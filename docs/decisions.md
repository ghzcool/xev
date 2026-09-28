# Implementation Decisions

> When making a decision that affects future development, add it here. Do not re-solve the same problem. Each entry explains what was decided and why.

## Format

Each decision entry:

```
### [Short Title]

**Date:** YYYY-MM-DD
**Context:** What situation or problem prompted this decision.
**Decision:** What was chosen.
**Rationale:** Why this choice over alternatives.
**Consequence:** What this means for future work.
```

---

## Decisions

### Single LLM Call for All Questions

**Date:** 2026-09-24
**Context:** TypeSafe evaluates all questions in parallel in one request. We could either send one LLM call per question or batch them.
**Decision:** Send all questions in a single prompt to the LLM.
**Rationale:** Reduces latency (one network round-trip), matches TypeSafe's parallel evaluation model, and keeps token overhead low.
**Consequence:** Adding new questions to a request has near-zero marginal cost.

### No response_format

**Date:** 2026-09-24
**Context:** LLMs return free-form text. We need structured JSON. `response_format: { type: "json_object" }` is supported by OpenAI but not by most local servers (LM Studio, Ollama).
**Decision:** Do not use `response_format`. Instead, instruct the LLM to return raw JSON in the prompt.
**Rationale:** Maximizes compatibility with local LLM servers. The prompt template approach works everywhere.
**Consequence:** The parser must extract answers from raw text with regex: `index:value` pairs as the primary format, JSON as a fallback. Some LLMs may return neither; the parser reports an error with a snippet of the response.

### JSON Template Prompts

**Date:** 2026-09-24
**Context:** Describing the expected JSON structure with `<number>` placeholders led to malformed output (quoted strings, extra keys, wrong structure).
**Decision:** Include an exact JSON template with `0` placeholders in the prompt. The LLM replaces zeros with its answers.
**Rationale:** Gives the LLM a concrete format to follow, reducing structural errors. Explicitly instructs "Do not add or remove any keys."
**Consequence:** The prompt includes the full template. Future question types must add their template shape in `buildPrompt`.
**Superseded:** 2026-09-28 by "Indexed Placeholder Answers" - the template still exists, but its values are `${index}` placeholders and the LLM answers with an `index:value` list instead of filling in JSON.

### Indexed Placeholder Answers

**Date:** 2026-09-28
**Context:** Asking the LLM to fill in a full JSON object made it regenerate the whole structure each time, which is token-heavy and still fails on some models (quoted keys, dropped keys, stray text).
**Decision:** The response template carries indexed placeholders (`${0}`, `${1}`, ...) instead of zeros, and the LLM answers with only a `;`-separated list of `index:value` pairs (e.g. `0:0.1;1:0.234;2:0;3:1`). Index order is defined once by `buildPlaceholderMap` in `prompt.ts` and reused by the parser to map values back to question fields.
**Rationale:** The answer format is unambiguous, has no structure to get wrong, and is much shorter. Keeping one function for index assignment prevents prompt/parser drift.
**Consequence:** `prompt.ts` owns `buildPlaceholderMap`; `parser.ts` imports it. `llm.ts` returns raw response text instead of parsed JSON. If the response contains a JSON object (models sometimes echo the template), the parser falls back to parsing it as before. Future question types must add their placeholders in `buildPlaceholderMap` and their shape in `buildTemplate`.

### String Coercion in Parser

**Date:** 2026-09-24
**Context:** Some LLMs return probability values as strings (`"0.5"`) instead of numbers (`0.5`), causing JSON parsing to fail or produce wrong types.
**Decision:** The parser uses a `toNum` helper that coerces string values to numbers via `parseFloat`.
**Rationale:** Simple defensive measure. Handles the common case where LLMs quote numeric values.
**Consequence:** All probability and noul values pass through `toNum`. The `toNum` function returns 0 for non-numeric strings.

### Proxy Endpoint for Demo Page

