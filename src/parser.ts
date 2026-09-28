import type {
  Question,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  Answer,
  NoulAnswer,
  ChoiceAnswer,
  ScoreAnswer,
  Description,
  LLMValues,
  LLMRawOutput,
  SystemOneResponse,
} from "./types";
import { buildPlaceholderMap, buildAliasMap } from "./prompt";

const HUNDREDTHS = 100;

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (!isNaN(n)) return n;
  }
  return 0;
}

function round2(n: number): number {
  return Math.round(n * HUNDREDTHS) / HUNDREDTHS;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Jev: confidence = clamp01((n * max_probability - 1) / (n - 1)).
// Computed on the full-precision distribution, before the 2-decimal rounding
// that the response reports, so it matches Jev's own rounding (e.g. a raw
// peak of 0.7399 reports probabilities 0.74 but confidence 0.67).
function computeConfidence(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities);
  const count = values.length;
  if (count === 0) return 0;
  if (count === 1) return 1;
  const peak = Math.max(...values);
  return round2(clamp01((count * peak - 1) / (count - 1)));
}

// Brings the LLM's numbers to a distribution that sums to exactly 1.
// Negative and non-finite values become 0; an all-zero answer becomes uniform.
function normalizeProbabilities(
  probabilities: Record<string, number>
): Record<string, number> {
  const clamped: Record<string, number> = {};
  for (const [key, val] of Object.entries(probabilities)) {
    clamped[key] = Number.isFinite(val) && val > 0 ? val : 0;
  }

  const total = Object.values(clamped).reduce((s, v) => s + v, 0);
  const keys = Object.keys(clamped);

  if (total === 0) {
    const uniform: Record<string, number> = {};
    keys.forEach((k) => (uniform[k] = keys.length > 0 ? 1 / keys.length : 0));
    return uniform;
  }

  const normalized: Record<string, number> = {};
  for (const [key, val] of Object.entries(clamped)) {
    normalized[key] = val / total;
  }
  return normalized;
}

// Jev reports probabilities with 2 decimals that still sum to exactly 1.
// Largest-remainder rounding: floor every value to cents, then hand the
// leftover cents to the biggest fractional parts, so the result stays as close
// as possible to the full-precision values.
function toTwoDecimals(probabilities: Record<string, number>): Record<string, number> {
  const cents: Record<string, number> = {};
  const remainders: { key: string; frac: number }[] = [];
  let assigned = 0;

  for (const [key, val] of Object.entries(probabilities)) {
    const exact = val * HUNDREDTHS;
    const floored = Math.floor(exact + 1e-9);
    cents[key] = floored;
    assigned += floored;
    remainders.push({ key, frac: exact - floored });
  }

  let leftover = HUNDREDTHS - assigned;
  remainders.sort((a, b) => b.frac - a.frac);
  for (const { key } of remainders) {
    if (leftover <= 0) break;
    cents[key] += 1;
    leftover -= 1;
  }

  const rounded: Record<string, number> = {};
  for (const [key, val] of Object.entries(cents)) {
    rounded[key] = val / HUNDREDTHS;
  }
  return rounded;
}

function argmax(probabilities: Record<string, number>): string {
  return Object.entries(probabilities).reduce((a, b) =>
    b[1] > a[1] ? b : a
  )[0];
}

function parseNoul(
  _id: string,
  _q: NoulQuestion,
  raw: LLMRawOutput
): NoulAnswer {
  const entry = raw[_id];
  if (!entry || entry.noul === undefined) {
    return { type: "noul", noul: 0.5 };
  }
  return {
    type: "noul",
    noul: round2(clamp01(toNum(entry.noul))),
  };
}

function parseChoice(
  id: string,
  q: ChoiceQuestion,
  raw: LLMRawOutput
): ChoiceAnswer {
  const entry = raw[id];
  const optionKeys = Object.keys(q.criteria);

  // Missing options and a missing answer both fall through: an all-zero
  // distribution normalizes to uniform, confidence 0, first option winning.
  const probs: Record<string, number> = {};
  for (const key of optionKeys) {
    probs[key] = entry?.probabilities ? toNum(entry.probabilities[key]) : 0;
  }

  const normalized = normalizeProbabilities(probs);

  return {
    type: "choice",
    choice: argmax(normalized),
    probabilities: toTwoDecimals(normalized),
    confidence: computeConfidence(normalized),
  };
}

