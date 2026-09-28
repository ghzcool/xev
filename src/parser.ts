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
// that the response reports: a raw peak of 0.745 across 3 options reports a
// probability of 0.75 but a confidence of 0.62, not the 0.63 that rescaling
// the rounded peak would give.
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
function clampProbabilities(
  probabilities: Record<string, number>
): Record<string, number> {
  const clamped: Record<string, number> = {};
  for (const [key, val] of Object.entries(probabilities)) {
    clamped[key] = Number.isFinite(val) && val > 0 ? val : 0;
  }
  return clamped;
}

function totalOf(probabilities: Record<string, number>): number {
  return Object.values(probabilities).reduce((s, v) => s + v, 0);
}

function normalizeProbabilities(
  probabilities: Record<string, number>
): Record<string, number> {
  const clamped = clampProbabilities(probabilities);
  const total = totalOf(clamped);
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
  const entries = Object.entries(probabilities);
  if (entries.length === 0) return "";
  // Ties keep the first key, matching criteria order.
  return entries.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

// How much of the answer the model actually gave us, per question. A missing
// value is indistinguishable from a real answer once probabilities are
// normalized, so this is what drives the `warnings` on the response.
interface QuestionCoverage {
  questionId: string;
  answered: number;
  expected: number;
}

function coverageByQuestion(
  raw: LLMRawOutput,
  questions: Record<string, Question>
): QuestionCoverage[] {
  const byQuestion = new Map<string, QuestionCoverage>();
  for (const placeholder of buildPlaceholderMap(questions)) {
    const cover = byQuestion.get(placeholder.questionId) ?? {
      questionId: placeholder.questionId,
      answered: 0,
      expected: 0,
    };
    cover.expected += 1;
    const entry = raw[placeholder.questionId];
    const value =
      placeholder.field === "noul"
        ? entry?.noul
        : entry?.probabilities?.[placeholder.key];
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
      cover.answered += 1;
    }
    byQuestion.set(placeholder.questionId, cover);
  }
  return [...byQuestion.values()];
}

function totalAnswered(covers: QuestionCoverage[]): number {
  return covers.reduce((sum, c) => sum + c.answered, 0);
}

interface ParsedAnswer<T> {
  answer: T;
  // The model returned nothing usable for this question (all values missing or
  // zero), so the distribution below is uniform rather than earned.
  degenerate: boolean;
}

function parseNoul(id: string, _q: NoulQuestion, raw: LLMRawOutput): ParsedAnswer<NoulAnswer> {
  const entry = raw[id];
  const value = entry?.noul;
  if (value === undefined || value === null || !Number.isFinite(Number(value))) {
    return { answer: { type: "noul", noul: 0.5 }, degenerate: true };
  }
  return {
    answer: { type: "noul", noul: round2(clamp01(toNum(value))) },
    degenerate: false,
  };
}

function parseChoice(
  id: string,
  q: ChoiceQuestion,
  raw: LLMRawOutput
): ParsedAnswer<ChoiceAnswer> {
  const entry = raw[id];
  const optionKeys = Object.keys(q.criteria);

  const probs: Record<string, number> = {};
  for (const key of optionKeys) {
    probs[key] = entry?.probabilities ? toNum(entry.probabilities[key]) : 0;
  }

  // No usable numbers at all: the uniform distribution below is a placeholder,
  // not an answer, and confidence 0 is the only honest signal we have.
  const degenerate = totalOf(clampProbabilities(probs)) === 0;
  const normalized = normalizeProbabilities(probs);

  return {
    answer: {
      type: "choice",
      choice: argmax(normalized),
      probabilities: toTwoDecimals(normalized),
      confidence: computeConfidence(normalized),
    },
    degenerate,
  };
}

