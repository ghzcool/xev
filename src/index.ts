import express, { type NextFunction, type Request, type Response } from "express";
import path from "path";
import { evaluate } from "./evaluate";
import {
  ConfigError,
  formatBaseUrl,
  getConfig,
  hyperlink,
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
  const outcome = await evaluate(req.body, { headers: req.headers });
  if (!outcome.ok) {
    res.status(outcome.status).json({ error: outcome.error, details: outcome.details });
    return;
  }
  res.json(outcome.response);
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
const HOST = process.env.HOST || undefined;

export function banner(base: string): string {
  const rows: [string, string][] = [
    ["Demo page", hyperlink(`${base}/`)],
    ["Health", hyperlink(`${base}/health`)],
    ["Models", hyperlink(`${base}/v1/models`)],
    ["Evaluate", `${hyperlink(`${base}/v1/systemone`)}  (POST)`],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)
    .join("\n");
}

const config = getConfig();

export function start(port = PORT, host: string | undefined = HOST): void {
  const base = formatBaseUrl(host, port);
  const ready = () => {
    console.log(`\nXev is running\n`);
    console.log(banner(base));
    console.log(`\n  LLM        ${config.model}`);
    console.log(`  Backend    ${config.baseURL}`);
    if (isOpenRouter(config.baseURL)) {
      const effort = config.reasoning.effort ? `, effort ${config.reasoning.effort}` : "";
      console.log(`  Reasoning  kept out of the response${effort}`);
    } else {
      // Non-router backends get `reasoning_effort` instead, so say which one
      // this server ends up being asked for. An unset effort means the model
      // decides, which is worth knowing before it spends the answer budget.
      const derived =
        config.reasoning.effort === "none" ? { reasoning_effort: "none" } : undefined;
      const extra = { ...derived, ...config.extraBody };
      console.log(
        `  Reasoning  ${Object.keys(extra).length > 0 ? JSON.stringify(extra) : "up to the model"}`
      );
    }
    console.log(`\n  Open the demo page above. Ctrl+C to stop.\n`);
  };

  const server = host ? app.listen(port, host, ready) : app.listen(port, ready);
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${port} is already in use. Set PORT to pick another one: PORT=3001 npm start`
      );
      process.exit(1);
    }
    throw err;
  });
}

if (require.main === module) start();

export { app };
export default app;
