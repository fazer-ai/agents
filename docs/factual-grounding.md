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
| `provider`, `model`, `credentialRef`, `baseURL` | `null` | The reviewer's own chat model, an override of the guardrails chat model resolved by `resolveModelOverride` (`resolveGroundingReviewer` in `settings.ts`), the same rule the suggestion reviewer and the choice check follow against the agent's model. Nothing set is the guardrails model whole, key and endpoint included. A model or key needs a provider (refused as `override_without_provider` otherwise; the console pins the guardrails provider when one is picked while it inherits). On the guardrails provider and endpoint, a blank model or key inherits theirs; on another provider a key of its own is required (`credential_required`), except a keyless `openai-compatible` endpoint, which runs on no key; a reviewer inheriting a guardrails model that is itself a keyless `openai-compatible` endpoint runs keyless too. A reviewer that does not resolve is a failed review (`credential_not_found` when its key did not resolve, `model_unavailable` otherwise), never a clean one. The console draws these four fields with `ModelOverrideFields`, like every other model of its own (docs/ui.md). |

The console draws it in the Guardrails tab (section `gr-grounding`); REST (`PATCH /v1/agents/:id`) and MCP (`agent_settings_set`) write it through the same schema, which refuses an action outside the four.

`generated` and `silent` are not offered. The reviewer has no tools, so a replacement it wrote would have to invent the fact it found missing, and silence leaves the customer unanswered on a false positive.

## When it runs

When a source tool returned something (a non-empty result that is not a tool error) in this turn, or in an earlier turn that the reviewer's conversation window still shows. The second case is the one that costs most when missed: a later answer, under the customer's pressure, repeats from memory what a tool returned turns ago, and gets it wrong without calling the tool again. Once a source turn is in the window, every reply until it leaves the window is reviewed, "thank you" answers included; that is the price of the coverage. A turn with no source in either place costs nothing: no call, no flow line, no trace row. It runs on the text that would go out: the answer that ends the turn, or, when that is empty, the reply written beside an earlier call that the runtime recovers, only when it would recover it: not after a transfer or once something was delivered or queued (on a stalled turn too, where a revise has no model call left and reads as an empty rewrite). A revise takes that draft out of the thread. The playground does not recover such a reply, so there it is not reviewed either. Once per turn, on the reactive inbox turn and on the playground turn. Not after a transfer the turn completed: the model's text is dropped then, so there is nothing to review. Proactive follow-ups are not reviewed.

## What the reviewer reads

One system message with the generic policy (`GROUNDING_SYSTEM_PROMPT`) and one user message with three fenced blocks:

- `<conversation_context>`: the last `contextMessages` messages before the turn, from the attendance that is open, each labeled customer, assistant or attendant. A customer message carries what vision read from an image they sent, so a reply that repeats what a customer's print shows counts as grounded. Each message is bounded at 8,000 characters.
- `<tool_results>`: first the source calls of the earlier turns in the window, then every tool call of this turn, each with its arguments and its whole result, sources marked `source="yes"`. An earlier call carries `turn="earlier" turns_back="N"` (N customer messages ago), and the policy tells the reviewer it is still a source. Results are never cut. Above 400,000 characters of results in total the review does not run and the flow line says `sources_too_large`.

  The earlier calls come from the agent's own thread (the checkpoint), where each `ToolMessage` is kept as the model read it, never from the flow log, which cuts values at 2,000 characters. They come from the same history the agent's model was sent, so with the history ceiling (`limits.maxHistoryTokens`) on, a result the model no longer saw is not a source either. The window is the one `<conversation_context>` shows (`contextMessages`, at most 20 messages, from the open attendance): a turn counts when any of its messages is in it, so the calls behind the oldest reply shown come with it. No separate cap: the same knob bounds what the reviewer reads of the conversation and of its sources, and the 400,000 ceiling bounds the total. Only earlier SOURCE calls travel; an earlier call to any other tool is no ground for this reply. A closed attendance is compacted into a summary and keeps no `ToolMessage`, so a source never crosses attendances.
- `<reply>`: the reply under review.

The agent's system prompt is never sent. Everything customer-written or tool-returned rides at user level, with any text that could close a fence removed, as the other checks do.

The verdict is `{violated, claims: [{claim, type, evidence}], rationale}`, asked with the same constrained-output modes as the moderation verdict and read by the same rule: exactly one verdict, or the review counts as failed.

## Actions

- `observe`: the reply goes out as written. The flow line and the trace carry the claims.
- `revise`: the graph asks the agent's model once more, without tools, with a late system note (`reviseNote`) quoting the draft and listing the claims. Only the second answer is kept in the thread and delivered; it is not reviewed again. A rewrite that comes back empty sends `output.templateMessage` instead (flow line `revision_empty`), never the refused draft. One extra generation per flagged turn.
- `template`: the reply is replaced with `output.templateMessage`, and a private note is posted.
- `handoff`: the reply is not sent, `output.handoffMessage` is, and the conversation goes to the team, through the same path as an output-moderation hand-over.

`template` and `handoff` cannot act from inside the graph, so the gate keeps the decision (`pending()`) and the runtime's output step applies it in place of the moderation screening. A transfer the turn completed wins over it, with its closing line or in silence: the conversation is a person's now. The text reviewed is the customer-facing one, so an answer that is only the silence token is not reviewed.

A review that fails (no key, an unusable model, an error, an unreadable answer, results past the ceiling) lets the reply through with a warn line, unless `guardrails.onFailure` is `hold` and the action is not `observe`, in which case the conversation is handed over.

## Logs

One `guardrail` line per review, clean or flagged, `check: "factual_grounding"`, so the rate of the check is readable from the log in any mode, `observe` included. Every line carries `verdict` (`clean` or `violated`), `claimCount`, the source tool names (`sources`), the total result size (`resultChars`), how many sources came from earlier turns (`earlierSources`), the latency (`latencyMs`) and the reviewer's tokens (`inputTokens`, `outputTokens`). A clean line is `info` with no `action`, the same contract as the external check's `allow` line: it is not a trip, so it is not an observed trip either and does not move the alert selectors. A flagged line is `warn` and adds the action and `categories: ["factual_grounding"]`. The claims and their evidence are model text quoting the reply and the tool results, so they are on the line only with `observability.logToolValues` on (new agents have it on). A review that could not run writes its failure line instead (above), and the Logs page shows each review with a headline of its own. Reading the sources the reviewer judged, days later, depends on keeping the turn's full tool results (#1761).

## Cost

One reviewer call per reviewed turn, billed on its own ledger node, `guardrail_grounding`, under the reviewer's model, so its cost reads apart from the moderation calls on `guardrail` in the cost dashboard and in each turn's usage. It counts as part of the agent's turn and is covered by the turn's spend gate, like `guardrail`. Plus one agent generation for each `revise`. Measured with the battery: about 8,100 input tokens at the median (about 11,400 at most) and 290 to 350 output tokens per review. The input is dominated by the tool results. A cascade of a cheap reviewer confirmed by a stronger one, and prompt caching of the sources, are tracked in #1763.
