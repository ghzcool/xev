import type {
  Instructions,
  Question,
  Placeholder,
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

// Assigns a sequential `${index}` to every value the LLM must answer.
// Index order: question order, then option/level order within a question.
export function buildPlaceholderMap(
  questions: Record<string, Question>
): Placeholder[] {
  const map: Placeholder[] = [];
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "choice") {
      for (const key of Object.keys(q.criteria)) {
        map.push({ questionId: id, field: "probabilities", key });
      }
    } else if (q.type === "score") {
      q.criteria.forEach((_, i) =>
        map.push({ questionId: id, field: "probabilities", key: String(i) })
      );
    } else {
      map.push({ questionId: id, field: "noul" });
    }
  }
  return map;
}

function buildTemplate(map: Placeholder[]): string {
  const template: Record<string, Record<string, unknown>> = {};
  for (const [index, placeholder] of map.entries()) {
    const value = "${" + index + "}";
    if (placeholder.field === "noul") {
      template[placeholder.questionId] = { noul: value };
      continue;
    }
    if (!template[placeholder.questionId]) {
      template[placeholder.questionId] = { probabilities: {} };
    }
    (template[placeholder.questionId].probabilities as Record<string, unknown>)[
      placeholder.key
    ] = value;
  }
  // Unquote the `${index}` tokens so they read as placeholders, not JSON strings
  return JSON.stringify(template, null, 2).replace(/"(\$\{\d+\})"/g, "$1");
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

  const template = buildTemplate(buildPlaceholderMap(questions));

  return `You are a precise evaluation engine. Evaluate the STATE against each QUESTION.

RULES:
1. Return ONLY the answer list. No markdown, no code fences, no explanations.
2. The answer list is a ";"-separated list of "index:value" pairs, one pair per placeholder. Example: 0:0.1;1:0.234;2:0;3:1
3. Answer every placeholder in the RESPONSE TEMPLATE below, each exactly once, in ascending index order.
4. Every value must be a bare number between 0.0 and 1.0. No quotes, no units, no text.
5. For Choice and Score questions, the values of that question MUST sum to exactly 1.0.
6. For Noul questions, the value is a single number between 0.0 (definitely no) and 1.0 (definitely yes).
7. Be precise. Do not split probability evenly unless truly uncertain.

STATE:
${stateStr}

QUESTIONS:
${questionPrompts}

RESPONSE TEMPLATE:
${template}

Return ONLY the values for the placeholders above, as index:value pairs separated by ";". Do not return the template itself.`;
}
