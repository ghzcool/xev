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

### The Server Key Never Leaves Its Configured Host

**Date:** 2026-09-28
**Context:** `x-llm-base-url` let any caller aim the request at any host while the server attached its own `LLM_API_KEY` as a `Bearer` token. Naming an attacker's host was enough to collect the server's credentials. This applied to both `/v1/systemone` and the chat proxy.
**Decision:** `config.ts` compares the requested base URL with the configured one. When they differ, `x-llm-api-key` is required and only the caller's key is used; otherwise the request is rejected with 400 and an explanation.
**Rationale:** The demo page and multi-tenant callers legitimately need to point xev at a different backend, so the capability stays. What must not stay is the ability to redirect the server's own secret. Requiring a key is the smallest change that keeps both.
**Consequence:** New code that builds an LLM call must go through `resolveLLMConfig` rather than reading `process.env.LLM_API_KEY` itself. If a deployment needs an allowlist of permitted hosts, add it in `resolveLLMConfig`; do not relax the key requirement. Covered by `config.test.ts`.

### Incomplete Answers Are Flagged, Not Filled In Silently

**Date:** 2026-09-28
**Context:** The parser normalizes whatever it receives. A model that answered `0:0;1:0;2:0` produced a uniform distribution with a chosen winner, and a model that answered one of three score levels produced `confidence: 1.0`. A partial or refused answer was indistinguishable from a real one at the API level, which is the worst failure mode for an evaluation API.
**Decision:** Count how many placeholders the model actually answered, per question. If nothing usable came back for a question, or the values were all zero, or only some arrived, `parseResponse` adds a line to a `warnings` array on the response (omitted entirely when the answer was complete). A response with nothing parseable at all throws `LLMResponseError` and becomes a 502 rather than a guess. Truncated output (`finish_reason: length`) is reported as a warning too.
**Rationale:** Refusing to answer would break small local models that routinely answer loosely, and a client cannot detect fabrication from the numbers alone. A partial answer plus an explicit warning keeps the response usable while making the failure visible.
**Consequence:** `SystemOneResponse` gains an optional `warnings: string[]`. This is an additive xev extension, not part of the TypeSafe shape, so clients that ignore unknown fields are unaffected. Never fill a value the model did not give without saying so in `warnings`; if this ever needs to become a hard failure, make it a flag rather than changing the default. Covered by `parser.test.ts`.

### Best-Candidate Parsing Instead of Format Precedence

**Date:** 2026-09-28
**Context:** The parser preferred `index:value` pairs whenever any pair was found, even a single `7: 0.5` in the middle of the model's prose, and only then looked at JSON. Its JSON extraction also grabbed from the first `{` to the last `}`, so a stray brace in the model's reasoning broke the fallback.
**Decision:** Parse both candidates and keep whichever answered more placeholders, with ties going to the pairs format. Extract JSON objects with a brace-balanced scan that skips braces inside strings.
**Rationale:** Coverage is a better signal of which candidate is the real answer than the order they appear in, and the documented primary format still wins whenever both are complete. The balanced scan removes a class of failure that depended on the model's prose.
**Consequence:** `parseContent` returns `{ raw, source }` and both formats can coexist in one response. If a new format is added, add it as another candidate with its own coverage rather than as a branch in a precedence chain.

### JSON Error Handler

**Date:** 2026-09-28
**Context:** Express's default error handler returns an HTML page containing a stack trace and absolute filesystem paths. A malformed JSON body hit it, so a client parsing the documented `{ error }` shape got HTML and a 400 with a path disclosure.
**Decision:** Add a terminal express error handler that always answers with JSON, uses the error's own status when it has one (body-parser sets 400 and 413), and returns a generic message for anything at 500 or above while logging the detail server-side.
**Rationale:** The `{ error }` body is part of the API contract, and a stack trace is not something a client needs.
**Consequence:** Unhandled errors are logged, not returned. LLM failures are mapped separately by `llmErrorStatus` (504 timeout, 429 passthrough, 502 otherwise) so clients can tell "the model failed" from "xev is broken".

### node:test With tsx, No Test Framework

