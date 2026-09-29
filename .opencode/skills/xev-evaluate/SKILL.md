---
name: xev-evaluate
description: Use the xev_evaluate MCP tool to judge text or data with an LLM and get structured answers back - classify, categorize, triage, route, score, rate, grade, label, or answer a yes/no question about an input. Use when asked to evaluate, assess, judge, or decide something with an LLM instead of guessing, when a task needs a probability or a confidence rather than a yes/no, or when handling xev, Jev, TypeSafe, or System One requests.
---

# Evaluating with xev

`xev_evaluate` sends one piece of content plus a set of questions to an LLM and returns a
structured answer per question, each with a probability distribution and a confidence. It is
how you turn "read this and decide" into something you can branch on.

Reach for it when the decision is a judgement call, not a lookup:

- routing or classifying content (a ticket to a team, a message to a category, a file to a language)
- grading or rating (severity, urgency, quality, risk, priority)
- a yes/no that you would otherwise be guessing at (is this spam, is this a complaint, does this answer the question)
- getting a distribution rather than a coin flip, so you can act differently on "probably" and "certainly"

Do **not** use it for anything a regular expression, a lookup table, or reading the file already
answers. It costs an LLM call and adds latency.

## Before you call

The tool must be configured on the client as an MCP server. If `xev_evaluate` is not in your
tools, say so rather than reimplementing the logic - the user needs to start the server. For
xev itself that is `npm run mcp` (or `node dist/mcp/index.js` after `npm run build`), pointed at
a reachable OpenAI-compatible model.

## Pick the question type

| You need | Type | Criteria shape |
|----------|------|-----------------|
| One of N named outcomes | `choice` | object: option key -> what that option means |
| A level on an ordered scale | `score` | array of 2-10 level strings, lowest first |
| A yes/no | `noul` | none |

Rules that are easy to get wrong:

- `choice` option keys are returned to you verbatim. Make them short, machine-safe, and
  self-describing (`"billing"`, not `"option_b"`). A key you cannot act on is a wasted call.
- `score` levels are **positional**: the array index *is* the value, so 4 levels score 0-3. Order
  them lowest to highest and write each one as a description of that band ("Payment fails at
  checkout, no revenue lost"), not a bare label ("bad").
- `score` needs 2 to 10 levels, `choice` needs 1 to 255 options. A `score` with one level is rejected.
- `instructions` is what the model reads. Say what you are deciding and what to weigh, not just a
  field name. `"Which team should own this?"` is weak; `"Which team should own this? Escalate to
  security if credentials or payment data are involved."` is not.

## Ask everything in one call

Every question in one `xev_evaluate` call is answered in a **single LLM call**. Splitting the same
questions across several calls costs latency and money for no gain, and it loses the shared
context - the model sees the whole state once and can weigh the questions against each other.

So put every question you need into one `questions` object. If you find yourself wanting to call
the tool a second time with a different question, you should have sent it the first time.

Use a JSON object for `state` when the input has structure (a log record, a file with a path and
contents, an issue with title and body). Use a string for prose. Do not paste a whole file when a
relevant excerpt will do; the state goes into the prompt verbatim and a bloated one degrades the
answers.

## Example: triage a support ticket

```json
{
  "state": "I've been waiting 3 weeks for my refund and nobody has replied. This is unacceptable.",
  "questions": {
    "team": {
      "type": "choice",
      "instructions": "Which team should own this ticket?",
      "criteria": {
        "support": "How-to questions, account access, general usage",
        "billing": "Charges, refunds, invoices, subscriptions",
        "engineering": "Bugs, outages, API failures"
      }
    },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is this? Weigh how long the customer has already waited.",
      "criteria": [
        "Low - informational, no action needed this week",
        "Medium - should be handled within 48 hours",
        "High - customer is blocked or losing money, handle today",
        "Critical - legal risk, data loss, or service-wide outage"
      ]
    },
    "is_churn_risk": {
      "type": "noul",
      "instructions": "Is the customer at risk of leaving over this? Look for dissatisfaction, not just anger."
    }
  }
}
```

Answers come back keyed by the ids you chose:

```
team (choice) => billing
  confidence 0.85
  billing 0.80  support 0.15  engineering 0.05

urgency (score) => 2.3 (mostly level 2: High - customer is blocked or losing money, handle today)
  confidence 0.53
  2=0.55 High - customer is blocked or losing money, handle today
  1=0.30 Medium - should be handled within 48 hours
  3=0.10 Critical - legal risk, data loss, or service-wide outage

is_churn_risk (noul) => 0.85 — yes

model xev-qwen/qwen3.5-9b · 380 tokens in / 21 out
```

## Example: yes/no, and the thing to be careful about

```json
{
  "state": "<the message, post or diff>",
  "questions": {
    "answers_the_question": {
      "type": "noul",
      "instructions": "Does this message actually address the user's question, or does it dodge it?"
    },
    "needs_clarification": {
      "type": "noul",
      "instructions": "Is something genuinely ambiguous, or would the reader understand this?"
    }
  }
}
```

A second `noul` in the same call is nearly free. Use them to pair a judgement with its
counter-check.

## Read the result properly

- **`confidence` is not accuracy.** It is a rescaled measure of how far the top answer beat the
  rest. A low confidence means the options were close, not that the answer is wrong. It is a
  signal for *you*: on a low-confidence choice you may want to say so, ask a human, or pick a
  tie-break rule explicitly rather than presenting the top option as settled.
- **`score` is an average, not a label.** It is the weighted mean of the level indices, so it is
  often fractional (`2.3`). The digest names the level it mostly landed on. If you need to round,
  round deliberately and say which way.
- **Read `warnings`.** It appears only when the model did not fully answer - a truncated reply, a
  question it skipped, or a leaked thinking trace. The numbers in a warned response may have been
  defaulted rather than decided, so do not present them as the model's judgement. A retry with a
  smaller question set is usually the fix.
- **The digest is for you; `structuredContent` is for the program.** The text block is a readable
  summary. The structured payload carries every probability, the full legend, and the token counts
  if you need to compute something yourself.

## When it fails

- `422` - the request is malformed. The message names the question id and what was wrong; fix that
  field and call again. It costs nothing, no model call happened.
- `429` - the provider is rate limiting. Wait, then retry the identical request.
- `502` / `504` - the model call failed or timed out. The request was fine. Retry once, and if it
  keeps failing the model or its connection is the problem, not your questions.

Do not silently retry a 422, and do not report a guessed answer as if the model had produced it.
If the tool is unavailable, say so.
