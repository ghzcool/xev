import { z } from "zod";

// ── Instructions (string | object | array) ──────────────────────────────────
const InstructionsSchema = z.union([
  z.string(),
  z.record(z.unknown()),
  z.array(z.unknown()),
]);
export type Instructions = z.infer<typeof InstructionsSchema>;

// ── Question types ──────────────────────────────────────────────────────────
const NoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: InstructionsSchema,
  criteria: z
    .object({
      true: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).optional(),
      false: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]).optional(),
    })
    .optional(),
});

const ChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: InstructionsSchema,
  criteria: z.record(
    z.union([z.string(), z.record(z.unknown()), z.array(z.unknown()), z.null()])
  ),
});

const ScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: InstructionsSchema,
  criteria: z.array(
    z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
  ),
});

const QuestionSchema = z.union([
  NoulQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);

export type NoulQuestion = z.infer<typeof NoulQuestionSchema>;
export type ChoiceQuestion = z.infer<typeof ChoiceQuestionSchema>;
export type ScoreQuestion = z.infer<typeof ScoreQuestionSchema>;
export type Question = z.infer<typeof QuestionSchema>;

// ── Images ──────────────────────────────────────────────────────────────────
// An image the model should read as part of the state. `url` is exactly what
// the OpenAI-compatible chat API accepts in an `image_url` part: an `http(s)`
// URL, or a `data:image/<type>;base64,<payload>` URI. Bare base64 is rejected -
// without the media type prefix neither xev nor the model can tell a PNG from
// a JPEG, and `readAsDataURL` is what the browser gives us anyway.
export const ImageSchema = z.object({
  url: z.string().min(1).refine(
    (url) => /^(data:image\/|https?:\/\/)/i.test(url),
    "must be an http(s) URL or a data:image/*;base64 URI"
  ),
  // "low" | "high" trade tokens for fidelity. Omitted entirely unless the
  // caller asks: it is OpenAI-specific, and local servers reject the request
  // when handed a key they do not know.
  detail: z.enum(["auto", "low", "high"]).optional(),
  // A one-line description of what the image shows, put in front of the model
  // so a question can refer to it ("image 2"). Never replaces the image.
  alt: z.string().optional(),
});

export type Image = z.infer<typeof ImageSchema>;

// ── Request ─────────────────────────────────────────────────────────────────
// `model` is optional: Jev clients either omit it or send the "jev-latest"
// alias, and index.ts falls back to LLM_MODEL in both cases.
export const SystemOneRequestSchema = z.object({
  state: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]),
  // Images attached to the state, sent as `image_url` parts alongside the
  // prompt. Additive to Jev's contract, which has no image field; requires a
  // vision-capable model.
  images: z.array(ImageSchema).optional(),
  model: z.string().optional(),
  questions: z.record(QuestionSchema),
});

export type SystemOneRequest = z.infer<typeof SystemOneRequestSchema>;

// ── Answer types ────────────────────────────────────────────────────────────
// A description is returned verbatim in `legend` (Jev keeps object/array levels structured)
export const DescriptionSchema = z.union([
  z.string(),
  z.record(z.unknown()),
  z.array(z.unknown()),
]);

export type Description = z.infer<typeof DescriptionSchema>;

export const NoulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number().min(0).max(1),
});

export const ChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.number()),
  confidence: z.number().min(0).max(1),
});

export const ScoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(DescriptionSchema),
  probabilities: z.record(z.number()),
  confidence: z.number().min(0).max(1),
});

export const AnswerSchema = z.union([
  NoulAnswerSchema,
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
]);

export type NoulAnswer = z.infer<typeof NoulAnswerSchema>;
export type ChoiceAnswer = z.infer<typeof ChoiceAnswerSchema>;
export type ScoreAnswer = z.infer<typeof ScoreAnswerSchema>;
export type Answer = z.infer<typeof AnswerSchema>;

// ── Response ────────────────────────────────────────────────────────────────
// `warnings` is an xev extension, not part of the TypeSafe shape: it is only
// present when the model's answer was incomplete or degenerate, so a client
// can tell a real answer from one the parser had to fill in.
export const SystemOneResponseSchema = z.object({
  model: z.string(),
  answers: z.record(AnswerSchema),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
  warnings: z.array(z.string()).optional(),
});

export type SystemOneResponse = z.infer<typeof SystemOneResponseSchema>;

// ── LLM output ──────────────────────────────────────────────────────────────
export interface LLMQuestionResult {
  probabilities?: Record<string, number>;
  noul?: number;
}

// Normalized per-question shape, produced from placeholder values or LLM JSON
export type LLMRawOutput = Record<string, LLMQuestionResult>;

// Values parsed from the LLM answer list: `0:0.1;1:0.234;2:0;3:1`
export type LLMValues = Record<number, number>;

// Maps a `${index}` placeholder in the response template to its target field
export type Placeholder =
  | { questionId: string; field: "noul" }
  | { questionId: string; field: "probabilities"; key: string };
