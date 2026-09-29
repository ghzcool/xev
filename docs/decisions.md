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
**Consequence:** Reasoning options are only sent to OpenRouter, since a plain OpenAI-compatible server has never heard of the parameter. `exclude` is on by default and `LLM_REASONING_EXCLUDE=false` exists for debugging. A model flagged `mandatory` in the `/v1/models` entry rejects `effort: "none"`; `low` and `minimal` are the safe choices. When a trace does come back next to an answer, the response carries a `warnings` entry rather than silently trusting it. Covered by `llm.test.ts` and `config.test.ts`.

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

