import { test } from "node:test";
import assert from "node:assert/strict";
import { validateRequest } from "./validate";
import type { Question } from "./types";

type Questions = Record<string, Question>;

function validate(body: unknown) {
  return validateRequest(body);
}

function choiceWithOptions(count: number): Question {
  const criteria: Record<string, string> = {};
  for (let i = 0; i < count; i++) criteria[`opt${i}`] = `option ${i}`;
  return { type: "choice", instructions: "x", criteria };
}

function scoreWithLevels(count: number): Question {
  return {
    type: "score",
    instructions: "x",
    criteria: Array.from({ length: count }, (_, i) => `level ${i}`),
  };
}

function body(questions: Questions, extra: Record<string, unknown> = {}) {
  return { state: "hello", model: "test", questions, ...extra };
}

function expectRejected(questions: Questions, fragment: string) {
  const result = validate(body(questions));
  assert.equal(result.success, false, "expected the request to be rejected");
  if (result.success) return;
  assert.equal(result.error.status, 422);
  assert.match(result.error.error, fragment);
}

// ── Accepts ─────────────────────────────────────────────────────────────────

test("a well-formed request passes", () => {
  const result = validate(
    body({
      d: { type: "choice", instructions: "x", criteria: { a: "A", b: "B" } },
      n: { type: "noul", instructions: "x" },
      s: { type: "score", instructions: "x", criteria: ["low", "high"] },
    })
  );
  assert.equal(result.success, true);
});

test("model is optional, matching Jev's jev-latest default", () => {
  const result = validate({
    state: "hello",
    questions: { n: { type: "noul", instructions: "x" } },
  });
  assert.equal(result.success, true);
});

test("state may be an object or array", () => {
  for (const state of ["text", { a: 1 }, [1, 2, 3]]) {
    const result = validate({ state, questions: { n: { type: "noul", instructions: "x" } } });
    assert.equal(result.success, true, `state ${JSON.stringify(state)} was rejected`);
  }
});

// ── TypeSafe's documented limits ────────────────────────────────────────────

test("choice accepts 1 to 255 options", () => {
  assert.equal(validate(body({ d: choiceWithOptions(1) })).success, true);
  assert.equal(validate(body({ d: choiceWithOptions(255) })).success, true);
});

test("choice rejects 256 options and 0 options", () => {
  expectRejected({ d: choiceWithOptions(256) }, /at most 255/);
  expectRejected(
    { d: { type: "choice", instructions: "x", criteria: {} } },
    /no options/
  );
});

test("score accepts 2 to 10 levels", () => {
  assert.equal(validate(body({ s: scoreWithLevels(2) })).success, true);
  assert.equal(validate(body({ s: scoreWithLevels(10) })).success, true);
  expectRejected({ s: scoreWithLevels(1) }, /2 to 10/);
  expectRejected({ s: scoreWithLevels(11) }, /2 to 10/);
});

// ── Shape errors ────────────────────────────────────────────────────────────

test("a choice without criteria is rejected with a message that says why", () => {
  const result = validate({
    state: "hello",
    questions: { d: { type: "choice", instructions: "x" } },
  });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.match(result.error.error, /questions\.d/);
  assert.match(result.error.error, /missing: criteria: Required/);
});

test("an unknown question type names the types xev accepts, without blaming fields", () => {
  const result = validate({
    state: "hello",
    questions: { d: { type: "ranking", instructions: "x" } },
  });
  assert.equal(result.success, false);
  if (result.success) return;
  for (const type of ["noul", "choice", "score"]) {
    assert.match(result.error.error, new RegExp(type));
  }
  // The type is the problem; "criteria: Required" would send the caller hunting
  // in the wrong direction.
  assert.equal(result.error.error.includes("criteria"), false);
});

test("an unknown question type is rejected", () => {
  const result = validate({
    state: "hello",
    questions: { d: { type: "ranking", instructions: "x" } },
  });
  assert.equal(result.success, false);
});

test("an empty questions map is rejected", () => {
  // Valid to zod as a record, but there is nothing to evaluate and no
  // placeholder for the model to answer.
  const result = validate({ state: "hello", questions: {} });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.status, 422);
  assert.match(result.error.error, /at least one question/);
});

test("a missing state is rejected with details", () => {
  const result = validate({ questions: { n: { type: "noul", instructions: "x" } } });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.status, 422);
  assert.ok(Array.isArray(result.error.details));
});

test("the offending question id appears in the error", () => {
  expectRejected({ my_question: scoreWithLevels(11) }, /"my_question"/);
});
