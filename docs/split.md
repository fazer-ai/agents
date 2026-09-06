# Split + typing (humanized delivery)

Instead of dumping one wall of text, optionally break the agent's reply into several balloons paced with a typing indicator + a proportional delay — the n8n "Quebrar e enviar mensagens" behavior. Per agent, **on by default** (n8n parity; the added latency is bounded by `maxDelayMs`), opt-out through the Behavior tab. Applies to TEXT replies only — an audio reply is a single voice note.

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
| nothing landed, and that is a FACT (`delivered: 0`, `failed`, not `unproven`) | **throws** — a real turn failure, and nothing reached the customer. The operator is told the way every failed turn tells them (`lastError`, private note, alert: the callers write those on a throw and on nothing else). Unless an attachment already went out, which is the same exception the attachment-only branch keeps. |
| nothing landed that we could ACCOUNT FOR (`delivered: 0`, `failed`, `unproven`) | **`posted-partial`** — a send was rejected and Chatwoot could not be asked whether it landed. The throw is not a louder report here, it is a different action: it is what eventually marks the ledger row `DEAD` and hands it to the delivery recovery, which re-runs the whole turn, every side-effecting tool included, over a message that may already have been answered. The badge is what the operator reads instead. |
| everything landed | `posted`. The watermark advances, the deferred `resolve_conversation` may run, and a previous `lastError` is cleared. |
| something landed and the rest did not | **`posted-partial`** — a word of its own. Everything that keys off "did this turn answer" reads it like `posted` (the burst is consumed, the ledger row is settled `answered`), because the customer HAS part of it. What it must not do is close the conversation or clear the operator's badge, and the turn writes that badge itself (`notePartialDelivery`) because past the return it is only a word. |

Both differences of that last row come from the same two bits — did the reply come out short, did a promised file fail — so they are one pure decision in [`src/graph/close-intent.ts`](../src/graph/close-intent.ts), with a table for a test, asked identically at the sites that can carry a deferred close (a reply, attachments plus a reply, attachments alone). It was answered at each of them separately first, and got a different answer at each.

### It does not throw, and NOT because a throw would duplicate

The obvious reason to keep the turn from throwing here would be that a retry re-sends the balloon the customer already has. **Measured against a real Chatwoot, on both retry paths, that duplication does not happen** — and the mechanism is worth knowing, because it is what makes the truncation permanent:

