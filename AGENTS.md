# AGENTS.md

**All agents must read this file and the linked documents before making any changes to the project.**

## Required Reading

Before editing any code, read these files in order:

1. [docs/index.md](./docs/index.md) - Documentation index, update rules
2. [docs/structure.md](./docs/structure.md) - File structure and module responsibilities
3. [docs/architecture.md](./docs/architecture.md) - System architecture and data flow
4. [docs/decisions.md](./docs/decisions.md) - Implementation decisions that constrain your work

## Rules

### Before Making Changes

1. Read `docs/decisions.md` to check if your change is covered by an existing decision.
2. Read `docs/structure.md` to understand where new code belongs and what modules already exist.
3. Read `docs/architecture.md` to understand the data flow your change affects.

### When Making Changes

1. Follow existing patterns. Do not introduce new frameworks, libraries, or conventions without adding a decision entry to `docs/decisions.md`.
2. Keep `types.ts` as the single source of truth for API types. Do not create duplicate type definitions.
3. Use Zod schemas for all new types that appear in request/response boundaries.
4. Use `temperature: 0` for all LLM calls.
5. All probabilities must be normalized to sum to 1.0.

### After Making Changes

1. If you added, removed, or moved files → update `docs/structure.md`
2. If you changed the request lifecycle or data flow → update `docs/architecture.md`
3. If you made a decision that affects future work → add an entry to `docs/decisions.md`
4. If you changed how documentation is organized → update `docs/index.md`

## Project Conventions

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js
- **HTTP Framework:** Express
- **Validation:** Zod schemas
- **LLM Client:** OpenAI SDK (compatible with any OpenAI-compatible API)
- **Module imports:** Direct file imports, no barrel files
- **File naming:** camelCase for source files
- **Temperature:** Always 0 for LLM calls
- **Confidence:** Computed via entropy of probability distribution

## Common Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run dev          # Development with hot reload
npm start            # Run compiled server
```
