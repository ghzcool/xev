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
**Rationale:** Reduces latency (one network round-trip), matches TypeSafe's parallel evaluation model, and keeps token overhead low. The prompt builder already handles all question types in one string.
**Consequence:** Adding new questions to a request has near-zero marginal cost. The prompt may grow long with many questions, but this is acceptable for typical use.

### JSON Output via response_format

**Date:** 2026-09-24
**Context:** LLMs return free-form text. We need structured JSON to parse probabilities.
**Decision:** Use `response_format: { type: "json_object" }` when calling the LLM, with regex JSON extraction as a fallback.
**Rationale:** Many OpenAI-compatible providers support structured output. The fallback handles providers that don't.
**Consequence:** If a provider doesn't support `response_format`, it is ignored by the SDK and the fallback kicks in. New LLM integrations should test both paths.

### Temperature 0

**Date:** 2026-09-24
**Context:** We need deterministic, reproducible evaluations.
**Decision:** Always use `temperature: 0` for LLM calls.
**Rationale:** Structured evaluation requires consistency. Temperature > 0 would produce different probabilities on each run.
**Consequence:** If a future use case needs creative/variety responses, it should use a separate endpoint or configuration flag.

### Confidence via Entropy

**Date:** 2026-09-24
**Context:** TypeSafe returns a `confidence` score. We need to compute it from the LLM's probability distribution.
**Decision:** Compute confidence as `1 - normalized_entropy` of the probability distribution.
**Rationale:** Entropy directly measures how spread out the distribution is. A single-peak distribution has low entropy (high confidence). An even spread has high entropy (low confidence). This matches TypeSafe's behavior.
**Consequence:** Confidence is always between 0 and 1. Values near 1 mean the LLM strongly favored one option. Values near 0 mean it was uncertain. Future question types must produce probability distributions to be compatible.

### Express Over Fastify

**Date:** 2026-09-24
**Context:** Choosing an HTTP framework for the server.
**Decision:** Use Express.
**Rationale:** Widely used, large ecosystem, simple mental model. This is a thin wrapper, not a high-performance proxy, so Express's overhead is negligible.
**Consequence:** All middleware and routing follows Express conventions. If performance becomes critical, consider switching to Fastify or Hono.

### Zod for Validation

**Date:** 2026-09-24
**Context:** Need to validate incoming requests against the TypeSafe API contract.
**Decision:** Use Zod schemas for both TypeScript types and runtime validation.
**Rationale:** Single source of truth. Define the schema once, derive TypeScript types from it. No drift between types and validation.
**Consequence:** All new request/response types should be defined as Zod schemas in `types.ts`. Do not create separate TypeScript interfaces that duplicate schema logic.

### No Barrel Files

**Date:** 2026-09-24
**Context:** Deciding module organization.
**Decision:** No `index.ts` barrel files. Each module imports directly from the file it needs.
**Rationale:** Barrel files add indirection and make it harder to trace where things come from. With a small codebase, direct imports are clearer.
**Consequence:** Import paths like `import { buildPrompt } from "./prompt"` are standard. Do not create `src/index.ts` that re-exports everything.

### Model Override via Request

**Date:** 2026-09-24
**Context:** The `model` field in the request could be a TypeSafe model name (e.g., `jev-latest`) or an actual LLM model name.
**Decision:** If the model field is `jev-latest` or similar TypeSafe alias, use the default `LLM_MODEL` from env. Otherwise, use the model name from the request directly.
**Rationale:** Allows clients to use TypeSafe-compatible model names while also letting them specify a different model per request.
**Consequence:** The response `model` field is prefixed with `xev-` to distinguish it from real TypeSafe responses.
