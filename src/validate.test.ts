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

// ── Blank instructions fall back to the question id ─────────────────────────

test("a blank instructions field is filled in with the question id", () => {
  const result = validate({
    state: "hello",
    questions: {
      male: { type: "noul", instructions: "" },
      female: { type: "noul", instructions: "  " },
      age: { type: "choice", instructions: "", criteria: { adult: null } },
      severity: { type: "score", instructions: "\n", criteria: ["low", "high"] },
    },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.deepEqual(result.data.questions, {
    male: { type: "noul", instructions: "male" },
    female: { type: "noul", instructions: "female" },
    age: { type: "choice", instructions: "age", criteria: { adult: "adult" } },
    severity: { type: "score", instructions: "severity", criteria: ["low", "high"] },
  });
});

test("instructions that say something are left alone", () => {
  const result = validate(body({ nice: { type: "noul", instructions: "Is this person nice?" } }));
  assert.equal(result.success, true);
  if (!result.success) return;
  const q = result.data.questions.nice;
  assert.equal(q.instructions, "Is this person nice?");
});

test("a missing instructions field is still an error, so a typo cannot pass silently", () => {
  // `{ male: { type: "noul" } }` would otherwise become the question "male".
  const result = validate({ state: "hello", questions: { male: { type: "noul" } } });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.match(result.error.error, /instructions/);
});

// ── Choice criteria are normalized, not passed through ─────────────────────

test("an option with a name but no value is described by its name", () => {
  const result = validate(
    body({ d: { type: "choice", instructions: "x", criteria: { billing: null, bugs: "Broken" } } })
  );
  assert.equal(result.success, true);
  if (!result.success) return;
  const q = result.data.questions.d;
  assert.equal(q.type, "choice");
  if (q.type !== "choice") return;
  assert.deepEqual(q.criteria, { billing: "billing", bugs: "Broken" });
});

test("an option with an empty name is dropped", () => {
  const result = validate(
    body({ d: { type: "choice", instructions: "x", criteria: { "": "orphan", "  ": null, bugs: "Broken" } } })
  );
  assert.equal(result.success, true);
  if (!result.success) return;
  const q = result.data.questions.d;
  assert.equal(q.type, "choice");
  if (q.type !== "choice") return;
  assert.deepEqual(Object.keys(q.criteria), ["bugs"]);
});

test("a choice whose only option has an empty name has no options", () => {
  expectRejected({ d: { type: "choice", instructions: "x", criteria: { "": null } } }, /no options/);
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

// ── Images ──────────────────────────────────────────────────────────────────

const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("a request without images is unaffected", () => {
  assert.equal(validate(body({ n: { type: "noul", instructions: "x" } })).success, true);
});

test("an image as a data URI or an https URL is accepted", () => {
  for (const url of [PNG, "https://example.com/a.png", "http://example.com/a.png"]) {
    const result = validate(body({ n: { type: "noul", instructions: "x" } }, { images: [{ url }] }));
    assert.equal(result.success, true, `image ${url} was rejected`);
  }
});

test("bare base64 is rejected, because nothing says what the bytes are", () => {
  const result = validate(body({ n: { type: "noul", instructions: "x" } }, {
    images: [{ url: "iVBORw0KGgo=" }],
  }));
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.status, 422);
  assert.match(result.error.error, /data:image/);
});

test("a non-image data URI is rejected", () => {
  const result = validate(body({ n: { type: "noul", instructions: "x" } }, {
    images: [{ url: "data:text/plain;base64,aGk=" }],
  }));
  assert.equal(result.success, false);
});

test("up to 8 images are accepted and a 9th is a 422", () => {
  const questions = { n: { type: "noul", instructions: "x" } as const };
  const many = (count: number) => Array.from({ length: count }, () => ({ url: PNG }));
  assert.equal(validate(body(questions, { images: many(8) })).success, true);

  const result = validate(body(questions, { images: many(9) }));
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.status, 422);
  assert.match(result.error.error, /at most 8/);
});

test("an unknown detail value is rejected", () => {
  const result = validate(body({ n: { type: "noul", instructions: "x" } }, {
    images: [{ url: PNG, detail: "medium" }],
  }));
  assert.equal(result.success, false);
});

test("alt text and detail survive validation", () => {
  const result = validate(body({ n: { type: "noul", instructions: "x" } }, {
    images: [{ url: PNG, alt: "the error dialog", detail: "high" }],
  }));
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.images?.[0].alt, "the error dialog");
  assert.equal(result.data.images?.[0].detail, "high");
});
