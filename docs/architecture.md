# Architecture

> When the request lifecycle, data flow, or integration patterns change, update this document.

## Overview

Xev is an HTTP server that translates TypeSafe's System One API format into LLM calls and back. It acts as a compatibility layer: clients send the same request they would send to TypeSafe, and Xev uses any OpenAI-compatible LLM to produce the answers.

A demo page is served at the root URL for browser-based testing. The demo proxies LLM calls through the Node server to avoid CORS issues.

## Request Lifecycle

```
Client Request (POST /v1/systemone)
     │
     ▼
┌─────────────┐
│  validate    │  Zod schema check on request body
└─────┬───────┘
      │ valid
      ▼
┌─────────────┐
│   prompt     │  Build prompt with JSON template (zero placeholders)
└─────┬───────┘
      │
      ▼
┌─────────────┐
│     llm      │  Call OpenAI-compatible API
└─────┬───────┘
      │
      ▼
┌─────────────┐
│   parser     │  Coerce strings→numbers, normalize probabilities, compute confidence
└─────┬───────┘
      │
      ▼
Client Response
```

## Proxy Flow (Demo Page)

```
Browser Demo ──POST──▶ /v1/proxy/chat/completions ──POST──▶ LLM Server
                       (Node server)                        (LM Studio, etc.)
```

The demo page sends requests through the Node server proxy to avoid CORS.
The proxy accepts optional headers to override server-side config:
- `x-llm-base-url` - overrides `LLM_BASE_URL` env var
- `x-llm-api-key` - overrides `LLM_API_KEY` env var

## Data Flow

1. **Request** arrives as JSON matching `SystemOneRequest` (state + questions map)
2. **Validation** checks required fields and question type constraints
3. **Prompt builder** serializes state and questions, then generates an exact JSON template with `0` placeholders that the LLM fills in
4. **LLM client** sends the prompt to the configured provider
5. **Parser** extracts JSON, coerces string values to numbers, normalizes probabilities per question type, computes confidence from entropy
6. **Response** is returned in `SystemOneResponse` format

## Key Design Decisions

- **Single prompt for all questions**: All questions are sent in one LLM call, not one per question. This mirrors how TypeSafe works (parallel evaluation) and reduces latency.
- **Temperature 0**: Deterministic output from the LLM for reproducible results.
- **JSON template prompts**: The prompt includes an exact JSON object with `0` placeholders. The LLM replaces the zeros with its answers. This produces more reliable JSON than describing the structure.
- **String coercion**: The parser converts string numbers (e.g., `"0.5"`) to actual numbers, since some LLMs return quoted numbers.
- **No response_format**: `response_format: { type: "json_object" }` is not used because many local LLM servers (LM Studio, Ollama) don't support it. Instead, the prompt instructs the LLM to return raw JSON, and the parser extracts it with regex.
- **Proxy endpoint**: The demo page routes LLM calls through the Node server (`/v1/proxy/chat/completions`) to avoid CORS issues with local LLM servers.
- **Probability normalization**: LLM outputs are normalized to sum to 1.0 for each question, fixing any drift from the LLM.
- **Confidence via entropy**: Confidence is derived from the entropy of the probability distribution, not from the LLM's self-assessment.

## Integration Points

| System | Protocol | Purpose |
|--------|----------|---------|
| OpenAI-compatible LLM | HTTP/HTTPS | Backend for question evaluation |
| Client applications | HTTP | Accept TypeSafe-format requests |
| Demo page (browser) | HTTP | Testing UI, served as static files |

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Demo page (static HTML) |
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List configured model |
| `POST` | `/v1/systemone` | Main evaluation endpoint |
| `POST` | `/v1/proxy/chat/completions` | LLM proxy (used by demo page) |

## Adding a New Question Type

1. Add the question type to `types.ts` (schema + TypeScript type)
2. Add prompt instructions in `prompt.ts` (`questionToPrompt` function)
3. Add template generation in `prompt.ts` (`buildPrompt` function)
4. Add parsing logic in `parser.ts` (new parse function, add to `parseResponse`)
5. Update this document and `structure.md`
