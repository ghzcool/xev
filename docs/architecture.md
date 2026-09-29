# Architecture

> When the request lifecycle, data flow, or integration patterns change, update this document.

## Overview

Xev is an HTTP server that translates TypeSafe's System One API format into LLM calls and back. It acts as a compatibility layer: clients send the same request they would send to TypeSafe, and Xev uses any OpenAI-compatible LLM to produce the answers.

A demo page is served at the root URL for browser-based testing. The demo proxies LLM calls through the Node server to avoid CORS issues.

Xev also runs as an MCP server, so agent tools (opencode, Claude Desktop, Cursor, and anything else that speaks MCP) can evaluate without an HTTP round trip or a running server.

## Front Doors

There are two, and they share one pipeline:

```
HTTP client ──POST /v1/systemone──▶ index.ts  ─┐
                                               ├─▶ evaluate() ─▶ validate → config → prompt → llm → parse
MCP client ──tools/call xev_evaluate──▶ mcp/ ───┘
```

`evaluate.ts` owns the pipeline and knows nothing about either transport. The HTTP route is a thin
adapter that maps an `EvaluateOutcome` to a status code and a body; the MCP tool maps it to a
`CallToolResult` with a readable digest and the structured response. A caller cannot get different
behavior, different validation, or different error messages by choosing a door.

`config.ts` is reached from both, and so the credential guard is not bypassable by arriving over
MCP: an MCP tool call has no header path, so the server's key can only ever go to its configured
host.

## MCP Server

Started with `npm run mcp` (from source) or `npm run mcp:start` (from `dist/`). It speaks JSON-RPC
over stdio and is launched as a child process by the client, which configures it entirely through
the environment it inherits:

```json
{
  "mcp": {
    "xev": {
      "type": "local",
      "command": ["node", "/path/to/xev/dist/mcp/index.js"],
      "environment": { "LLM_BASE_URL": "...", "LLM_MODEL": "...", "LLM_API_KEY": "..." }
    }
  }
}
```

The same `LLM_*` variables as the HTTP server apply, because both call `getConfig()`. There is no
MCP-specific configuration.

**Tools:** one, `xev_evaluate`.

| Tool | Input | Output |
|------|-------|--------|
| `xev_evaluate` | `state` (required), `questions` (required), `model` (optional) | `SystemOneResponse` |

**Input schema.** `state` is typed exactly as the API contract types it (a string, object, or
array), which puts it in the published schema's `required` list so strict tool-calling clients
cannot send a request with no state. `questions` is a `record` of anything: the three question
shapes are documented in the tool description in prose, and the actual check is `validateRequest`,
the same one the HTTP endpoint uses. Declaring the question schemas in the JSON Schema as well
would mean two validators, and zod's union error for a wrong question type is a nested JSON dump
an agent cannot act on, where xev's own message names the question id and the allowed types.

**Output.** A success returns both a digest and `structuredContent`. The digest is what a calling
model reads: the chosen option, the runners-up by weight, the level a `score` mostly landed on, the
`warnings` block when the model did not fully answer, and the token counts. `structuredContent` is
the full `SystemOneResponse`, re-parsed through `SystemOneResponseSchema` so it always satisfies
the `outputSchema` the tool advertises - the raw response carries a `reasoning_tokens` counter the
schema does not declare, and a strict client would reject a payload the server called its own
contract.

A failure returns `isError: true` with the status in the text and a hint about whether to retry
(`429`, `5xx`) or fix the request (`422`). Validation failures are returned rather than thrown, so
the model sees the message and can correct itself in the next turn.

Note that a `score` answer's `score` is the probability-weighted mean of the level indices, not a
level key, which is why the digest names the argmax level and its legend separately.

## Request Lifecycle

