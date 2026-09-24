import { SystemOneRequestSchema, type SystemOneRequest } from "./types";
import type { ZodError } from "zod";

export interface ValidationError {
  status: number;
  error: string;
  details?: unknown;
}

function formatZodError(err: ZodError): string {
  const issues = err.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return `Validation failed: ${issues}`;
}

export function validateRequest(body: unknown): {
  success: true;
  data: SystemOneRequest;
} | {
  success: false;
  error: ValidationError;
} {
  const result = SystemOneRequestSchema.safeParse(body);

  if (result.success) {
    // Additional validation: check question types are valid
    const questions = result.data.questions;
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice" && Object.keys(q.criteria).length === 0) {
        return {
          success: false,
          error: {
            status: 422,
            error: `Question "${id}" is a choice with no options`,
          },
        };
      }
      if (q.type === "score" && q.criteria.length < 2) {
        return {
          success: false,
          error: {
            status: 422,
            error: `Question "${id}" is a score with fewer than 2 levels`,
          },
        };
      }
    }
    return { success: true, data: result.data };
  }

  return {
    success: false,
    error: {
      status: 422,
      error: formatZodError(result.error),
      details: result.error.issues,
    },
  };
}
