# Factual grounding

An output check of the guardrails (`guardrails.factualGrounding`). Before a reply goes out, a reviewer model compares it with what the agent's tools returned in that turn and with the recent conversation, and lists the claims the tool results do not support. Off by default.

Code: `src/modules/guardrails/grounding.ts` (what the reviewer reads, the prompt, the verdict), `src/modules/guardrails/grounding-gate.ts` (when it runs, the flow line, what each action leaves behind), the `reviewReply` hook in `src/graph/graph.ts`, and its two callers, `src/graph/runtime.ts` and `src/modules/playground/service.ts`.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Needs `guardrails.enabled` too. Independent of `output.enabled`: an operator can run grounding without moderation. |
| `sourceTools` | `[]` | Tool names whose results count as sources. Empty means the check never runs. |
| `action` | `observe` | `observe`, `revise`, `template` or `handoff`. |
| `contextMessages` | `6` | Earlier messages of the conversation the reviewer reads (0 to 20). |
| `provider`, `model`, `credentialRef`, `baseURL` | `null` | The reviewer's own chat model. With `provider` null it is the guardrails chat model, key included (`groundingReviewer`). |

The console draws it in the Guardrails tab (section `gr-grounding`); REST (`PATCH /v1/agents/:id`) and MCP (`agent_settings_set`) write it through the same schema, which refuses an action outside the four.

`generated` and `silent` are not offered. The reviewer has no tools, so a replacement it wrote would have to invent the fact it found missing, and silence leaves the customer unanswered on a false positive.

## When it runs

Only on a turn in which at least one source tool returned something (a non-empty result that is not a tool error). A turn with no source costs nothing: no call, no flow line, no trace row. It runs on the answer that would end the turn (text and no tool calls), once per turn, on the reactive inbox turn and on the playground turn. Proactive follow-ups are not reviewed.

## What the reviewer reads

One system message with the generic policy (`GROUNDING_SYSTEM_PROMPT`) and one user message with three fenced blocks:

- `<conversation_context>`: the last `contextMessages` messages before the turn, from the attendance that is open, each labeled customer, assistant or attendant. A customer message carries what vision read from an image they sent, so a reply that repeats what a customer's print shows counts as grounded. Each message is bounded at 8,000 characters.
- `<tool_results>`: every tool call of the turn with its arguments and its whole result, sources marked `source="yes"`. Results are never cut. Above 400,000 characters of results in one turn the review does not run and the flow line says `sources_too_large`.
- `<reply>`: the reply under review.

The agent's system prompt is never sent. Everything customer-written or tool-returned rides at user level, with any text that could close a fence removed, as the other checks do.

The verdict is `{violated, claims: [{claim, type, evidence}], rationale}`, asked with the same constrained-output modes as the moderation verdict and read by the same rule: exactly one verdict, or the review counts as failed.

## Actions

- `observe`: the reply goes out as written. The flow line and the trace carry the claims.
- `revise`: the graph asks the agent's model once more, with a late system note (`reviseNote`) quoting the draft and listing the claims. Only the second answer is kept in the thread and delivered; the revised answer is not reviewed again. One extra generation per flagged turn.
- `template`: the reply is replaced with `output.templateMessage`, and a private note is posted.
- `handoff`: the reply is not sent, `output.handoffMessage` is, and the conversation goes to the team, through the same path as an output-moderation hand-over.

`template` and `handoff` cannot act from inside the graph, so the gate keeps the decision (`pending()`) and the runtime's output step applies it in place of the moderation screening.

A review that fails (no key, an unusable model, an error, an unreadable answer, results past the ceiling) lets the reply through with a warn line, unless `guardrails.onFailure` is `hold` and the action is not `observe`, in which case the conversation is handed over.

## Logs

One `guardrail` line per flagged turn, `check: "factual_grounding"`, with the action, the source tool names, the total result size, the latency and the claim count. The claims and their evidence are model text quoting the reply and the tool results, so they are on the line only with `observability.logToolValues` on (new agents have it on). A clean verdict writes no line. Reading the sources the reviewer judged, days later, depends on keeping the turn's full tool results (#1761).

## Cost

One reviewer call per reviewed turn, billed on the `guardrail` ledger node under the reviewer's model, plus one agent generation for each `revise`. The input is dominated by the tool results. A cascade of a cheap reviewer confirmed by a stronger one, and prompt caching of the sources, are tracked in #1763.
