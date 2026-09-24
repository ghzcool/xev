# Project Structure

> When adding, removing, or moving files, update this document.

## Directory Layout

```
xev/
├── src/
│   ├── index.ts        # Express server entry point, route definitions
│   ├── types.ts        # TypeSafe-compatible request/response types (Zod schemas)
│   ├── prompt.ts       # Builds LLM prompt from state + questions
│   ├── llm.ts          # OpenAI-compatible LLM client wrapper
│   ├── parser.ts       # Parses LLM JSON output into TypeSafe response format
│   └── validate.ts     # Request validation with Zod
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
| `prompt.ts` | Converts `state` + `questions` into a single prompt string that instructs the LLM to return exact probability values as JSON. |
| `llm.ts` | Wraps the OpenAI SDK. Sends the prompt, handles response parsing and JSON extraction. Configurable via environment variables. |
| `parser.ts` | Takes raw LLM JSON output and produces a normalized `SystemOneResponse`. Computes confidence scores, normalizes probabilities to sum to 1.0, builds score legends. |
| `validate.ts` | Validates incoming request bodies against Zod schemas. Returns structured error responses on failure. |
| `index.ts` | Express server. Defines routes (`/v1/systemone`, `/health`, `/v1/models`). Orchestrates validate → prompt → LLM → parse → respond. |

## File Naming Conventions

- All source files use `camelCase.ts` (e.g., `prompt.ts`, `llm.ts`)
- No barrel files (`index.ts` re-exports); each module is imported directly
- Types that span multiple files go in `types.ts`; module-specific types stay co-located
