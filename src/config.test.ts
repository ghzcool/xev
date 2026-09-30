import { test } from "node:test";
import assert from "node:assert/strict";
import type { Request } from "express";
import {
  ConfigError,
  formatBaseUrl,
  getConfig,
  hyperlink,
  isOpenRouter,
  isTypeSafeAlias,
  maxTokensFor,
  normalizeBaseUrl,
  resolveLLMConfig,
  type ServerConfig,
} from "./config";

function req(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

const BASE: ServerConfig = {
  baseURL: "https://api.openai.com/v1",
  apiKey: "server-secret-key",
  model: "gpt-4o",
  timeoutMs: 1000,
  maxRetries: 2,
  maxTokens: 0,
  referer: "http://localhost:3000",
  title: "xev",
  providerOrder: [],
  allowFallbacks: undefined,
  dataCollection: undefined,
  reasoning: { exclude: true },
  discoverModels: false,
  corsOrigins: [],
  rateLimitRpm: 0,
};

const OPENROUTER: ServerConfig = {
  ...BASE,
  baseURL: "https://openrouter.ai/api/v1",
  discoverModels: true,
};

// ── The server's key never leaves the host it is configured for ─────────────

test("the server key is used for the configured host", () => {
  const config = resolveLLMConfig(req(), BASE);
  assert.equal(config.apiKey, "server-secret-key");
  assert.equal(config.baseURL, "https://api.openai.com/v1");
});

test("a trailing slash does not count as a different host", () => {
  const config = resolveLLMConfig(
    req({ "x-llm-base-url": "https://api.openai.com/v1/", "x-llm-api-key": "ignored" }),
    BASE
  );
  assert.equal(config.apiKey, "server-secret-key");
});

test("redirecting at another host without a key is refused", () => {
  assert.throws(
    () => resolveLLMConfig(req({ "x-llm-base-url": "https://evil.example/v1" }), BASE),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      assert.equal(err.status, 400);
      assert.match(err.message, /x-llm-api-key is required/);
      return true;
    }
  );
});

test("redirecting at another host with a key uses the caller's key, not the server's", () => {
  const config = resolveLLMConfig(
    req({ "x-llm-base-url": "https://evil.example/v1", "x-llm-api-key": "caller-key" }),
    BASE
  );
  assert.equal(config.apiKey, "caller-key");
  assert.equal(config.apiKey.includes("server-secret-key"), false);
});

test("a local server with no key still works", () => {
  const local: ServerConfig = { ...BASE, baseURL: "http://127.0.0.1:1234/v1", apiKey: "" };
  const config = resolveLLMConfig(
    req({ "x-llm-base-url": "http://127.0.0.1:1234/v1" }),
    local
  );
  assert.equal(config.apiKey, "no-key");
});

// ── Model selection ─────────────────────────────────────────────────────────

test("the body's model is used when it is a real model name", () => {
  assert.equal(resolveLLMConfig(req(), BASE, "gpt-4o-mini").model, "gpt-4o-mini");
});

test("TypeSafe aliases fall back to the configured model", () => {
  assert.equal(resolveLLMConfig(req(), BASE, "jev-latest").model, "gpt-4o");
  assert.equal(resolveLLMConfig(req(), BASE, "jev-beta").model, "gpt-4o");
  assert.equal(isTypeSafeAlias("jev-latest"), true);
  assert.equal(isTypeSafeAlias("gpt-4o"), false);
  assert.equal(isTypeSafeAlias(undefined), false);
});

test("the model header wins over the body", () => {
  const config = resolveLLMConfig(req({ "x-llm-model": "from-header" }), BASE, "from-body");
  assert.equal(config.model, "from-header");
});

// ── OpenRouter ──────────────────────────────────────────────────────────────

