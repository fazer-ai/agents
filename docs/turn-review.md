# Turn review

A guardrails check of the agent's own steps (`guardrails.turnReview`). Before a write tool call runs, and before the final reply is sent, the guardrails chat model judges that one step against the agent's instructions and `guardrails.customPolicy`. Under `revise` a flagged step goes back to the agent with the reviewer's reason, so it can fix what it did inside the same turn. Off by default.

It exists because the output checks judge the reply after the turn is over, when every call has already run. What goes wrong in a turn is often an action: a handoff before the question the instructions require, a handoff of a question a search of the same turn answered, a reply that promises a transfer no call made, an answer to a subject the instructions send to a person. `prompt_adherence` sees these but can only replace the reply. [Factual grounding](factual-grounding.md) has the same shape for one question (is the claim backed by a source?), and this check follows it.

Code: `src/modules/guardrails/turn-review.ts` (what the reviewer reads, the prompt, the gate), `src/graph/reviewed-calls.ts` (the veto at the tool boundary), the `reviewCall` and `reviewTurnReply` hooks in `src/graph/graph.ts`, and their two callers, `src/graph/runtime.ts` and `src/modules/playground/service.ts`.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Needs `guardrails.enabled` too. Independent of `output.enabled`. |
| `action` | `observe` | `observe` (record the verdict, the step goes on) or `revise` (send the step back). |
| `maxAttempts` | `1` | `revise` only. Steps sent back per turn, 1 to 3 (`GUARDRAIL_RANGES.turnReviewMaxAttempts`). |
| `fallback` | `handoff` | `revise` only. What the turn's reply becomes once the attempts are spent and a step is flagged again: `handoff` (`output.handoffMessage` and a transfer), `template` (`output.templateMessage`) or `silent` (nothing is sent). |

The reviewer has no model of its own: it is the guardrails chat model with its key (`turnReviewer` in `prepare.ts`), whichever classifier screens, or no key on an OpenAI-compatible endpoint, whose URL comes from the credential or from the Base URL field the tab shows for that provider. A typed URL belongs to that provider only: the reader drops it for any other (`readGuardrailsConfig`), and the tab clears it on a provider change, since OpenRouter's client would honor it. The console draws the block in the Guardrails tab (section `gr-turn-review`), keeps the chat model fields in reach when screening uses Decisions, and edits the fallback's message (the same `output.templateMessage` or `output.handoffMessage` the Output section edits) in the block itself. A reviewer that can run makes the playground's "Run guardrails" toggle usable (`playgroundGuardrailsUsable`), so a test turn can skip it. REST (`PATCH /v1/agents/:id`) and MCP (`agent_settings_set`) write it through the same schema.

The block is its own and not a new value of `output.action`: every reader of `GuardrailAction` keeps its meaning, and `observe` lets an operator measure the rate on real traffic before letting the check act, as factual grounding does.

## When a step is reviewed

- **A write call**, in the graph's `tools` node, after the contradicted-handoff veto and before `ToolNode` runs. A write is a call to a tool of the set that is not read-only (`isReadOnlyTool`, `src/graph/tools/reads.ts`): the native actions, `handoff_to_human`, `skip_reply`, an HTTP tool with a method other than GET, and every MCP or integration tool, since nothing says those only read (`isReadTool` marks them for the observer, which is a different question). Read-only tools (an HTTP GET, an effect-free tool, a utility native) are never reviewed. Each write of a step is reviewed in the order the model wrote it. A call that already has an answer in the thread is left alone, and a factual-grounding revision round, which runs only the sources it admitted, is not reviewed. The reviews are awaited model calls, so the tools node reads again whether the turn is still wanted (the called-off veto) before anything runs.
- **The final reply**, in the agent node, after the filler cleanup and before the factual-grounding review. Only a turn that answers somebody: no reply channel, a silent turn, or an answer with tool calls is not a candidate. When the final text is empty, the reply under review is the one written beside an earlier call that the runtime would recover (`replyWrittenThisTurn`), and a flagged one leaves the thread before the redo. Every review of the reply, the factual-grounding one included, reads the thread as delivery will read it, with the drafts taken out so far, so an older draft a blank redo uncovers is reviewed before the runtime can recover it. On the stalled exit, where no model call is left, that recovered reply is reviewed with no redo (`canRedo: false`): a flagged one meets `fallback` at once and its draft leaves the thread.

Every path that leaves a reply for the runtime reaches the review exactly once with its final text, through one helper in the agent node (`reviewHeadedOut`):

| Path | Reviewed | Redo |
|---|---|---|
| The final answer | yes | yes |
| The silence retry's answer | yes, after the retry | yes |
| A redo the review asked for | yes, again | yes, while attempts last |
| A blank redo | gets the turn's one silence retry first, then its answer is reviewed | yes |
| The draft recovered beside an earlier call | yes, on the thread as delivery reads it | yes |
| The recovered draft on the stalled exit | yes | no: a flagged one meets `fallback` |
| A factual-grounding rewrite | yes, before grounding reviews it again | no: a flagged one meets `fallback`, and grounding skips its own review |
| The fallback message | no: it is the operator's text | |

