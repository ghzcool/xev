import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildPlaceholderMap, bindQuestions } from "./prompt";
import type { Question } from "./types";

type Questions = Record<string, Question>;

const MIXED: Questions = {
  department: {
    type: "choice",
    instructions: "Which team?",
    criteria: { billing: "Money", technical: "Bugs" },
  },
  is_urgent: { type: "noul", instructions: "Is it urgent?" },
  severity: {
    type: "score",
    instructions: "How bad?",
    criteria: ["low", "high"],
  },
};

// ── Question ids never reach the model (Jev privacy parity) ────────────────

test("the caller's question ids are absent from the prompt", () => {
  const prompt = buildPrompt("hello", MIXED);
  for (const id of Object.keys(MIXED)) {
    assert.equal(prompt.includes(id), false, `prompt leaked question id "${id}"`);
  }
});

test("questions are addressed positionally as q0, q1, ...", () => {
  const prompt = buildPrompt("hello", MIXED);
  assert.match(prompt, /Question q0/);
  assert.match(prompt, /Question q1/);
  assert.match(prompt, /Question q2/);
  const bindings = bindQuestions(MIXED);
  assert.deepEqual(
    bindings.map((b) => b.alias),
    ["q0", "q1", "q2"]
  );
  assert.deepEqual(
    bindings.map((b) => b.questionId),
    ["department", "is_urgent", "severity"]
  );
});

// ── Placeholder index order is shared with the parser ───────────────────────

test("placeholder indices follow question order, then option order", () => {
  // 2 choice options, 1 noul, 2 score levels
  assert.deepEqual(buildPlaceholderMap(MIXED), [
    { questionId: "department", field: "probabilities", key: "billing" },
    { questionId: "department", field: "probabilities", key: "technical" },
    { questionId: "is_urgent", field: "noul" },
    { questionId: "severity", field: "probabilities", key: "0" },
    { questionId: "severity", field: "probabilities", key: "1" },
  ]);
});

test("the template numbers every placeholder the parser will look for", () => {
  const prompt = buildPrompt("hello", MIXED);
  const expected = buildPlaceholderMap(MIXED).length;
  for (let i = 0; i < expected; i++) {
    assert.ok(prompt.includes(`\${${i}}`), `template is missing \${${i}}`);
  }
  assert.equal(prompt.includes(`\${${expected}}`), false);
});

test("placeholders are bare numbers, not quoted strings", () => {
  const prompt = buildPrompt("hello", MIXED);
  assert.equal(prompt.includes('"${0}"'), false);
  assert.match(prompt, /"noul": \$\{2\}/);
});

// ── Prompt content ──────────────────────────────────────────────────────────

test("the prompt states the answer format", () => {
  const prompt = buildPrompt("hello", MIXED);
  assert.match(prompt, /index:value/);
  assert.match(prompt, /";"-separated/);
  assert.match(prompt, /sum to exactly 1\.0/);
});

test("state is included and object state is serialized", () => {
  const prompt = buildPrompt({ message: "hi", urgent: true }, MIXED);
  assert.match(prompt, /"message": "hi"/);
  assert.match(prompt, /"urgent": true/);
});

test("choice options and score levels are listed with their keys", () => {
  const prompt = buildPrompt("hello", MIXED);
  assert.match(prompt, /- "billing": Money/);
  assert.match(prompt, /- "technical": Bugs/);
  assert.match(prompt, /0: low/);
  assert.match(prompt, /1: high/);
});

test("a choice option with no description is still listed", () => {
  const prompt = buildPrompt("hello", {
    d: { type: "choice", instructions: "x", criteria: { a: null, b: "B" } },
  });
  assert.match(prompt, /- "a": \(no description\)/);
});

test("noul true/false criteria are described when present", () => {
  const prompt = buildPrompt("hello", {
    n: {
      type: "noul",
      instructions: "x",
      criteria: { true: "the sky is blue", false: "anything else" },
    },
  });
  assert.match(prompt, /What "yes" \(1\.0\) means: the sky is blue/);
  assert.match(prompt, /What "no" \(0\.0\) means: anything else/);
});

test("object and array instructions are serialized as JSON", () => {
  const prompt = buildPrompt("hello", {
    n: { type: "noul", instructions: { task: "classify", labels: ["a", "b"] } },
  });
  assert.match(prompt, /"task": "classify"/);
  assert.match(prompt, /"labels": \[/);
});
