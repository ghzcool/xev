import type {
  Image,
  Instructions,
  Question,
  Placeholder,
} from "./types";

// One entry per question, in request order. `alias` is what the prompt and the
// response template use instead of the caller's question id: Jev never sends
// question ids to the model, so neither does xev.
export interface QuestionBinding {
  alias: string;
  questionId: string;
  question: Question;
}

export function bindQuestions(
  questions: Record<string, Question>
): QuestionBinding[] {
  return Object.entries(questions).map(([questionId, question], index) => ({
    alias: `q${index}`,
    questionId,
    question,
  }));
}

// Maps template key ("q0") back to the caller's question id, for the JSON
// fallback where the model answers with the template filled in.
export function buildAliasMap(
  questions: Record<string, Question>
): Map<string, string> {
  const map = new Map<string, string>();
  for (const binding of bindQuestions(questions)) {
    map.set(binding.alias, binding.questionId);
  }
  return map;
}

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
        // A validated request never reaches here with a null value (the schema
        // copies the option name in), so this only covers a direct call.
        if (val === null) return `  - "${key}": ${key}`;
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

function questionToPrompt(binding: QuestionBinding): string {
  const q = binding.question;
  const instructions = serializeInstructions(q.instructions);
  let prompt = `Question ${binding.alias}\nType: ${q.type}\nInstructions: ${instructions}`;

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

function buildTemplate(
  bindings: QuestionBinding[],
  questions: Record<string, Question>
): string {
  const map = buildPlaceholderMap(questions);

  // Group the flat placeholder list per question, keeping global indices.
  const groups: { questionId: string; entries: { key: string; index: number }[]; noul?: number }[] = [];
  map.forEach((placeholder, index) => {
    let group = groups[groups.length - 1];
    if (!group || group.questionId !== placeholder.questionId) {
      group = { questionId: placeholder.questionId, entries: [] };
      groups.push(group);
    }
    if (placeholder.field === "noul") {
      group.noul = index;
      return;
    }
    group.entries.push({ key: placeholder.key, index });
  });

  const template: Record<string, Record<string, unknown>> = {};
  bindings.forEach((binding, i) => {
    const group = groups[i];
    if (!group) return;
    if (binding.question.type === "noul") {
      template[binding.alias] = { noul: "${" + (group.noul ?? 0) + "}" };
      return;
    }
    const probabilities: Record<string, unknown> = {};
    for (const entry of group.entries) {
      probabilities[entry.key] = "${" + entry.index + "}";
    }
    template[binding.alias] = { probabilities };
  });

  // Unquote the `${index}` tokens so they read as placeholders, not JSON strings
  return JSON.stringify(template, null, 2).replace(/"(\$\{\d+\})"/g, "$1");
}

/**
 * The block that makes an attached image part of the STATE rather than an
 * afterthought. Without it the model treats the picture as context and answers
 * from the text alone, which is the failure this exists to prevent.
 *
 * `alt` labels are numbered the way the images arrive, so a question can say
 * "image 2" and mean one thing.
 */
function imageNotice(images: Image[]): string {
  const count = images.length;
  const labels = images
    .map((image, i) => (image.alt ? `${i + 1} = "${image.alt}"` : null))
    .filter((label): label is string => label !== null);

  return `IMAGES:
${count} image${count === 1 ? " is" : "s are"} attached to this message${labels.length ? `, labelled ${labels.join(", ")}` : ""}, and ${count === 1 ? "is" : "are"} part of the STATE - not separate context.
Read every image before answering: transcribe any text, numbers, labels, and error messages you can see, note what state the UI is in, and weigh all of it together with the STATE above when answering each QUESTION. If the text and an image disagree, the image wins, since it is what the user actually saw.`;
}

export function buildPrompt(
  state: string | Record<string, unknown> | unknown[],
  questions: Record<string, Question>,
  images: Image[] = []
): string {
  const stateStr =
    typeof state === "string" ? state : JSON.stringify(state, null, 2);

  const bindings = bindQuestions(questions);

  const questionPrompts = bindings
    .map((binding) => questionToPrompt(binding))
    .join("\n\n---\n\n");

  const template = buildTemplate(bindings, questions);

  const imageBlock = images.length > 0 ? `\n\n${imageNotice(images)}` : "";

  return `You are a precise evaluation engine. Evaluate the STATE against each QUESTION.

RULES:
1. Return ONLY the answer list. No markdown, no code fences, no explanations.
2. Do not include your reasoning, analysis, planning, or any preamble. The list is the whole answer.
3. The answer list is a ";"-separated list of "index:value" pairs, one pair per placeholder. Example: 0:0.1;1:0.234;2:0;3:1
4. Answer every placeholder in the RESPONSE TEMPLATE below, each exactly once, in ascending index order.
5. Every value must be a bare number between 0.0 and 1.0. No quotes, no units, no text.
6. For Choice and Score questions, the values of that question MUST sum to exactly 1.0.
7. For Noul questions, the value is a single number between 0.0 (definitely no) and 1.0 (definitely yes).
8. Never answer 0 for every placeholder of a question. A question is always answered, so if the STATE supports none of its options, give the closest ones the weight instead of answering nothing.
9. Be precise. Do not split probability evenly unless truly uncertain.
10. The keys q0, q1, ... in the RESPONSE TEMPLATE are the questions listed above, in order: q0 is the first question, q1 the second, and so on.
11. Spend as few tokens as possible. Keep any deliberation to a minimum, then emit the list.

STATE:
${stateStr}${imageBlock}

QUESTIONS:
${questionPrompts}

RESPONSE TEMPLATE:
${template}

Return ONLY the values for the placeholders above, as index:value pairs separated by ";". Do not return the template itself.`;
}