```
Request (POST /v1/systemone, or an xev_evaluate tool call)
     │
     ▼
┌─────────────┐
│  validate    │  Zod schema check on the request body / tool arguments
└─────┬───────┘
      │ valid
      ▼
┌─────────────┐
│   config     │  Merge env + x-llm-* headers, enforce credential guard
└─────┬───────┘
      │
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
Response  (plus `warnings` if the answer was incomplete)
         JSON body over HTTP, or a digest + `structuredContent` over MCP
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

## Demo Presets

The demo page ships three read-only built-in presets (Support Ticket, Code Review, Email Triage) defined in the `PRESETS` object in `public/index.html`. Users can snapshot the current state + questions as a named preset ("Save"), overwrite an existing saved preset by reusing its name (case-insensitive), and delete saved presets ("×" on the chip). Saved presets are stored in the browser under the `xev_saved_presets` localStorage key as `{ id, name, state, questions }` records; loading one replaces the current state and questions and bumps the question id counter so new questions cannot reuse loaded ids.

This is demo-only: the server has no preset storage and no preset endpoints.

## Data Flow

1. **Request** arrives as JSON matching `SystemOneRequest` (state + questions map). `model` is optional; a TypeSafe alias like `jev-latest` falls through to `LLM_MODEL`
2. **Validation** checks required fields and question type constraints
3. **Config** merges the server's env config with the request's `x-llm-*` headers, and refuses a request that redirects to a host other than the configured one unless it brings its own key
4. **Prompt builder** serializes state and questions, then generates a response template whose values are indexed placeholders (`${0}`, `${1}`, ...), defined by `buildPlaceholderMap`. Questions appear as `q0`, `q1`, ... — the caller's question ids are never sent to the model
5. **LLM client** sends the prompt and returns the raw response text (code fences stripped), the usage counters, and `finish_reason`
6. **Parser** resolves the text to values: it reads `;`-separated `index:value` pairs and maps each index back to its question field through `buildPlaceholderMap`, falling back to a JSON object (with `qN` keys mapped back to question ids) extracted with a brace-balanced scan. Both candidates are parsed and the one that answered more placeholders wins, ties going to the pairs format. It coerces string values to numbers, clamps negatives to 0 and normalizes probabilities per question type, computes confidence as `clamp01((n * max_probability - 1) / (n - 1))` on the full-precision distribution, then rounds probabilities to 2 decimals so they still sum to exactly 1
7. **Response** is returned in `SystemOneResponse` format, with a `warnings` array when a question was partly or wholly unanswered, when every value it did return was zero, or when the output was truncated (`finish_reason: length`)

## Connection Resolution

`config.ts` is the only place that decides which LLM a request talks to. Priority is
`x-llm-*` header → request body's `model` (unless a `jev*` alias) → `LLM_MODEL`.

**Credential guard:** the server's `LLM_API_KEY` is only ever sent to the base URL from
`LLM_BASE_URL`. A request that sets `x-llm-base-url` to any other host must also set
`x-llm-api-key`; otherwise the request is rejected with 400. Without this, anyone able to reach
the server could name a host and collect the server's API key in the `Authorization` header.

## OpenRouter and Other Routers

Any OpenAI-compatible base URL works, which includes OpenRouter. On top of that,
`config.ts` recognizes OpenRouter hosts and `llm.ts` sends its two conventions through the
OpenAI SDK, which forwards unknown body keys to the server untouched:

- `HTTP-Referer` / `X-Title` attribution from `OPENROUTER_REFERER` / `OPENROUTER_TITLE`
- `provider.order`, `provider.allow_fallbacks`, `provider.data_collection` from
  `LLM_PROVIDER_ORDER`, `LLM_PROVIDER_ALLOW_FALLBACKS`, `LLM_DATA_COLLECTION`
- `reasoning.exclude`, `reasoning.effort`, `reasoning.max_tokens` from
  `LLM_REASONING_EXCLUDE`, `LLM_REASONING_EFFORT`, `LLM_REASONING_MAX_TOKENS`

All of these are omitted entirely for non-OpenRouter backends. `max_tokens` is set from the
placeholder count (`LLM_MAX_TOKENS` overrides) so a 255-option question can still finish its answer
list; when reasoning is requested, a reasoning reserve is added to that budget.

## Reasoning Models

Reasoning models answer with a thinking trace, and on OpenRouter those tokens are billed and count
against the same `max_tokens` budget. A model that thinks longer than the budget returns
`finish_reason: length` with no answer, which used to surface as an unhelpful
"No index:value pairs found" error.

Four defenses, in `config.ts` and `llm.ts`:

1. `reasoning.exclude: true` (default for OpenRouter) keeps the trace out of the response
2. the answer budget is widened by a reasoning reserve so thinking cannot starve the answer
3. a `reasoning` / `reasoning_content` field is never parsed, and `<think>…</think>` blocks inlined
   in the content are stripped, with `hadReasoning` reported to the caller as a warning
4. a response that was all thinking raises a specific error carrying the reasoning and visible token
   counts and names the fixes (`LLM_REASONING_EFFORT=none`, a non-reasoning model, a bigger
   `LLM_MAX_TOKENS`) instead of the generic parse failure

Speed comes from `reasoning.effort`: `none` disables thinking where the model allows it, `low` and
`minimal` bound it. `exclude` alone does not make a model faster, only quieter. The prompt also
states that the answer list is the whole response, which helps reasoning models on backends that
have no reasoning controls.

## Model Discovery

`GET /v1/models` normally returns the single configured model. When the base URL is a router
(OpenRouter) or `LLM_DISCOVER_MODELS` is on, it fetches `{baseURL}/models`, maps it into
TypeSafe's `{ name, description, release_date }` shape, and caches it for 5 minutes. On failure
it keeps serving the last good list, then falls back to the configured model. The demo page's
"Load models" button populates a datalist from this endpoint.

## Cross-Origin Access

`CORS_ORIGIN` (comma-separated, or `*`) enables CORS for `/v1/*`, including an `OPTIONS`
preflight, so browser clients can call the API the way they would call TypeSafe. Off by default:
xev sends no CORS headers unless the variable is set.

## Rate Limiting

`RATE_LIMIT_RPM` caps `/v1/systemone` per client IP over a sliding one-minute window, replying
429 with `Retry-After`. Off by default (`0`), since each request costs an LLM call and a small
deployment may be the only client.

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
- **Validation limits**: A request must carry at least one question; Choice accepts 1-255 options and Score 2-10 levels, per TypeSafe's documented limits. Violations are rejected with HTTP 422. An empty `questions` object is a valid record to zod, so it is checked explicitly: it would otherwise reach the model as a prompt with no placeholders and come back as an answer with nowhere to go.
- **TypeSafe-shaped model list**: `GET /v1/models` returns `{ models: [{ name, description, release_date }] }`, the documented Jev shape, rather than the OpenAI `{ data: [...] }` shape.
- **Incomplete answers are reported, not hidden**: normalization makes a missing value look like a real one, so the parser counts coverage and says so in `warnings`.
- **Errors are always JSON**: an express error handler keeps body-parser failures and thrown errors inside the `{ error }` contract instead of Express's HTML page with a stack trace.
- **The server key stays home**: a request cannot redirect the server's credentials to a host it names. An MCP tool call has no header path at all, so the server's key can only reach its configured host.
- **One pipeline, two front doors**: `evaluate.ts` holds the pipeline and takes no transport, so the HTTP route and the MCP tool cannot drift apart in validation, normalization, or error wording. Each front door only maps the outcome to its own response shape.
- **One validator at the boundary**: the MCP tool's JSON Schema documents the question types in prose and leaves the checking to `validateRequest`. A wrong question type produces xev's readable message rather than zod's union dump, on both doors.
- **The MCP output is re-parsed before it is sent**: `structuredContent` is validated against the tool's own published `outputSchema` rather than passed through, so a client with strict validation never receives a payload the server called its own contract.

## Integration Points

| System | Protocol | Purpose |
|--------|----------|---------|
| OpenAI-compatible LLM | HTTP/HTTPS | Backend for question evaluation |
| Client applications | HTTP | Accept TypeSafe-format requests |
| MCP clients (opencode, Claude Desktop, …) | JSON-RPC over stdio | Agent-facing `xev_evaluate` tool |
| Demo page (browser) | HTTP | Testing UI, served as static files |

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/` | Demo page (static HTML) |
| `GET` | `/health` | Health check |
| `GET` | `/v1/models` | List models in TypeSafe's `{ models: [{ name, description, release_date }] }` shape; the upstream catalog when discovery is on |
| `POST` | `/v1/systemone` | Main evaluation endpoint |
| `POST` | `/v1/proxy/chat/completions` | LLM proxy (used by demo page) |

Status codes: `400` bad JSON body or bad `x-llm-*` value, `422` validation, `429` rate limited,
`502` LLM failure or unparseable answer, `504` LLM timeout.

## Startup

`index.ts` prints a banner with links to the demo page and the three read-only endpoints, using
OSC 8 hyperlinks where the terminal supports them (Windows Terminal, VS Code, iTerm2) and plain
text everywhere else, so a URL is always visible and clickable. A wildcard bind is displayed as
`localhost`; setting `HOST` to a specific address shows that address instead. A port already in use
is reported as one actionable line rather than an unhandled `EADDRINUSE` crash.

`start()` runs only when `index.ts` is the main module, so `import app from "./index"` in a test
does not bind a port. The same rule applies to `src/mcp/index.ts`, so a test can import
`createServer()` without attaching a transport.

## Adding a New Question Type

1. Add the question type to `types.ts` (schema + TypeScript type)
2. Add prompt instructions in `prompt.ts` (`questionToPrompt` function)
3. Add placeholders in `prompt.ts` (`buildPlaceholderMap`, and the shape in `buildTemplate`)
4. Add parsing logic in `parser.ts` (new parse function, add to `parseResponse`, and report coverage warnings)
5. Add a branch to `renderEvaluation` in `mcp/evaluateTool.ts` and document the type in `EVALUATE_TOOL_DESCRIPTION`
6. Add tests in `src/**/*.test.ts`
7. Update this document and `structure.md`

Steps 1 to 4 change the pipeline and reach both front doors at once. Step 5 exists because the
question contract is documented twice on purpose: once as schemas, which the HTTP side and
`validateRequest` enforce, and once in the MCP tool description, which is the only documentation a
third-party model gets. A new type that skips step 5 is enforced but not discoverable.

## Running the Tests

`npm test` runs `tsx --test "src/**/*.test.ts"`. There is no test framework dependency: `tsx` is
already a dev dependency and the assertions use `node:test` and `node:assert`. `llm.test.ts`
starts a throwaway `http` server on an ephemeral port and asserts what the LLM client actually
sends and how it handles what comes back, which is where OpenRouter header and provider-routing
behavior is pinned down.

`evaluate.test.ts` and `mcp/index.test.ts` each stand up the same kind of mock LLM. The MCP one
goes further and connects a real `Client` to `createServer()` over `InMemoryTransport`, so the
published JSON Schema, the `required` list, the digest, and `structuredContent` are asserted over
the wire rather than against internals. A change to the tool contract that breaks a third-party
client fails there first.
