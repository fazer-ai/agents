# Split + typing (humanized delivery)

Instead of dumping one wall of text, optionally break the agent's reply into several balloons paced with a typing indicator + a proportional delay — the n8n "Quebrar e enviar mensagens" behavior. Per agent, **off by default** (typing delays are real latency; opt-in). Applies to TEXT replies only — an audio reply is a single voice note.

## Module (`src/modules/split/service.ts`)

- `splitReplyParts(text, cfg)` — split on blank lines (paragraphs); any paragraph over `maxChars` is further split on sentence boundaries; the balloon count is capped at `maxChunks` (overflow merged into the last). Always ≥1 non-empty chunk. Returns the chunks **and the separators** (`seps[i]` is what preceded `chunks[i]`: `"\n\n"` for a paragraph break, `" "` for a sentence boundary inside one paragraph), because splitting discards them and two places have to put the text back together. `splitReply(text, cfg)` is the chunks alone, for callers that only send them in order.
- **The text delivered is the text the model wrote.** Rejoining with a fixed `"\n\n"` turns a paragraph the model wrote as ONE into two, which the customer reads as the agent's own words. Both rejoin sites use `seps`: the overflow merge (reachable with no failure at all, on every reply with more balloons than `maxChunks`) and the consolidated retry below.
- `typingDelayMs(chunk, cfg)` — `words / typingWpm × 60s`, clamped to `[minDelayMs, maxDelayMs]`.
- `deliverReply(client, conversationId, reply, cfg, sleep?)` — the loop the runtime calls for text replies: disabled → one `sendMessage`; enabled → per balloon `toggleTyping(on)` → `sleep(delay)` → `sendMessage`, then a final `toggleTyping(off)` (in a `finally`, so a failure does not leave the customer watching the agent "type" a reply that is never coming). Typing toggles are **best-effort** (admin token, `.catch` swallows failures — the indicator may be unsupported on a channel; the pacing still applies). `sleep` is injectable (tests pass a no-op). Returns `{ delivered, failed }` — see the next section.

## The unit of delivery is the REPLY, not the balloon (issue #429)

Splitting is what makes this a question at all: a one-balloon reply either lands or does not, while N sends separated by a typing pause give a transient Chatwoot failure N-1 windows to land **inside** the answer — and the window is as wide as the reply is long, because the delay is proportional to the chunk. What that leaves is not a failed send but a customer holding half an answer.

So `deliverReply` reports instead of throwing, and the caller in `runLoadedTurn` reads the two fields together:

| what happened | what the turn does |
| --- | --- |
| nothing landed (`delivered: 0`, `failed`) | **throws** — a real turn failure. The operator is told (`lastError`, private note, alert: the callers write those on a throw and on nothing else), and a retry is safe precisely because the customer received nothing that could duplicate. Unless an attachment already went out, which is the same exception the attachment-only branch keeps. |
| something landed | never throws. The turn is `posted`, the watermark advances, no retry is armed. |

The asymmetry exists because **both** retry paths re-run the whole turn, not the missing part: a `DEBOUNCE` flush that throws bubbles to the worker with the watermark unadvanced, so the next attempt coalesces the same burst and answers it again; and the delivery recovery (issue #295) puts the ledger row back to `DEAD` on a turn error and runs the delivery path again. Either way, a throw after a balloon landed puts that balloon in the conversation twice and runs every side-effecting tool the turn chose a second time. (The direct webhook path has no retry of its own — the receiver acks <5s and processes detached, so Chatwoot is handed a 200 and never re-sends.)

When a balloon fails, the **remainder is retried once, consolidated into a single send** (rejoined with its real separators, per the rule above): the customer gets the whole answer rather than a truncated one, and no balloon they already have is sent again. Per-chunk durable state was the alternative and buys nothing here — the chunks are still in memory in this very process; the only thing it would add is resuming after a process death, which is the recovery's job. If that one retry fails too, the reply stays truncated and `failed` is reported: the flow line (`stage: "split"`, `outcome: "send_failed"`) is where an operator sees it.

`client.toggleTyping(id, on)` = `POST …/conversations/{id}/toggle_typing_status { typing_status }` (admin token — not in the bot allowlist). The runtime threads an injectable `sleep` via `RuntimeDeps`.

## Configuration

Per-agent `agent.settings.split` (`readSplitConfig`): `enabled` (default `false`), `maxChars` (default 600), `typingWpm` (150), `minDelayMs` (800), `maxDelayMs` (8000), `maxChunks` (6). The editor Behavior tab exposes enabled + maxChars + typingWpm + maxDelayMs; min/maxChunks keep defaults. Writable over REST (`PATCH /v1/agents/:id`) + MCP (`agent_settings_get`/`agent_settings_set`, the `split` block) via the settings bag.

## Interaction notes

- The reply text is committed before delivery; a multi-balloon send takes seconds during which a human could take over — acceptable for the single-replica MVP (debounce already coalesced the input side). A future refinement could re-check the assignee between balloons. (A `/reset` landing mid-split IS covered: `calledOff` is asked before each balloon, and standing down that way is **not** a failure — reported as one, it would put `lastError` back on the conversation the operator had just cleared.)
- Holds the processing/job a bit longer (within the scheduler reaper window). Typical replies finish well under the stale threshold.

Read before touching `src/modules/split/*`, `client.toggleTyping`, or the text-delivery branch in `runLoadedTurn`.
