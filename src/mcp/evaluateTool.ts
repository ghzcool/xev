import { z } from "zod";
import { evaluate, type EvaluateOptions, type EvaluateOutcome } from "../evaluate";
import {
  ImageSchema,
  SystemOneResponseSchema,
  type Description,
  type SystemOneResponse,
} from "../types";

export const EVALUATE_TOOL_NAME = "xev_evaluate";

/**
 * The tool description is the only documentation a third-party model gets, so it
 * carries the full question contract: the JSON Schema stays permissive on
 * purpose, and `validateRequest` in `evaluate.ts` is what actually checks the
 * question shapes. That way the same rules and the same error messages apply
 * whether a request came in over HTTP or over MCP.
 */
export const EVALUATE_TOOL_DESCRIPTION = `Evaluate anything with an LLM and get structured answers back.

Send one piece of \`state\` (any text, or a JSON object/array describing it) plus a map of
\`questions\`. Every question in the map is answered in a SINGLE LLM call, so batch as many as
you need - splitting them across calls costs latency and money for no benefit. Question ids
are yours to choose; the model never sees them.

Optionally attach up to 8 \`images\` (a screenshot, a photo of a document, a rendered page). They
are evaluated as part of the \`state\`, not as extra context, so a question can be about what is
visible in one. This needs a vision-capable model, and base64 image data is expensive in your
context window - describe the image in \`state\` instead unless the picture genuinely carries
information the text does not.

Each question has a "type" and "instructions" (a string, or an object/array with more detail):

- "choice" — also needs "criteria": an object of optionKey -> what that option means
  (a string, object, or array). 1 to 255 options. Answers come back as the winning key plus a
  probability per option. Use this for "which category / who owns this / what should we do".
  An option may be given without a value ("what": null), in which case its key is used as its
  description; an option with an empty key is dropped.

- "score" — also needs "criteria": an ARRAY of 2 to 10 level descriptions, ordered lowest to
  highest. The index of a level is its value, so 4 levels mean the answer is 0 to 3. Answers
  come back as a 0-based number (the average of the level indices weighted by their
  probabilities, so it can be fractional), the legend you supplied, and a probability per level.
  Use this for "how urgent / how severe / how well does this meet the bar".

- "noul" — no criteria. Answers come back as a single 0 to 1 number: 0 means definitely no, 1
  means definitely yes. Use this for a plain yes/no.

"confidence" (0 to 1) is a rescaled measure of how clearly the top answer won, not how correct it
is. A low confidence means the options were close, not that the answer is wrong.

\`warnings\` appears only when the model did not fully answer: a truncated answer, a question it
skipped, or a reasoning trace leaking in. Always read it - the numbers in a warned response may
have been filled in rather than decided.`;

const QUESTIONS_DESCRIPTION = `Map of question id -> question, where a question is:
  { "type": "choice", "instructions": "...", "criteria": { "optionKey": "what it means", ... } }
  { "type": "score",  "instructions": "...", "criteria": ["level 0", "level 1", ...] }
  { "type": "noul",   "instructions": "..." }
At least one question is required. "instructions" may also be an object or an array for extra
detail. Choice accepts 1-255 options; score accepts 2-10 levels. A choice option given as
"optionKey": null is described by its own key, and an option with an empty key is dropped.`;

const STATE_DESCRIPTION = `The thing being evaluated. A string (e.g. a support ticket, a diff, a
paragraph) or a JSON object/array with whatever context the questions need. Keep it focused:
it goes into the prompt verbatim and a bloated state degrades the answers.`;

/**
 * Deliberately permissive on the question shapes. See EVALUATE_TOOL_DESCRIPTION:
 * the precise contract is documented in prose and enforced once, by
 * `validateRequest`. Declaring the question schemas here would mean two validators
 * with two sets of error messages, and the zod union error for a wrong question
 * type is a JSON dump an agent cannot act on.
 *
 * `state` is the exception: it is a flat union of three types, it matches the API
 * contract exactly, and typing it that way puts it in the schema's `required` list.
 * `z.unknown()` would validate anything but land in the optional set, which leaves
 * strict tool-calling clients free to send a request with no state at all.
 */
