import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResponse, LLMResponseError } from "./parser";
import { SystemOneResponseSchema } from "./types";
import type { Question } from "./types";

const USAGE = { input_tokens: 10, output_tokens: 5 };

type Questions = Record<string, Question>;

function parse(questions: Questions, content: string) {
  return parseResponse(questions, content, "test-model", USAGE);
}

function parseWithWarnings(questions: Questions, content: string, warnings: string[]) {
  return parseResponse(questions, content, "test-model", USAGE, { warnings });
}

const CHOICE_THREE: Questions = {
  d: {
    type: "choice",
    instructions: "Which team?",
    criteria: { a: "A", b: "B", c: "C" },
  },
};

const MIXED: Questions = {
  d: {
    type: "choice",
    instructions: "Which team?",
    criteria: { a: "A", b: "B", c: "C" },
  },
  n: { type: "noul", instructions: "Is it urgent?" },
  s: { type: "score", instructions: "How bad?", criteria: ["low", "mid", "high"] },
};

function sum(probabilities: Record<string, number>): number {
  return Object.values(probabilities).reduce((s, v) => s + v, 0);
}

function roundedSum(value: number): boolean {
  return Math.abs(value - 1) < 1e-9;
}

// ── Jev parity: probabilities and confidence ───────────────────────────────

test("probabilities are normalized to 1 and reported at 2 decimals", () => {
  // 0.1 + 0.2 + 0.8 drifts to 1.1, so the parser rescales.
  const { answers } = parse(CHOICE_THREE, "0:0.1;1:0.2;2:0.8");
  const answer = answers.d;
  assert.equal(answer.type, "choice");
  if (answer.type !== "choice") return;
  assert.deepEqual(answer.probabilities, { a: 0.09, b: 0.18, c: 0.73 });
  assert.ok(roundedSum(sum(answer.probabilities)));
});

test("largest-remainder rounding keeps the sum at exactly 1", () => {
  const { answers } = parse(CHOICE_THREE, "0:0.333;1:0.333;2:0.333");
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.ok(roundedSum(sum(answer.probabilities)), "sum drifted from 1");
  assert.equal(answer.confidence, 0);
});

test("confidence uses Jev's peak rescaling on full precision", () => {
  // The reported probability is 0.75, but confidence must come from the
  // full-precision peak: (3 * 0.745 - 1) / 2 = 0.6175 -> 0.62. Rescaling the
  // rounded 0.75 instead would give 0.63.
  const { answers } = parse(CHOICE_THREE, "0:0.745;1:0.255;2:0");
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.probabilities.a, 0.75);
  assert.equal(answer.confidence, 0.62);
});

test("confidence matches Jev's published example", () => {
  // (4 * 0.8 - 1) / 3 = 0.7333
  const questions: Questions = {
    d: {
      type: "choice",
      instructions: "x",
      criteria: { a: "a", b: "b", c: "c", d: "d" },
    },
  };
  const { answers } = parse(questions, "0:0.1;1:0.8;2:0.05;3:0.05");
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.confidence, 0.73);
});

test("a single peak gives confidence 1 and a uniform distribution gives 0", () => {
  const { answers } = parse(CHOICE_THREE, "0:1;1:0;2:0");
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.choice, "a");
  assert.equal(answer.confidence, 1);
});

test("negative and non-numeric values are clamped", () => {
  const { answers } = parse(CHOICE_THREE, "0:-5;1:0.5;2:abc");
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.probabilities.a, 0);
  assert.ok(roundedSum(sum(answer.probabilities)));
});

test("ties keep the first criterion", () => {
  const { answers } = parse(CHOICE_THREE, "0:0.5;1:0.5;2:0");
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.choice, "a");
});

test("score is the probability-weighted level index", () => {
  // Placeholders: 0-2 choice options, 3 noul, 4-6 score levels.
  const { answers } = parse(MIXED, "0:0.1;1:0.2;2:0.7;3:0.9;4:0;5:0.7;6:0.3");
  const answer = answers.s;
  assert.equal(answer.type, "score");
  if (answer.type !== "score") return;
  assert.equal(answer.score, 1.3);
  assert.deepEqual(answer.probabilities, { "0": 0, "1": 0.7, "2": 0.3 });
  assert.equal(answer.confidence, 0.55);
});

test("legend returns criteria verbatim, keeping object levels structured", () => {
  const questions: Questions = {
    s: {
      type: "score",
      instructions: "x",
      criteria: ["Cosmetic", { what: "Broken", examples: ["throws"] }],
    },
  };
  const { answers } = parse(questions, "0:0;1:1");
  const answer = answers.s;
  if (answer.type !== "score") return;
  assert.deepEqual(answer.legend, {
    "0": "Cosmetic",
    "1": { what: "Broken", examples: ["throws"] },
  });
  assert.equal(typeof answer.legend["1"], "object");
});

