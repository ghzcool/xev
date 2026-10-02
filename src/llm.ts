import OpenAI from "openai";
import type { Image } from "./types";

export type ReasoningEffort =
  | "max"
  | "xhigh"
  | "high"
  | "medium"
  | "low"
  | "minimal"
  | "none";

/** OpenRouter's unified reasoning controls. Ignored by non-reasoning models. */
export interface LLMReasoningConfig {
  // Reason internally but do not return the trace. Supported by every model.
  exclude?: boolean;
  effort?: ReasoningEffort;
  // Anthropic-style hard cap on reasoning tokens.
  maxTokens?: number;
}

export interface LLMClientConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxRetries?: number;
  // Upper bound on the answer. Undefined lets the provider decide.
  maxTokens?: number;
  // OpenRouter app attribution. Sent as HTTP-Referer / X-Title.
  referer?: string;
  title?: string;
  // OpenRouter provider routing: which upstream providers to try, in order.
  providerOrder?: string[];
  allowFallbacks?: boolean;
  // OpenRouter: "deny" only routes to providers that do not train on the prompt.
  dataCollection?: "allow" | "deny";
  // OpenRouter's reasoning dialect: the model may think, `exclude` keeps the
  // trace out of the response, `effort` and `maxTokens` bound the thinking.
  reasoning?: LLMReasoningConfig;
  // Parameters merged into the request body last, after everything xev built.
  // This is how the standard OpenAI reasoning controls reach a backend that is
  // not a router: `reasoning_effort` is what LM Studio, SGLang and vLLM all
  // honor (vLLM translates it into the chat template's own `enable_thinking`),
  // and it is also the escape hatch for anything else a server understands,
  // such as `chat_template_kwargs` or `thinking_token_budget`.
  extraBody?: Record<string, unknown>;
}

export interface LLMResult {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    // Tokens the model spent thinking. Counted inside output_tokens.
    reasoning_tokens: number;
  };
  // finish_reason was "length": the answer was cut off, so values are missing.
  truncated: boolean;
  finishReason: string | null;
  // The model returned a thinking trace, either alongside or instead of an answer.
  hadReasoning: boolean;
}


function stripCodeFences(content: string): string {
  const cleaned = content.trim();
  if (!cleaned.startsWith("```")) return cleaned;

  const firstNewline = cleaned.indexOf("\n");
  if (firstNewline === -1) {
    // "```0:0.5```" - no language line, so the fence wraps the answer itself.
    const afterOpen = cleaned.slice(3);
    const payload = afterOpen.endsWith("```") ? afterOpen.slice(0, -3) : afterOpen;
    return payload.trim() || afterOpen.trim() || cleaned;
  }
  const lastFence = cleaned.lastIndexOf("```");
  if (lastFence > firstNewline) {
    return cleaned.slice(firstNewline + 1, lastFence).trim();
  }
  return cleaned;
}

// Reasoning models that inline their trace in `content` (Nemotron, R1 distills,
// QwQ) rather than returning it as a separate field. Trimming it here means the
// parser never sees prose that only looked like an answer.
function stripThinkBlocks(content: string): { text: string; found: boolean } {
  let found = false;
  let text = content.replace(/<think>[\s\S]*?<\/think>/gi, () => {
    found = true;
    return "\n";
  });
  // Truncated mid-thought: everything after the opening tag is reasoning.
  const unterminated = text.search(/<think>/i);
  if (unterminated !== -1) {
    found = true;
    text = text.slice(0, unterminated);
  }
  if (/<\/think>/i.test(text)) {
    found = true;
    text = text.replace(/<\/?think>/gi, "");
  }
  return { text: text.trim(), found };
}

// Some OpenRouter models report failures in the body with a 200 status.
function bodyError(response: unknown): string | null {
  const error = (response as { error?: unknown } | null)?.error;
  if (!error) return null;
  if (typeof error === "string") return error;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : JSON.stringify(error);
}

/**
 * Builds the user message. A vision model takes multimodal input as an array of
 * content parts rather than a string:
 *
 *   content: [ { type: "text", text }, { type: "image_url", image_url: { url } } ]
 *
 * `url` is an `http(s)` URL or a `data:` URI; the data URI is what a local
 * backend needs, since it has no way to fetch an external one. Text first, then
 * images, which is the order these models are trained to read.
 *
 * Without images the content stays a plain string: every text-only model accepts
 * an array, but keeping the existing shape means an image-free request is
 * byte-identical to what it was before this existed.
 */
function userContent(prompt: string, images: Image[]): string | unknown[] {
  if (images.length === 0) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "image_url",
      image_url: {
        url: image.url,
        // Omitted unless asked for: `detail` is an OpenAI-specific key and some
        // local servers reject a request carrying one.
        ...(image.detail ? { detail: image.detail } : {}),
      },
    })),
  ];
}

