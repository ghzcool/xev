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
| `LLM_MODEL` | `google/gemma-4-26b-a4b-qat` | Model to use for evaluations |
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
      "confidence": 0.81,
      "probabilities": { "technical": 0.85, "sales": 0.0, "billing": 0.15 }
    },
    "is_urgent": {
      "type": "noul",
      "noul": 0.95
    },
    "frustration": {
      "type": "score",
      "score": 1.05,
      "confidence": 0.92,
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 }
    }
  },
  "usage": { "input_tokens": 392, "output_tokens": 65 }
}
```

### `GET /health`

Returns `{ "status": "ok", "service": "xev" }`.

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
2. Builds a prompt with an exact JSON template (zero placeholders) for the LLM to fill
3. LLM returns probabilities/values in the template format
4. Parser coerces strings to numbers, normalizes probabilities, computes confidence
5. Returns a TypeSafe-compatible response

## License

MIT
