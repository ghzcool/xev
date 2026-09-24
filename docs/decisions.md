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
**Consequence:** The parser must extract JSON from the response with regex as a fallback. Some LLMs may return invalid JSON; the parser handles this gracefully.

### JSON Template Prompts

**Date:** 2026-09-24
**Context:** Describing the expected JSON structure with `<number>` placeholders led to malformed output (quoted strings, extra keys, wrong structure).
**Decision:** Include an exact JSON template with `0` placeholders in the prompt. The LLM replaces zeros with its answers.
**Rationale:** Gives the LLM a concrete format to follow, reducing structural errors. Explicitly instructs "Do not add or remove any keys."
**Consequence:** The prompt includes the full template. Future question types must add their template shape in `buildPrompt`.

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

### Confidence via Entropy

**Date:** 2026-09-24
**Context:** TypeSafe returns a `confidence` score. We need to compute it from the LLM's probability distribution.
**Decision:** Compute confidence as `1 - normalized_entropy` of the probability distribution.
**Rationale:** Entropy directly measures how spread out the distribution is. Single peak = high confidence. Even spread = low confidence.
**Consequence:** Confidence is always between 0 and 1. Future question types must produce probability distributions to be compatible.