export async function callLLM(
  prompt: string,
  config: LLMClientConfig,
  images: Image[] = []
): Promise<LLMResult> {
  const defaultHeaders: Record<string, string> = {};
  if (config.referer) defaultHeaders["HTTP-Referer"] = config.referer;
  if (config.title) defaultHeaders["X-Title"] = config.title;

  const client = new OpenAI({
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    ...(config.timeoutMs ? { timeout: config.timeoutMs } : {}),
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
    ...(Object.keys(defaultHeaders).length > 0 ? { defaultHeaders } : {}),
  });

  // OpenRouter reads provider routing from the request body. Unknown body keys
  // pass straight through the OpenAI SDK, so they are added here rather than
  // through a provider-specific client.
  const provider: Record<string, unknown> = {};
  if (config.providerOrder && config.providerOrder.length > 0) {
    provider.order = config.providerOrder;
  }
  if (config.allowFallbacks !== undefined) {
    provider.allow_fallbacks = config.allowFallbacks;
  }
  if (config.dataCollection) {
    provider.data_collection = config.dataCollection;
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      {
        role: "system",
        content:
          "You are a precise structured evaluation engine. You always return only the requested index:value answer list, with no explanations, no reasoning, and no markdown.",
      },
      {
        role: "user",
        content: userContent(prompt, images),
      },
    ],
    temperature: 0,
  };
  if (config.maxTokens) body.max_tokens = config.maxTokens;
  if (Object.keys(provider).length > 0) body.provider = provider;
  if (config.reasoning) {
    // camelCase in, snake_case on the wire.
    const reasoning: Record<string, unknown> = {};
    if (config.reasoning.exclude !== undefined) reasoning.exclude = config.reasoning.exclude;
    if (config.reasoning.effort) reasoning.effort = config.reasoning.effort;
    if (config.reasoning.maxTokens) reasoning.max_tokens = config.reasoning.maxTokens;
    if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;
  }
  // Last word on the body goes to the operator, so a key here overrides whatever
  // xev derived for the same name.
  if (config.extraBody) Object.assign(body, config.extraBody);

  const response = await client.chat.completions.create(
    // The body is assembled above so OpenRouter-only keys can be added; the
    // SDK forwards unknown keys to the server untouched.
    body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming
  );

  const failure = bodyError(response);
  if (failure) {
    throw new Error(`LLM returned an error: ${failure}`);
  }

  const choice = response.choices[0];
  const finishReason = choice?.finish_reason ?? null;
  const message = choice?.message as
    | { content?: string | null; reasoning?: string | null; reasoning_content?: string | null }
    | undefined;

  // Reasoning arrives either as its own field or inline in the content.
  const reasoningField = message?.reasoning ?? message?.reasoning_content ?? "";
  const inline = stripThinkBlocks(message?.content ?? "");
  const content = inline.text;
  const hadReasoning = reasoningField.trim() !== "" || inline.found;

  const details = (
    response.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined
  )?.completion_tokens_details;
  const reasoningTokens = details?.reasoning_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;
  const visibleTokens = Math.max(0, outputTokens - reasoningTokens);

  if (!content) {
    // The common reasoning-model failure: the thinking ate the whole output
    // budget, so there is no answer to parse and the tokens are already spent.
    if (hadReasoning || reasoningTokens > 0 || finishReason === "length") {
      throw new Error(
        `the model used its output budget on reasoning and returned no answer ` +
          `(finish_reason: ${finishReason}, ${reasoningTokens} reasoning tokens, ` +
          `${visibleTokens} visible). Retry with a non-reasoning model, or set ` +
          `LLM_REASONING_EFFORT=none / raise LLM_MAX_TOKENS.`
      );
    }
    throw new Error("LLM returned empty response");
  }

  return {
    content: stripCodeFences(content),
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: outputTokens,
      reasoning_tokens: reasoningTokens,
    },
    truncated: finishReason === "length",
    finishReason,
    hadReasoning,
  };
}

// Maps an LLM failure to the status the client should see. Everything that goes
// wrong upstream is a bad gateway (or a gateway timeout) - the caller's request
// was fine, we could not carry it out.
export function llmErrorStatus(err: unknown): number {
  if (err instanceof OpenAI.APIConnectionTimeoutError) return 504;
  if (err instanceof OpenAI.APIError) {
    // 429 from the provider, 401 from a bad key, 5xx from the provider: none of
    // these are the caller's fault, but 429 is worth passing through as-is.
    if (err.status === 429) return 429;
    return 502;
  }
  return 500;
}