**Date:** 2026-09-28
**Context:** The parser's normalization, largest-remainder rounding, and confidence ordering encode documented Jev-parity rules, and there was no way to check a change against them. A review also turned up a wrong worked example in a code comment, which a test would have caught.
**Decision:** Use `node:test` and `node:assert` through the already-present `tsx` (`npm test` runs `tsx --test "src/*.test.ts"`), one test file per module, excluded from the tsc build.
**Rationale:** No new dependency, no config, and the tests run in milliseconds. AGENTS.md forbids new libraries without a decision entry; a framework bought nothing here.
**Consequence:** Tests are colocated with the modules they cover as `*.test.ts`. If coverage or mocking needs grow, revisit before reaching for a framework.

### Routers Are Supported Through the OpenAI SDK's Passthrough

**Date:** 2026-09-28
**Context:** OpenRouter, and other routers like Together or Fireworks, speak the OpenAI chat API but add conventions: `HTTP-Referer` / `X-Title` app attribution, a `provider` object in the request body for routing, fallback and data-collection policy, and a `/models` catalog. Supporting OpenRouter was a stated goal.
**Decision:** Keep the OpenAI SDK as the only client. Send attribution as `defaultHeaders`, and the `provider` object by placing it in the request body, which the SDK forwards verbatim even though it is not in its types. Detect OpenRouter hosts in `config.ts` to decide whether to send attribution at all, and expose router features as `LLM_*` env vars plus `x-llm-*` headers rather than as new fields in the request body.
**Rationale:** A second provider SDK would duplicate retry, timeout, and error handling for two extra headers. Keeping router options out of the request body means the TypeSafe request contract stays exactly as documented, and clients can still override per request.
**Consequence:** The `provider` key depends on SDK passthrough of unknown body fields; `llm.test.ts` asserts it against a mock server so a future SDK upgrade that drops it fails loudly. If a router needs a non-OpenAI endpoint, add a client in `llm.ts` behind the same `callLLM` signature rather than leaking it into `index.ts`.

### Reasoning Traces Are Excluded, Not Parsed

**Date:** 2026-09-28
**Context:** Trying `nvidia/nemotron-3.5-lightning:free` on OpenRouter returned `HTTP 502: No index:value pairs or JSON object found in LLM response: Here's a thinking process: ...`. The model spent its whole `max_tokens` budget reasoning, so it returned `finish_reason: length` with no answer list. The error blamed the format, not the cause.
**Decision:** For OpenRouter targets, send `reasoning.exclude: true` by default and add a reasoning reserve (1024 tokens, or `LLM_REASONING_MAX_TOKENS`) to the answer budget. Ignore the `reasoning` / `reasoning_content` response fields, strip `<think>…</think>` blocks inlined in the content, and when a response turns out to be all thinking, raise an error carrying the reasoning and visible token counts plus the fixes. Thinking is bounded by OpenRouter's `reasoning.effort` (`LLM_REASONING_EFFORT`), defaulting to unset.
**Rationale:** Reasoning tokens are billed and share the `max_tokens` budget, so xev has to reserve room for them or thinking models can never answer. The trace itself is never useful here — xev wants a short answer list — so excluding it is always right for the normal path. `exclude` hides the trace but does not make a model faster, so speed is a separate knob (`effort`) and is left to the operator.
**Consequence:** The `reasoning` object is only sent to OpenRouter, since a plain OpenAI-compatible server has never heard of the parameter; local backends are handled by "Thinking Is Switched Off Through `reasoning_effort`, Not the Router". A model flagged `mandatory` in the `/v1/models` entry rejects `effort: "none"`; `low` and `minimal` are the safe choices. When a trace does come back next to an answer, the response carries a `warnings` entry rather than silently trusting it. Covered by `llm.test.ts` and `config.test.ts`.

### Thinking Is Switched Off Through `reasoning_effort`, Not the Router

