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
│   prompt     │  Build prompt with response template (${0}, ${1}, ...)
└─────┬───────┘
      │
      ▼
┌─────────────┐
│     llm      │  Call OpenAI-compatible API, return raw text
└─────┬───────┘
      │
      ▼
┌─────────────┐
│   parser     │  Parse `index:value;` pairs (JSON fallback), normalize, confidence
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
3. **Prompt builder** serializes state and questions, then generates a response template whose values are indexed placeholders (`${0}`, `${1}`, ...), defined by `buildPlaceholderMap`. Questions appear as `q0`, `q1`, ... — the caller's question ids are never sent to the model
4. **LLM client** sends the prompt and returns the raw response text (code fences stripped)
5. **Parser** resolves the text to values: it reads `;`-separated `index:value` pairs first and maps each index back to its question field through `buildPlaceholderMap`, falling back to a JSON object (with `qN` keys mapped back to question ids) when there are no pairs; coerces string values to numbers, clamps negatives to 0 and normalizes probabilities per question type, computes confidence as `clamp01((n * max_probability - 1) / (n - 1))` on the full-precision distribution, then rounds probabilities to 2 decimals so they still sum to exactly 1
6. **Response** is returned in `SystemOneResponse` format

## Key Design Decisions

- **Single prompt for all questions**: All questions are sent in one LLM call, not one per question. This mirrors how TypeSafe works (parallel evaluation) and reduces latency.
- **Temperature 0**: Deterministic output from the LLM for reproducible results.
- **Indexed placeholder templates**: The prompt includes a response template whose values are `${0}`, `${1}`, ... placeholders. The LLM answers with a short `;`-separated `index:value` list instead of regenerating the whole structure, which avoids malformed JSON and keeps responses small.
- **String coercion**: The parser converts string numbers (e.g., `"0.5"`) to actual numbers, since some LLMs return quoted numbers (mainly in the JSON fallback path).
- **No response_format**: `response_format: { type: "json_object" }` is not used because many local LLM servers (LM Studio, Ollama) don't support it. Instead, the prompt instructs the LLM to return a bare `index:value` list, and the parser extracts it with regex. If the response contains a JSON object instead, the parser accepts it as a fallback.
- **Proxy endpoint**: The demo page routes LLM calls through the Node server (`/v1/proxy/chat/completions`) to avoid CORS issues with local LLM servers.
- **Probability normalization**: LLM outputs are clamped at 0 and normalized to sum to 1.0 for each question, fixing any drift from the LLM. Before returning, probabilities are rounded to 2 decimals with a largest-remainder method so they still sum to exactly 1, matching how Jev reports them.
- **Confidence via peak rescaling**: Confidence is `clamp01((n * max_probability - 1) / (n - 1))` computed on full-precision probabilities — Jev's documented formula — not an entropy measure and not an LLM self-assessment.
- **Question ids stay client-side**: Questions are labeled `q0`, `q1`, ... in the prompt, so the model never sees caller-defined ids (Jev behaves the same way). The parser maps aliases back through `buildAliasMap`.
- **Legend passthrough**: Score legends are built from the criteria as given. String levels stay strings; object/array levels stay structured objects, exactly as Jev returns them.
- **Validation limits**: Choice accepts 1-255 options and Score 2-10 levels, per TypeSafe's documented limits; violations are rejected with HTTP 422.
- **TypeSafe-shaped model list**: `GET /v1/models` returns `{ models: [{ name, description, release_date }] }`, the documented Jev shape, rather than the OpenAI `{ data: [...] }` shape.

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
| `GET` | `/v1/models` | List configured model in TypeSafe's `{ models: [{ name, description, release_date }] }` shape |
| `POST` | `/v1/systemone` | Main evaluation endpoint |
| `POST` | `/v1/proxy/chat/completions` | LLM proxy (used by demo page) |

## Adding a New Question Type

1. Add the question type to `types.ts` (schema + TypeScript type)
2. Add prompt instructions in `prompt.ts` (`questionToPrompt` function)
3. Add placeholders in `prompt.ts` (`buildPlaceholderMap`, and the shape in `buildTemplate`)
4. Add parsing logic in `parser.ts` (new parse function, add to `parseResponse`)
5. Update this document and `structure.md`
