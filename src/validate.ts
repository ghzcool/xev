import { SystemOneRequestSchema, type SystemOneRequest } from "./types";
import type { ZodError, ZodInvalidUnionIssue } from "zod";

export interface ValidationError {
  status: number;
  error: string;
  details?: unknown;
}

// Images are an xev extension with no documented Jev limit. A request carrying
// more than this is not a question about vision: local backends take one image
// per request in practice, and every one of them is base64 in the body, so the
// count is what bounds the payload size rather than the content itself.
const MAX_IMAGES = 8;

// A question that matches none of the type branches only produces "Invalid
// input" from zod, which tells a client nothing. Walk the branches instead: the
// type literals they expect, plus whatever the branch that accepted the type
// was still missing.
function describeUnionIssue(issue: ZodInvalidUnionIssue): string {
  // zod reports sub-issue paths in full (questions.d.criteria), so trim the
  // union's own path off to avoid prefixing the message twice.
  const depth = issue.path.length;
  const types = new Set<string>();
  const extras: string[] = [];
  let received: string | undefined;

  for (const branch of issue.unionErrors) {
    let typeFailed = false;
    const missing: string[] = [];

    for (const sub of branch.issues) {
      const rel = sub.path.slice(depth);
      if (rel.length === 1 && rel[0] === "type" && sub.code === "invalid_literal") {
        typeFailed = true;
        types.add(String(sub.expected));
        received = String(sub.received);
      } else {
        missing.push(`${rel.join(".") || "(value)"}: ${sub.message}`);
      }
    }

    // A branch that already rejected the type has nothing useful to add: for
    // { type: "ranking" } the choice branch also reports "criteria: Required",
    // which would point the caller at the wrong field.
    if (!typeFailed) {
      if (received !== undefined) types.add(received);
      extras.push(...missing);
    }
  }

  const expected = [...types].map((t) => `"${t}"`).join(" | ");
  const base = expected
    ? `expected a question of type ${expected}`
    : "no question type matched";
  return extras.length > 0 ? `${base}; missing: ${extras.join("; ")}` : base;
}

function formatZodError(err: ZodError): string {
  const issues = err.issues
    .map((i) => {
      const where = i.path.join(".") || "(body)";
      return `${where}: ${i.code === "invalid_union" ? describeUnionIssue(i) : i.message}`;
    })
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
    const questions = result.data.questions;
    const questionCount = Object.keys(questions).length;
    const images = result.data.images;
    if (images && images.length > MAX_IMAGES) {
      return {
        success: false,
        error: {
          status: 422,
          error: `Validation failed: images has ${images.length} entries; a request accepts at most ${MAX_IMAGES}`,
        },
      };
    }
    if (questionCount === 0) {
      // An empty questions map is a structurally valid record to zod, but there
      // is nothing to evaluate and no placeholder for the model to answer.
      return {
        success: false,
        error: {
          status: 422,
          error:
            "Validation failed: questions must contain at least one question",
        },
      };
    }
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === "choice") {
        const optionCount = Object.keys(q.criteria).length;
        if (optionCount === 0) {
          return {
            success: false,
            error: {
              status: 422,
              error: `Question "${id}" is a choice with no options`,
            },
          };
        }
        if (optionCount > 255) {
          return {
            success: false,
            error: {
              status: 422,
              error: `Question "${id}" has ${optionCount} options; a choice accepts at most 255`,
            },
          };
        }
      }
      if (q.type === "score" && (q.criteria.length < 2 || q.criteria.length > 10)) {
        return {
          success: false,
          error: {
            status: 422,
            error: `Question "${id}" is a score with ${q.criteria.length} levels; a score accepts 2 to 10`,
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
