# Token ceiling (per-tenant spend gate)

Nothing in the system could refuse a model call because a tenant had already spent enough. `LlmUsage`
is an accurate ledger, but it is written **after** each call and every reader of it is a projection:
the first time an operator learned a month had gone wrong was the dashboard, or the provider's
invoice. This feature is the gate that ledger was missing. Before a billed call, the runtime sums
the calendar month's tokens for the tenant and refuses once the configured ceiling is reached.

## Why tokens and not money

Cost in this codebase comes from Langfuse (`src/modules/analytics/langfuse-costs.ts`). It is
optional, asynchronous, and legitimately zero on an instance that never configured pricing, which is
why the dashboard reads a zero-cost series as "ingestion lag or no pricing" rather than "spent
nothing". A gate cannot be built on a number that is optional, lagging, and legitimately zero.

Tokens are written by our own callback (`src/graph/usage.ts`) on every model invocation and are
summable on an index that already exists (`(tenant_id, created_at)`), which is why there is **no
counter table**: a second source of truth would have to be kept correct, and the ledger already is.

Measured on PostgreSQL 17 with 1M ledger rows spread over 200 tenants and 90 days, a month's sum for
one tenant runs in **1.3ms median**, on `llm_usage_tenant_id_created_at_idx`. The spread matters more
than the row count: the same million rows under a single tenant take 40ms and a parallel seq scan,
because an index that selects the whole table is worth nothing to the planner. That is a fixture, not
a fleet.

The sum is `prompt_tokens + completion_tokens`. Cached reads are **not** added: a cached read is a
discounted subset of the prompt tokens, so adding the column on top would count the same token
twice, moving the ceiling by however much the provider cache happened to serve.

## Two ceilings, not one

`LlmUsage.source` already separates `inbox` (real customer traffic) from `playground` (an operator
testing), and the two fail differently. Customer traffic is driven by how many people write in, the
variable the operator does not control; the playground is one person testing a prompt in a loop,
which is the cheapest way to discover there was no ceiling at all. A single number would let the
second silence the agent for the first, so each source answers to its own. `0` on either half means
**no ceiling on that half**, never "refuse everything".

## The window

The **calendar month**, in UTC (`monthStart`). It is the cycle the provider's invoice follows and
the number an operator compares this against. A rolling window measures consumption more honestly
and never zeroes at once, which is the property that would have to be explained to whoever signs the
invoice.

## What the customer and the operator get

Over the ceiling, on an inbox conversation:

1. the operator's configured sentence goes out **as the persona**, not as silence;
2. the conversation is **opened for humans** (the `handoff_to_human` mechanics: status `open` ends
   the bot's attribution and Chatwoot's own routing picks it up);
3. a **private note** names the numbers and says whether the handoff happened.

Copy and note sit behind `noticeCooldownSeconds`; the **verdict never does**. Ten people writing in
after the month is spent are each evaluated, and each conversation is told once per window.

There is deliberately **no team target** here, unlike the per-agent contact-auth gate. A Chatwoot
team id belongs to one account, contact-auth stores the account beside it precisely so a pinned team
is ignored in the wrong one, and this ceiling is per **tenant** — a tenant spans as many Chatwoot
accounts as it has instances, so one stored team would be meaningless in every account but one.

Below the ceiling but past `warnAtPercent`, the turn runs and a `spend_ceiling` warn is emitted, so
the operator hears about it through the alert channels **before** the agent goes quiet.

**How often each line is said** is decided in one place, `spendCeilingAnnouncement`. An `over` line
is written per refused message, because each one is a turn that did not run and the Logs page is
where an operator counts them. A `warning` is not: it describes the month, it stays true for every
message from the fraction to the ceiling, and the alert bus only coalesces a burst (it bumps a
`PENDING` delivery and inserts a fresh one as soon as the worker has sent the last), so a per-message
warning would page the channels for the rest of the month about one unchanging fact. The warning is
therefore claimed once per **six hours** per `(tenant, source)` — not `noticeCooldownSeconds`, which
is a per-conversation cooldown on what a *customer* sees. The claim is in-process, so a restart or a
second replica re-announces once; for a warning that is the right failure direction.