**Date:** 2026-09-30
**Context:** `LLM_REASONING_EFFORT=none` did nothing on a local backend. `resolveLLMConfig` attached the `reasoning` object only for OpenRouter hosts, so against LM Studio or vLLM the effort was read, validated, and then silently discarded: a Qwen3 hybrid model kept thinking, spent the answer budget doing it, and returned either nothing or a trace the parser read as values. The setting looked like it was working because it never errored. Measured against LM Studio with `qwen/qwen3.8-27b`: `reasoning_effort: "none"` returns `reasoning_tokens: 0`; `chat_template_kwargs: {enable_thinking: false}` and a `/no_think` soft switch are both accepted and ignored (58 reasoning tokens); `reasoning_effort: "low"` is answered with a 400.
**Decision:** Express "stop thinking" in the dialect the backend actually reads. `LLM_REASONING_EFFORT=none` on a non-OpenRouter target becomes the standard top-level `reasoning_effort: "none"`, which LM Studio and SGLang implement directly and which vLLM translates into the chat template's `enable_thinking`. `LLM_EXTRA_BODY` / `x-llm-extra-body` pass a JSON object into the request body verbatim for anything xev does not derive (`chat_template_kwargs`, `thinking_token_budget`, a level a given server does support), merged last so an explicit key there overrides what xev chose. Nothing is sent unless configured, because a server that rejects an unknown body key answers 400.
**Rationale:** A setting that is accepted and ignored is worse than one that errors, because the operator has no signal that their model is still thinking. Both dialects are documented upstream and both are needed: the router object is OpenRouter's, `reasoning_effort` is the OpenAI standard the local servers implement, and picking the wrong one is precisely the bug. Only the disable direction is derived, and that asymmetry is measured rather than assumed — LM Studio 400s on `low`, so forwarding the other levels would replace a working request with a failing one, while sending nothing leaves the model thinking exactly as much as it did before the operator touched the setting. Enabling or capping thinking on a backend is a per-model tuning problem, which is what the explicit body passthrough is for.
**Consequence:** `ServerConfig` and `LLMClientConfig` gain an optional `extraBody`, and `llm.ts` merges it into the request body after everything else it built. A request that turns thinking off leaves the answer budget un-widened, and so does one that sets `LLM_MAX_TOKENS`, so `max_tokens` on such a request is smaller than the same request with an auto-sized budget. `/no_think` in the prompt was tried and dropped: it is Qwen3-specific, changed nothing on a real backend, and mutating the prompt is not worth a mechanism that cannot be shown to work. Covered by `config.test.ts` and `llm.test.ts`.

### The Repository `.env` Is Actually Read

**Date:** 2026-09-30
**Context:** `.env.example` and the README both tell operators to put their `LLM_*` settings in `.env`, and `LLM_REASONING_EFFORT=none` in that file did nothing at all. There was no dotenv dependency, no `process.loadEnvFile`, and no `--env-file` flag on any of the five scripts, so nothing ever read the file. Every server and MCP process ran on the built-in defaults, and the reason it went unnoticed is that `.env.example`'s base URL and model are identical to those defaults, so the two paths looked identical. The failure mode is the worst kind: a setting that is documented, present in the file, and silently discarded, with no error anywhere. `resolveLLMConfig` was already turning `LLM_REASONING_EFFORT=none` into `reasoning_effort: "none"` correctly — it was being handed an unset variable.
**Decision:** `config.ts` exports `loadEnvFile()`, which uses Node's own `process.loadEnvFile` to read `.env` into `process.env` for variables that are not already set, so an exported variable still wins. The server and MCP entry points call it before anything reads the environment. The path is resolved relative to the module (`dist/config.js` and `src/config.ts` both sit one level below the root) rather than the working directory, because an MCP client may launch xev from anywhere. A missing file is not an error.
**Rationale:** Node's loader is already the dotenv implementation, so this adds no dependency and no decision about one. It is called from the entry points rather than at module load because a library module that mutates `process.env` as an import side effect makes every test depend on the developer's local `.env`, which is how this class of bug hides. A missing `.env` staying quiet matters because the environment is a documented way to run xev too, and the defaults are what an operator without a `.env` wants.
**Consequence:** xev now requires Node 20.12 or newer, recorded in `package.json` `engines` and the README; on anything older it warns once and continues on the exported environment instead of failing at startup. Existing `.env` files start taking effect, which may change behavior for anyone whose file disagreed with what they were actually running. Covered by `config.test.ts`.

