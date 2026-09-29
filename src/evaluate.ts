import { validateRequest } from "./validate";
import { buildPrompt, buildPlaceholderMap } from "./prompt";
import { callLLM, llmErrorStatus } from "./llm";
import { parseResponse, LLMResponseError } from "./parser";
import {
  ConfigError,
  getConfig,
  resolveLLMConfig,
  type HeaderSource,
  type ServerConfig,
} from "./config";
import type { SystemOneResponse } from "./types";

/**
 * The evaluation pipeline, independent of how the request arrived.
 *
 * The HTTP route and the MCP server both go through here, so a caller cannot get
 * different behavior by choosing a different door. `headers` carries the same
 * `x-llm-*` overrides the HTTP route reads off the request, which is what keeps
 * the credential guard in one place.
 */
export interface EvaluateOptions {
  headers?: HeaderSource["headers"];
  // Defaults to the environment, resolved per call the way the HTTP route does.
  config?: ServerConfig;
}

export type EvaluateOutcome =
  | { ok: true; response: SystemOneResponse }
  | { ok: false; status: number; error: string; details?: unknown };

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Validates a System One request, runs it through the LLM, and returns the
 * TypeSafe-shaped response.
 *
 * Failures are returned rather than thrown: the status is the same one the HTTP
 * route would have used, so a non-HTTP transport can report it in whatever form
 * it needs without re-deriving the mapping.
 */
export async function evaluate(
  request: unknown,
  options: EvaluateOptions = {}
): Promise<EvaluateOutcome> {
  const config = options.config ?? getConfig();

  const validation = validateRequest(request);
  if (!validation.success) {
    return {
      ok: false,
      status: validation.error.status,
      error: validation.error.error,
      details: validation.error.details,
    };
  }

  const { state, model, questions } = validation.data;

  try {
    const llmConfig = resolveLLMConfig(
      { headers: options.headers ?? {} },
      config,
      model,
      buildPlaceholderMap(questions).length
    );
    const prompt = buildPrompt(state, questions);
    const result = await callLLM(prompt, llmConfig);

    // Transport-level problems the parser cannot see: a truncated answer looks
    // like a model that chose not to answer some placeholders.
    const warnings: string[] = [];
    if (result.hadReasoning) {
      warnings.push(
        `the model returned a thinking trace alongside its answer (${result.usage.reasoning_tokens} reasoning tokens); check the values`
      );
    }
    if (result.truncated) {
      warnings.push(
        "the model's answer was cut off (finish_reason: length); some values are missing"
      );
    }

    return {
      ok: true,
      response: parseResponse(
        questions,
        result.content,
        llmConfig.model,
        result.usage,
        { warnings }
      ),
    };
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      return { ok: false, status: err.status, error: err.message };
    }
    const detail = message(err);
    // The caller's request was valid; the model or the upstream server failed.
    const status = err instanceof LLMResponseError ? 502 : llmErrorStatus(err);
    console.error(`Evaluation error (${status}):`, detail);
    return {
      ok: false,
      status,
      error: status === 504 ? `LLM request timed out: ${detail}` : `Evaluation failed: ${detail}`,
    };
  }
}
