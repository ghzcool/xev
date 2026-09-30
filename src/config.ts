import type { LLMClientConfig, LLMReasoningConfig, ReasoningEffort } from "./llm";

// Defaults match .env.example and the demo page, so a server started with no
// .env talks to a local LLM instead of silently reaching for a paid API.
const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL = "qwen/qwen3.5-9b";

// Reasoning tokens come out of the same budget as the answer, so an answer cap
// sized only for the answer list leaves a thinking model nothing to answer with.
const REASONING_RESERVE_TOKENS = 1024;

const REASONING_EFFORTS: ReasoningEffort[] = [
  "max",
  "xhigh",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
];

export interface ServerConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  // 0 means "size the cap from the number of placeholders in the request".
  maxTokens: number;
  referer: string;
  title: string;
  providerOrder: string[];
  allowFallbacks: boolean | undefined;
  dataCollection: "allow" | "deny" | undefined;
  reasoning: LLMReasoningConfig;
  // Merged into the request body last. Holds the standard `reasoning_effort` a
  // non-router backend needs, plus anything the operator wants to pass through.
  // Omitted unless set, since a server that rejects the key would 400.
  extraBody?: Record<string, unknown>;
  discoverModels: boolean;
  corsOrigins: string[];
  rateLimitRpm: number;
}

export class ConfigError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ConfigError";
    this.status = status;
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function envList(name: string): string[] {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim().toLowerCase() === "true";
}

/**
 * A JSON object passed straight through to the backend. Unset and blank input
 * is simply absent; anything unparseable is reported once at startup and
 * ignored rather than silently becoming `{}`, which would read as "the
 * operator asked for nothing here".
 */
