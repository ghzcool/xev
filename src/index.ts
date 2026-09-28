import express, { type NextFunction, type Request, type Response } from "express";
import path from "path";
import { validateRequest } from "./validate";
import { buildPrompt, buildPlaceholderMap } from "./prompt";
import { callLLM, llmErrorStatus } from "./llm";
import { parseResponse, LLMResponseError } from "./parser";
import {
  ConfigError,
  getConfig,
  isOpenRouter,
  normalizeBaseUrl,
  resolveLLMConfig,
  type ServerConfig,
} from "./config";

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── CORS (off unless CORS_ORIGIN is set) ────────────────────────────────────
// Browser clients calling /v1/systemone cross origins, and TypeSafe's real API
// allows that, so a drop-in replacement should too.
const serverConfig = getConfig();

if (serverConfig.corsOrigins.length > 0) {
  const allowAll = serverConfig.corsOrigins.includes("*");
  const allowed = new Set(serverConfig.corsOrigins);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && (allowAll || allowed.has(origin))) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, x-llm-base-url, x-llm-api-key, x-llm-model, x-llm-referer, x-llm-title, x-llm-provider-order, x-llm-provider-fallbacks, x-llm-data-collection, x-llm-max-tokens"
      );
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    }
    next();
  });
}

// ── Rate limiting (off unless RATE_LIMIT_RPM is set) ────────────────────────
// Every evaluation is a paid LLM call, so an unbounded endpoint is a liability.
if (serverConfig.rateLimitRpm > 0) {
  const limit = serverConfig.rateLimitRpm;
  const hits = new Map<string, number[]>();
  app.post("/v1/systemone", (req, res, next) => {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limit) {
      const retryAfter = Math.ceil((60_000 - (now - recent[0])) / 1000);
      res.set("Retry-After", String(Math.max(1, retryAfter)));
      res.status(429).json({ error: `Rate limit reached: ${limit} requests per minute` });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    for (const [k, v] of hits) {
      if (v.every((t) => now - t >= 60_000)) hits.delete(k);
    }
    next();
  });
}

// Serve static files from public/
app.use(express.static(path.join(__dirname, "..", "public")));

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "xev" });
});

// Models endpoint - TypeSafe-compatible shape: { models: [{ name, description, release_date }] }
// release_date is the date this xev deployment started serving the model; the
// backend model's own release date is not knowable from an OpenAI-compatible API.
const SERVING_SINCE = new Date().toISOString().slice(0, 10);

interface ModelEntry {
  name: string;
  description: string;
  release_date: string;
}

function configuredModelEntry(config: ServerConfig): ModelEntry {
  return {
    name: config.model,
    description: "Model configured for xev via LLM_MODEL",
    release_date: SERVING_SINCE,
  };
}

// Routers such as OpenRouter publish a catalog at {baseURL}/models. Serving it
// in TypeSafe's shape lets clients pick a model without leaving the API.
const modelCache: { at: number; value: ModelEntry[] | null } = {
  at: 0,
  value: null,
};
const MODEL_CACHE_MS = 5 * 60 * 1000;

