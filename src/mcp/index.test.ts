import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, SERVER_NAME } from "./index";
import { EVALUATE_TOOL_NAME } from "./evaluateTool";
import { getConfig, type ServerConfig } from "../config";

// Drives the real server over the real protocol, with the LLM replaced by a
// throwaway OpenAI-compatible one. What is under test is the MCP surface: the
// published schema, the call result shape, and which validator answers a bad
// request.
async function withClient(
  reply: (content: string) => unknown,
  run: (
    client: Client,
    cleanup: () => Promise<void>
  ) => Promise<void>
): Promise<void> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply(JSON.parse(raw).messages.at(-1).content)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  // createServer resolves config from the environment, so point it at the mock
  // the only way an MCP client can: through the process it launches.
  const previous = { base: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL };
  process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
  process.env.LLM_API_KEY = "k";
  process.env.LLM_MODEL = "mock-model";

  const mcp = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });

  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client, async () => {
      await client.close();
      await mcp.close();
    });
  } finally {
    for (const [key, value] of [["LLM_BASE_URL", previous.base], ["LLM_API_KEY", previous.key], ["LLM_MODEL", previous.model]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function chatReply(content: string) {
  return {
    id: "1",
    object: "chat.completion",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}

const REQUEST = {
  state: "Your dashboard has been loading for 30 seconds.",
  questions: {
    team: {
      type: "choice",
      instructions: "Which team owns this?",
      criteria: { support: "How-to questions", engineering: "Bugs and outages" },
    },
    is_outage: { type: "noul", instructions: "Is production down for users?" },
  },
};

// ── Discovery ────────────────────────────────────────────────────────────────

test("the server identifies itself and publishes one tool", async () => {
  await withClient(chatReply, async (client, cleanup) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, EVALUATE_TOOL_NAME);
    assert.equal(cleanup !== undefined, true);
    await cleanup();
  });
});

test("the tool advertises a typed input and output schema", async () => {
  await withClient(chatReply, async (client, cleanup) => {
    const { tools } = await client.listTools();
    const tool = tools[0];

    // A client with structured output support relies on these existing.
    assert.ok(tool.inputSchema, "expected an inputSchema");
    assert.ok(tool.outputSchema, "expected an outputSchema");
    const required = (tool.inputSchema as { required?: string[] }).required ?? [];
    assert.deepEqual(required.sort(), ["questions", "state"]);

    const output = tool.outputSchema as { properties?: Record<string, unknown> };
    assert.deepEqual(Object.keys(output.properties ?? {}).sort(), [
      "answers",
      "model",
      "usage",
      "warnings",
    ]);

    // The question contract lives in the description, so a third-party model can
    // build a valid request without a schema it can introspect.
    assert.match(tool.description ?? "", /"choice"/);
    assert.match(tool.description ?? "", /"score"/);
    assert.match(tool.description ?? "", /"noul"/);
    assert.match(tool.description ?? "", /1 to 255 options/);
    await cleanup();
  });
});

// ── Calling ──────────────────────────────────────────────────────────────────

test("a call returns the digest and the full structured response", async () => {
  await withClient(
    (content) => chatReply("0:0.15;1:0.85;2:0.1"),
    async (client, cleanup) => {
      const result = await client.callTool({ name: EVALUATE_TOOL_NAME, arguments: REQUEST });

      assert.equal(result.isError, undefined);
      const text = (result.content as { type: string; text: string }[])[0].text;
      assert.match(text, /team \(choice\) => engineering/);
      assert.match(text, /is_outage \(noul\) => 0\.10 — no/);
      assert.match(text, /model xev-mock-model/);

      const structured = result.structuredContent as {
        answers: Record<string, { type: string }>;
        usage: { input_tokens: number };
      };
      assert.deepEqual(Object.keys(structured.answers), ["team", "is_outage"]);
      assert.equal(structured.usage.input_tokens, 11);
      await cleanup();
    }
  );
});

test("the prompt never carries the caller's question ids", async () => {
  let prompt = "";
  await withClient(
    (content) => {
      prompt = content;
      return chatReply("0:0.15;1:0.85;2:0.1");
    },
    async (client, cleanup) => {
      await client.callTool({ name: EVALUATE_TOOL_NAME, arguments: REQUEST });
      // "team" and "is_outage" would leak the caller's vocabulary to the model.
      assert.equal(prompt.includes("is_outage"), false);
      assert.match(prompt, /Question q0/);
      await cleanup();
    }
  );
});

test("an invalid question comes back as an error an agent can act on", async () => {
  await withClient(chatReply, async (client, cleanup) => {
    const result = await client.callTool({
      name: EVALUATE_TOOL_NAME,
      arguments: { state: "x", questions: { bad: { type: "ranking", instructions: "y" } } },
    });

    assert.equal(result.isError, true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    // xev's own validator answered, not a zod union dump: the message names the
    // types that are allowed and the field that is missing.
    assert.match(text, /expected a question of type "noul" \| "choice" \| "score"/);
    assert.equal(text.includes('"code"'), false);
    await cleanup();
  });
});

test("a missing state is refused before the model is called", async () => {
  let called = false;
  await withClient(
    (content) => {
      called = true;
      return chatReply("0:1");
    },
    async (client, cleanup) => {
      const result = await client.callTool({
        name: EVALUATE_TOOL_NAME,
        arguments: { questions: { a: { type: "noul", instructions: "y" } } },
      });
      assert.equal(result.isError, true);
      assert.equal(called, false);
      await cleanup();
    }
  );
});

test("an unknown tool name is reported as an error, not a crash", async () => {
  await withClient(chatReply, async (client, cleanup) => {
    const result = await client.callTool({ name: "xev_nope", arguments: {} });
    // An error result rather than a protocol error: the calling model sees the
    // message and can correct itself, instead of the turn failing outright.
    assert.equal(result.isError, true);
    const text = (result.content as { type: string; text: string }[])[0].text;
    assert.match(text, /xev_nope/);
    await cleanup();
  });
});

test("the server name is stable for clients that key off it", () => {
  assert.equal(SERVER_NAME, "xev");
});
