import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, buildPlaceholderMap, bindQuestions } from "./prompt";
import { validateRequest } from "./validate";
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

test("a blank instructions field reaches the model as the question id", () => {
  // The one way an id reaches the model: the caller left the wording empty, so
  // the id is the question. It is still not a template key.
  const result = validateRequest({
    state: "hello",
    questions: { male: { type: "noul", instructions: "" } },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  const prompt = buildPrompt(result.data.state, result.data.questions);
  assert.match(prompt, /Instructions: male/);
  assert.match(prompt, /"noul": \$\{0\}/);
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

test("the prompt forbids an all-zero answer", () => {
  // A model with no applicable option used to answer 0 for every placeholder,
  // which is not a distribution and left the parser with a uniform guess.
  const prompt = buildPrompt("hello", MIXED);
  assert.match(prompt, /Never answer 0 for every placeholder/);
  assert.match(prompt, /supports none of its options/);
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

test("a choice option with no description falls back to its name", () => {
  const prompt = buildPrompt("hello", {
    d: { type: "choice", instructions: "x", criteria: { a: null, b: "B" } },
  });
  assert.match(prompt, /- "a": a/);
  // A null is not a description the model can read.
  assert.equal(prompt.includes("null"), false);
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

// ── Images are part of the state, not a footnote ────────────────────────────

test("no images means no image instructions in the prompt", () => {
  const prompt = buildPrompt("hello", MIXED);
  assert.equal(prompt.includes("IMAGES:"), false);
});

test("an attached image is declared part of the STATE", () => {
  const prompt = buildPrompt("hello", MIXED, [{ url: "data:image/png;base64,AAAA" }]);
  assert.match(prompt, /1 image is attached to this message/);
  assert.match(prompt, /part of the STATE/);
  // The model has to be told to actually look, or it answers from the text.
  assert.match(prompt, /Read every image before answering/);
  // And it must sit inside the STATE block, not after the questions.
  assert.ok(prompt.indexOf("IMAGES:") < prompt.indexOf("QUESTIONS:"));
});

test("several images are counted and each is in scope", () => {
  const prompt = buildPrompt("hello", MIXED, [
    { url: "data:image/png;base64,AAAA" },
    { url: "https://example.com/b.jpg" },
  ]);
  assert.match(prompt, /2 images are attached to this message/);
});

test("alt labels are numbered so a question can refer to one image", () => {
  const prompt = buildPrompt("hello", MIXED, [
    { url: "data:image/png;base64,AAAA" },
    { url: "data:image/png;base64,BBBB", alt: "the error dialog" },
  ]);
  assert.match(prompt, /2 = "the error dialog"/);
});

test("image bytes never enter the prompt itself", () => {
  // The image travels as an `image_url` part, not as prompt text: a model that
  // cannot read images must still get a prompt that makes no sense to inline it.
  const prompt = buildPrompt("hello", MIXED, [{ url: "data:image/png;base64,AAAABBBBCCCC" }]);
  assert.equal(prompt.includes("AAAABBBBCCCC"), false);
});

test("the placeholder template is unaffected by images", () => {
  const prompt = buildPrompt("hello", MIXED, [{ url: "data:image/png;base64,AAAA" }]);
  const expected = buildPlaceholderMap(MIXED).length;
  for (let i = 0; i < expected; i++) {
    assert.ok(prompt.includes(`\${${i}}`), `template is missing \${${i}}`);
  }
  assert.equal(prompt.includes(`\${${expected}}`), false);
});