async function fetchProviderModels(config: ServerConfig): Promise<ModelEntry[] | null> {
  if (Date.now() - modelCache.at < MODEL_CACHE_MS) return modelCache.value;

  const cached = modelCache.value;
  modelCache.at = Date.now();
  modelCache.value = null; // drop first: a failed refresh must not pin a bad list

  try {
    const res = await fetch(`${normalizeBaseUrl(config.baseURL)}/models`, {
      headers: {
        Accept: "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
    });
    if (!res.ok) return cached;
    const body = (await res.json()) as {
      data?: { id: string; name?: string; context_length?: number; created?: number }[];
    };
    const models = (body.data ?? []).filter((m) => m && typeof m.id === "string");
    if (models.length === 0) return cached;

    modelCache.value = models.map((m) => ({
      name: m.id,
      description: `${m.name ?? m.id}${m.context_length ? ` (${Math.round(m.context_length / 1000)}k context)` : ""}`,
      release_date: m.created
        ? new Date(m.created * 1000).toISOString().slice(0, 10)
        : SERVING_SINCE,
    }));
    return modelCache.value;
  } catch {
    return cached;
  }
}

app.get("/v1/models", async (_req, res) => {
  const config = getConfig();
  if (!config.discoverModels) {
    res.json({ models: [configuredModelEntry(config)] });
    return;
  }
  const models = await fetchProviderModels(config);
  res.json({ models: models ?? [configuredModelEntry(config)] });
});

// Main evaluation endpoint - mirrors TypeSafe API
app.post("/v1/systemone", async (req, res) => {
  const serverCfg = getConfig();

  const validation = validateRequest(req.body);
  if (!validation.success) {
    res.status(validation.error.status).json({
      error: validation.error.error,
      details: validation.error.details,
    });
    return;
  }

  const { state, model, questions } = validation.data;

  try {
    const llmConfig = resolveLLMConfig(
      req,
      serverCfg,
      model,
      buildPlaceholderMap(questions).length
    );
    const prompt = buildPrompt(state, questions);
    const result = await callLLM(prompt, llmConfig);

    const transportWarnings: string[] = [];
    if (result.hadReasoning) {
      transportWarnings.push(
        `the model returned a thinking trace alongside its answer (${result.usage.reasoning_tokens} reasoning tokens); check the values`
      );
    }
    if (result.truncated) {
      transportWarnings.push(
        "the model's answer was cut off (finish_reason: length); some values are missing"
      );
    }

    const response = parseResponse(
      questions,
      result.content,
      llmConfig.model,
      result.usage,
      { warnings: transportWarnings }
    );

    res.json(response);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    // The caller's request was valid; the model or the upstream server failed.
    const status = err instanceof LLMResponseError ? 502 : llmErrorStatus(err);
    console.error(`Evaluation error (${status}):`, message);
    res.status(status).json({
      error: status === 504 ? `LLM request timed out: ${message}` : `Evaluation failed: ${message}`,
    });
  }
});

// Proxy endpoint for chat completions (avoids CORS issues from browser)
app.post("/v1/proxy/chat/completions", async (req, res) => {
  try {
    const llmConfig = resolveLLMConfig(req, getConfig());
    const response = await fetch(`${normalizeBaseUrl(llmConfig.baseURL)}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${llmConfig.apiKey}`,
        ...(llmConfig.referer ? { "HTTP-Referer": llmConfig.referer } : {}),
        ...(llmConfig.title ? { "X-Title": llmConfig.title } : {}),
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.text();
    res.status(response.status).set("Content-Type", "application/json").send(data);
  } catch (err: unknown) {
    if (err instanceof ConfigError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `LLM proxy error: ${message}` });
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler. Without this, express.json failures (bad JSON, oversized
// bodies) and anything thrown in a handler return an HTML page with a stack
// trace, which breaks the { error } contract and leaks server paths.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    err instanceof ConfigError
      ? err.status
      : typeof (err as { status?: unknown })?.status === "number"
        ? ((err as { status: number }).status >= 400 &&
            (err as { status: number }).status < 600
            ? (err as { status: number }).status
            : 500)
        : 500;

  const message =
    err instanceof Error
      ? status < 500
        ? err.message
        : "Internal server error"
      : "Internal server error";

  if (status >= 500) {
    console.error("Unhandled error:", err);
  }
  res.status(status).json({ error: message });
});

const PORT = parseInt(process.env.PORT || "3000", 10);

app.listen(PORT, () => {
  const config = getConfig();
  console.log(`Xev server running on port ${PORT}`);
  console.log(`Using LLM: ${config.model} at ${config.baseURL}`);
  if (isOpenRouter(config.baseURL)) {
    console.log(`OpenRouter detected: /v1/models lists the router's catalog`);
  }
  console.log(`POST /v1/systemone - evaluate state against questions`);
});

export default app;
