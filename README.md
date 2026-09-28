# xev

Jev-like wrapper for any LLM. Drop-in replacement for TypeSafe's Jev API that uses any OpenAI-compatible LLM as the backend.

## Overview

Xev accepts the same request format as TypeSafe's [System One API](https://docs.typesafe.ai/api) and returns the same response structure, but uses any LLM (GPT-4o, Claude, Llama, LM Studio, Ollama, etc.) to evaluate your questions.

**Supported question types:**
- **Choice** - Pick one option from a defined set (returns choice, probabilities, confidence)
- **Score** - Rate content against ordered levels (returns score, legend, probabilities, confidence)
- **Noul** - Yes/no evaluation (returns noul 0-1)

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your LLM settings
npm run dev
# Open http://localhost:3000
```

On startup the server prints clickable links (OSC 8 hyperlinks where the terminal supports them,
plain text otherwise):

```
Xev is running

  Demo page  http://localhost:3000/
  Health     http://localhost:3000/health
  Models     http://localhost:3000/v1/models
  Evaluate   http://localhost:3000/v1/systemone  (POST)

  LLM        qwen/qwen3.5-9b
  Backend    http://127.0.0.1:1234/v1

  Open the demo page above. Ctrl+C to stop.
```

## Configuration

Set environment variables in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible API base URL |
| `LLM_API_KEY` | (empty) | API key for the LLM provider |
| `LLM_MODEL` | `qwen/qwen3.5-9b` | Model to use for evaluations |
| `LLM_TIMEOUT_MS` | `120000` | Give up on the LLM after this long |
| `LLM_MAX_RETRIES` | `2` | Retries for a failed LLM call |
| `LLM_MAX_TOKENS` | `0` (auto) | Cap on the answer; 0 sizes it from the question count |
| `LLM_PROVIDER_ORDER` | (empty) | OpenRouter upstream provider order, e.g. `groq,together` |
| `LLM_DATA_COLLECTION` | (empty) | Set to `deny` to use only providers that don't train on prompts |
| `LLM_REASONING_EXCLUDE` | `true` | Ask OpenRouter not to return the thinking trace |
| `LLM_REASONING_EFFORT` | (empty) | `none` to skip thinking, or `minimal`/`low`/`medium`/`high` to allow some |
| `LLM_REASONING_MAX_TOKENS` | (empty) | Hard cap on thinking tokens |
| `OPENROUTER_REFERER` | `http://localhost:3000` | OpenRouter app attribution |
| `OPENROUTER_TITLE` | `xev` | OpenRouter app attribution |
| `LLM_DISCOVER_MODELS` | auto | Serve the backend catalog at `/v1/models` (auto for routers) |
| `CORS_ORIGIN` | (empty) | Comma-separated browser origins, or `*`; empty sends no CORS headers |
| `RATE_LIMIT_RPM` | `0` (off) | Requests per minute per client on `/v1/systemone` |
| `PORT` | `3000` | Server port |
| `HOST` | (all interfaces) | Interface to bind; the startup banner links `localhost` unless set |

Works with any OpenAI-compatible API: LM Studio, Ollama, OpenAI, vLLM, OpenRouter, etc.

## OpenRouter

Point xev at OpenRouter and use any model in its catalog:

```bash
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=anthropic/claude-sonnet-4
```

Model ids are OpenRouter's (`vendor/model`, optionally `:free`). `GET /v1/models` returns the
router's catalog in TypeSafe's shape, so clients can discover models through xev:

```bash
curl http://localhost:3000/v1/models
```

OpenRouter-specific options, all ignored by other backends:

- `LLM_PROVIDER_ORDER=groq,together` — prefer these upstream providers, in that order
- `LLM_DATA_COLLECTION=deny` — only use providers that do not train on your prompts
- `OPENROUTER_REFERER` / `OPENROUTER_TITLE` — app attribution (sent as `HTTP-Referer` and `X-Title`)

### Reasoning models

Models like `deepseek/deepseek-r1`, `qwen/qwq-*`, Gemini thinking models and Nemotron reason
before answering, and those tokens are billed and **count against the same `max_tokens` budget**.
Left alone, a thinking model can spend the whole budget thinking and return
`finish_reason: length` with no answer at all.

xev handles this three ways:

1. **`reasoning.exclude: true`** (on by default for OpenRouter) — the model may think, but the trace
   is not returned, so only the answer list reaches the parser.
2. **A wider `max_tokens`** — the answer budget is added to a reasoning reserve, so thinking cannot
   starve the answer.
3. **Recovery and honest errors** — reasoning returned in a separate `reasoning` /
   `reasoning_content` field is ignored, `<think>…</think>` blocks inlined in the answer are stripped,
   and if a response was all thinking the error says so with the token counts instead of reporting
   "no index:value pairs found".

To make it faster, cap or switch off the thinking:

```bash
LLM_REASONING_EFFORT=none     # no thinking at all, where the model supports it
LLM_REASONING_EFFORT=low      # a little thinking
LLM_REASONING_MAX_TOKENS=2048 # hard cap
LLM_REASONING_EXCLUDE=false   # return the trace, for debugging
```

Set these in `.env` rather than per request. Models that require reasoning (`mandatory` in the
`/v1/models` entry) reject `effort: "none"`; `low` and `minimal` are the safe choices there.
When a model does return a thinking trace next to its answer, the response carries a `warnings`
entry saying the values came from a reasoned response.

Any request can override the connection with headers:

