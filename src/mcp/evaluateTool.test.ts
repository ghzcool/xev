import { test } from "node:test";
import assert from "node:assert/strict";
import { failureText, renderEvaluation, toToolResult } from "./evaluateTool";
import type { SystemOneResponse } from "../types";

const RESPONSE: SystemOneResponse = {
  model: "xev-m",
  answers: {
    department: {
      type: "choice",
      choice: "billing",
      probabilities: { support: 0.2, billing: 0.8 },
      confidence: 0.6,
    },
    // 0.05*0 + 0.15*1 + 0.6*2 + 0.2*3 = 1.65, the weighted average of the indices.
    urgency: {
      type: "score",
      score: 1.65,
      legend: { "0": "Low", "1": "Medium", "2": "High", "3": "Critical" },
      probabilities: { "0": 0.05, "1": 0.15, "2": 0.6, "3": 0.2 },
      confidence: 0.47,
    },
    is_complaint: { type: "noul", noul: 0.95 },
  },
  usage: { input_tokens: 412, output_tokens: 23 },
};

test("the digest leads with the answer for each question type", () => {
  const text = renderEvaluation(RESPONSE);
  assert.match(text, /^department \(choice\) => billing$/m);
  assert.match(text, /confidence 0\.60/);
  assert.match(text, /^urgency \(score\) => 1\.65 \(mostly level 2: High\)$/m);
  assert.match(text, /^is_complaint \(noul\) => 0\.95 — yes$/m);
  assert.match(text, /model xev-m · 412 tokens in \/ 23 out/);
});

test("a choice lists its options by weight, best first", () => {
  const text = renderEvaluation(RESPONSE);
  assert.match(text, /billing 0\.80 {2}support 0\.20/);
});

test("a score names the level it mostly landed on, not the fractional average", () => {
  // `score` is a probability-weighted mean of the level indices, so indexing the
  // legend with it yields nothing. The argmax is what the caller acts on.
  const text = renderEvaluation(RESPONSE);
  assert.match(text, /urgency \(score\) => 1\.65 \(mostly level 2: High\)/);
  assert.equal(text.includes("(no description)"), false);
});

test("a spread-out score still reports the level it favoured", () => {
  const text = renderEvaluation({
    ...RESPONSE,
    answers: {
      quality: {
        type: "score",
        score: 0.9,
        legend: { "0": "Cosmetic", "1": "Blocking" },
        probabilities: { "0": 0.1, "1": 0.9 },
        confidence: 0.8,
      },
    },
  });
  assert.match(text, /quality \(score\) => 0\.9 \(mostly level 1: Blocking\)/);
});

test("a noul is labelled so the number is not read as a probability", () => {
  const text = renderEvaluation(RESPONSE);
  assert.match(text, /is_complaint \(noul\) => 0\.95 — yes/);
});

test("an uncertain noul is not rounded into a yes or a no", () => {
  const text = renderEvaluation({ ...RESPONSE, answers: { q: { type: "noul", noul: 0.5 } } });
  assert.match(text, /q \(noul\) => 0\.50 — uncertain/);
});

test("warnings are shown, not buried", () => {
  const text = renderEvaluation({
    ...RESPONSE,
    warnings: ["Question \"urgency\": the model answered 2 of 4 levels"],
  });
  const lines = text.split("\n");
  const warningAt = lines.findIndex((l) => l.startsWith("warnings"));
  assert.ok(warningAt > 0, "expected a warnings heading");
  assert.match(lines[warningAt + 1] ?? "", /urgency/);
  // A warned response should not read as a clean one at a glance.
  assert.ok(warningAt < lines.length - 2, "warnings must not be the last line");
});

test("a clean response has no warnings section", () => {
  assert.equal(renderEvaluation(RESPONSE).includes("warnings"), false);
});

test("an object score level is rendered as JSON, not as [object Object]", () => {
  const text = renderEvaluation({
    ...RESPONSE,
    answers: {
      quality: {
        type: "score",
        score: 1,
        legend: { "0": "Cosmetic", "1": { what: "Blocking", examples: ["data loss"] } },
        probabilities: { "0": 0.1, "1": 0.9 },
        confidence: 0.8,
      },
    },
  });
  assert.match(text, /quality \(score\) => 1 \(mostly level 1: \{"what":"Blocking"/);
  assert.equal(text.includes("[object Object]"), false);
});

test("structured content matches the schema the tool publishes", () => {
  // The published outputSchema sets additionalProperties:false on usage, which
  // does not include reasoning_tokens. Passing the raw response through would
  // hand a strict client a payload its own contract rejects.
  const raw = {
    ...RESPONSE,
    usage: { input_tokens: 412, output_tokens: 23, reasoning_tokens: 96 },
  };
  const result = toToolResult({ ok: true, response: raw as SystemOneResponse });
  assert.deepEqual(result.structuredContent, RESPONSE);
  assert.equal(
    (result.structuredContent as { usage: Record<string, unknown> }).usage.reasoning_tokens,
    undefined
  );
});

test("a success carries both the digest and the structured response", () => {
  const result = toToolResult({ ok: true, response: RESPONSE });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.deepEqual(result.structuredContent, RESPONSE);
  assert.match(result.content[0].text, /department \(choice\)/);
});

test("a failure is an error result with no structured content", () => {
  const result = toToolResult({ ok: false, status: 422, error: "Validation failed: nope" });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(result.content[0].text, "xev_evaluate failed (422): Validation failed: nope Fix the request and try again.");
});

test("a rate limit is told apart from a bad request", () => {
  // 429 is worth retrying and 422 is not; a client that cannot tell them apart
  // either loops forever or gives up on a fixable problem.
  const limited = failureText({ ok: false, status: 429, error: "Rate limit reached" });
  assert.match(limited, /rate limiting; wait and retry/);
  const upstream = failureText({ ok: false, status: 502, error: "Evaluation failed" });
  assert.match(upstream, /not your request/);
});