### The Proxy Forwards the Reasoning Settings It Resolves

**Date:** 2026-09-30
**Context:** `POST /v1/proxy/chat/completions` called `resolveLLMConfig`, then used only `baseURL`, `apiKey`, `referer` and `title` from the result and forwarded `req.body` verbatim. Every reasoning decision xev had just made was discarded, so a request through the proxy ignored `LLM_REASONING_EFFORT` while the same request to `/v1/systemone` honored it. It was the same class of bug as the OpenRouter gate: resolve it, then not use it.
**Decision:** Merge the resolved reasoning settings and `extraBody` into the forwarded body, behind `req.body`, so a caller that sets those keys itself still decides.
**Rationale:** The route exists to avoid CORS for browser callers, which makes it a second front door to the same backend, and a second front door that resolves a configuration and then ignores it is a trap. Keeping the caller's body last preserves the route's original contract of forwarding what it was given.
**Consequence:** The proxy now sends `reasoning` and `extraBody` keys the caller's body did not contain. It deliberately does not forward `max_tokens`: the proxy has no placeholder count, so the server's auto-sized cap would be sized for an empty question set and cut a free-form chat off. Covered by `index.test.ts`.

### The Reasoning Reserve Is Not Router-Specific

**Date:** 2026-09-30
**Context:** The reserve was added on top of the answer budget only when the `reasoning` object was present, and that object was only ever sent to OpenRouter. On a local backend the assumption behind it — "only a router reasons" — is false, so a thinking model got a budget sized for nothing but its answer and reliably returned `finish_reason: length` with the whole budget spent on thinking. Measured against LM Studio with `qwen/qwen3.8-27b` and a 7-placeholder request: 115 reasoning tokens out of a 116-token budget, 0 tokens left for the answer, and the request failed outright.
**Decision:** Add the reserve for every backend, and drop it only when thinking was explicitly switched off. An explicit `LLM_MAX_TOKENS` is honored as given rather than used as a base for the reserve, because it is documented as the cap on the answer.
**Rationale:** `max_tokens` is an upper bound, so widening it costs a model that does not think nothing, and a model that does think needs the room or the request cannot succeed at any prompt setting. Gating the reserve on a router-only parameter meant the protection existed exactly where it was least needed. Honoring an explicit cap as a total keeps the documented contract and gives an operator whose backend thinks longer than the default reserve a way out.
**Consequence:** Every request without `LLM_MAX_TOKENS` now carries a budget 1024 tokens above the answer, on every backend. `LLM_MAX_TOKENS` set to a positive value is a total, not a base, which is the only behavior change visible to an existing configuration. Covered by `config.test.ts`.

### A Reasoning Trace Cannot Donate Values It Only Floated

**Date:** 2026-09-30
**Context:** With thinking switched off but not switchable on every backend, a trace still arrives on servers whose client has no reasoning parser: inline in `content` and with no `<think>` markers, because the template emitted none. `stripThinkBlocks` found nothing to strip, and `parseValuePairs` scanned the whole response with one global regex, so `0:0.99 looks tempting` inside the thinking could become the answer for placeholder 0. Nothing in the response identified it as reasoning, so the value looked exactly as trustworthy as one the model meant.
**Decision:** Split the pair scan into contiguous runs, separated by anything that is not `;`, a comma or whitespace, and treat each run plus the union of all runs as separate parse candidates under the existing best-coverage rule. The last run wins ties, because a trace precedes its answer. Report the winning run's position in a `warnings` entry when it did not open the response, which is the only evidence an untagged trace leaves.
**Rationale:** The answer list is the last thing a model writes, and prose between two pairs is by definition not part of one list. Splitting runs keeps the forgiving behavior the union gives a model that narrates between pairs (it still wins on coverage) while making the structured answer win the tie it used to lose. A `warnings` entry rather than a silent choice keeps the response usable and the failure visible, matching the existing incomplete-answer decision.
**Consequence:** `parseContent` returns `{ raw, source, preamble }` and `parseResponse` may emit one more `warnings` line. A response whose answer list opens the text, including inside a leading code fence, is unchanged. Per the best-candidate rule, if a new format is added it becomes another candidate with its own coverage rather than a branch in a precedence chain. Covered by `parser.test.ts`.