function parseScore(
  id: string,
  q: ScoreQuestion,
  raw: LLMRawOutput
): ParsedAnswer<ScoreAnswer> {
  const entry = raw[id];
  const levelCount = q.criteria.length;

  const probs: Record<string, number> = {};
  for (let i = 0; i < levelCount; i++) {
    probs[String(i)] = entry?.probabilities ? toNum(entry.probabilities[String(i)]) : 0;
  }

  const degenerate = totalOf(clampProbabilities(probs)) === 0;
  const normalized = normalizeProbabilities(probs);

  let score = 0;
  for (let i = 0; i < levelCount; i++) {
    score += i * (normalized[String(i)] || 0);
  }

  return {
    answer: {
      type: "score",
      score: round2(score),
      legend: buildLegend(q),
      probabilities: toTwoDecimals(normalized),
      confidence: computeConfidence(normalized),
    },
    degenerate,
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

// Fallback for LLMs that answer with the JSON template filled in.
// Returns the index of the `}` that closes the `{` at `start`, ignoring braces
// inside strings, or -1 if the object never closes.
function findObjectEnd(content: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Every balanced `{...}` block in the response. A greedy /\{[\s\S]*\}/ grab
// breaks on the first stray brace in the model's prose.
function extractJsonObjects(content: string): string[] {
  const objects: string[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "{") continue;
    const end = findObjectEnd(content, i);
    if (end === -1) continue;
    objects.push(content.slice(i, end + 1));
    i = end;
  }
  return objects;
}

function parseJsonObjects(content: string): LLMRawOutput[] {
  const parsed: LLMRawOutput[] = [];
  for (const object of extractJsonObjects(content)) {
    try {
      parsed.push(JSON.parse(object) as LLMRawOutput);
    } catch {
      // Not a valid object on its own; try the next one.
    }
  }
  return parsed;
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

// Primary format is index:value pairs, JSON is the fallback. Both are parsed
// and the one that answered more placeholders wins, so a stray `3: 0.5` in the
// model's prose cannot beat a complete JSON answer.
function parseContent(
  content: string,
  questions: Record<string, Question>
): { raw: LLMRawOutput; source: "pairs" | "json" } {
  const candidates: { raw: LLMRawOutput; source: "pairs" | "json" }[] = [];

  const values = parseValuePairs(content);
  if (Object.keys(values).length > 0) {
    candidates.push({ raw: rawFromValues(values, questions), source: "pairs" });
  }
  for (const object of parseJsonObjects(content)) {
    const remapped = remapAliases(object, buildAliasMap(questions));
    if (Object.keys(remapped).length > 0) {
      candidates.push({ raw: remapped, source: "json" });
    }
  }

  let best: { raw: LLMRawOutput; source: "pairs" | "json" } | undefined;
  let bestAnswered = 0;
  for (const candidate of candidates) {
    const answered = totalAnswered(coverageByQuestion(candidate.raw, questions));
    if (answered > bestAnswered) {
      best = candidate;
      bestAnswered = answered;
    }
  }

  if (best && bestAnswered > 0) return best;

  // Pairs were parsed but there was nothing to map them onto, which means the
  // request carried no question values. Saying "no pairs found" here would be
  // plainly false: the model answered correctly, we had nowhere to put it.
  if (candidates.length > 0) {
    throw new LLMResponseError(
      buildPlaceholderMap(questions).length === 0
        ? "The request contained no questions, so the model's answer could not be mapped onto anything"
        : `The model's answer did not match any placeholder: ${content.slice(0, 200)}`
    );
  }

  throw new LLMResponseError(
    `No index:value pairs or JSON object found in LLM response: ${content.slice(0, 200)}`
  );
}

// Thrown when the model's answer cannot be understood at all. The request was
// valid, so callers map this to 502 (bad gateway), not 500.
export class LLMResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMResponseError";
  }
}

export interface ParseOptions {
  // Warnings from the transport layer (truncated output, retries) that the
  // parser cannot see but the caller should report alongside parse warnings.
  warnings?: string[];
}

export function parseResponse(
  questions: Record<string, Question>,
  content: string,
  model: string,
  usage: { input_tokens: number; output_tokens: number },
  options: ParseOptions = {}
): SystemOneResponse {
  const { raw, source } = parseContent(content, questions);
  const covers = coverageByQuestion(raw, questions);
  const coverFor = (id: string) => covers.find((c) => c.questionId === id);

  const answers: Record<string, Answer> = {};
  const warnings: string[] = [...(options.warnings ?? [])];

  for (const [id, q] of Object.entries(questions)) {
    const cover = coverFor(id);
    const missing = !cover || cover.answered === 0;
    const partial = !!cover && cover.answered > 0 && cover.answered < cover.expected;

    if (q.type === "noul") {
      const parsed = parseNoul(id, q, raw);
      answers[id] = parsed.answer;
      if (missing || parsed.degenerate) {
        warnings.push(
          `question "${id}": the model returned no usable noul value; defaulted to 0.5`
        );
      }
      continue;
    }

    const parsed = q.type === "choice" ? parseChoice(id, q, raw) : parseScore(id, q, raw);
    answers[id] = parsed.answer;

    if (missing) {
      warnings.push(
        `question "${id}": the model returned no usable values; answered with a uniform distribution (confidence 0)`
      );
    } else if (parsed.degenerate) {
      warnings.push(
        `question "${id}": every value the model returned was 0; answered with a uniform distribution (confidence 0)`
      );
    } else if (partial && cover) {
      warnings.push(
        `question "${id}": the model answered ${cover.answered} of ${cover.expected} values; the rest were filled in`
      );
    }
  }

  if (warnings.length > 0) {
    console.warn(
      `xev: ${warnings.length} warning(s) while parsing a "${source}" answer: ${warnings.join("; ")}`
    );
  }

  return {
    model: `xev-${model}`,
    answers,
    usage,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
