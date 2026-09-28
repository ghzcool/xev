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