### One Pipeline, Two Front Doors

**Date:** 2026-09-29
**Context:** The MCP server needs to run the same evaluation as `POST /v1/systemone`. It could call the HTTP endpoint, or re-implement the steps, or call the same modules. Re-implementing guarantees drift in validation, warnings, and normalization over time; the HTTP hop requires a second process to be running and adds a failure mode that has nothing to do with evaluation.
**Decision:** Extract the pipeline into `src/evaluate.ts` with no transport attached. It takes the request body plus an optional `headers` bag and returns `{ ok: true, response }` or `{ ok: false, status, error, details }`, where `status` is exactly the code the HTTP route would have used. `index.ts` and `src/mcp/` both call it and only map the outcome to their own response shape. `config.ts` was changed to accept a `HeaderSource` (`{ headers }`) instead of an express `Request`, which an express request satisfies structurally, so the MCP path reaches the same `resolveLLMConfig` and the same credential guard.
**Rationale:** A caller must not get different behavior by choosing a door. One function that owns validate → config → prompt → llm → parse makes that structural rather than a review rule, and it means a future change to the pipeline reaches both front doors at once. Returning the HTTP status rather than throwing keeps the mapping in one place instead of each transport re-deriving it.
**Consequence:** `index.ts`'s evaluate route is now a five-line adapter. New transports call `evaluate()`; they must not import `validate`/`prompt`/`llm`/`parser` directly. Failures log to stderr through `evaluate()` rather than being thrown, so a transport that wants a stack trace has to add its own. Covered by `evaluate.test.ts`.

### MCP Is stdio, In-Process, Using the Official SDK

**Date:** 2026-09-29
**Context:** xev needs to be usable by third-party agent tools. That means speaking the Model Context Protocol. The choice was between hand-rolling JSON-RPC over stdio (roughly 200 lines for `initialize` / `tools/list` / `tools/call`) and adding `@modelcontextprotocol/sdk`, in a repo whose AGENTS.md forbids new libraries without a decision entry.
**Decision:** Add `@modelcontextprotocol/sdk` (^1.31.0, with `zod` raised to ^3.25.0 to satisfy its peer range). Serve stdio only. The server runs the evaluation in-process through `evaluate()` rather than calling `XEV_URL`.
**Rationale:** The protocol is versioned and clients pin spec revisions; hand-rolling means owning protocol negotiation, capability advertisement, and JSON Schema generation forever, for a tool surface that is one function. The SDK's value shows up exactly where this project would otherwise hand-roll: it derives the published JSON Schema from the Zod schemas and validates tool output against a declared `outputSchema`. In-process means an agent does not need a second running process, a free port, or CORS, and a single MCP call does not become three network hops. Stdio is what every MCP client already knows how to launch, and configuration is the environment block, which reuses the existing `LLM_*` variables with nothing MCP-specific to document.
**Consequence:** The dependency tree is no longer three packages, which was the cost of the choice. `McpServer.registerTool` infers its types from the schemas and that inference exceeds TypeScript's instantiation depth here, so the call goes through a locally declared `RegisterTool` signature in `mcp/index.ts` that documents why; the runtime path is untouched. Adding a transport later (Streamable HTTP for a shared deployment) means a second entry point over the same `createServer()`, not a rewrite. `mcp/index.test.ts` drives a real `Client` over `InMemoryTransport` so a protocol-level break fails in tests.

### The MCP Tool Does Not Duplicate the Request Validation

