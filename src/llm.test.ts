import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { callLLM } from "./llm";

interface MockReply {
  status?: number;
  body: unknown;
}

interface Captured {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

// Starts a throwaway OpenAI-compatible server for one call.
async function withServer(
  reply: MockReply,
  run: (baseURL: string, captured: Captured[]) => Promise<void>
): Promise<void> {
  const captured: Captured[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {
        body = {};
      }
      captured.push({ path: req.url ?? "", headers: req.headers, body });
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function chatReply(content: string, finishReason = "stop", extra: Record<string, unknown> = {}) {
  return {
    id: "1",
    object: "chat.completion",
    created: 1,
    model: "m",
    choices: [
      { index: 0, message: { role: "assistant", content, ...extra }, finish_reason: finishReason },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  };
}

const BASE = { apiKey: "k", model: "m" };

// ── Request shape ───────────────────────────────────────────────────────────

test("the request is a single temperature-0 chat completion", async () => {
  await withServer({ body: chatReply("0:0.5") }, async (baseURL, captured) => {
    await callLLM("PROMPT", { ...BASE, baseURL });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].path, "/v1/chat/completions");
    assert.equal(captured[0].body.model, "m");
    assert.equal(captured[0].body.temperature, 0);
    assert.deepEqual(
      (captured[0].body.messages as { role: string }[]).map((m) => m.role),
      ["system", "user"]
    );
    assert.equal(captured[0].headers.authorization, "Bearer k");
  });
});

test("OpenRouter attribution headers and provider routing are sent", async () => {
  await withServer({ body: chatReply("0:0.5") }, async (baseURL, captured) => {
    await callLLM("PROMPT", {
      ...BASE,
      baseURL,
      referer: "https://my.app",
      title: "My App",
      providerOrder: ["groq", "together"],
      allowFallbacks: false,
      dataCollection: "deny",
      maxTokens: 512,
    });
    const sent = captured[0];
    assert.equal(sent.headers["http-referer"], "https://my.app");
    assert.equal(sent.headers["x-title"], "My App");
    assert.equal(sent.body.max_tokens, 512);
    assert.deepEqual(sent.body.provider, {
      order: ["groq", "together"],
      allow_fallbacks: false,
      data_collection: "deny",
    });
  });
});

test("no provider or max_tokens keys are sent when unconfigured", async () => {
  await withServer({ body: chatReply("0:0.5") }, async (baseURL, captured) => {
    await callLLM("PROMPT", { ...BASE, baseURL });
    assert.equal("provider" in captured[0].body, false);
    assert.equal("max_tokens" in captured[0].body, false);
  });
});

test("timeouts and retries are passed to the client", async () => {
  // A dead port fails fast; the point is that the options are accepted and the
  // failure surfaces as a connection error rather than a config error.
  await assert.rejects(
    callLLM("PROMPT", {
      ...BASE,
      baseURL: "http://127.0.0.1:1/v1",
      timeoutMs: 250,
      maxRetries: 0,
    }),
    /Connection error|ECONNREFUSED/
  );
});

// ── Response handling ───────────────────────────────────────────────────────

test("usage and content are read from the response", async () => {
  await withServer({ body: chatReply("0:0.5;1:0.5") }, async (baseURL) => {
    const result = await callLLM("PROMPT", { ...BASE, baseURL });
    assert.equal(result.content, "0:0.5;1:0.5");
    assert.deepEqual(result.usage, {
      input_tokens: 11,
      output_tokens: 7,
      reasoning_tokens: 0,
    });
    assert.equal(result.truncated, false);
    assert.equal(result.finishReason, "stop");
  });
});

test("code fences are stripped", async () => {
  await withServer({ body: chatReply("```\n0:0.5\n```") }, async (baseURL) => {
    const result = await callLLM("PROMPT", { ...BASE, baseURL });
    assert.equal(result.content, "0:0.5");
  });
});

test("a fence with a language tag and no trailing newline still parses", async () => {
  await withServer({ body: chatReply("```json\n0:0.5```") }, async (baseURL) => {
    const result = await callLLM("PROMPT", { ...BASE, baseURL });
    assert.equal(result.content.includes("0:0.5"), true);
    assert.equal(result.content.startsWith("```json"), false);
  });
});

test("a one-line fence is handled without producing garbage", async () => {
  await withServer({ body: chatReply("```0:0.5```") }, async (baseURL) => {
    const result = await callLLM("PROMPT", { ...BASE, baseURL });
    assert.match(result.content, /0:0\.5/);
    assert.equal(result.content.includes("```"), false);
  });
});

test("a length finish_reason is reported as truncated", async () => {
  await withServer({ body: chatReply("0:0.5;1:0", "length") }, async (baseURL) => {
    const result = await callLLM("PROMPT", { ...BASE, baseURL });
    assert.equal(result.truncated, true);
    assert.equal(result.finishReason, "length");
  });
});

test("an empty message is an error, not an empty answer", async () => {
  await withServer(
    { body: { ...chatReply(""), choices: [{ index: 0, message: { role: "assistant" } }] } },
    async (baseURL) => {
      await assert.rejects(
        callLLM("PROMPT", { ...BASE, baseURL }),
        /empty response/
      );
    }
  );
});

test("an error reported in a 200 body is surfaced", async () => {
  await withServer(
    { body: { error: { message: "Provider returned nothing" } } },
    async (baseURL) => {
      await assert.rejects(
        callLLM("PROMPT", { ...BASE, baseURL }),
        /Provider returned nothing/
      );
    }
  );
});

test("missing usage counters default to zero", async () => {
  await withServer(
    { body: { ...chatReply("0:0.5"), usage: undefined } },
    async (baseURL) => {
      const result = await callLLM("PROMPT", { ...BASE, baseURL });
      assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
    }
  );
});

// ── Reasoning models ────────────────────────────────────────────────────────

test("the reasoning object is sent when configured", async () => {
  await withServer({ body: chatReply("0:0.5") }, async (baseURL, captured) => {
    await callLLM("PROMPT", {
      ...BASE,
      baseURL,
      reasoning: { exclude: true, effort: "low", maxTokens: 512 },
    });
    assert.deepEqual(captured[0].body.reasoning, {
      exclude: true,
      effort: "low",
      max_tokens: 512,
    });
  });
});

test("reasoning is left out of the body when unconfigured", async () => {
  await withServer({ body: chatReply("0:0.5") }, async (baseURL, captured) => {
    await callLLM("PROMPT", { ...BASE, baseURL });
    assert.equal("reasoning" in captured[0].body, false);
  });
});

test("a separate reasoning field is ignored so the answer still parses", async () => {
  await withServer(
    { body: chatReply("0:0.2;1:0.8", "stop", { reasoning: "Let me weigh the options: 0:0.9 ..." }) },
    async (baseURL) => {
      const result = await callLLM("PROMPT", { ...BASE, baseURL });
      assert.equal(result.content, "0:0.2;1:0.8");
      assert.equal(result.hadReasoning, true);
    }
  );
});

test("reasoning_content is treated the same as reasoning", async () => {
  await withServer(
    { body: chatReply("0:0.2;1:0.8", "stop", { reasoning_content: "thinking..." }) },
    async (baseURL) => {
      const result = await callLLM("PROMPT", { ...BASE, baseURL });
      assert.equal(result.content, "0:0.2;1:0.8");
      assert.equal(result.hadReasoning, true);
    }
  );
});

test("an inline <think> block is stripped before parsing", async () => {
  const content =
    "<think>The user wants probabilities. 0:0.9 would be too confident.</think>\n0:0.2;1:0.8";
  await withServer({ body: chatReply(content) }, async (baseURL) => {
    const result = await callLLM("PROMPT", { ...BASE, baseURL });
    assert.equal(result.content, "0:0.2;1:0.8");
    assert.equal(result.hadReasoning, true);
  });
});

test("a response truncated mid-thought yields no answer and a clear error", async () => {
  // The failure that motivated reasoning support: the thinking consumed the
  // whole output budget, so there is no answer list at all.
  await withServer(
    {
      body: {
        ...chatReply("<think>\n1. **Analyze the User's Request:**\n- I must act as", "length"),
        usage: { prompt_tokens: 100, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 298 } },
      },
    },
    async (baseURL) => {
      await assert.rejects(callLLM("PROMPT", { ...BASE, baseURL }), (err: Error) => {
        assert.match(err.message, /reasoning/);
        assert.match(err.message, /298 reasoning tokens/);
        assert.match(err.message, /LLM_REASONING_EFFORT=none/);
        return true;
      });
    }
  );
});

test("reasoning token counts are reported", async () => {
  await withServer(
    {
      body: {
        ...chatReply("0:0.5", "stop", { reasoning: "brief thought" }),
        usage: { prompt_tokens: 100, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 32 } },
      },
    },
    async (baseURL) => {
      const result = await callLLM("PROMPT", { ...BASE, baseURL });
      assert.equal(result.usage.reasoning_tokens, 32);
      assert.equal(result.usage.output_tokens, 40);
    }
  );
});
