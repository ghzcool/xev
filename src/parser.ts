import type {
  Question,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
  Answer,
  NoulAnswer,
  ChoiceAnswer,
  ScoreAnswer,
  LLMRawOutput,
  SystemOneResponse,
} from "./types";

function computeConfidence(probabilities: Record<string, number>): number {
  const values = Object.values(probabilities);
  if (values.length === 0) return 0;
  const max = Math.max(...values);
  // Confidence: 1.0 when all probability on one option, lower when spread out
  // Uses entropy-based approach: confidence = 1 - normalized_entropy
  const entropy = values.reduce((sum, p) => {
    if (p <= 0) return sum;
    return sum - p * Math.log2(p);
  }, 0);
  const maxEntropy = Math.log2(values.length);
  if (maxEntropy === 0) return 1;
  return Math.round((1 - entropy / maxEntropy) * 100) / 100;
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
  const noul = typeof entry.noul === "number" ? entry.noul : 0.5;
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
    probs[key] = typeof entry.probabilities[key] === "number" ? entry.probabilities[key] : 0;
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
    probs[String(i)] =
      typeof entry.probabilities[String(i)] === "number"
        ? entry.probabilities[String(i)]
        : 0;
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

export function parseResponse(
  questions: Record<string, Question>,
  raw: LLMRawOutput,
  model: string,
  usage: { input_tokens: number; output_tokens: number }
): SystemOneResponse {
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
