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

// ── Request ─────────────────────────────────────────────────────────────────
export const SystemOneRequestSchema = z.object({
  state: z.union([z.string(), z.record(z.unknown()), z.array(z.unknown())]),
  model: z.string(),
  questions: z.record(QuestionSchema),
});

export type SystemOneRequest = z.infer<typeof SystemOneRequestSchema>;

// ── Answer types ────────────────────────────────────────────────────────────
export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

// ── Response ────────────────────────────────────────────────────────────────
export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ── LLM raw output (what we ask the LLM to return) ─────────────────────────
export interface LLMQuestionResult {
  probabilities?: Record<string, number>;
  noul?: number;
}

export type LLMRawOutput = Record<string, LLMQuestionResult>;