The reactive turn and the playground pass the hooks. A proactive turn (follow-up, re-engagement) does not, so it keeps its behavior. Once the turn completed a transfer, nothing more is reviewed: the conversation is a person's.

## What the reviewer reads

One system message with the policy (`TURN_REVIEW_SYSTEM_PROMPT`), the agent's resolved system prompt fenced in `<agent_instructions>`, the operator's per-tool guidance (`operatorToolGuidance` in `prepare.ts`: `handoff.instructions`, `kanban.instructions`, `toolGuidance`) fenced in `<tool_instructions>`, since it reaches the agent in the tool descriptions and not in the prompt, and the additional policy when there is one. One user message with `<now>`, the last 24 messages of the conversation (`<conversation_context>`, the same window as factual grounding), the calls with their results (`<tool_results>`, each result clipped to 8,000 characters), and the step (`<proposed_step>`): the call with its arguments, or the reply with the names of the tools the turn called. A call is shown with the writes of the same step already admitted, listed as not yet run, so two bookings in one batch are judged together. Tag-like text inside any block is stripped, so a message cannot close a fence.

The verdict is the shared guardrail JSON (`VERDICT_SCHEMA`), and the rationale is one sentence addressed to the agent, in the conversation's language, saying what to do instead. The policy flags only a step that does what the instructions forbid or skips what they require in that situation. Style, tone, wording and anything left to the agent's judgment are not violations, and the prompt says to not flag when in doubt.

## Actions

- `observe`: the step goes on as written. The flow line and the trace carry the verdict.
- `revise`, a flagged call: the call does not run. A `ToolMessage` marked `turn_review_veto` (`turnReviewVetoToolResult`) answers it with a note (`turnReviewNote`, Portuguese like the other agent-facing notes) saying the call was not executed and why, and the model continues the turn. A read in the same step still runs. The marker keeps the vetoed call out of the side-effect accounting of a superseded reply (`turnActedBeforeItsReply`, `actedToolNames` in `refused-turn.ts`), by call id, so a sibling write that ran still counts.
- `revise`, a flagged reply: the draft never reaches the thread. The graph asks the model again with the note as a late system message quoting the draft, bound to the whole toolset, so a reply that promised a transfer can now make the call. A call in the new answer goes to the tools node and is reviewed there. A new reply is reviewed again.

Each step sent back spends one attempt. Once they are spent, the next flagged step stops the review for the rest of the turn: a call runs as written, and the turn's reply meets `fallback` through the caller's output step (`pending()`), ahead of the factual-grounding decision and in place of the moderation screening, as a grounding `template` or `handoff` does. Once that decision is pending, the factual-grounding review of the reply is skipped, since nobody would read its rewrite. A call past the limit is let through because a veto would only loop: the model reads the note and calls again.

The held refusals are errors (`status: "error"`) like the veto, so a refused read never reads as a source that answered. Vetoes and holds on a call a provider sent with no id are matched by name inside their batch.

A review that fails (no key, an unusable model, an error, an unreadable answer) lets the step through with a warn line, unless `guardrails.onFailure` is `hold` and the action is not `observe`. Then the turn stops reviewing, the tools node refuses every call of that step and ends the round (`halted()`), and the conversation is handed over before any write runs. The refusals carry their own marker (`turn_review_held`), never `called_off`: a called-off turn exits before the handover (`turnWasCalledOff`), and a held one must reach it.

## Logs

One `guardrail` line per review, `check: "turn_review"`, with `step` (`call` or `reply`), `tool` on a call, `verdict` (`clean` or `violated`), `latencyMs`, `inputTokens` and `outputTokens`. A flagged step is `warn` and carries `action`, and under `revise` `outcome` (`revised` with the `attempt` number, or `exhausted` with the fallback as `action`). The rationale is logged only with `logToolValues` on (scrubbed, 500 characters), otherwise only its length (`rationaleChars`). A failed review writes `outcome` (`credential_not_found`, `model_unavailable`, `analysis_failed`) with `unchecked: true`, or `held: true` under `hold`. The playground trace shows each review as a guardrail row, named by its step and tool, and the Logs page tells an observed call (it ran as written) from an observed reply (it went out as written).

## Cost

One reviewer call per reviewed step, billed on its own ledger node, `guardrail_turn_review`, under the guardrails model, and covered by the turn's spend gate. A turn with two writes and a reply pays three calls. Plus one agent generation for each step sent back. The system message is the same bytes on every review of the agent while its prompt does not change, so providers that cache a prefix read it from the cache.