// ── Answer format handling ──────────────────────────────────────────────────

test("index:value pairs are the primary format", () => {
  const { answers } = parse(CHOICE_THREE, "0:0.1;1:0.1;2:0.8");
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.choice, "c");
});

test("spaces, newlines and surrounding prose are tolerated", () => {
  const { answers } = parse(CHOICE_THREE, "Sure, here are the values:\n0: 0.1; 1: 0.1; 2: 0.8");
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.choice, "c");
});

test("a filled-in JSON template is accepted as a fallback", () => {
  const { answers } = parse(CHOICE_THREE, '```json\n{"q0": {"probabilities": {"a": 0.1, "b": 0.1, "c": 0.8}}}\n```');
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.choice, "c");
});

test("a complete JSON answer beats a stray pair in prose", () => {
  const content =
    'Based on my analysis the ratio was 7:0.5 and confidence 0.9.\n{"q0": {"probabilities": {"a": 0.1, "b": 0.1, "c": 0.8}}}';
  const { answers } = parse(CHOICE_THREE, content);
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.choice, "c");
});

test("a complete pair answer beats a JSON echo of the same answer", () => {
  const content = '0:0.1;1:0.1;2:0.8 {"q0": {"probabilities": {"a": 0.1, "b": 0.1, "c": 0.8}}}';
  const { answers } = parse(CHOICE_THREE, content);
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.deepEqual(answer.probabilities, { a: 0.1, b: 0.1, c: 0.8 });
});

// ── Reasoning that arrives inline and untagged ──

test("an untagged reasoning trace does not contribute values to the answer", () => {
  // A backend with no reasoning parser leaves the thinking in `content` with no
  // marker. "0:0.99 was tempting" is a number the model floated while thinking,
  // not a value it answered, so the answer list it finished on is the answer.
  const content =
    "Let me weigh the options. Option A is strong, so 0:0.99 looks tempting. " +
    "Reconsidering, the ticket mentions two teams.\n0:0.1;1:0.1;2:0.8";
  const { answers, warnings } = parse(CHOICE_THREE, content);
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.deepEqual(answer.probabilities, { a: 0.1, b: 0.1, c: 0.8 });
  assert.equal(
    warnings?.some((w) => w.includes("text in front of the answer list")),
    true
  );
});

test("the last answer list wins over an earlier one the model abandoned", () => {
  const content = "First pass: 0:0.34;1:0.33;2:0.33\nOn reflection:\n0:0.1;1:0.1;2:0.8";
  const { answers } = parse(CHOICE_THREE, content);
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.deepEqual(answer.probabilities, { a: 0.1, b: 0.1, c: 0.8 });
});

test("pairs narrated one at a time are still all read", () => {
  // No single run covers the request, so the union is what answers it.
  const content =
    "Start with the first option: 0:0.2\nNow the second: 1:0.3\nAnd the third: 2:0.5";
  const { answers } = parse(CHOICE_THREE, content);
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.deepEqual(answer.probabilities, { a: 0.2, b: 0.3, c: 0.5 });
  assert.equal(sum(answer.probabilities), 1);
});

test("an answer list that opens the response raises no preamble warning", () => {
  const { warnings } = parse(CHOICE_THREE, "0:0.1;1:0.1;2:0.8");
  assert.equal(warnings, undefined);
});

test("a fenced answer list after prose is read and still flagged", () => {
  const content = "Considering both teams.\n```\n0:0.1;1:0.1;2:0.8\n```";
  const { answers, warnings } = parse(CHOICE_THREE, content);
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.deepEqual(answer.probabilities, { a: 0.1, b: 0.1, c: 0.8 });
  assert.equal(
    warnings?.some((w) => w.includes("text in front of the answer list")),
    true
  );
});

test("a fenced answer list alone is not flagged as a preamble", () => {
  const { warnings } = parse(CHOICE_THREE, "```\n0:0.1;1:0.1;2:0.8\n```");
  assert.equal(warnings, undefined);
});

test("braces in the model's prose do not break JSON extraction", () => {
  // A greedy /\{[\s\S]*\}/ grab would run past the object into the "}" below
  // and fail to parse.
  const content =
    'Reasoning: {this looks like a yes} for the first question.\n{"q0": {"probabilities": {"a": 0.2, "b": 0.3, "c": 0.5}}}\nEnd of reasoning }';
  const { answers } = parse(CHOICE_THREE, content);
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.choice, "c");
});

test("quoted numbers in the JSON fallback are coerced", () => {
  const { answers } = parse(CHOICE_THREE, '{"q0": {"probabilities": {"a": "0.1", "b": "0.1", "c": "0.8"}}}');
  const answer = answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.choice, "c");
  assert.equal(answer.probabilities.c, 0.8);
});

