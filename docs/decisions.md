# The decisions engine of a monitoring agent

A monitoring agent decides in one of two ways, chosen by `settings.monitoring.engine`:

- `llm` (the default, and what any absent or unknown value reads as): the ordinary graph with the agent's prompt and tools, run on a muted client (docs/chatwoot.md, "Monitoring").
- `decisions`: the tick asks a classification API typed questions about the conversation and turns the answers into tool calls by rule. No chat model runs.

The mode stays `monitoring` either way, so everything that keys on the mode is unchanged: the agent never answers, it attaches as an observer, several observers share an inbox, the Conversations filter and the dashboard list it as before. Only the brain of the tick changes. Issue #1135.

## What is shared with the `llm` engine

`runObserve` (`src/modules/observe/job.ts`) runs the same steps up to the decision: arming (debounced burst, or on resolve, by `monitoring.analysis`), the claim and the fences, the window and transcript (with transcriptions and image descriptions from the media pass), current labels, notes and label history, the toolset build, and the spend ceiling. What differs is after the ceiling: the `decisions` engine builds no model and calls the provider instead.

The provider reads the same evidence the model would, rendered by `observeEvidenceText`: the label, note, label-change and transcript blocks without the frame that tells a model how to act. TypeSafe documents that accuracy drops when the state carries irrelevant text, and instructions about tools the API does not have are exactly that.

## The block

```json
{
  "monitoring": {
    "engine": "decisions",
    "decisions": {
      "provider": "typesafe",
      "model": "jev-latest",
      "credentialRef": "vault:12",
      "questions": [
        { "name": "pede_reembolso", "type": "yes_no", "instructions": "O cliente pede o dinheiro de volta?" },
        { "name": "assunto", "type": "choice", "instructions": "Assunto principal",
          "options": [{ "value": "reembolso", "description": "estorno" }, { "value": "outro", "description": "outro assunto" }] },
        { "name": "irritacao", "type": "score", "instructions": "Quão irritado está o cliente?",
          "levels": [{ "value": "calmo", "description": "" }, { "value": "frustrado", "description": "" }, { "value": "muito_irritado", "description": "" }] }
      ],
      "rules": [
        { "when": [{ "question": "pede_reembolso", "minProbability": 0.7 }],
          "action": { "tool": "set_labels", "args": { "add": ["reembolso"] } } },
        { "when": [{ "question": "assunto", "equals": "reembolso", "minConfidence": 0.8 },
                   { "question": "irritacao", "minLevel": 2, "maxLevel": 2 }],
          "action": { "tool": "handoff_to_human", "args": {} } }
      ],
      "apply": "shadow"
    }
  }
}
```