| Header | Purpose |
|--------|---------|
| `x-llm-base-url` | Use a different backend for this request |
| `x-llm-api-key` | Key for that backend (**required** when the base URL is not the server's) |
| `x-llm-model` | Model for this request |
| `x-llm-referer`, `x-llm-title` | OpenRouter attribution |
| `x-llm-provider-order` | OpenRouter provider order |
| `x-llm-provider-fallbacks` | `true`/`false` |
| `x-llm-data-collection` | `allow`/`deny` |
| `x-llm-reasoning-effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `x-llm-reasoning-max-tokens` | Cap on thinking tokens |
| `x-llm-reasoning-exclude` | `true`/`false` |
| `x-llm-max-tokens` | Answer token cap |

xev only ever sends its own `LLM_API_KEY` to the base URL it is configured for. A request that
redirects to a different host must supply its own key, so the server's credentials can't be
handed to a host named by a caller.

## Demo Page

Open `http://localhost:3000` in your browser for a testing UI with:
- Configurable LLM connection (base URL, model, API key) with presets for local, OpenRouter, and OpenAI
- State textarea with presets (Support Ticket, Code Review, Email Triage)
- Save your own presets by name, reload them later, and remove them with the "×" on the chip
- Question builder for Choice, Score, and Noul types
- Live request preview
- Response viewer that flags incomplete answers, with probabilities and confidence

All values, including saved presets, are saved in localStorage.

## API

### `POST /v1/systemone`

Send state and typed questions, get structured answers.

**Request:**
```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "gpt-4o",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payment or subscription issues",
        "technical": "Bugs or integration problems",
        "sales": "Pricing or account questions"
      }
    },
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?"
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

**Response:**
```json
{
  "model": "xev-gpt-4o",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "technical",
      "probabilities": { "technical": 0.85, "sales": 0.0, "billing": 0.15 },
      "confidence": 0.78
    },
    "is_urgent": {
      "type": "noul",
      "noul": 0.95
    },
    "frustration": {
      "type": "score",
      "score": 1.05,
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
      "confidence": 0.93
    }
  },
  "usage": { "input_tokens": 392, "output_tokens": 65 }
}
```

### `GET /health`

Returns `{ "status": "ok", "service": "xev" }`.

### `GET /v1/models`

Returns the configured model in TypeSafe's documented shape:

```json
{ "models": [{ "name": "qwen/qwen3.5-9b", "description": "Model configured for xev via LLM_MODEL", "release_date": "2026-09-28" }] }
```

When the backend is a router (OpenRouter) or `LLM_DISCOVER_MODELS` is on, the upstream catalog is
served instead, cached for 5 minutes, falling back to the configured model if the router is
unreachable.

### `POST /v1/proxy/chat/completions`

Proxies chat completion requests to the configured LLM. Used by the demo page to avoid CORS issues. Accepts optional headers:
- `x-llm-base-url` - override `LLM_BASE_URL`
- `x-llm-api-key` - override `LLM_API_KEY`

### Errors

| Status | Meaning |
|--------|---------|
| `400` | Malformed JSON body, or a bad `x-llm-*` header value |
| `422` | Request failed validation (includes the offending field) |
| `429` | Rate limited, or the LLM provider rate limited us (`Retry-After` set) |
| `502` | The LLM failed, or its answer could not be parsed |
| `504` | The LLM timed out |

The body is always JSON: `{ "error": "..." }`, plus `details` for validation failures.

### Incomplete answers

If the model leaves values out — or returns only zeros — xev still returns a normalized answer, but
says so:

```json
{
  "answers": { "department": { "choice": "billing", "probabilities": { "billing": 0.34 }, "confidence": 0 } },
  "warnings": ["question \"department\": every value the model returned was 0; answered with a uniform distribution (confidence 0)"]
}
```

`warnings` is an xev extension: it is omitted entirely when the answer was complete, so clients that
ignore unknown fields are unaffected.

### Limits

- At least one question is required; an empty `questions` object is a 422.
- Choice: 1-255 options; Score: 2-10 levels. Violations are rejected with HTTP 422.
- Probabilities are reported with 2 decimals and always sum to 1.
- `confidence` = `clamp01((n * max_probability - 1) / (n - 1))`, computed on full-precision probabilities — Jev's formula.
- Score `legend` is returned as the criteria you sent: strings stay strings, object/array levels stay structured.

## Usage with curl

```bash
curl -X POST http://localhost:3000/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "state": "My running shoes arrived in the wrong size.",
    "model": "gpt-4o",
    "questions": {
      "department": {
        "type": "choice",
        "instructions": "Which team should handle this?",
        "criteria": {
          "returns": "Exchanges, wrong or damaged items",
          "shipping": "Delivery status, delays",
          "billing": "Charges, invoices, payment problems"
        }
      }
    }
  }'
```

## How It Works

1. Receives a TypeSafe-compatible request with state + questions
2. Builds a prompt with a response template whose values are indexed placeholders (`${0}`, `${1}`, ...); questions are labeled `q0`, `q1`, ... so your question ids never reach the model
3. LLM answers with a `;`-separated `index:value` list, e.g. `0:0.1;1:0.234;2:0;3:1` (filled-in JSON is accepted as a fallback)
4. Parser maps each index back to its question, coerces strings to numbers, clamps and normalizes probabilities, computes confidence, then rounds reported probabilities to 2 decimals so they still sum to 1
5. Returns a TypeSafe-compatible response, with a `warnings` array if the model's answer was incomplete

## Development

```bash
npm test    # 82 unit tests (node:test, no extra dependencies)
npm run build
```

Tests cover the parser's Jev-parity math (normalization, largest-remainder rounding, confidence
ordering), prompt/parser placeholder agreement, the validation limits, credential handling, and the
LLM client's request and response handling against a mock server.

## License

MIT
