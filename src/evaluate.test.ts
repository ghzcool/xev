import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { evaluate } from "./evaluate";
import { getConfig, type ServerConfig } from "./config";

// A throwaway OpenAI-compatible server, so the success path is exercised without
// a real model. Mirrors the helper in llm.test.ts rather than sharing one, since
// test-only helpers are not part of the build.
async function withMockLLM(
  content: string,
  run: (baseURL: string, prompts: string[]) => Promise<void>
): Promise<void> {
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      prompts.push(body.messages[body.messages.length - 1].content);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "1",
          object: "chat.completion",
          created: 1,
          model: "m",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        })
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, prompts);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function configFor(baseURL: string): ServerConfig {
  return { ...getConfig(), baseURL, apiKey: "k", model: "m" };
}

const CHOICE_AND_NOUL = {
  state: "The customer has waited three weeks for a refund.",
  questions: {
    department: {
      type: "choice",
      instructions: "Which team handles this?",
      criteria: { support: "General help", billing: "Refunds" },
    },
    is_complaint: { type: "noul", instructions: "Is the customer unhappy?" },
  },
} as const;

// ── Success path ─────────────────────────────────────────────────────────────

test("one call answers every question, with the ids the caller used", async () => {
  await withMockLLM("0:0.2;1:0.8;2:0.95", async (baseURL, prompts) => {
    const outcome = await evaluate(CHOICE_AND_NOUL, { config: configFor(baseURL) });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    // All questions ride in one prompt; a second call would mean a second price.
    assert.equal(prompts.length, 1);
    assert.equal(outcome.response.model, "xev-m");
    assert.deepEqual(Object.keys(outcome.response.answers), ["department", "is_complaint"]);

    const department = outcome.response.answers.department;
    assert.equal(department?.type, "choice");
    assert.equal(department?.type === "choice" ? department.choice : "", "billing");
    assert.deepEqual(department?.type === "choice" ? department.probabilities : {}, {
      support: 0.2,
      billing: 0.8,
    });

    const complaint = outcome.response.answers.is_complaint;
    assert.equal(complaint?.type === "noul" ? complaint.noul : 0, 0.95);
    assert.equal(outcome.response.warnings, undefined);
  });
});

test("an unparseable answer is reported, not guessed at", async () => {
  await withMockLLM("I am not going to answer that.", async (baseURL) => {
    const outcome = await evaluate(CHOICE_AND_NOUL, { config: configFor(baseURL) });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 502);
  });
});

test("a partial answer produces a warning on the response", async () => {
  // Only the choice is answered; the noul placeholder is missing.
  await withMockLLM("0:0.5;1:0.5", async (baseURL) => {
    const outcome = await evaluate(CHOICE_AND_NOUL, { config: configFor(baseURL) });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.response.warnings?.length, 1);
    assert.match(outcome.response.warnings?.[0] ?? "", /is_complaint/);
  });
});

// ── Validation, before any LLM call ──────────────────────────────────────────

test("an unknown question type is rejected with a readable message", async () => {
  const outcome = await evaluate({
    state: "x",
    questions: { bad: { type: "ranking", instructions: "y" } },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 422);
  // The point of the crafted message: an agent can act on this, where zod's own
  // union dump would be a dozen lines of nested JSON.
  assert.equal(
    outcome.error,
    'Validation failed: questions.bad: expected a question of type "noul" | "choice" | "score"'
  );
});

test("a known type missing its criteria names the missing field", async () => {
  const outcome = await evaluate({
    state: "x",
    questions: { bad: { type: "choice", instructions: "y" } },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.error, /missing: criteria/);
});

test("an empty question map is rejected", async () => {
  const outcome = await evaluate({ state: "x", questions: {} });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 422);
  assert.match(outcome.error, /at least one question/);
});

test("a score with one level is rejected against TypeSafe's limits", async () => {
  const outcome = await evaluate({
    state: "x",
    questions: { s: { type: "score", instructions: "y", criteria: ["only"] } },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 422);
  assert.match(outcome.error, /2 to 10/);
});

test("a missing state is rejected", async () => {
  const outcome = await evaluate({ questions: { a: { type: "noul", instructions: "y" } } });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 422);
});

// ── Credential guard, reachable without express ──────────────────────────────

test("headers cannot redirect the server's API key to another host", async () => {
  const outcome = await evaluate(CHOICE_AND_NOUL, {
    config: configFor("http://127.0.0.1:1/v1"),
    headers: { "x-llm-base-url": "http://evil.example/v1" },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 400);
  assert.match(outcome.error, /x-llm-api-key is required/);
});

test("a bad x-llm value is rejected rather than silently ignored", async () => {
  const outcome = await evaluate(CHOICE_AND_NOUL, {
    config: configFor("http://127.0.0.1:1/v1"),
    headers: { "x-llm-reasoning-effort": "turbo" },
  });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.status, 400);
});

// ── Upstream failures ────────────────────────────────────────────────────────

test("an upstream failure is a 502, not a 500", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream exploded" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const outcome = await evaluate(CHOICE_AND_NOUL, {
      config: configFor(`http://127.0.0.1:${port}/v1`),
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 502);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
