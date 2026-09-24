# xev

Jev-like wrapper for any LLM. Drop-in replacement for TypeSafe's Jev API that uses any OpenAI-compatible LLM as the backend.

## Overview

Xev accepts the same request format as TypeSafe's [System One API](https://docs.typesafe.ai/api) and returns the same response structure, but uses any LLM (GPT-4o, Claude, Llama, etc.) to evaluate your questions.

**Supported question types:**
- **Choice** - Pick one option from a defined set (returns choice, probabilities, confidence)
- **Score** - Rate content against ordered levels (returns score, legend, probabilities, confidence)
- **Noul** - Yes/no evaluation (returns noul 0-1)

## Quick Start

```bash
npm install
cp .env.example .env
# Edit .env with your LLM API key
npm run dev
```

## Configuration

Set environment variables in `.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible API base URL |
| `LLM_API_KEY` | - | API key for the LLM provider |
| `LLM_MODEL` | `gpt-4o` | Model to use for evaluations |
| `PORT` | `3000` | Server port |

Works with any OpenAI-compatible API: OpenAI, Anthropic (via proxy), Ollama, vLLM, etc.

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
2. Builds a structured prompt asking the LLM to evaluate each question
3. LLM returns probabilities/values for each question
4. Parser normalizes probabilities, computes confidence scores
5. Returns a TypeSafe-compatible response

## License

MIT