`shouldPost` advances the handled watermark with a monotonic CAS (`lastHandledMessageId < toMessageId`) immediately before the first balloon, on the debounce flush ([`handler.ts`](../src/modules/debounce/handler.ts), the post gate) and on the direct turn ([`runtime.ts`](../src/graph/runtime.ts), `runAgentTurn`) alike. The burst is claimed before anything is sent. So a `DEBOUNCE` flush that throws mid-reply bubbles to the worker with the watermark **already advanced**: the next attempt coalesces nothing. And the delivery recovery (issue #295), which puts the ledger row back to `DEAD` on a turn error and runs the whole turn again, gets as far as `shouldPost`, finds the watermark past its own message and comes back `superseded` having posted nothing. (The direct webhook path has no retry of its own — the receiver acks <5s and processes detached, so Chatwoot is handed a 200 and never re-sends.)

What a throw actually costs, then, is three worker attempts and three model calls to arrive at that same silence. What it BUYS is the operator: `lastError` is written on a throw and on nothing else. Reporting a partial delivery as plain `posted` spends that — the flush's `clearConversationError` fires and the conversation ends up carrying no sign at all that a customer is sitting on one of three balloons. Measured live on exactly that input: the reporting version came back `lastError: (none)` where the throwing version showed the 502. Hence neither: report the outcome, skip the retries, and write the badge.

### A rejected send is not an undelivered one, and "I cannot tell" is a third answer

The request carries a 15s deadline, so a rejection here can mean the message was written on the far side and only the response was lost — and the error's type cannot settle it (a 502 is a proxy that may or may not have forwarded; a 500 is Chatwoot failing at an unknown point in its own transaction). Retrying blindly would be the very duplication this module is fixing, one layer down and likelier, since an overloaded Chatwoot is when both the timeout and the retry happen.

So every send that is rejected — the balloon **and** the consolidated retry — asks Chatwoot instead of guessing. **It asks by name.** Each send mints an id and carries it out in `content_attributes` (`CHATWOOT_SEND_ID_KEY`), which the fork stores verbatim and returns on the read, so the read-back looks for *that message* rather than for a message that says the same thing. The id goes out **with the request**, because an id assigned by the response is no help to the attempt that timed out.

The read-back answers one of **three** things, and the third is the whole of issue #499. `unproven` on the reply's own report is that third answer surviving all the way out to the caller, because what rides on it is not just this chunk but whether the TURN may be run again:

| verdict | what it means | what the chunk gets |
| --- | --- | --- |
| **landed** | the id is in the conversation | not resent, and counted as delivered |
| **absent** | read far enough back to be sure it is not there | resent — nothing can be duplicated by sending a message that does not exist |
| **unknown** | the conversation could not be read, or not read far enough | **left out**, and the reply is reported `failed` |

Absence has to be *earned*, which is what the paging is for: `getMessages` answers with the newest ~20, so "absent from the newest twenty" is not absence. The walk stops with certainty only at a send this same loop already completed (nothing older can carry an id minted after it) or at the top of the history. A ceiling of five pages and a single 10s budget bound the cost — the per-request deadline is what remains of that budget, so three pages is not three times the wait. Running out of either is `unknown`, never `absent`.

**Why `unknown` no longer resends.** It used to, and the two production duplicates of #499 are that decision meeting its own worst case: the overloaded Chatwoot that loses the POST's response is the one that cannot answer the read, so the case that could not be told apart was precisely the case that arose. The defence was that the errors are asymmetric — a resend "costs one duplicated balloon that they and the operator can both see". Measured, the operator sees nothing: the loop reported `delivered: 1, failed: false` while the customer read the reply twice. A gap is the one that is visible: `failed` is the partial badge on the conversation, and `lastError` when nothing landed at all. Between an invisible duplicate and a visible gap, the gap wins.

**What this bought on the successful path.** Matching on content needed a boundary, and the boundary needed a read of its own before the first send — kept short so it would not tax replies that never fail (measured then: 2181ms added to a successful three-balloon reply unbounded, 34ms bounded), which is exactly why an overloaded Chatwoot missed it. A send that names itself needs no boundary, so that read is **gone** rather than tuned: a reply that succeeds now costs **zero** reads, and there is no budget left to be too small. What survives of the boundary is a cost bound on the paging, fed only by sends that already returned an id.

When a balloon fails, the **remainder is retried once, consolidated into a single send** (rejoined with its real separators, per the rule above). The chunk that failed joins it only on `absent`. The cancellation fence is asked again after the read-back and immediately before that write — the failed request and the read are both I/O, so the earlier answer is stale — and standing down there is **not** a failure. Per-chunk durable state was the alternative and buys nothing here — the chunks are still in memory in this very process; the only thing it would add is resuming after a process death, which is the recovery's job. If that one retry fails too, the reply stays truncated and `failed` is reported: the flow line (`stage: "split"`, `outcome: "send_failed"`) carries the cause, and the conversation carries the badge the turn writes for it.

`client.toggleTyping(id, on)` = `POST …/conversations/{id}/toggle_typing_status { typing_status }` (admin token — not in the bot allowlist). The runtime threads an injectable `sleep` via `RuntimeDeps`.

## Configuration

Per-agent `agent.settings.split` (`readSplitConfig`): `enabled` (default `true`), `maxChars` (default 600), `typingWpm` (250), `minDelayMs` (800), `maxDelayMs` (8000), `maxChunks` (6). The editor Behavior tab exposes enabled + maxChars + typingWpm + maxDelayMs; min/maxChunks keep defaults. Writable over REST (`PATCH /v1/agents/:id`) + MCP (`agent_settings_get`/`agent_settings_set`, the `split` block) via the settings bag.

## Interaction notes

- The reply text is committed before delivery; a multi-balloon send takes seconds during which a human could take over — acceptable for the single-replica MVP (debounce already coalesced the input side). A future refinement could re-check the assignee between balloons. (A `/reset` landing mid-split IS covered: `calledOff` is asked before each balloon, and standing down that way is **not** a failure — reported as one, it would put `lastError` back on the conversation the operator had just cleared.)
- Holds the processing/job a bit longer (within the scheduler reaper window). Typical replies finish well under the stale threshold.

Read before touching `src/modules/split/*`, `client.toggleTyping`, or the text-delivery branch in `runLoadedTurn`.