**Date:** 2026-09-29
**Context:** An MCP tool must publish a JSON Schema, and the SDK validates arguments against it before the handler runs. The obvious move is to declare xev's real question schemas, which are a `z.union` of three object types. That union is the worst case for error messages: zod's own message for one wrong question type is a nested JSON dump of `unionErrors` with a duplicated path per branch, roughly fifty lines. xev already solved this in `validate.ts`, which expands the union into a message naming the question id, the allowed types, and the missing field.
**Decision:** The published input schema is permissive about question shapes (`questions` is a `record` of anything) and the full question contract lives in the tool's prose description, which is what a calling model actually reads. `state` is the one exception: it is typed exactly as the API contract types it, because `z.unknown()` would validate the same values but land in the schema's optional set, leaving strict tool-calling clients free to send a request with no state at all. The real check is `validateRequest`, unchanged, shared with the HTTP endpoint.
**Rationale:** One validator means one set of error messages, so a malformed question reads the same however it arrived. A twelve-line JSON `anyOf` in a tool description is also worse guidance than prose that can say "criteria is an array of 2 to 10 level strings, lowest first" and explain why. Keeping `state` typed costs nothing, since a flat three-way union is both precise and cheap, and getting `required` right is what makes the tool usable with strict clients.
**Consequence:** The question contract is documented twice on purpose: as schemas in `types.ts` for the pipeline, and as prose in `EVALUATE_TOOL_DESCRIPTION` for the model. Adding a question type means updating both, and the "Adding a New Question Type" checklist in `architecture.md` says so. Do not tighten the `questions` schema into a union; if the JSON Schema ever needs to be machine-enforcing, fix zod's error rendering instead of adding a second validator.

### MCP Structured Output Is Re-Parsed, Not Passed Through

**Date:** 2026-09-29
**Context:** The `xev_evaluate` tool declares `SystemOneResponseSchema` as its `outputSchema`, which the SDK renders with `additionalProperties: false` on every object. The response built by `evaluate()` also carries a `reasoning_tokens` counter inside `usage` that the documented TypeSafe shape does not declare. A smoke test over real stdio showed the contradiction: the server was sending a payload that the schema it had just published would reject.
**Decision:** `structuredContent` is `SystemOneResponseSchema.parse(response)` rather than the response object. The reasoning count is already surfaced through the `warnings` entry that `hadReasoning` produces, so nothing is lost.
**Rationale:** A tool that advertises a schema has to honor it, and a strict client would otherwise fail on a response the server considers valid. Making the schema the thing that gets sent means the two cannot drift, and a response that genuinely violates the contract now throws at the tool boundary instead of somewhere in the client. Reusing the schema rather than stripping fields by hand is also what keeps `types.ts` the single source of truth.
**Consequence:** `reasoning_tokens` never appears in MCP structured output, only in the text digest via `warnings`. If it is ever worth exposing as data, add it to `SystemOneResponseSchema.usage` as optional rather than re-widening the output here; that is an additive change to the HTTP response too and would need its own decision. Covered by `mcp/evaluateTool.test.ts`.

### An Option Without A Description Is Described By Its Name

**Date:** 2026-10-02
**Context:** A `choice` criteria object is `optionKey -> what it means`, and callers write the short form `{"billing": null}` when the key says it all. That `null` used to reach the prompt as `- "billing": (no description)`, i.e. an instruction to weigh an option the prompt then described not at all, which is the one description guaranteed to be uninformative. A second, worse case was an option whose key was empty or blank: it consumed a placeholder, a probability slot, and a line in the answer, for an option with no name to be chosen by.
**Decision:** Normalize choice criteria in the Zod schema (`ChoiceCriteriaSchema` in `types.ts`), at the boundary: a `null` value becomes the option's own key, and an option whose key is blank is dropped before anything else sees the question.
**Rationale:** The schema is the one place both front doors pass through, and normalizing there means the prompt, the placeholder indices, and the returned probabilities agree by construction. `null` stays accepted, because rejecting the short form would break callers rather than fix them; a null is a way of writing the key twice, not an error. Dropping the blank key is the opposite case: nothing is left to ask about, and the option-count limits (`1-255`) are enforced on the normalized map, so a question left with no options is rejected with the existing "no options" 422 rather than sent to the model.
**Consequence:** `ChoiceQuestion["criteria"]` no longer admits `null` - downstream code (prompt building, parsing, the MCP digest) must treat every value as a real description. `DescriptionSchema` in `types.ts` is the single union shared by instructions, choice options, score levels, and `legend`. Code that builds a `Question` in memory and calls `buildPrompt` without going through `validateRequest` still gets the name fallback in `prompt.ts`, but an empty key there is not filtered. Covered by `validate.test.ts` and `prompt.test.ts`.