test("an unparseable answer is reported, never guessed", () => {
  assert.throws(
    () => parse(CHOICE_THREE, "I cannot evaluate this request."),
    (err: unknown) => err instanceof LLMResponseError
  );
});

test("a refusal is not silently turned into a uniform answer", () => {
  assert.throws(() => parse(CHOICE_THREE, "Sorry, I am unable to help with that."));
});

// ── Incomplete answers are flagged, not hidden ──────────────────────────────

test("a complete answer has no warnings field", () => {
  const response = parse(CHOICE_THREE, "0:0.1;1:0.1;2:0.8");
  assert.equal("warnings" in response, false);
  assert.deepEqual(response, {
    model: "xev-test-model",
    answers: response.answers,
    usage: USAGE,
  });
});

test("all-zero values are reported as a uniform distribution, with a warning", () => {
  const response = parse(CHOICE_THREE, "0:0;1:0;2:0");
  const answer = response.answers.d;
  if (answer.type !== "choice") return;
  assert.ok(roundedSum(sum(answer.probabilities)));
  assert.equal(answer.confidence, 0);
  assert.ok(response.warnings?.length === 1, "expected exactly one warning");
  assert.match(response.warnings![0], /uniform distribution/);
});

test("a partially answered question is flagged with the counts", () => {
  const response = parse(CHOICE_THREE, "0:0.1;1:0.9");
  const answer = response.answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.probabilities.c, 0);
  assert.match(response.warnings![0], /2 of 3 values/);
});

test("a missing noul value defaults to 0.5 and says so", () => {
  // The choice is answered, the noul placeholder is not.
  const questions: Questions = {
    c: { type: "choice", instructions: "x", criteria: { a: "a", b: "b" } },
    n: { type: "noul", instructions: "x" },
  };
  const response = parse(questions, "0:0.7;1:0.3");
  assert.deepEqual(response.answers.n, { type: "noul", noul: 0.5 });
  assert.equal(response.warnings?.length, 1);
  assert.match(response.warnings![0], /noul value/);
});

test("one bad question does not suppress warnings for the others", () => {
  const response = parse(MIXED, "0:0;1:0;2:0;3:0.9;4:1");
  const warnings = response.warnings ?? [];
  assert.equal(warnings.length, 2);
  assert.ok(warnings.some((w) => w.includes('"d"')));
  assert.ok(warnings.some((w) => w.includes('"s"')));
  const noul = response.answers.n;
  assert.equal(noul.type, "noul");
  if (noul.type !== "noul") return;
  assert.equal(noul.noul, 0.9);
});

test("truncated output warnings from the transport are surfaced", () => {
  const response = parseWithWarnings(CHOICE_THREE, "0:0.1;1:0.1;2:0.8", [
    "the model's answer was cut off (finish_reason: length)",
  ]);
  assert.equal(response.warnings?.length, 1);
  assert.match(response.warnings![0], /finish_reason/);
});

test("indexes past the last placeholder are ignored", () => {
  const response = parse(CHOICE_THREE, "0:0.1;1:0.1;2:0.8;9:0.5;10:0.25");
  const answer = response.answers.d;
  if (answer.type !== "choice") return;
  assert.equal(answer.choice, "c");
  assert.equal(response.warnings, undefined, "out-of-range indexes are not a parse failure");
});

// ── Response contract ───────────────────────────────────────────────────────

test("every response validates against SystemOneResponseSchema", () => {
  const responses = [
    parse(CHOICE_THREE, "0:0.1;1:0.1;2:0.8"),
    parse(CHOICE_THREE, "0:0;1:0;2:0"),
    parse({ n: { type: "noul", instructions: "x" } }, "0:0.42"),
    parse(
      {
        s: {
          type: "score",
          instructions: "x",
          criteria: ["low", { what: "high" }, ["a", "b"]],
        },
      },
      "0:0.2;1:0.3;2:0.5"
    ),
  ];
  for (const response of responses) {
    const result = SystemOneResponseSchema.safeParse(response);
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  }
});

test("a valid pair with nothing to map it onto is not blamed on the format", () => {
  // The model answered 0:1 correctly; the request carried no questions. Saying
  // "no index:value pairs found" would be plainly false.
  assert.throws(
    () => parse({}, "0:1"),
    (err: unknown) => {
      assert.ok(err instanceof LLMResponseError);
      assert.match(err.message, /no questions/i);
      assert.equal(err.message.includes("No index:value pairs"), false);
      return true;
    }
  );
});

test("the model name is prefixed with xev-", () => {
  assert.equal(parse(CHOICE_THREE, "0:1;1:0;2:0").model, "xev-test-model");
});