**Date:** 2026-09-24
**Context:** The demo page needs to call the LLM server. Calling directly from the browser sends CORS preflight `OPTIONS` requests that local LLM servers (LM Studio) don't handle.
**Decision:** Add a proxy endpoint (`/v1/proxy/chat/completions`) in the Node server. The demo page calls this endpoint instead of the LLM directly.
**Rationale:** Eliminates CORS issues. The proxy accepts `x-llm-base-url` and `x-llm-api-key` headers so the demo page can override server config.
**Consequence:** The demo page depends on the Node server being running. Direct API calls still go through `/v1/systemone`.

### Model Override via Request

**Date:** 2026-09-24
**Context:** The `model` field in the request could be a TypeSafe model name (e.g., `jev-latest`) or an actual LLM model name.
**Decision:** If the model field is `jev-latest` or similar TypeSafe alias, use the default `LLM_MODEL` from env. Otherwise, use the model name from the request directly.
**Rationale:** Allows clients to use TypeSafe-compatible model names while also letting them specify a different model per request.
**Consequence:** The response `model` field is prefixed with `xev-` to distinguish it from real TypeSafe responses.

### Express Over Fastify

**Date:** 2026-09-24
**Context:** Choosing an HTTP framework for the server.
**Decision:** Use Express.
**Rationale:** Widely used, large ecosystem, simple mental model. This is a thin wrapper, not a high-performance proxy.
**Consequence:** All middleware and routing follows Express conventions.

### Zod for Validation

**Date:** 2026-09-24
**Context:** Need to validate incoming requests against the TypeSafe API contract.
**Decision:** Use Zod schemas for both TypeScript types and runtime validation.
**Rationale:** Single source of truth. Define the schema once, derive TypeScript types from it.
**Consequence:** All new request/response types should be defined as Zod schemas in `types.ts`.

### No Barrel Files

**Date:** 2026-09-24
**Context:** Deciding module organization.
**Decision:** No barrel files. Each module imports directly from the file it needs.
**Rationale:** With a small codebase, direct imports are clearer.
**Consequence:** Import paths like `import { buildPrompt } from "./prompt"` are standard.

### Temperature 0

**Date:** 2026-09-24
**Context:** We need deterministic, reproducible evaluations.
**Decision:** Always use `temperature: 0` for LLM calls.
**Rationale:** Structured evaluation requires consistency.
**Consequence:** If a future use case needs creative/variety responses, it should use a separate endpoint or configuration flag.

### Confidence via Peak Rescaling (matches Jev)

**Date:** 2026-09-24
**Context:** TypeSafe returns a `confidence` score. We need to compute it from the LLM's probability distribution so results match Jev.

**Decision:** Compute confidence as `clamp01((n * max_probability - 1) / (n - 1))`, where `n` is the number of options/levels.

**Rationale:** This is Jev's documented formula (the Confidence docs state it for three options as `(3 * largest - 1) / 2`). It rescales the top probability so that a uniform distribution gives 0 and a single peak gives 1, independent of how many options exist. Verified against published Jev responses.

**Consequence:** Confidence is always between 0 and 1. It is a rescaled max probability, not an entropy measure, so it is sensitive to the winner's margin rather than the whole spread. Future question types must produce probability distributions to be compatible.

**Supersedes:** the earlier entropy-based decision (`1 - normalized_entropy`), which produced systematically lower values than Jev (e.g. 0.49 vs 0.73 for `[0.1, 0.8, 0.05, 0.05]`).

### Probabilities Reported at 2 Decimals

**Date:** 2026-09-28
**Context:** Jev's published responses show probabilities with two decimal places (e.g. `0.67`, `0.84`), including examples where the reported values still sum to exactly 1 while full-precision values would not.
**Decision:** Compute confidence on the full-precision distribution, then round the reported probabilities to 2 decimals with a largest-remainder pass so the rounded values still sum to 1.00. Scores are rounded to 2 decimals as well; noul is clamped to [0, 1] and rounded to 2 decimals.
**Rationale:** Matches Jev's output exactly, avoids `0.6666666666666666` in JSON, and keeps the invariant that probabilities sum to 1. Rounding after confidence avoids drift (e.g. `0.86` with 4 options gives confidence `0.81` from full precision).
**Consequence:** Clients doing `JSON.stringify` on our response see the same numbers Jev sends. Do not round before computing confidence. If a caller needs more precision, they must use the full distribution themselves � we do not store it.