### A Manual Check Is One Process, Not A Backgrounded Server

**Date:** 2026-10-02
**Context:** To check what xev really sends to a model, the server has to run somewhere. Starting one with PowerShell's `Start-Process -NoNewWindow` (with or without output redirection) hands the child the shell tool's own stdout and stderr handles, and a handle is only released when the process exits - so the tool call blocked until it timed out, every time, and the check looked like a hang rather than a slow command. Twice this left orphaned servers holding fixed ports, and a `Get-NetTCPConnection` with no `-LocalPort` spent ~10s enumerating every socket on the machine to find them.
**Decision:** Verify with a single `node` script that does the whole job in one process: a mock OpenAI-compatible `http` server for the LLM, `import { app } from "./dist/index.js"` (not the default import - it is a CJS namespace under ESM), `app.listen(0, "127.0.0.1")` for an ephemeral port, `fetch` against it, then `close()` on both. One process, no backgrounding, sub-second, nothing left listening. When a real long-lived server genuinely is needed, start it with `-WindowStyle Hidden` and file redirection rather than `-NoNewWindow`, and stop it by the PID that `Start-Process -PassThru` returns.
**Rationale:** Anything that outlives the shell call has to give the handles back, and the only reliable way to do that on Windows is to not inherit them. An ephemeral port removes the second failure mode too: two agents on the same machine both reach for 3000, and the loser either exits or, worse, answers for the wrong process.
**Consequence:** Prefer `npm test` and the mock-LLM harness in `llm.test.ts` / `evaluate.test.ts` over a hand-started server; they assert the same prompt bytes without a port. A manual check is for questions the tests cannot answer (what did the model actually receive, how does a real backend behave), not for re-verifying behavior a test already covers. When checking a process, always scope the query (`Get-NetTCPConnection -LocalPort 3000 -State Listen`) and never kill a PID on a port the check did not start - other agents' servers share this machine.

### An All-Zero Answer Means "None Of These Apply"

**Date:** 2026-10-02
**Context:** A choice question about an image that contains no furniture came back as `0:0;1:0;2:0;3:0` - every value zero - which xev normalized to a uniform 0.25 distribution with `confidence 0` and the warning "every value the model returned was 0", which reads like a transport failure rather than an answer. It was not a criteria-handling bug, and the evidence had to be measured rather than argued: against LM Studio with `qwen/qwen3.5-9b`, five request shapes produced identical all-zero answers - `null` criteria, the same criteria written out by hand, no image at all, English instructions, and a non-empty `state`. Meanwhile the same backend, same image and empty state, answered `{red: null, blue: null, green: null}` with `red 1.0, confidence 1`, and the prompts generated from `null` and hand-written criteria were byte-identical. So the zeros track the question ("what material is this") against the state, never the shape of the criteria.
**Decision:** Keep the uniform distribution with `confidence 0` - zeros are a distribution the model chose, and promoting one of them to `choice` would be fabrication - but say what happened: the warning now reads that the model gave every option 0, "which reads as 'none of these apply'". The prompt also states that an all-zero list is not an answer and that the closest options should carry the weight instead.
**Rationale:** An evaluation API that silently converts "none of these apply" into a confident-looking winner is worse than one that returns an obviously unearned uniform plus a sentence explaining it. The rule belongs in the prompt because the documented contract already requires a distribution summing to 1.0 and the model had no sanctioned way to decline.
**Consequence:** The prompt rule costs about 30 tokens and `qwen3.5-9b` ignores it - all five shapes still abstained after it was added - so the warning is the mechanism that does the work, not the instruction. A caller who wants "none of the above" to be a first-class answer must include an option for it, and a caller evaluating an image should describe it in `state` rather than send `state: ""`; xev cannot invent the option. Covered by `prompt.test.ts` and `parser.test.ts`.

### A Bare Number Answers A Request That Asked Once

