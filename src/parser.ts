import type {
  Question,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  Answer,
  NoulAnswer,
  ChoiceAnswer,
  ScoreAnswer,
  LLMValues,
  LLMRawOutput,
  SystemOneResponse,
} from "./types";
import { buildPlaceholderMap } from "./prompt";

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (!isNaN(n)) return n;
  }
  return 0;
}

function computeConfidence(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities);
  const count = values.length;
  if (count === 0) return 0;
  if (count === 1) return 1;
  // Jev/TypeSafe: confidence = clamp01((n * max_probability - 1) / (n - 1))
  const peak = Math.max(...values);
  const confidence = (count * peak - 1) / (count - 1);
  return Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;
}

function normalizeProbabilities(
  probabilities: Record<string, number>
): Record<string, number> {
  const total = Object.values(probabilities).reduce((s, v) => s + v, 0);
  if (total === 0) return probabilities;
  const normalized: Record<string, number> = {};
  for (const [key, val] of Object.entries(probabilities)) {
    normalized[key] = Math.round((val / total) * 10000) / 10000;
  }
  // Fix floating point: ensure sum is exactly 1
  const diff = 1 - Object.values(normalized).reduce((s, v) => s + v, 0);
  const keys = Object.keys(normalized);
  if (keys.length > 0 && Math.abs(diff) > 0.0001) {
    normalized[keys[0]] = Math.round((normalized[keys[0]] + diff) * 10000) / 10000;
  }
  return normalized;
}

function parseNoul(
  id: string,
  q: NoulQuestion,
  raw: LLMRawOutput
): NoulAnswer {
  const entry = raw[id];
  if (!entry) {
    return { type: "noul", noul: 0.5 };
  }
  const noul = toNum(entry.noul);
  return {
    type: "noul",
    noul: Math.round(Math.max(0, Math.min(1, noul)) * 100) / 100,
  };
}

function parseChoice(
  id: string,
  q: ChoiceQuestion,
  raw: LLMRawOutput
): ChoiceAnswer {
  const entry = raw[id];
  const optionKeys = Object.keys(q.criteria);

  if (!entry?.probabilities) {
    // Fallback: equal probability
    const probs: Record<string, number> = {};
    optionKeys.forEach((k) => (probs[k] = 1 / optionKeys.length));
    return {
      type: "choice",
      choice: optionKeys[0],
      probabilities: probs,
      confidence: 0,
    };
  }

  // Ensure all options have a probability
  const probs: Record<string, number> = {};
  for (const key of optionKeys) {
    probs[key] = toNum(entry.probabilities[key]);
  }

  const normalized = normalizeProbabilities(probs);
  const choice = Object.entries(normalized).reduce((a, b) =>
    b[1] > a[1] ? b : a
  )[0];

  return {
    type: "choice",
    choice,
    probabilities: normalized,
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

  if (!entry?.probabilities) {
    const probs: Record<string, number> = {};
    for (let i = 0; i < levelCount; i++) {
      probs[String(i)] = 1 / levelCount;
    }
    return {
      type: "score",
      score: (levelCount - 1) / 2,
      legend: buildLegend(q),
      probabilities: probs,
      confidence: 0,
    };
  }

  const probs: Record<string, number> = {};
  for (let i = 0; i < levelCount; i++) {
    probs[String(i)] = toNum(entry.probabilities[String(i)]);
  }

  const normalized = normalizeProbabilities(probs);

  // Calculate weighted score
  let score = 0;
  for (let i = 0; i < levelCount; i++) {
    score += i * (normalized[String(i)] || 0);
  }
  score = Math.round(score * 100) / 100;

  return {
    type: "score",
    score,
    legend: buildLegend(q),
    probabilities: normalized,
    confidence: computeConfidence(normalized),
  };
}

function buildLegend(q: ScoreQuestion): Record<string, string> {
  const legend: Record<string, string> = {};
  q.criteria.forEach((level, i) => {
    legend[String(i)] =
      typeof level === "string" ? level : JSON.stringify(level);
  });
  return legend;
}

// Parses the answer list: `0:0.1;1:0.234;2:0;3:1`
function parseValuePairs(content: string): LLMValues {
  const values: LLMValues = {};
  for (const match of content.matchAll(/(\d+)\s*:\s*(-?\d+(?:\.\d+)?)/g)) {
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

export function parseResponse(
  questions: Record<string, Question>,
  content: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number }
): SystemOneResponse {
  let raw: LLMRawOutput;
  if (/\{[\s\S]*\}/.test(content)) {
    raw = parseJson(content);
  } else {
    raw = rawFromValues(parseValuePairs(content), questions);
    if (Object.keys(raw).length === 0) {
      throw new Error(
        `No index:value pairs found in LLM response: ${content.slice(0, 200)}`
      );
    }
  }

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