### No Question Ids Sent to the Model

**Date:** 2026-09-28
**Context:** Jev's docs state that "the model never sees the question id". Our prompt originally used the caller's question keys (`department`, `is_urgent`, ...) as template keys, leaking potentially sensitive ids into the LLM context.
**Decision:** Bind questions positionally as `q0`, `q1`, ... in the prompt and response template (`bindQuestions`/`buildAliasMap` in `prompt.ts`), and map them back to the caller's ids in the parser.
**Rationale:** Parity with Jev's privacy guarantee, and removes a source of prompt drift (weird ids, long ids, ids containing template syntax).
**Consequence:** `prompt.ts` owns alias generation; `parser.ts` imports `buildAliasMap`. Any code that inspects the raw prompt must expect `qN` keys. The JSON fallback path parses `qN` keys, not caller ids.

### Legend Passthrough

**Date:** 2026-09-28
**Context:** Jev returns `legend` for Score questions as the structured criteria the caller supplied, including object levels such as `{"what": "Cosmetic", "examples": ["typo"]}`. We had been serializing everything to JSON strings.
**Decision:** Build `legend` from `criteria` verbatim: string levels stay strings, object/array levels stay structured values (`Description` type in `types.ts`).
**Rationale:** Parity with Jev, and keeps the response machine-readable without a decode step on the client.
**Consequence:** `legend` is typed as `Record<string, Description>` where `Description = string | Record<string, unknown> | unknown[]`. Do not `JSON.stringify` levels. Demo UI uses `legendLabel()` to render object levels.

### TypeSafe Validation Limits

**Date:** 2026-09-28
**Context:** TypeSafe documents limits on question size (Choice up to 255 options, Score 2-10 levels) and rejects violations with HTTP 422. Our schema accepted any number of options/levels.
**Decision:** Enforce the documented bounds in `validate.ts` (Zod `.max(255)` on choice criteria keys, level count 2-10 for score) and return HTTP 422 with `{ error, details }`.
**Rationale:** Parity with Jev's error behavior; oversized questions blow up prompt size and degrade model quality anyway.
**Consequence:** Clients relying on unlimited options must split questions. Future type additions should copy the documented TypeSafe limits into the Zod schema and the error status code.

### TypeSafe-Shaped /v1/models

**Date:** 2026-09-28
**Context:** Jev documents `GET /v1/models` as `{ models: [{ name, description, release_date }] }` with `release_date` required, not OpenAI's `{ data: [{ id, ... }] }`.
**Decision:** Return `{ models: [{ name, description, release_date }] }` with `release_date` set to the server's serving date (`SERVING_SINCE`).
**Rationale:** Clients written against Jev's documented shape parse our response without changes.
**Consequence:** Do not switch back to the OpenAI `data` shape. If a client needs OpenAI-style discovery, add a separate route rather than changing this one.

### Presets Live in Browser localStorage

**Date:** 2026-09-28
**Context:** The demo page's built-in presets (Support Ticket, Code Review, Email Triage) are hardcoded and read-only, so there was no way to keep a scenario you had just built. Saving presets could mean a new server endpoint with a data directory, or browser storage.
**Decision:** Keep the built-in presets as a hardcoded `PRESETS` object (read-only) and store user presets in localStorage under `xev_saved_presets` as `{ id, name, state, questions }` records. Saving with an existing name overwrites that preset (case-insensitive match); each saved preset chip has a "×" to remove it.
**Rationale:** Every other demo value already persists in localStorage, so this is consistent, requires no server API or migration story, and keeps a throwaway testing UI from growing a persistence layer. A preset is a demo convenience, not part of the TypeSafe contract, so nothing in the server needs to know about it.
**Consequence:** Saved presets are per-browser and are lost when localStorage is cleared; they are never uploaded. If presets must be shareable across machines, add `GET`/`POST`/`DELETE /v1/presets` with server-side storage rather than reshaping the localStorage records. Loading a preset bumps the question id counter so newly added questions cannot collide with ids from the loaded preset.
