# Architecture

> When the request lifecycle, data flow, or integration patterns change, update this document.

## Overview

Xev is an HTTP server that translates TypeSafe's System One API format into LLM calls and back. It acts as a compatibility layer: clients send the same request they would send to TypeSafe, and Xev uses any OpenAI-compatible LLM to produce the answers.

## Request Lifecycle

```
Client Request
     │
     ▼
┌─────────────┐
│  validate    │  Zod schema check on request body
└─────┬───────┘
      │ valid
      ▼
┌─────────────┐
│   prompt     │  Build structured prompt from state + questions
└─────┬───────┘
      │
      ▼
┌─────────────┐
│     llm      │  Call OpenAI-compatible API, get JSON response
└─────┬───────┘
      │
      ▼
┌─────────────┐
│   parser     │  Normalize probabilities, compute confidence, build response
└─────┬───────┘
      │
      ▼
Client Response
```

## Data Flow

1. **Request** arrives as JSON matching `SystemOneRequest` (state + questions map)
2. **Validation** checks required fields and question type constraints
3. **Prompt builder** serializes state and questions into a single prompt string with explicit JSON output instructions
4. **LLM client** sends the prompt to the configured provider, requests JSON output via `response_format`
5. **Parser** extracts the JSON, normalizes probabilities per question type, computes confidence from entropy
6. **Response** is returned in `SystemOneResponse` format

## Key Design Decisions

- **Single prompt for all questions**: All questions are sent in one LLM call, not one per question. This mirrors how TypeSafe works (parallel evaluation) and reduces latency.
- **Temperature 0**: Deterministic output from the LLM for reproducible results.
- **JSON response format**: Uses the `response_format: { type: "json_object" }` parameter when available, with regex fallback parsing.
- **Probability normalization**: LLM outputs are normalized to sum to 1.0 for each question, fixing any drift from the LLM.
- **Confidence via entropy**: Confidence is derived from the entropy of the probability distribution, not from the LLM's self-assessment.

## Integration Points

| System | Protocol | Purpose |
|--------|----------|---------|
| OpenAI-compatible LLM | HTTPS | Backend for question evaluation |
| Client applications | HTTP | Accept TypeSafe-format requests |

## Adding a New Question Type

1. Add the question type to `types.ts` (schema + TypeScript type)
2. Add prompt instructions in `prompt.ts` (`questionToPrompt` function)
3. Add parsing logic in `parser.ts` (new parse function, add to `parseResponse`)
4. Update this document and `structure.md`