test("openrouter hosts are detected", () => {
  assert.equal(isOpenRouter("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouter("https://openrouter.ai/api/v1/"), true);
  assert.equal(isOpenRouter("https://eu.openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouter("https://openrouter.ai.evil.example/v1"), false);
  assert.equal(isOpenRouter("not a url"), false);
  assert.equal(isOpenRouter("http://127.0.0.1:1234/v1"), false);
});

test("attribution headers are sent to OpenRouter by default", () => {
  const config = resolveLLMConfig(req(), OPENROUTER);
  assert.equal(config.referer, "http://localhost:3000");
  assert.equal(config.title, "xev");
});

test("attribution headers can be overridden per request", () => {
  const config = resolveLLMConfig(
    req({ "x-llm-referer": "https://my.app", "x-llm-title": "My App" }),
    OPENROUTER
  );
  assert.equal(config.referer, "https://my.app");
  assert.equal(config.title, "My App");
});

test("attribution headers are omitted for non-OpenRouter servers", () => {
  const config = resolveLLMConfig(req(), BASE);
  assert.equal(config.referer, undefined);
  assert.equal(config.title, undefined);
});

test("provider routing comes from the header or the environment config", () => {
  assert.deepEqual(
    resolveLLMConfig(req({ "x-llm-provider-order": "groq, together ,fireworks" }), OPENROUTER)
      .providerOrder,
    ["groq", "together", "fireworks"]
  );
  const withEnv: ServerConfig = { ...OPENROUTER, providerOrder: ["azure"] };
  assert.deepEqual(resolveLLMConfig(req(), withEnv).providerOrder, ["azure"]);
  assert.equal(resolveLLMConfig(req(), OPENROUTER).providerOrder, undefined);
});

test("provider fallbacks and data collection are passed through", () => {
  const config = resolveLLMConfig(
    req({ "x-llm-provider-fallbacks": "false", "x-llm-data-collection": "deny" }),
    OPENROUTER
  );
  assert.equal(config.allowFallbacks, false);
  assert.equal(config.dataCollection, "deny");
});

test("an invalid data collection value is rejected", () => {
  assert.throws(
    () => resolveLLMConfig(req({ "x-llm-data-collection": "maybe" }), OPENROUTER),
    ConfigError
  );
});

// ── Reasoning ───────────────────────────────────────────────────────────────

test("OpenRouter requests exclude reasoning by default", () => {
  const config = resolveLLMConfig(req(), OPENROUTER, undefined, 2);
  assert.deepEqual(config.reasoning, { exclude: true });
  // The answer budget must leave room for the thinking.
  assert.equal(config.maxTokens, maxTokensFor(2) + 1024);
});

test("reasoning effort and cap can be set, and widen the token budget", () => {
  const config = resolveLLMConfig(
    req({ "x-llm-reasoning-effort": "none", "x-llm-reasoning-max-tokens": "256" }),
    OPENROUTER,
    undefined,
    2
  );
  assert.deepEqual(config.reasoning, { exclude: true, effort: "none", maxTokens: 256 });
  assert.equal(config.maxTokens, maxTokensFor(2) + 256);
});

test("reasoning can be turned back on to inspect the trace", () => {
  const config = resolveLLMConfig(
    req({ "x-llm-reasoning-exclude": "false", "x-llm-reasoning-effort": "low" }),
    OPENROUTER
  );
  assert.equal(config.reasoning?.exclude, false);
  assert.equal(config.reasoning?.effort, "low");
});

test("an invalid reasoning effort is rejected", () => {
  assert.throws(
    () => resolveLLMConfig(req({ "x-llm-reasoning-effort": "turbo" }), OPENROUTER),
    ConfigError
  );
});

test("reasoning is not sent to plain OpenAI-compatible servers", () => {
  const config = resolveLLMConfig(req(), BASE, undefined, 3);
  assert.equal(config.reasoning, undefined);
  assert.equal(config.extraBody, undefined);
  // The reserve is not router-specific: a local Qwen3 thinks whatever xev sends.
  assert.equal(config.maxTokens, maxTokensFor(3) + 1024);
});

test("no reserve is left for thinking that was switched off", () => {
  const config = resolveLLMConfig(
    req({ "x-llm-extra-body": '{"reasoning_effort":"none"}' }),
    BASE,
    undefined,
    3
  );
  assert.equal(config.maxTokens, maxTokensFor(3));
});

test("the vLLM chat template switch counts as thinking, both ways", () => {
  const off = resolveLLMConfig(
    req({ "x-llm-extra-body": '{"chat_template_kwargs":{"enable_thinking":false}}' }),
    BASE,
    undefined,
    2
  );
  assert.equal(off.maxTokens, maxTokensFor(2), "nothing is coming, so no reserve");
  const on = resolveLLMConfig(
    req({ "x-llm-extra-body": '{"chat_template_kwargs":{"enable_thinking":true}}' }),
    BASE,
    undefined,
    2
  );
  assert.equal(on.maxTokens, maxTokensFor(2) + 1024, "thinking needs room to finish");
});

test("thinking that is explicitly requested widens the answer budget", () => {
  const config = resolveLLMConfig(req({ "x-llm-extra-body": '{"reasoning_effort":"high"}' }), BASE, undefined, 2);
  assert.equal(config.maxTokens, maxTokensFor(2) + 1024);
});

test("LLM_REASONING_EFFORT=none switches thinking off on a local backend", () => {
  // The bug this exists for: a Qwen3 model on LM Studio or vLLM reads the
  // standard `reasoning_effort`, not OpenRouter's `reasoning` object, so "none"
  // used to be accepted and then silently dropped.
  process.env.LLM_REASONING_EFFORT = "none";
  try {
    const config = getConfig();
    const resolved = resolveLLMConfig(req(), config, undefined, 2);
    assert.deepEqual(resolved.extraBody, { reasoning_effort: "none" });
    // Nothing is going to be spent thinking, so the budget is the answer alone.
    assert.equal(resolved.maxTokens, maxTokensFor(2));
  } finally {
    delete process.env.LLM_REASONING_EFFORT;
  }
});

test("an effort the backend may reject is not sent", () => {
  // LM Studio answers `reasoning_effort: "low"` with a 400, where sending
  // nothing keeps the request working. Only the disable direction is derived.
  const config = resolveLLMConfig(req({ "x-llm-reasoning-effort": "low" }), BASE, undefined, 2);
  assert.equal(config.extraBody, undefined);
  assert.equal(config.maxTokens, maxTokensFor(2) + 1024);
});

test("the effort header switches thinking off on a local backend", () => {
  const config = resolveLLMConfig(
    req({ "x-llm-reasoning-effort": "none" }),
    BASE,
    undefined,
    2
  );
  assert.deepEqual(config.extraBody, { reasoning_effort: "none" });
});

test("an effort header overrides a low env effort", () => {
  const configured: ServerConfig = { ...BASE, reasoning: { exclude: true, effort: "low" } };
  const off = resolveLLMConfig(req({ "x-llm-reasoning-effort": "none" }), configured);
  assert.deepEqual(off.extraBody, { reasoning_effort: "none" });
  assert.equal(resolveLLMConfig(req(), configured).extraBody, undefined);
});

test("extra body parameters pass through from the env and the header", () => {
  process.env.LLM_EXTRA_BODY = '{"thinking_token_budget":512}';
  try {
    const configured = getConfig();
    assert.deepEqual(configured.extraBody, { thinking_token_budget: 512 });
    assert.deepEqual(resolveLLMConfig(req(), configured).extraBody, {
      thinking_token_budget: 512,
    });
    // The header wins, and wins over the value xev derived.
    assert.deepEqual(
      resolveLLMConfig(
        req({
          "x-llm-extra-body": '{"reasoning_effort":"high"}',
          "x-llm-reasoning-effort": "none",
        }),
        configured
      ).extraBody,
      { reasoning_effort: "high" }
    );
  } finally {
    delete process.env.LLM_EXTRA_BODY;
  }
});

test("unusable extra body parameters are ignored, not guessed at", () => {
  process.env.LLM_EXTRA_BODY = "reasoning_effort=none";
  try {
    assert.equal(getConfig().extraBody, undefined);
  } finally {
    delete process.env.LLM_EXTRA_BODY;
  }
  assert.equal(
    resolveLLMConfig(req({ "x-llm-extra-body": "[1,2]" }), BASE).extraBody,
    undefined
  );
});

test("thinking that is explicitly requested widens the answer budget", () => {
  const config = resolveLLMConfig(req({ "x-llm-extra-body": '{"reasoning_effort":"high"}' }), BASE, undefined, 2);
  assert.equal(config.maxTokens, maxTokensFor(2) + 1024);
});

test("OpenRouter keeps the reasoning dialect and gains no extra body key", () => {
  const config = resolveLLMConfig(
    req({ "x-llm-reasoning-effort": "none" }),
    OPENROUTER,
    undefined,
    2
  );
  assert.deepEqual(config.reasoning, { exclude: true, effort: "none" });
  assert.equal(config.extraBody, undefined);
});

// ── Token cap ───────────────────────────────────────────────────────────────

test("the token cap is sized from the placeholder count when unset", () => {
  // Room for the answer plus the thinking reserve, which every backend gets.
  assert.equal(
    resolveLLMConfig(req(), BASE, undefined, 2).maxTokens,
    maxTokensFor(2) + 1024
  );
  // A 255-option question still fits in the answer budget.
  assert.ok(maxTokensFor(255) >= 255 * 6);
});

test("an explicit cap wins over the computed one", () => {
  // An explicit cap is the cap on the answer, so the reserve is not added to it.
  assert.equal(resolveLLMConfig(req({ "x-llm-max-tokens": "512" }), BASE, undefined, 2).maxTokens, 512);
  const withEnv: ServerConfig = { ...BASE, maxTokens: 256 };
  assert.equal(resolveLLMConfig(req(), withEnv, undefined, 2).maxTokens, 256);
});

// ── Startup banner ──────────────────────────────────────────────────────────

test("a wildcard bind is shown as localhost", () => {
  assert.equal(formatBaseUrl(undefined, 3000), "http://localhost:3000");
  assert.equal(formatBaseUrl("0.0.0.0", 8080), "http://localhost:8080");
  assert.equal(formatBaseUrl("::", 3000), "http://localhost:3000");
});

test("a specific host is used as given, IPv6 in brackets", () => {
  assert.equal(formatBaseUrl("127.0.0.1", 3000), "http://127.0.0.1:3000");
  assert.equal(formatBaseUrl("::1", 3000), "http://[::1]:3000");
});

test("the banner always shows something clickable", () => {
  // Without a TTY (pipes, CI) there are no escape codes, just the URL text.
  const link = hyperlink("http://localhost:3000/");
  assert.match(link, /http:\/\/localhost:3000\//);
});

// ── Environment parsing ─────────────────────────────────────────────────────

test("base URLs are normalized", () => {
  assert.equal(normalizeBaseUrl("http://x/v1///"), "http://x/v1");
  assert.equal(normalizeBaseUrl("http://x/v1"), "http://x/v1");
});

test("config falls back to the local defaults documented in .env.example", () => {
  for (const key of [
    "LLM_BASE_URL",
    "LLM_API_KEY",
    "LLM_MODEL",
    "LLM_TIMEOUT_MS",
    "LLM_MAX_RETRIES",
    "LLM_MAX_TOKENS",
    "CORS_ORIGIN",
    "RATE_LIMIT_RPM",
    "LLM_PROVIDER_ORDER",
    "LLM_DISCOVER_MODELS",
  ]) {
    delete process.env[key];
  }
  const config = getConfig();
  assert.equal(config.baseURL, "http://127.0.0.1:1234/v1");
  assert.equal(config.model, "qwen/qwen3.5-9b");
  assert.equal(config.discoverModels, false, "a fixed base URL has no catalog");
  assert.equal(config.rateLimitRpm, 0);
  assert.deepEqual(config.corsOrigins, []);
});

test("an OpenRouter base URL turns on model discovery", () => {
  process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
  try {
    assert.equal(getConfig().discoverModels, true);
    process.env.LLM_DISCOVER_MODELS = "false";
    assert.equal(getConfig().discoverModels, false);
  } finally {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_DISCOVER_MODELS;
  }
});

test("list and numeric env vars are parsed", () => {
  process.env.CORS_ORIGIN = "https://a.example, https://b.example";
  process.env.RATE_LIMIT_RPM = "12";
  process.env.LLM_PROVIDER_ORDER = "groq,fireworks";
  try {
    const config = getConfig();
    assert.deepEqual(config.corsOrigins, ["https://a.example", "https://b.example"]);
    assert.equal(config.rateLimitRpm, 12);
    assert.deepEqual(config.providerOrder, ["groq", "fireworks"]);
  } finally {
    delete process.env.CORS_ORIGIN;
    delete process.env.RATE_LIMIT_RPM;
    delete process.env.LLM_PROVIDER_ORDER;
  }
});
