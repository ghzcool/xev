# Project Structure

> When adding, removing, or moving files, update this document.

## Directory Layout

```
xev/
├── src/
│   ├── index.ts        # Express server entry point, route definitions, proxy endpoint
│   ├── types.ts        # TypeSafe-compatible request/response types (Zod schemas)
│   ├── prompt.ts       # Builds LLM prompt from state + questions (indexed ${i} template)
│   ├── llm.ts          # OpenAI-compatible LLM client wrapper (returns raw response text)
│   ├── parser.ts       # Parses LLM answer list into TypeSafe response format
│   └── validate.ts     # Request validation with Zod
├── public/
│   └── index.html      # Demo page - browser-based testing UI
├── docs/
│   ├── index.md        # Documentation index and update rules
│   ├── structure.md    # This file
│   ├── architecture.md # System architecture and data flow
│   └── decisions.md    # Implementation decisions
├── dist/               # Compiled TypeScript output (gitignored)
├── .env.example        # Environment variable template
├── package.json        # Dependencies and scripts
├── tsconfig.json       # TypeScript configuration
├── AGENTS.md           # Agent instructions, links to docs
└── README.md           # User-facing documentation
```

## Module Responsibilities

| Module | Responsibility |
|--------|---------------|
| `types.ts` | Defines `SystemOneRequest`, `SystemOneResponse`, `Question`, `Answer` types. Zod schemas for runtime validation. Single source of truth for the API contract. |
| `prompt.ts` | Converts `state` + `questions` into a single prompt string. Builds a response template whose values are indexed placeholders (`${0}`, `${1}`, ...) via `buildPlaceholderMap`, which is the single source of the index order. Questions are addressed as `q0`, `q1`, ... (`bindQuestions`/`buildAliasMap`) so the caller's question ids never reach the model, as in Jev. |
| `llm.ts` | Wraps the OpenAI SDK. Sends the prompt and returns the raw response text with code fences stripped. Configurable via environment variables or per-request headers. |
| `parser.ts` | Takes the raw LLM response text, resolves it to per-question values: primary format is `;`-separated `index:value` pairs mapped back through `buildPlaceholderMap`, with JSON as a fallback (template aliases mapped back to question ids). Coerces string numbers to numbers, clamps and normalizes probabilities to sum to 1.0, rounds them to 2 decimals the way Jev reports them (largest remainder, so they still sum to 1), computes confidence as `clamp01((n * max_probability - 1) / (n - 1))`, and builds score legends that keep object/array levels structured. |
| `validate.ts` | Validates incoming request bodies against Zod schemas plus TypeSafe's documented limits (choice 1-255 options, score 2-10 levels). Returns structured error responses on failure. |
| `index.ts` | Express server. Defines routes (`/v1/systemone`, `/health`, `/v1/models`, `/v1/proxy/chat/completions`). Orchestrates validate → prompt → LLM → parse → respond. Serves static files from `public/`. |
| `public/index.html` | Single-page demo UI. Configurable LLM connection, state textarea, question builder, request preview, response viewer. All values persist in localStorage. Proxies LLM calls through the Node server. |

## File Naming Conventions

- All source files use `camelCase.ts` (e.g., `prompt.ts`, `llm.ts`)
- No barrel files; each module is imported directly
- Types that span multiple files go in `types.ts`; module-specific types stay co-located