function parseJSONObject(source: string, raw: string): Record<string, unknown> | undefined {
  if (raw.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    console.warn(`Ignoring ${source}: expected a JSON object, got "${raw}"`);
    return undefined;
  }
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The address the server is reachable at, for the startup banner. A wildcard
 * bind (the default) is not an address anyone can click, so it becomes
 * localhost; IPv6 literals need brackets.
 */
export function formatBaseUrl(host: string | undefined, port: number): string {
  const name =
    !host || host === "0.0.0.0" || host === "::" || host === "[::]" ? "localhost" : host;
  return `http://${name.includes(":") ? `[${name}]` : name}:${port}`;
}

/**
 * OSC 8 hyperlink. Terminals that do not understand it (legacy Windows conhost)
 * would print the escape codes, so it is only emitted where it is known to work.
 */
export function supportsHyperlinks(): boolean {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return false;
  if (process.platform === "win32") {
    return Boolean(
      process.env.WT_SESSION ||
        process.env.TERM_PROGRAM === "vscode" ||
        process.env.ConEmuTask
    );
  }
  return process.env.TERM !== "dumb";
}

export function hyperlink(url: string, label = url): string {
  if (!supportsHyperlinks()) return label;
  return `\u001b]8;;${url}\u001b\\${label}\u001b\\`;
}

export function isOpenRouter(baseURL: string): boolean {
  return /(^|\.)openrouter\.ai$/i.test(safeHost(baseURL));
}

// Both dialects can say "the model will not think": the standard
// `reasoning_effort`, and vLLM's chat template switch. The operator's own
// `LLM_EXTRA_BODY` counts too, since it is merged over what xev derived.
function thinkingIsOff(body: Record<string, unknown> | undefined): boolean {
  if (!body) return false;
  if (body.reasoning_effort === "none") return true;
  const kwargs = body.chat_template_kwargs as { enable_thinking?: unknown } | undefined;
  return kwargs?.enable_thinking === false;
}

function safeHost(url: string): string {
  try {
    return new URL(normalizeBaseUrl(url)).hostname;
  } catch {
    return "";
  }
}

export function getConfig(): ServerConfig {
  const baseURL = process.env.LLM_BASE_URL || DEFAULT_BASE_URL;
  const discoverFlag = envBool("LLM_DISCOVER_MODELS");
  const effort = process.env.LLM_REASONING_EFFORT?.trim();
  if (effort && !REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
    console.warn(
      `Ignoring LLM_REASONING_EFFORT="${effort}": expected one of ${REASONING_EFFORTS.join(", ")}`
    );
  }
  const extraBody = parseJSONObject("LLM_EXTRA_BODY", process.env.LLM_EXTRA_BODY?.trim() || "");

  return {
    baseURL,
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || DEFAULT_MODEL,
    timeoutMs: envInt("LLM_TIMEOUT_MS", 120_000),
    maxRetries: envInt("LLM_MAX_RETRIES", 2),
    maxTokens: envInt("LLM_MAX_TOKENS", 0),
    referer: process.env.OPENROUTER_REFERER || "http://localhost:3000",
    title: process.env.OPENROUTER_TITLE || "xev",
    providerOrder: envList("LLM_PROVIDER_ORDER"),
    allowFallbacks: envBool("LLM_PROVIDER_ALLOW_FALLBACKS"),
    dataCollection:
      process.env.LLM_DATA_COLLECTION === "deny" ? "deny" : undefined,
    reasoning: {
      // Never return a thinking trace: xev wants the answer list, and a trace
      // in the response is indistinguishable from prose the parser must skip.
      exclude: envBool("LLM_REASONING_EXCLUDE") ?? true,
      ...(effort && REASONING_EFFORTS.includes(effort as ReasoningEffort)
        ? { effort: effort as ReasoningEffort }
        : {}),
      ...(envInt("LLM_REASONING_MAX_TOKENS", 0) > 0
        ? { maxTokens: envInt("LLM_REASONING_MAX_TOKENS", 0) }
        : {}),
    },
    ...(extraBody ? { extraBody } : {}),

    // Routers like OpenRouter expose a catalog; a fixed base URL does not.
    discoverModels: discoverFlag ?? isOpenRouter(baseURL),
    corsOrigins: envList("CORS_ORIGIN"),
    rateLimitRpm: envInt("RATE_LIMIT_RPM", 0),
  };
}

/**
 * Anything that carries HTTP-style headers. An express `Request` satisfies this
 * structurally, and so does a plain `{ headers }` object, which is what the MCP
 * server and tests pass: connection overrides are a transport concern, not an
 * express one, and the credential guard must not be bypassable by reaching for a
 * different caller.
 */
export interface HeaderSource {
  headers: Record<string, string | string[] | undefined>;
}

function header(req: HeaderSource, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

/**
 * TypeSafe's own model names ("jev-latest", "jev-anything") are aliases, not
 * real model names, so they fall through to the configured backend model.
 */
export function isTypeSafeAlias(model: string | undefined): boolean {
  return !!model && /^jev/i.test(model.trim());
}

/**
 * Resolves the LLM connection for one request: server config, overridden by
 * the request's `model` field and then by `x-llm-*` headers.
 *
 * The server's API key is only ever sent to the base URL it is configured for.
 * A caller that redirects the request at a different host must bring its own
 * key, otherwise this endpoint would hand out the server's credentials to
 * whatever host the caller named.
 */
export function resolveLLMConfig(
  req: HeaderSource,
  config: ServerConfig,
  bodyModel?: string,
  placeholderCount = 0
): LLMClientConfig {
  const requestedBase = header(req, "x-llm-base-url");
  const requestedKey = header(req, "x-llm-api-key");
  const targetBase = requestedBase || config.baseURL;
  const isConfiguredHost =
    normalizeBaseUrl(targetBase) === normalizeBaseUrl(config.baseURL);

  if (requestedBase && !isConfiguredHost && !requestedKey) {
    throw new ConfigError(
      "x-llm-api-key is required when x-llm-base-url points at a different host: xev never sends its own API key to a caller-supplied host"
    );
  }

  const model = header(req, "x-llm-model");
  const referer = header(req, "x-llm-referer");
  const title = header(req, "x-llm-title");
  const providerOrder = header(req, "x-llm-provider-order");
  const allowFallbacks = header(req, "x-llm-provider-fallbacks");
  const dataCollection = header(req, "x-llm-data-collection");
  const maxTokens = header(req, "x-llm-max-tokens");
  const effort = header(req, "x-llm-reasoning-effort");
  const reasoningMax = header(req, "x-llm-reasoning-max-tokens");
  const excludeReasoning = header(req, "x-llm-reasoning-exclude");
  const extraBodyHeader = header(req, "x-llm-extra-body");

  if (dataCollection && dataCollection !== "allow" && dataCollection !== "deny") {
    throw new ConfigError(
      `x-llm-data-collection must be "allow" or "deny", got "${dataCollection}"`
    );
  }
  if (effort && !REASONING_EFFORTS.includes(effort as ReasoningEffort)) {
    throw new ConfigError(
      `x-llm-reasoning-effort must be one of ${REASONING_EFFORTS.join(", ")}, got "${effort}"`
    );
  }

  const requested = isTypeSafeAlias(bodyModel) ? undefined : bodyModel;

  const resolved: LLMClientConfig = {
    baseURL: targetBase,
    apiKey: (isConfiguredHost ? config.apiKey : requestedKey) || "no-key",
    model: model || requested || config.model,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  };

  // Attribution and provider routing are OpenRouter features; sending them to
  // any other server is noise, so they go out only for OpenRouter targets.
  const openRouter = isOpenRouter(targetBase);
  if (openRouter || referer) resolved.referer = referer || config.referer;
  if (openRouter || title) resolved.title = title || config.title;

  const order = providerOrder
    ? providerOrder.split(",").map((s) => s.trim()).filter(Boolean)
    : config.providerOrder;
  if (order.length > 0) resolved.providerOrder = order;

  if (allowFallbacks !== undefined) {
    resolved.allowFallbacks = allowFallbacks.toLowerCase() !== "false";
  } else if (config.allowFallbacks !== undefined) {
    resolved.allowFallbacks = config.allowFallbacks;
  }

  const collection = dataCollection || config.dataCollection;
  if (collection) resolved.dataCollection = collection as "allow" | "deny";

  // Reasoning comes in two dialects. OpenRouter puts it in a `reasoning`
  // object; every other OpenAI-compatible server speaks the standard top-level
  // `reasoning_effort`, which LM Studio and SGLang implement directly and vLLM
  // translates into the chat template's own `enable_thinking`. Only the disable
  // direction is derived, so "none" is honoured everywhere while a backend with
  // no notion of "a little thinking" is never handed a level it would reject:
  // LM Studio answers `reasoning_effort: "low"` with a 400, where sending
  // nothing keeps the request working.
  const effectiveEffort = (effort || config.reasoning.effort) as ReasoningEffort | undefined;

  if (openRouter) {
    const reasoning: LLMReasoningConfig = {
      ...config.reasoning,
      ...(effort ? { effort: effort as ReasoningEffort } : {}),
      ...(excludeReasoning !== undefined
        ? { exclude: excludeReasoning.toLowerCase() !== "false" }
        : {}),
    };
    const reasoningCap = reasoningMax ? Number.parseInt(reasoningMax, 10) : config.reasoning.maxTokens;
    if (Number.isFinite(reasoningCap) && (reasoningCap ?? 0) > 0) {
      reasoning.maxTokens = reasoningCap;
    }
    if (Object.keys(reasoning).length > 0) resolved.reasoning = reasoning;
  }

  // The operator's own keys go last, so they can override what xev derived.
  const extra =
    extraBodyHeader !== undefined
      ? parseJSONObject("x-llm-extra-body", extraBodyHeader)
      : config.extraBody;
  const derived = !openRouter && effectiveEffort === "none" ? { reasoning_effort: "none" } : {};
  const extraBody = { ...derived, ...extra };
  if (Object.keys(extraBody).length > 0) resolved.extraBody = extraBody;

  const tokenCap = maxTokens ? Number.parseInt(maxTokens, 10) : config.maxTokens;
  const explicitCap = Number.isFinite(tokenCap) && tokenCap > 0;
  const answerBudget = explicitCap ? tokenCap : maxTokensFor(placeholderCount);
  // A thinking model spends from the same budget and answers nothing until it is
  // done, so reserve room unless thinking was switched off. The reserve goes to
  // every backend, not only the ones xev can ask for reasoning controls on: a
  // local Qwen3 keeps thinking whatever xev sends, and a budget with no room for
  // it is a guaranteed `finish_reason: length` with no answer. Widening an upper
  // bound costs a model that does not think nothing. An explicit LLM_MAX_TOKENS
  // is documented as the cap on the answer, so it is honored as given: whoever
  // set it has already decided what the model may spend, and it is the way out
  // for a backend whose thinking does not fit the default reserve.
  resolved.maxTokens =
    explicitCap || thinkingIsOff(resolved.extraBody)
      ? answerBudget
      : answerBudget + (resolved.reasoning?.maxTokens ?? REASONING_RESERVE_TOKENS);

  return resolved;
}

/** Upper bound for the answer, sized so a 255-option question still fits. */
export function maxTokensFor(placeholderCount: number): number {
  return Math.max(64, placeholderCount * 12 + 32);
}