export const EVALUATE_INPUT_SHAPE = {
  state: z
    .union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
    .describe(STATE_DESCRIPTION),
  images: z
    .array(ImageSchema)
    .max(8)
    .optional()
    .describe(
      `Optional images to evaluate as part of the state, at most 8. Each is
      { "url": "data:image/png;base64,...", "alt": "optional one-line description", "detail": "low" | "high" }.
      The url must be an http(s) URL or a data:image/*;base64 URI - a local backend cannot fetch an
      external one. Requires a vision-capable model; a text-only one rejects the request.`
    ),
  questions: z.record(z.unknown()).describe(QUESTIONS_DESCRIPTION),
  model: z
    .string()
    .optional()
    .describe(
      "Optional model override for this call. Omit it to use the server's configured model. A TypeSafe alias like \"jev-latest\" also falls back to the configured model."
    ),
} satisfies Record<string, z.ZodTypeAny>;

export type EvaluateInput = {
  state: unknown;
  images?: unknown;
  questions: Record<string, unknown>;
  model?: string;
};

function pct(value: number): string {
  return value.toFixed(2);
}

function legendText(level: Description | undefined): string {
  if (level === undefined) return "(no description)";
  return typeof level === "string" ? level : JSON.stringify(level);
}

function ranked(
  probabilities: Record<string, number>,
  limit: number
): [string, number][] {
  return Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

/**
 * Renders the answers for a model to read. `structuredContent` carries the complete
 * response for clients that consume it as data; this is the digest, so it leads with the
 * decision, keeps the runners-up, and puts warnings where they cannot be missed.
 */
export function renderEvaluation(response: SystemOneResponse): string {
  const lines: string[] = [];

  for (const [id, answer] of Object.entries(response.answers)) {
    if (answer.type === "choice") {
      lines.push(`${id} (choice) => ${answer.choice}`);
      lines.push(`  confidence ${pct(answer.confidence)}`);
      const top = ranked(answer.probabilities, 5)
        .map(([key, value]) => `${key} ${pct(value)}`)
        .join("  ");
      lines.push(`  ${top}`);
    } else if (answer.type === "score") {
      // `score` is the probability-weighted average of the level indices, so it
      // is usually fractional and is not a key into the legend. The level it
      // mostly landed on is what a caller acts on; the average is the nuance.
      const lead = ranked(answer.probabilities, 1)[0];
      const leadText = lead
        ? ` (mostly level ${lead[0]}: ${legendText(answer.legend[lead[0]])})`
        : "";
      lines.push(`${id} (score) => ${answer.score}${leadText}`);
      lines.push(`  confidence ${pct(answer.confidence)}`);
      const top = ranked(answer.probabilities, 3)
        .map(([key, value]) => `${key}=${pct(value)} ${legendText(answer.legend[key])}`)
        .join("\n  ");
      lines.push(`  ${top}`);
    } else {
      const verdict = answer.noul > 0.7 ? "yes" : answer.noul < 0.3 ? "no" : "uncertain";
      lines.push(`${id} (noul) => ${pct(answer.noul)} — ${verdict}`);
    }
    lines.push("");
  }

  if (response.warnings && response.warnings.length > 0) {
    lines.push(`warnings — the model did not fully answer, treat the numbers with care:`);
    for (const warning of response.warnings) lines.push(`  - ${warning}`);
    lines.push("");
  }

  lines.push(
    `model ${response.model} · ${response.usage.input_tokens} tokens in / ${response.usage.output_tokens} out`
  );

  return lines.join("\n").trimEnd();
}

export function failureText(outcome: Extract<EvaluateOutcome, { ok: false }>): string {
  const retry =
    outcome.status === 429
      ? " The LLM provider is rate limiting; wait and retry."
      : outcome.status >= 500
        ? " The LLM call failed, not your request; retrying may work."
        : " Fix the request and try again.";
  return `xev_evaluate failed (${outcome.status}): ${outcome.error}${retry}`;
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: SystemOneResponse;
};

export function toToolResult(outcome: EvaluateOutcome): ToolResult {
  if (!outcome.ok) {
    return { content: [{ type: "text", text: failureText(outcome) }], isError: true };
  }
  return {
    content: [{ type: "text", text: renderEvaluation(outcome.response) }],
    // Parsed through the published schema rather than passed through: the tool
    // advertises an outputSchema with additionalProperties:false, and the raw
    // response carries a reasoning_tokens counter that it does not declare. A
    // client validating strictly would reject a payload that this server called
    // its own contract, so the schema is what actually gets sent - and a response
    // that violated it fails loudly here instead of downstream.
    structuredContent: SystemOneResponseSchema.parse(outcome.response),
  };
}

/**
 * Builds the tool result for one call. `options` exists so tests can point the
 * evaluation at a throwaway config; the MCP server never passes it.
 */
export async function runEvaluate(
  input: EvaluateInput,
  options: EvaluateOptions = {}
): Promise<ToolResult> {
  return toToolResult(await evaluate(input, options));
}
