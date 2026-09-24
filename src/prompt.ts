import type {
  Instructions,
  Question,
  NoulQuestion,
  ChoiceQuestion,
  ScoreQuestion,
} from "./types";

function serializeInstructions(instructions: Instructions): string {
  if (typeof instructions === "string") return instructions;
  return JSON.stringify(instructions, null, 2);
}

function serializeCriteria(
  type: string,
  criteria: unknown
): string {
  if (type === "choice") {
    const entries = Object.entries(criteria as Record<string, unknown>).map(
      ([key, val]) => {
        if (val === null) return `  - "${key}": (no description)`;
        if (typeof val === "string") return `  - "${key}": ${val}`;
        return `  - "${key}": ${JSON.stringify(val)}`;
      }
    );
    return entries.join("\n");
  }
  if (type === "score") {
    return (criteria as unknown[])
      .map((level, i) => {
        if (typeof level === "string") return `  ${i}: ${level}`;
        return `  ${i}: ${JSON.stringify(level)}`;
      })
      .join("\n");
  }
  return "";
}

function questionToPrompt(id: string, q: Question): string {
  const instructions = serializeInstructions(q.instructions);
  let prompt = `Question ID: "${id}"\nType: ${q.type}\nInstructions: ${instructions}`;

  if (q.type === "choice") {
    prompt += `\nOptions:\n${serializeCriteria("choice", q.criteria)}`;
    prompt += `\nReturn a probability (0.0 to 1.0) for EACH option. Probabilities must sum to 1.0.`;
  } else if (q.type === "score") {
    prompt += `\nLevels:\n${serializeCriteria("score", q.criteria)}`;
    prompt += `\nReturn a probability (0.0 to 1.0) for EACH level. Probabilities must sum to 1.0.`;
  } else if (q.type === "noul") {
    if (q.criteria) {
      if (q.criteria.true)
        prompt += `\nWhat "yes" (1.0) means: ${serializeInstructions(q.criteria.true as Instructions)}`;
      if (q.criteria.false)
        prompt += `\nWhat "no" (0.0) means: ${serializeInstructions(q.criteria.false as Instructions)}`;
    }
    prompt += `\nReturn a single number from 0.0 (definitely no) to 1.0 (definitely yes).`;
  }

  return prompt;
}

export function buildPrompt(
  state: string | Record<string, unknown> | unknown[],
  questions: Record<string, Question>
): string {
  const stateStr =
    typeof state === "string" ? state : JSON.stringify(state, null, 2);

  const questionPrompts = Object.entries(questions)
    .map(([id, q]) => questionToPrompt(id, q))
    .join("\n\n---\n\n");

  // Build expected JSON keys for the LLM output
  const expectedKeys: Record<string, string> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      expectedKeys[id] = `{"probabilities": {${Object.keys(q.criteria)
        .map((k) => `"${k}": <number>`)
        .join(", ")}}}`;
    } else if (q.type === "score") {
      expectedKeys[id] = `{"probabilities": {${q.criteria
        .map((_, i) => `"${i}": <number>`)
        .join(", ")}}}`;
    } else {
      expectedKeys[id] = `{"noul": <number 0-1>}`;
    }
  }

  return `You are a precise evaluation engine. Your task is to evaluate the given STATE against a set of questions and return ONLY a JSON object with your answers.

RULES:
1. Return ONLY valid JSON, no markdown, no explanations, no code fences.
2. Every probability must be between 0.0 and 1.0.
3. For Choice and Score questions, probabilities for ALL options/levels MUST sum to exactly 1.0.
4. For Noul questions, return a single number between 0.0 and 1.0.
5. Be precise and decisive. Avoid splitting probability evenly unless truly uncertain.

STATE:
${stateStr}

QUESTIONS:
${questionPrompts}

Return a JSON object with exactly these keys and structure:
${JSON.stringify(expectedKeys, null, 2)}`;
}
