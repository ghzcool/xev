import express from "express";
import path from "path";
import { validateRequest } from "./validate";
import { buildPrompt } from "./prompt";
import { callLLM, type LLMClientConfig } from "./llm";
import { parseResponse } from "./parser";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Serve static files from public/
app.use(express.static(path.join(__dirname, "..", "public")));

function getConfig(): LLMClientConfig {
  return {
    baseURL: process.env.LLM_BASE_URL || "https://api.openai.com/v1",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "gpt-4o",
  };
}

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "xev" });
});

// Models endpoint (for compatibility)
app.get("/v1/models", (_req, res) => {
  const config = getConfig();
  res.json({
    data: [
      {
        id: config.model,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "xev",
      },
    ],
  });
});

// Main evaluation endpoint - mirrors TypeSafe API
app.post("/v1/systemone", async (req, res) => {
  const config = getConfig();

  if (!config.apiKey) {
    res.status(500).json({
      error: "LLM_API_KEY environment variable is not set",
    });
    return;
  }

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
    // Use the model from request if it looks like a real model name,
    // otherwise fall back to env config
    const effectiveModel =
      model && model !== "jev-latest" ? model : config.model;

    const prompt = buildPrompt(state, questions);

    const llmConfig = { ...config, model: effectiveModel };
    const result = await callLLM(prompt, llmConfig);

    const response = parseResponse(
      questions,
      result.output,
      effectiveModel,
      result.usage
    );

    res.json(response);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Evaluation error:", message);
    res.status(500).json({
      error: `Evaluation failed: ${message}`,
    });
  }
});

// Proxy endpoint for chat completions (avoids CORS issues from browser)
// Accepts x-llm-base-url and x-llm-api-key headers to override server config
app.post("/v1/proxy/chat/completions", async (req, res) => {
  const serverConfig = getConfig();
  const llmBase = (req.headers["x-llm-base-url"] as string || serverConfig.baseURL).replace(/\/+$/, "");
  const apiKey = (req.headers["x-llm-api-key"] as string) || serverConfig.apiKey || "no-key";

  try {
    const response = await fetch(`${llmBase}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.text();
    res.status(response.status).set("Content-Type", "application/json").send(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `LLM proxy error: ${message}` });
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

const PORT = parseInt(process.env.PORT || "3000", 10);

app.listen(PORT, () => {
  console.log(`Xev server running on port ${PORT}`);
  console.log(
    `Using LLM: ${process.env.LLM_MODEL || "gpt-4o"} at ${process.env.LLM_BASE_URL || "https://api.openai.com/v1"}`
  );
  console.log(`POST /v1/systemone - evaluate state against questions`);
});

export default app;
