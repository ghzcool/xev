import type { Request } from "express";
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

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function isOpenRouter(baseURL: string): boolean {
  return /(^|\.)openrouter\.ai$/i.test(safeHost(baseURL));
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
    // Routers like OpenRouter expose a catalog; a fixed base URL does not.
    discoverModels: discoverFlag ?? isOpenRouter(baseURL),
    corsOrigins: envList("CORS_ORIGIN"),
    rateLimitRpm: envInt("RATE_LIMIT_RPM", 0),
  };
}

function header(req: Request, name: string): string | undefined {
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
  req: Request,
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

  // Reasoning is requested only for routers that implement it. A plain
  // OpenAI-compatible server has never heard of the parameter.
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

  const tokenCap = maxTokens ? Number.parseInt(maxTokens, 10) : config.maxTokens;
  const answerBudget =
    Number.isFinite(tokenCap) && tokenCap > 0 ? tokenCap : maxTokensFor(placeholderCount);
  // Leave the reasoning room it needs, or a thinking model never reaches the
  // answer list at all.
  resolved.maxTokens = resolved.reasoning
    ? answerBudget + (resolved.reasoning.maxTokens ?? REASONING_RESERVE_TOKENS)
    : answerBudget;

  return resolved;
}

/** Upper bound for the answer, sized so a 255-option question still fits. */
export function maxTokensFor(placeholderCount: number): number {
  return Math.max(64, placeholderCount * 12 + 32);
}