- `provider`: `openai` (OpenAI Decisions, `POST /v1/decisions`, public beta, `gpt-6-luna` only) or `typesafe` (Jev, the official API at `api.typesafe.ai/v1/systemone`; `jev-latest` is an alias, a version such as `jev-1.13.0` pins it). `model` defaults per provider. The provider is kept apart from the agent's chat `modelConfig` on purpose: `typesafe` is not a chat provider and is not in `MODEL_PROVIDERS`.
- `credentialRef`: a vault entry holding the provider's API key. Listed in `SETTINGS_CREDENTIAL_PATHS`, so MCP takes and answers a name, export and import translate it, and config-health reports it missing, pending, gone or of the wrong kind (`decisions`, degraded) on a monitoring agent whose engine is `decisions` (a watcher switched to production keeps its stored block and is not judged by it). A credential entry's base URL, when it has one, replaces the provider's.
- `questions`: up to 50. `yes_no` answers a probability; `choice` (2 to 255 options, values unique within the question) answers one option's `value`, its confidence and every option's probability; `score` (2 to 10 levels, lowest first) answers a probability-weighted mean of level indices, its confidence and every level's probability. Probabilities are keyed by the option's or level's `value` for both providers.
- `rules`: a rule fires when EVERY condition holds. A `yes_no` condition needs `minProbability`; a `choice` condition needs `equals`, one of the question's option values, and may ask `minConfidence`; a `score` condition needs `minLevel` and `maxLevel` (inclusive, the score read as the nearest level) and may ask `minConfidence`. A provider that omits confidence does not pass a condition that asks for one. Two rules firing the same tool with the same arguments run it once.
- `action.tool`: `set_labels`, `handoff_to_human`, `private_note` or `set_custom_attribute`, with fixed `args` in the tool's own schema. The call goes through the same tool object the `llm` engine's model calls, after the same fenced wrapper, so protected labels, the pinned handoff target, allowed labels, the label queue and at-most-once counting apply unchanged, and the tool writes its own `tool` flow line. A tool the agent was not granted does not run (`not_granted`): grants are the operator's, as for the model. The agent's `limits.maxToolCalls` caps the actions one tick dispatches, shadow's included; a rule past it reports `over_budget`.
- `apply`: `shadow` (the default) decides, pays for the call and logs the actions it would have run (an ungranted tool shows as `not_granted` and arguments the tool's schema refuses as `failed` with `invalid_arguments`, as on enforce), and writes nothing to Chatwoot; `enforce` runs them. Shadow is how a decisions agent is validated beside an `llm` agent on the same inbox before it is trusted. The tick's fence asks the engine and `apply` again before every action, so switching to `shadow` (or off the engine) while a call is in flight ends that tick with `skipped: engine_changed` instead of letting it write.

`engine: "decisions"` without a block (absent or `null`) is refused at `monitoring.engine`, judged against the whole monitoring block. REST and MCP refuse a block the tick could not run, with a 400 naming the field (`decisionsSchema`, through `assertSettingsClosedValues`). A missing field is named at the object that lacks it, since the boundary compares by value at the issue's path and an absent key equals an absent stored key. A cross-field problem is judged against the whole block instead: renaming an option, deleting a question or shortening a scale that an unchanged rule still names is refused (naming the rule's field), while a stored block re-sent untouched still saves. On MCP the block is a partial patch like any other: `agent_settings_set` takes it without the cross-field rules (`decisionsPatchSchema`), merges it into the stored block, and asks the merged block the full schema already in the preview, so `{ "decisions": { "apply": "enforce" } }` flips one field of a working block and a patch that leaves the block incomplete is refused before it is stored. The tick reads the block again (`readDecisionsConfig`) and stops on a problem instead of acting, because a row written before this schema, or re-sent untouched, still reaches it.

