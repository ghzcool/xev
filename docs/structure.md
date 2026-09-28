# Project Structure

> When adding, removing, or moving files, update this document.

## Directory Layout

```
xev/
├── src/
│   ├── index.ts        # Express server entry point, route definitions, proxy endpoint
│   ├── config.ts       # Env + x-llm-* header resolution, credential guard, OpenRouter detection
│   ├── types.ts        # TypeSafe-compatible request/response types (Zod schemas)
│   ├── prompt.ts       # Builds LLM prompt from state + questions (indexed ${i} template)
│   ├── llm.ts          # OpenAI-compatible LLM client wrapper (returns raw response text)
│   ├── parser.ts       # Parses LLM answer list into TypeSafe response format
│   ├── validate.ts     # Request validation with Zod
│   └── *.test.ts       # node:test unit tests, one per module
├── public/
│   └── index.html      # Demo page - browser-based testing UI
├── demo/
│   └── index.ts        # CLI client: evaluates random states and prints decisions
├── docs/
│   ├── index.md        # Documentation index and update rules
│   ├── structure.md    # This file
│   ├── architecture.md # System architecture and data flow
│   └── decisions.md    # Implementation decisions
├── dist/               # Compiled TypeScript output (gitignored)
├── .env.example        # Environment variable template
├── package.json        # Dependencies and scripts
├── tsconfig.json       # TypeScript configuration (excludes *.test.ts)
├── AGENTS.md           # Agent instructions, links to docs
└── README.md           # User-facing documentation
```

## Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `config.ts` | Single source of truth for connection settings. Parses `LLM_*` env vars into `ServerConfig` and merges per-request `x-llm-*` headers into an `LLMClientConfig`. Enforces the credential guard (the server key is only sent to its configured host), detects OpenRouter to gate attribution/routing/reasoning, and sizes the answer token cap from the placeholder count plus a reasoning reserve. Also parses `CORS_ORIGIN` and `RATE_LIMIT_RPM`, and formats the startup banner links (`formatBaseUrl`, `hyperlink`, `supportsHyperlinks`). |
| `types.ts` | Defines `SystemOneRequest`, `SystemOneResponse`, `Question`, `Answer` types as Zod schemas (request and response both), so the API contract is validated in both directions. Single source of truth for the API contract. |
| `prompt.ts` | Converts `state` + `questions` into a single prompt string. Builds a response template whose values are indexed placeholders (`${0}`, `${1}`, ...) via `buildPlaceholderMap`, which is the single source of the index order. Questions are addressed as `q0`, `q1`, ... (`bindQuestions`/`buildAliasMap`) so the caller's question ids never reach the model, as in Jev. |
| `llm.ts` | Wraps the OpenAI SDK. Sends the prompt (always `temperature: 0`) and returns the raw response text with code fences stripped, plus usage, `finish_reason`, and whether a reasoning trace was seen. Adds OpenRouter attribution headers (`HTTP-Referer`, `X-Title`), provider routing (`provider.order`, `allow_fallbacks`, `data_collection`) and reasoning controls (`reasoning.exclude`/`effort`/`max_tokens`) via unknown body keys, which the SDK forwards, mapping camelCase config to the snake_case wire format. Ignores `reasoning`/`reasoning_content` fields, strips `<think>…</think>` blocks, and maps upstream failures to HTTP status with `llmErrorStatus`. |
| `parser.ts` | Takes the raw LLM response text and resolves it to per-question values: primary format is `;`-separated `index:value` pairs mapped back through `buildPlaceholderMap`, with JSON as a fallback (brace-balanced extraction, template aliases mapped back to question ids). Both candidates are parsed and the one that answered more placeholders wins. Coerces string numbers to numbers, clamps and normalizes probabilities to sum to 1.0, rounds them to 2 decimals the way Jev reports them (largest remainder, so they still sum to 1), computes confidence as `clamp01((n * max_probability - 1) / (n - 1))`, and builds score legends that keep object/array levels structured. Tracks per-question coverage and returns a `warnings` array when an answer was incomplete or degenerate; throws `LLMResponseError` when nothing could be parsed. |
| `validate.ts` | Validates incoming request bodies against Zod schemas plus TypeSafe's documented limits (at least one question, choice 1-255 options, score 2-10 levels). Expands `invalid_union` issues into a readable message (expected type + what the matching branch was missing). Returns structured error responses with status 422. |
| `index.ts` | Express server. Defines routes (`/v1/systemone`, `/health`, `/v1/models`, `/v1/proxy/chat/completions`), optional CORS and rate limiting, upstream model discovery, and a JSON error handler. Orchestrates validate → config → prompt → LLM → parse → respond. Serves static files from `public/`. Prints the startup banner (clickable links via `formatBaseUrl`/`hyperlink` in `config.ts`) and only calls `start()` when it is the main module, so tests can import it without binding a port. |
| `*.test.ts` | Unit tests run by `npm test` (`tsx --test`, node:test). One file per module; no new dependencies. `llm.test.ts` runs a mock OpenAI-compatible server to assert the request and response handling, including OpenRouter headers and reasoning controls. `index.test.ts` asserts the startup banner and that importing the server does not start it. |
| `public/index.html` | Single-page demo UI. Configurable LLM connection with local/OpenRouter/OpenAI presets and a model list loaded from `/v1/models`, state textarea, question builder, request preview, response viewer that surfaces `warnings`. Sending is blocked with a hint when there are no questions or a choice has no option key. Router options (provider order, attribution, data-collection policy, reasoning) are server-side configuration and are not in the UI. All values persist in localStorage. Built-in state presets plus user presets that can be saved (by name, overwriting on name collision) and removed, stored in localStorage under `xev_saved_presets`. Proxies LLM calls through the Node server. |
| `demo/index.ts` | CLI client run with `npm run demo`. Posts random states to a running xev and prints the answers plus a decision. Not part of the server build. |

## File Naming Conventions

- All source files use `camelCase.ts` (e.g., `prompt.ts`, `llm.ts`)
- No barrel files; each module is imported directly
- Types that span multiple files go in `types.ts`; module-specific types stay co-located
