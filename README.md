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

## Configuration

Set environment variables in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `http://127.0.0.1:1234/v1` | OpenAI-compatible API base URL |
| `LLM_API_KEY` | (empty) | API key for the LLM provider |
| `LLM_MODEL` | `qwen/qwen3.5-9b` | Model to use for evaluations |
| `PORT` | `3000` | Server port |

Works with any OpenAI-compatible API: LM Studio, Ollama, OpenAI, vLLM, etc.

## Demo Page

Open `http://localhost:3000` in your browser for a testing UI with:
- Configurable LLM connection (base URL, model, API key)
- State textarea with presets (Support Ticket, Code Review, Email Triage)
- Question builder for Choice, Score, and Noul types
- Live request preview
- Response viewer with probabilities and confidence

All values are saved in localStorage.

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

### Limits

- Choice: 1-255 options; Score: 2-10 levels. Violations are rejected with HTTP 422.
- Probabilities are reported with 2 decimals and always sum to 1.
- `confidence` = `clamp01((n * max_probability - 1) / (n - 1))`, computed on full-precision probabilities — Jev's formula.
- Score `legend` is returned as the criteria you sent: strings stay strings, object/array levels stay structured.

### `POST /v1/proxy/chat/completions`

Proxies chat completion requests to the configured LLM. Used by the demo page to avoid CORS issues. Accepts optional headers:
- `x-llm-base-url` - override `LLM_BASE_URL`
- `x-llm-api-key` - override `LLM_API_KEY`

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
5. Returns a TypeSafe-compatible response

## License

MIT
