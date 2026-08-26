# Debounce (inbound message coalescing)

WhatsApp customers send several quick balloons ("oi", "tudo bem?", "queria saber…"). Answering each one is the #1 amateur tell and duplicates replies. Debounce waits for the customer to stop, then answers the **whole burst in one turn**. This is feature parity with the n8n workflows (which used a durable Postgres queue + a fixed Wait + supersede), reimplemented on our durable scheduler with the guards n8n lacked. It is **on by default** per agent.

## Flow

```
incoming message (gate=act)                 fast worker tick (~2.5s)
        │                                            │
   webhook (processChatwootDelivery)          claimDueDebounceJobs (FOR UPDATE SKIP LOCKED)
        │  resolveDebounceConfig → enabled?          │
        ├─ yes → armDebounce (re-arm runAt)    flushDebounceJob
        └─ no  → runAgentTurn (direct, as before)    │ re-fetch messages → coalesce past watermark
                                                      │ run one turn (coalesced text)
                                                      │ shouldPost: re-fetch → superseded? → CAS watermark
                                                      └ post once via the bot token
```

- **Arming** (`armDebounce`, `src/modules/debounce/service.ts`): one live `SchedulerJob` (`kind = DEBOUNCE`, `dedupeKey = debounce:<threadId>`) per thread. Each new message bumps `runAt = min(now + windowSeconds, burstStartedAt + maxWindowSeconds)` via upsert — the durable, crash-safe equivalent of n8n's supersede, with an anti-starvation cap n8n didn't have. Serialized per thread by an advisory lock so concurrent deliveries can't lose the burst-start stamp. The payload is JSON-safe (no bigint): `instanceId`/`conversationId` are recovered from `threadId`.
- **Dedicated fast worker** (`src/modules/debounce/worker.ts`, `DEBOUNCE_WORKER_INTERVAL_MS`, default 2500ms): drains **only** `DEBOUNCE` (`claimDueDebounceJobs`). The main scheduler tick (15s) claims the kinds the lane table assigns to it (`claimDueJobs` → `laneFilter("shared")`, derived from `JOB_LANE` in `src/modules/scheduler/lanes.ts`), so the window is honored without ticking the reaper/sweep that fast. That file also carries the rule for when a lane is warranted at all: **cadence or budget, never duration**. Debounce is the cadence case (this one); attendance compaction is the budget case. A kind that is merely slow needs no lane, because the shared tick drains its batch concurrently (issue #165). The scheduler's reaper still re-pends a stranded `CLAIMED` debounce job.
- **Flush** (`flushDebounceJob`, `src/modules/debounce/handler.ts`): re-fetch the thread (admin token), coalesce the incoming messages past `Conversation.lastHandledMessageId` (the **watermark**), cap at `maxMessagesPerBurst` (keep the most recent), feed the joined text to `runLoadedTurn`.
- **`coalesceAndRunTurn`** (same file, exported) is the reusable "re-fetch → select a burst → coalesce → answer once" core. It takes a `selectPending` strategy: the flush passes `pendingIncoming(_, watermark)`; the **manual re-engage** (item 6, `src/modules/conversations/reengage.ts`) passes "incoming after the last outgoing" to re-answer the unanswered tail without a new inbound. Both share the same supersede + watermark-CAS at-most-once guards below; a failed turn stamps `Conversation.lastError` (cleared on a successful post) so the operator sees an error badge + a re-engage button.

## Watermark + supersede (why no duplicate / no incomplete reply)

The re-fetch decision (not a durable buffer) keeps us aligned with the anti-PII rule (we never mirror message bodies). Correctness rests on two guards in `shouldPost`, evaluated AFTER the LLM call and BEFORE the post:

1. **Post-response supersede** (n8n-faithful): re-fetch and if any incoming id `> targetWatermark`, a message arrived mid-turn → **drop this reply** (outcome `superseded`); the re-armed job answers the full burst. Re-fetch failure is non-fatal (reply rather than drop; the re-armed flush covers any miss). This gate also runs for EMPTY replies (since the deferred-resolve change): an empty turn with a newer mid-turn message returns `superseded` (watermark untouched, re-armed flush answers the whole burst) instead of `empty`, and any deferred resolve intent is discarded with it.
2. **Monotonic watermark CAS**: advance `lastHandledMessageId` to `targetWatermark` only if the stored value is `null`/`< target`. The loser of a (rare) concurrent claim sees 0 rows and suppresses, so a burst is answered **at most once**. The watermark advances on the success path (post), so an LLM/Chatwoot error retries against the same burst (idempotent).

   Alongside the advance, a consumed burst also **retires the ledger rows** of the messages it contained (`retireCoveredDeliveries`, issue #228), keyed by account + conversation + message and restricted to rows already `PROCESSING` (or `DEAD`, which it corrects). The gate exits, which decide before any fetch, state the burst as the range their watermark advance covers — bounded at BOTH ends, since open at the bottom it reaches back over a strand an earlier message left behind and closes a real loss for good. A burst re-read from Chatwoot can carry a message whose own webhook delivery died mid-processing, and that is the one case where re-reading the thread rescues something the ledger still shows as unfinished. The watermark cannot record it — it is a per-conversation high-water mark and this is a per-message fact — so the turn writes it where it belongs. The messages `maxMessagesPerBurst` takes OUT of the burst are retired too, always as `consumed`: the watermark advances past the whole burst either way, so leaving them open would report as lost a message the product looked at and deliberately dropped. `PENDING` is left alone because a burst also legitimately contains messages whose deliveries have not started yet, and consuming those would skip their mirror writes. A gate exit taken because **another AgentBot** now owns the conversation retires nothing at all: Chatwoot fans a message to up to two routes (`agent_bots_for`), so the owner's own delivery for a message in that range may be `PROCESSING` right now, and a range write would turn it `PROCESSED` — the one state the sweep never revisits. A **human** taking over is the opposite (they answer the message whichever route carried it) and so is a refusal by the contact-authorization gate (the conversation is still ours), and both keep the wide range. Best-effort: a miss costs a line in the stranded-delivery list, never a reply.

`runLoadedTurn` (`src/graph/runtime.ts`) is the shared tail of both the direct path and the flush: build → invoke → re-check the live assignee (human takeover aborts) → `shouldPost` → post.

## Configuration

Per-agent, in `agent.settings.debounce` (free-form bag, validated/clamped by `readDebounceConfig` in `src/modules/debounce/settings.ts` — a bad value can never break the flush). Surfaced in the agent editor's **Behavior** tab and writable over REST (`PATCH /v1/agents/:id`) and MCP (`agent_settings_get`/`agent_settings_set`, the `debounce` block), per "one core, three transports".

| Setting               | Default | Range    | Meaning                                                      |
| --------------------- | ------- | -------- | ----------------------------------------------------------- |
| `enabled`             | `true`  | bool     | Off → the direct (balloon-by-balloon) path, unchanged.      |
| `windowSeconds`       | `15`    | 3–120    | Idle time after the last message before flushing.           |
| `maxMessagesPerBurst` | `20`    | 1–50     | Context/cost cap; the most recent N are kept.               |
| `maxWindowSeconds`    | `60`    | ≥ window | Anti-starvation: reply at most this long after burst start. |

Operational (env, NOT per-agent): `DEBOUNCE_WORKER_ENABLED`, `DEBOUNCE_WORKER_INTERVAL_MS` (keep it below the smallest window, 3s).

## Known limits (single-replica MVP)

- A transient LLM/Chatwoot error after a partial graph invoke can re-append the coalesced `HumanMessage` to the checkpointer on retry (a duplicated user line in context). Low-harm; rare.
- The supersede micro-race (a message arriving between the `shouldPost` re-fetch and the post) is irreducible without a transaction spanning the network. The window is one DB CAS + one POST.
- Concurrent flushes of one thread only become possible after the 5-min reaper window (an LLM call longer than the stale threshold); the watermark CAS still bounds it to one post.

Read before touching `src/modules/debounce/*`, the scheduler claim split, or the webhook → runtime seam.