## Where the gate is asked

The ceiling is one question asked in several places, and the failure mode of that shape is a place
that never asks. So the answer is written down per ledger `node` in
`src/modules/spend-ceiling/coverage.ts`, and `tests/modules/spend-ceiling-coverage.test.ts` compares
its key set against `USAGE_NODE_IS_AGENT_TURN`: a node added to the ledger without an answer is a
red test.

| node | gate |
| --- | --- |
| `agent` | the Chatwoot webhook (inbox) and `runPlaygroundTurn` (playground), before the graph is built |
| `nudge` | `runAgentNudge` and `runPlaygroundFollowup` |
| `vision` | `extractInboundFile` / `extractPlaygroundFile`, asked before the download |
| `guardrail`, `tts_normalize`, `memory_compact` | covered by the unit above them |

**Vision asks for itself** because it runs on the incoming attachment *before* the webhook's gates
decide anything — the same asymmetry `#316` measured for attribution. **Guardrails deliberately do
not**: on the output direction the reply is already written and paid for, so refusing there posts it
unscreened or drops a reply the customer is waiting for, and a ceiling that switched moderation off
would let a budget decide a safety question. Memory compaction is out for a sharper reason: skipping
it makes the *next* turn cost more, so gating it would raise spend rather than bound it.

## Refuse quietly, or throw

The two directions are not a style choice.

- **Customer-facing paths go quiet** (the webhook returns, the nudge returns `over-ceiling`, vision
  skips). The webhook must never be stranded, and a `over-ceiling` nudge is a *repairable* refusal
  (`isRepairableNudgeRefusal`), so a follow-up occasion is not burned against a ceiling the operator
  can raise and a month that turns over on its own.
- **The playground throws** `429 errors.spendCeilingReached` (`assertPlaygroundSpendCeiling`). The
  operator is looking at the screen, and a turn that silently produced nothing would read as a
  broken provider.

## An unreadable ceiling ALLOWS the call

The opposite direction from the durable turn claim (`#203`), and deliberately. There the false
answer let a writer erase a customer's message; here the false answer refuses to answer a customer
who is waiting because our own database hiccuped. The ledger keeps recording either way, so the next
message re-asks having lost nothing but the tokens of one turn.

## Configuration

`tenant.settings.spendCeiling`, read leniently at runtime (`readSpendCeilingConfig`, clamps and never
throws, so a malformed bag cannot break the webhook) and validated strictly on the way in
(`spendCeilingSettingsSchema`, so a ceiling typed with an extra zero comes back as a 422 the operator
can read).

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `false` | whether the ceiling is enforced at all |
| `monthlyInboxTokens` | `0` | ceiling for customer traffic; `0` = none |
| `monthlyPlaygroundTokens` | `0` | ceiling for the playground; `0` = none |
| `overCeilingMessage` | a pt-BR sentence | what the customer is told; `null` says nothing |
| `handoffEnabled` | `true` | open a refused conversation for humans |
| `noticeCooldownSeconds` | `300` | cooldown on the copy and the note, never on the verdict |
| `warnAtPercent` | `80` | fraction of a ceiling that raises the warning; `0` = none |

REST: `GET /v1/tenant-settings` returns the block, `PUT /v1/tenant-settings/spend-ceiling` writes it,
and `GET /v1/tenant-settings/spend-ceiling/usage` returns what the month has cost per source against
the ceiling. The console renders all of that on **Resources → Advanced**
(`src/client/pages/resources/SpendCeilingCard.tsx`): the two bars come first, because nobody can pick
a monthly token budget without seeing what the month has already cost.