`readMonitoringConfig` carries `engine` and the `decisions` block: it is the reader every rewrite of `monitoring` goes through (the MCP merge, the console's Behavior save, the audit projection), and a block it did not carry would be deleted by them. It carries the declared fields only (`projectDecisionsBlock`), picked by name at every level, so a key pasted beside them (an `apiKey`) never reaches an audit row; `action.args` goes as written. The console has no screen for the block yet; its Observation form carries both through untouched.

## How the actions reach Chatwoot

Actions run in rule order, one at a time, each after the observation's fence. The exception is the actions whose tool commits calls that arrive together as one write (`sharedWriteKey`, `src/graph/tools/native.ts`): every `set_labels` on the conversation, and every `set_custom_attribute` on the conversation. Those that are NEIGHBOURS in rule order are dispatched together, after each has passed its own fence, so three attribute rules cost one read and one write instead of three of each, and two label rules cost one read and one write of the set they add up to; the label write and the attribute write go out side by side, since they touch different things. Nothing else changes: the same actions run, the line lists each one in rule order with its own outcome and its own label counts, and a write Chatwoot refuses fails exactly the actions that rode on it. Only neighbours are grouped, so no action ever runs ahead of one the rules put before it: a note or a transfer between two attribute rules keeps them apart, and putting the label and attribute rules next to each other is what makes them one round trip. A tool that carries a precondition (`settings.toolPreconditions`) is never grouped: its condition reads what the rules before it wrote, so it waits for them. And a watcher whose contact gate has conditions (`settings.contactAuth.rule`) groups nothing at all: the fence asks those conditions of the same labels and attributes the actions write, so an action that takes the conversation out of the rule must have landed before the next one is admitted, and such a watcher pays one read and one write per action. The grouping is asked again once the group's fences have run, since they are what read the live settings: a gate saved while the provider was answering is seen there, and the group falls back to its first action alone. The same watcher's tools do not share a write either (`ToolCtx.writesAlone`), which is what covers the `llm` engine, whose model calls its tools in parallel: each call queues an entry of its own and is admitted by its own fence after the write ahead of it. Calls that had already joined one write when its fence first read such a gate are split there: the first is written, and the others follow inside the same queue entry, one read and one write each and each asked again, so a writer queued meanwhile stays behind all of them. The mirror updates of one conversation's attributes are applied in the order the writes reached Chatwoot, so two neighbouring rules naming one key leave the mirror on the value Chatwoot kept. A fence that refuses while a group is being admitted stops the whole group, since none of it has started. An action whose arguments its tool's schema refuses is dispatched in its place and fails before its handler runs, so it writes nothing and rides inside the run it sits in: an invalid rule between two attribute rules is that rule's `invalid_arguments`, and the two around it are still one write. The label rules are applied to the labels the tick read for the evidence, one provider call earlier (`ToolCtx.conversationLabelsRead`, trusted for ten seconds), and a later label write of the same tick to the set the earlier one left; the price is that a label another writer puts on inside that window is not in the set written back, which is why the `llm` engine, whose model thinks for seconds, reads again. A decision with labels, three attributes and a note on a conversation shorter than a page is six requests: the window, the labels, the label write, the attributes read and written, the note (issue #1177).

## The tick's outcomes

One `observe` line per tick, with `engine: "decisions"`, the provider and the requested model (on every exit, a fence refusal after the call included), and:

| Outcome | Status, level | Detail |
| --- | --- | --- |
| Decided | `ok`, `info` | `apply`, `modelVersion` (what the provider says answered; TypeSafe resolves the alias; kept only when it is the requested model, its dated snapshot or, on TypeSafe, a numeric `jev-` version, null otherwise, since a credential's base URL may point anywhere), `answers` (numbers and option names only), `actions` (`ran`, `shadow`, `not_granted`, `over_budget`, `failed` with `invalid_arguments` or `tool_error`), `notFired` (per rule, the first condition that failed and why: `below_threshold` with the value, threshold and measure, `other_choice`, `outside_levels`, `refused`, `unanswered`), `acted`, `messagesRead`, `labelsBefore`, `labels` |
| An action could not run | `ok`, `warn` | as above, with a `not_granted`, `over_budget` or `failed` action |
| Block invalid | `skipped`, `warn` | `skipped: "decisions_config_invalid"`, `problem` naming the field |
| Credential unresolved | `skipped`, `warn` | `skipped: "decisions_credential_unresolved"` |
| Provider failed | `error`, `info` with `willRetry` while the job retries, `warn` on the last attempt | `failed: "decision_call"`, `failure` in the closed vocabulary (`HTTP 503`, `timeout`, `provider error`); the response body is never read into the error |

A problem never falls back to the `llm` engine: an operator who chose classification did not choose to pay for a model turn when it is misconfigured. The conversation text is sent to the provider and never written to the line.

## Cost

A successful call is recorded through `recordDirectUsage` under node `decision` (`USAGE_NODE_IS_AGENT_TURN`: false; `SPEND_GATE_FOR_NODE`: gated, by the same check the `llm` tick asks right before its call). Both providers bill input tokens only, so the row carries `completionTokens: 0` even when TypeSafe reports output tokens. `gpt-6-luna` is priced by the LiteLLM table's input rate ($0.10 per 1M, the rate the Decisions guide states). TypeSafe is not in that table; its rate is pinned in `PUBLISHED_RATES` (`src/modules/pricing/price.ts`), $0.042 per 1M input tokens, from docs.typesafe.ai/models read 2026-10-07. `typesafe` is in `PRICE_OVERRIDE_PROVIDERS`, so a tenant may override that rate and `reprice-usage --provider typesafe` corrects past rows. A failed call records nothing.

## Known limits

- Text only, on both providers. OpenAI accepts inline images; sending them to one provider and not the other would make the two incomparable on the same agent, and the observer already reads image descriptions as text.
- Questions are independent. A question that depends on another's answer needs a second request (OpenAI says so); not supported.
- The agent still needs a chat `modelConfig` that builds: `loadAgentConfig` is asked before the engine is known, and a config it cannot build retries the tick as it does for an `llm` agent.
- No console screen yet: the block is written through REST or MCP.