function parseScore(
  id: string,
  q: ScoreQuestion,
  raw: LLMRawOutput
): ScoreAnswer {
  const entry = raw[id];
  const levelCount = q.criteria.length;

  const probs: Record<string, number> = {};
  for (let i = 0; i < levelCount; i++) {
    probs[String(i)] = entry?.probabilities ? toNum(entry.probabilities[String(i)]) : 0;
  }

  const normalized = normalizeProbabilities(probs);

  let score = 0;
  for (let i = 0; i < levelCount; i++) {
    score += i * (normalized[String(i)] || 0);
  }

  return {
    type: "score",
    score: round2(score),
    legend: buildLegend(q),
    probabilities: toTwoDecimals(normalized),
    confidence: computeConfidence(normalized),
  };
}

// Levels are returned exactly as they were given: strings stay strings, and
// object/array levels stay structured the way Jev returns them.
function buildLegend(q: ScoreQuestion): Record<string, Description> {
  const legend: Record<string, Description> = {};
  q.criteria.forEach((level, i) => {
    legend[String(i)] = level as Description;
  });
  return legend;
}

// Parses the answer list: `0:0.1;1:0.234;2:0;3:1`
function parseValuePairs(content: string): LLMValues {
  const values: LLMValues = {};
  const pattern = /(\d+)\s*:\s*(-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)/g;
  for (const match of content.matchAll(pattern)) {
    values[parseInt(match[1], 10)] = parseFloat(match[2]);
  }
  return values;
}

// Fallback for LLMs that answer with the JSON template filled in
function parseJson(content: string): LLMRawOutput {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in LLM response: ${content.slice(0, 200)}`);
  }
  try {
    return JSON.parse(jsonMatch[0]) as LLMRawOutput;
  } catch {
    throw new Error(`Invalid JSON in LLM response: ${jsonMatch[0].slice(0, 200)}`);
  }
}

// The response template keys questions as q0, q1, ... so the model never sees
// the caller's question ids (Jev does not send them either). Map them back.
function remapAliases(
  raw: LLMRawOutput,
  aliases: Map<string, string>
): LLMRawOutput {
  const remapped: LLMRawOutput = {};
  for (const [key, value] of Object.entries(raw)) {
    remapped[aliases.get(key) ?? key] = value;
  }
  return remapped;
}

// Maps placeholder values back onto question fields by placeholder index
function rawFromValues(
  values: LLMValues,
  questions: Record<string, Question>
): LLMRawOutput {
  const raw: LLMRawOutput = {};
  for (const [index, placeholder] of buildPlaceholderMap(questions).entries()) {
    const value = values[index];
    if (value === undefined) continue;
    if (placeholder.field === "noul") {
      raw[placeholder.questionId] = { noul: value };
      continue;
    }
    const entry =
      raw[placeholder.questionId] ?? (raw[placeholder.questionId] = {});
    if (!entry.probabilities) entry.probabilities = {};
    entry.probabilities[placeholder.key] = value;
  }
  return raw;
}

// Primary format is index:value pairs, JSON is the fallback.
function parseContent(
  content: string,
  questions: Record<string, Question>
): LLMRawOutput {
  const values = parseValuePairs(content);
  const fromPairs =
    Object.keys(values).length > 0 ? rawFromValues(values, questions) : {};
  if (Object.keys(fromPairs).length > 0) return fromPairs;

  if (/\{[\s\S]*\}/.test(content)) {
    const fromJson = remapAliases(parseJson(content), buildAliasMap(questions));
    if (Object.keys(fromJson).length > 0) return fromJson;
  }

  throw new Error(
    `No index:value pairs or JSON object found in LLM response: ${content.slice(0, 200)}`
  );
}

export function parseResponse(
  questions: Record<string, Question>,
  content: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number }
): SystemOneResponse {
  const raw = parseContent(content, questions);

  const answers: Record<string, Answer> = {};

  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      answers[id] = parseNoul(id, q, raw);
    } else if (q.type === "choice") {
      answers[id] = parseChoice(id, q, raw);
    } else if (q.type === "score") {
      answers[id] = parseScore(id, q, raw);
    }
  }

  return {
    model: `xev-${model}`,
    answers,
    usage,
  };
}