**Date:** 2026-10-02
**Context:** `POST /v1/systemone` with one `noul` question and one image returned `HTTP 502: No index:value pairs or JSON object found in LLM response: 0.5`. The model had answered correctly - the placeholder takes a single value, and it wrote that value without the `index:` prefix. xev asked for `index:value` pairs, got a valid answer to the only question there was, and reported a parse failure: a 502 claiming the format was broken when the format was redundant. Reproduced against `qwen/qwen3.5-9b` on LM Studio, which answers exactly `0.5` for that request shape.
**Decision:** `bareNumberCandidate` in `parser.ts` accepts a response that is nothing but a number, but only where it cannot be anything else: the request must have exactly one placeholder and that placeholder must be a `noul`. Surrounding whitespace, a wrapping code fence, and surrounding quotes are tolerated. It is checked last, so it can never win a tie against a real pairs or JSON candidate.
**Rationale:** With one placeholder there is no index to write, so the prefix is redundant rather than wrong, and refusing the answer punishes the caller for the model's brevity. Everywhere else the number stays ambiguous - two questions, or a choice or score needing one value per option - and guessing there is the fabrication the best-candidate rule exists to prevent, so those still raise the parse error. A number inside prose stays refused, because pulling a value out of a sentence is how an untagged trace donates a number it never committed to.
**Consequence:** `parseContent`'s `source` gains `"bare"`, which shows up in the parse warning when one is emitted. The documented answer format is unchanged - the prompt still asks for `index:value` pairs, and a bare number is a tolerated answer, not an encouraged one. If a future model family answers bare numbers for multi-question requests, widen this by mapping the value to every placeholder of the same field rather than by scanning prose for numbers. Covered by `parser.test.ts`.

### A Question Key On The Answer List Is Not A Preamble

**Date:** 2026-10-02
**Context:** The model answered `q0:0.65` for a one-question request. xev read the value correctly and then warned that "the model put text in front of the answer list ... check the reasoning settings if it was reasoning", on a response with `reasoning_tokens: 0`. `q0` is not prose: it is the template's question key, and the model read rule 9 ("the keys q0, q1 ... are the questions listed above") as though it were the index. The parser's `opensTheResponse` allowed only whitespace, separators, and a code fence before the first pair, so a one-character label looked like a preamble. The warning was not merely wrong, it pointed at the one cause that had been ruled out.
**Decision:** `opensTheResponse` also accepts a single question label - `q` with optional digits - ahead of the first pair. The digits are optional because the run starts at the index *inside* the label: for `q0:0.65` the text before the run is the single character `q`.
**Rationale:** The JSON fallback already reads `q0` as a question key, so this is the same reading applied to the pairs format rather than a new rule. Prose still warns, which is the point of the warning: only a label is excused, and it is excused only where it cannot be anything else.
**Consequence:** The label's own digits are not checked against the request - the pair's digits index the value, and a label of the wrong number is no more meaningful than a missing one. `"Let me think. q0:0.65"` still raises the warning, and so does a trace. Covered by `parser.test.ts`.

### A Blank Instructions Field Means The Question Id

**Date:** 2026-10-02
**Context:** `{ "male": { "type": "noul", "instructions": "" } }` reached the model as a question with an empty `Instructions:` line, which asks nothing: the model has no wording to judge and the caller gets an answer to whatever it infers. The caller already named the question - `male` is the question - and asked for the short form so the wording is not written twice.
**Decision:** `withKeyAsInstructions` in `types.ts` fills a blank `instructions` (empty or whitespace) with the question's id, for all three question types, at the request schema where the id is available. The field stays required: a request with `instructions` missing entirely is still a 422.
**Rationale:** The id is the only wording left, so filling it in is what the caller meant, and normalizing at the schema keeps the prompt, the placeholder map, and the parser in agreement. Keeping the field required is the part that matters for safety: zod objects are non-strict, so a client that misspells `instructions` as `instruction` would otherwise have that key stripped and the question silently become its own id with no error anywhere.
**Consequence:** This is the one case where a caller's question id reaches the model, since it becomes the instructions text; the response template still keys questions as `q0`, `q1`, ... and nothing else exposes the id. `prompt.test.ts`'s "ids are absent from the prompt" guarantee holds for every question that has wording. Documented in the MCP tool description, which is the only documentation a third-party model reads. Covered by `validate.test.ts` and `prompt.test.ts`.

