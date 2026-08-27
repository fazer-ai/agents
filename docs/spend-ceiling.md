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
**no ceiling on that half**, never "refuse everything" — and it is answered from `cfg` before the
ledger is touched, so a tenant that bounds only its playground does not pay a monthly aggregate on
every customer message to learn a fact the settings already carry.

## What the ceiling does not promise

It is a gate, not a reservation. Each caller sums the month **as committed** and decides; the row
for its own call is appended after the provider answers. So turns that start while usage sits just
under the ceiling all read the same sum and all proceed, and the month can end above the number by
whatever those in-flight turns spend. The overshoot is bounded by what is in flight at that instant,
not by the traffic that follows: the first turn to commit past the line closes it for everyone after
it.

The alternative is a reservation — a counter written before the call and reconciled after — and it
is refused for the reason the ledger is the only source here. A reservation is a second number that
has to stay correct across a crashed process, a provider timeout, and a call whose real cost is
known only at the end; a ceiling built on it would fail in the direction where a tenant is refused
because of tokens nobody ever spent. A turn is seconds and the window is a month, so the error this
design accepts is small, one-sided, and self-correcting; the error the other design accepts is not.

**The warning has the same shape, and therefore the same bound.** It is evaluated by the gate, on the
ledger as it stood before the turn, so what it promises is that the first verdict landing at or past
`warnAtPercent` warns. It does not promise that the ceiling is never reached without a warning
first: a single turn that spends more than the band between the fraction and the ceiling (20% of the
ceiling at the default 80) takes a tenant from `allowed` straight to `over`, and the operator's first
line about that month is the `over` one. That is the same read-then-act property as the overshoot
above, and closing it would mean re-reading the ledger after every call rather than before every
turn. The band is what buys the lead time, so an operator who wants more of it lowers the fraction;
a tenant whose single turn can cross the whole band had no lead time to give.

## The window

The **calendar month**, in UTC, closed at both ends: `[monthStart, monthEnd)`, where `monthEnd` is
the first instant of the next month and is exclusive. It is the cycle the provider's invoice follows
and the number an operator compares this against. A rolling window measures consumption more
honestly and never zeroes at once, which is the property that would have to be explained to whoever
signs the invoice.

Both ends are derived inside `sumUsageInMonth`, from a single instant naming the month, so no caller
can build half a window. That instant is the verdict's own `evaluatedAt`, and the upper bound is
what keeps it meaningful: a verdict captured at 23:59:59.9 whose query runs at 00:00:00.1 would
otherwise count the new month's rows against the month it was asked about, and refuse a tenant whose
budget had just reset.

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
the operator hears about it **before** the agent goes quiet.

**Only the inbox half pages.** `writeFlowEvent` dispatches to alert channels for `source === "inbox"`
only, which is the rule the whole flow log follows so playground telemetry never wakes anyone. The
playground warning is therefore written to the Logs page and to the console's own bars, and nowhere
else — which is the right reach for it, since the person spending that half is the one at the screen,
and the refusal, when it comes, is a `429` that names the number.

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
| `agent` | the Chatwoot webhook (inbox), the **debounce flush**, the **re-engage** button, and `runPlaygroundTurn` (playground), which resolves its target first |
| `nudge` | `runAgentNudge` and `runPlaygroundFollowup` |
| `vision` | `extractInboundFile` / `extractPlaygroundFile`, asked **after** the file is known to be readable and immediately before the provider call |
| `guardrail`, `tts_normalize` | covered by the unit above them |
| `memory_compact` | **ungated, by decision** — see below |

A refusal says that **spend** was what stood in the way, so it is asked only where spend was
actually next: after everything that would have stopped the call anyway, and immediately before the
call. Three shapes, all the same rule:

- **an agent that cannot run.** `agent.enabled` is the operator's switch, not the whole question:
  `loadAgentConfig` also answers null when the agent row is gone or its model `credentialRef` no
  longer resolves, and the turn then returns `agent-unavailable` before a model is built. The webhook
  gate asks it on the refusing branch, with `skipExperiment` so a probe cannot enrol a turn that is
  not going to run.
- **a message the agent would never have read.** Blank content with no recognised attachment renders
  to nothing, and `runAgentTurn` returns `skipped` before any billed call — so that customer is met
  with silence under a ceiling with room too. The gate asks with `incomingRenderable`, the same shape
  the turn renders from.
- **a file this provider cannot read.** The extraction returns `unsupported` in a month with budget
  to spare, so answering `429` (playground) or a `spend_ceiling` skip (inbox) in a spent one reports
  a refusal that never happened and sends the operator to look at a budget over a file that would
  have been rejected either way.
- **an agent that does not exist**, or has no runnable model. The same playground request answers
  404 or 400 under a ceiling with room, so the target is resolved before the money is asked about.
The rule is about the **refusal**. A `warning` is a statement about the MONTH and stays true whether
or not this particular call runs, so a six-hour window it claims on a path that then exits without
calling costs at most a staler percentage in the line the operator reads — the operator was told the
month crossed its fraction, which is the whole content of the warning. That is why the gates
announce both halves where they sit, and why "defer the warning until every no-call exit has passed"
is recorded as rejected in `.codex-review-waived` rather than implemented.

One thing does NOT follow this rule, and the difference is the direction of the failure: a probe that
could not answer is not the same as an answer of "this would not have run". The ceiling fails **open**
when the CEILING is unreadable, because no customer should be silenced by our own database hiccup —
but once the verdict is read and says `over`, the checks above are escape hatches from it, and an
unreadable escape hatch does not open. A pool timeout on the runnable probe leaves the refusal
standing; treating it as "not runnable" would let the turn spend past a budget the operator capped.

For the inbound attachment this means the ceiling sits **below** the download. The download is a
Chatwoot fetch and not a billed one, and it is what tells that path the file's type in the first
place.

`memory_compact` has a word of its own because no gate answers for it. It runs from its own
`MEMORY_COMPACT` scheduler job, minutes after the attendance it summarizes and on attendances a human
handled, so there is no enclosing verdict to be covered by. It is out of the ceiling by decision, for
the reason that separates it from every other billed call: refusing it does not save the tokens, it
moves them — the raw history stays in the thread and the next turn carries it, so a ceiling that
skipped compaction would raise spend rather than bound it. The cost that buys is real and is not
hidden: a tenant past its ceiling keeps paying for compaction. Bounded (one job per attendance, one
summary each) and small beside a turn, but it is the one path on which "the ceiling bounds the month"
is not literally true.

**The gate stays in front of the contact-authorization call, not behind it.** Both orderings can
report a refusal the other would have made first — over-ceiling when authorization would have denied,
or denied when the ceiling would have refused — and both verdicts are true and operative, since the
turn does not run either way. What breaks the tie is that the ceiling is one indexed local read and
authorization is a ten-second round trip to somebody else's endpoint: asking a stranger's service
about a turn that is not going to run spends their capacity on a question whose answer changes
nothing. A verdict going stale across that call is the same read-then-act overshoot this gate accepts
everywhere else.

**The turn is asked about more than once**, and the second ask is not redundant. The webhook's gate
covers the message; the debounce flush runs minutes later, and a tenant can cross its ceiling inside
that window from its own other conversations. So the flush asks again where the turn actually
happens, exactly as the contact-authorization gate does and for the same reason. And a flush refused
there owes the conversation the **whole** contract, not just the handoff: the webhook never refused
anything, so this is the first refusal the conversation gets, and the operator's sentence, the
handoff and the private note all fall to it.

The re-engage button asks the same question a second time on the refusing path: its pre-fetch proves
there was a tail, but the verdict underneath is two database reads deep and the conversation is live
throughout, so a delivery that answers the tail inside that window leaves the click nothing to run.
Re-read there, it reports `empty` instead of telling the operator to raise a ceiling for work that no
longer exists.

**An inbound nudge refused by the ceiling is not re-sent, and that is the inbound module's contract,
not the ceiling's.** `processInboundDelivery` records the ConversionEvent as its durable barrier and
treats Phase B — the customer-facing nudge — as one best-effort attempt: a Chatwoot outage, a model
failure and a spent budget all end with the notification not going out and the row `PROCESSED`. The
ceiling is the most visible of the three, because it also writes the `error` flow line that pages the
alert channels. Making that recoverable needs a scheduler kind for inbound deliveries (nothing re-runs
one today, and the conversion barrier would send a redelivery down the `done` path), which would fix
the throw case as well; it is not something the ceiling can do from its side.

**A `/reset` withdraws a burst; it does not withdraw a message already refused.** The flush asks
`jobRetired` before every act because `/reset` durably retires the DEBOUNCE row: the burst was taken
back, not answered. The webhook gate has no such marker and needs none — the customer's message was
delivered and refused, the tenant is still over its ceiling, and handing the conversation to humans
with a note saying why is the state the very next message would produce anyway. The reset's hand-back
undoes a handoff that predates the command; it cannot undo a budget that is spent.

**And it refuses a burst, never an empty one.** The flush asks two questions before it says a word,
because a refusal is about something the customer is waiting for: was this burst already ANSWERED (an
earlier attempt advanced the watermark past the payload's own last id and died before the scheduler
could mark the job done), and is there anything in it to answer at all (the armed message was deleted,
or renders to no answerable text). The second is asked with `selectAnswerableBurst` — the same
selection and rendering the turn itself uses, lifted out so the two cannot drift. Without the ceiling
such a burst reaches `coalesceAndRunTurn`, which returns `empty` and says nothing to anybody; with it
and without these asks, the customer gets the operator's sentence, a human gets the conversation, and
the burst is declared handled.

It cannot be left to the customer's next message. With `handoffEnabled` (the default) the `open` is
precisely what takes the conversation out of `pending`, so `shouldBotHandle` is false from then on
and no later message of theirs reaches a gate at all; with the handoff switched off the conversation
stays `pending`, but the burst being dropped right now is still silent unless the customer happens to
write a second time. `announceSpendCeilingOnConversation` is that sequence in one place, called by
the webhook gate and by the flush with each caller's own fenced primitives, under the same
per-conversation cooldown key: the two are one notice about one conversation, and a burst refused
seconds after a delivery was refused must not say it twice.

The order inside it is load-bearing in both directions. The copy goes **first**, because the handoff
is what ends the bot's attribution and after it the ownership fence would rightly withhold anything
the bot tried to say. The note goes **last**, because it is the only one of the three that can report
whether the handoff actually happened.

**A message that was already answered is not a message to refuse.** The fan-out sends one message
down two routes, and the two read the ledger at different instants: the first can be under the
ceiling, answer, and commit the usage that puts the tenant over before the second gets here. The
second would then tell the customer the agent cannot answer, open the conversation for humans, and
write an `error` line saying a turn was skipped for budget — about a message that was answered. The
webhook gate reads the handled watermark on the `over` branch only, before announcing anything, so a
refusal that did not happen leaves no record of having happened. The debounce flush asks the same
question off the payload and the watermark it already holds, which is what a retried job needs: an
earlier attempt can have answered the burst and died before the scheduler marked the job done.

Neither closes the whole race, and neither is meant to. A delivery landing inside the window between
the other route's usage write and its watermark CAS sees neither, and that narrow interleaving is
left to the CAS, which is what keeps the ANSWER single. What these close is the wide half — a second
delivery, or a retry, arriving after the first has finished — which needs no coincidence at all.

The whole sequence is **single-flighted per conversation**, not just claimed per notice. The claims
make each write happen once and say nothing about order, and Chatwoot produces two deliveries of one
message by design (the conversation's assigned bot and the inbox's): the second caller would find
the copy's window already held, skip to the handoff, and open the conversation while the first was
still awaiting its send — at which point the ownership fence correctly withholds a sentence nobody
else was going to say. The second caller now awaits the first and inherits its answer.

And every one of those acts is fenced by the **command** as well as by ownership, because they are
different questions. `/reset` retires the burst, and a flush already claimed is past every cancel;
ownership cannot stand in for that, since the reset hands the conversation back to the bot and the
gate therefore says yes at exactly the moment the command has said no. Retired, the refusal is
withdrawn with the burst rather than delivered about it: nothing is said, nothing is reopened, and
the watermark stays where it was, so a later flush asks the ceiling again with a fresh notice window.
Asked once per write, like the turn path's own `stillWanted`, because the three sends are network
round trips a command can land inside.

**The flow line is one of those writes.** It is what the Logs page counts refused customers by, and
an `over` line is `error` severity, so it pages the alert channels too; on top of that the
announcement *claims* the notice window as it decides, so a line written about a withdrawn burst
would also swallow the window a later, real refusal needs. The same holds for the nudge, whose
`stillWanted` runs before the ceiling verdict and is therefore stale by two database reads when the
line is written: it is asked again immediately before announcing. Nothing was refused, so nothing is
reported.

The flush's primitives carry two things that are easy to leave out of a second copy, and both were
left out of the first draft of this one. They go out with the **persona's bot token**: `messages` and
`toggle_status` are bot-token endpoints, and a client built without it raises before the call leaves
the process, so a handoff written without the token is logged as a best-effort failure while the
conversation stays on a bot that will not answer. And ownership is **re-read immediately before each
act**, because the flush's own gate judged the instant before two database reads and neither act is
neutral: the copy would talk over a human, and `open` ends the bot's attribution and re-queues the
conversation, so applying it to one a human just claimed pulls it back out of their hands. The note
is the exception, deliberately: it is invisible to the customer, and a conversation a human just
inherited is exactly where the reason for the silence still needs saying. Dropping the burst is right
either way; only what is said and the status change are theirs to lose.
`conversationStillOurs` is that question in one place, shared with the authorization gate's own
re-check.

**Vision asks for itself** because it runs on the incoming attachment *before* the webhook's gates
decide anything — the same asymmetry `#316` measured for attribution. It is also the only gate that
**announces the warning and not the refusal**, and the split follows from what each half leaves
behind. The `over` line is written per refused message, and vision runs on the very message the
webhook gate refuses moments later, so a line from each would put two refusal rows and two alert
bumps on the Logs page for one customer message; nothing is lost by staying quiet, because its own
`vision` line reports `skipped` with `spend_ceiling` as the reason, which is the stage an operator
filters by when the question is why an attachment was never read. The **warning** leaves no such
trace: the call proceeds, the attachment is read, and no line anywhere says the month crossed its
fraction. And the gate that would have said it may never run — vision is upstream of every one of
them, so a human-owned conversation, a silenced agent, a redirect or an hour outside the schedule
consumes the delivery first and this billed call is the only thing that happened. It cannot
double-write, because the warning's window is claimed once and a gate that follows writes nothing.

That window is per **(tenant, source, month)**, and the month comes off the **verdict's own**
evaluation instant rather than the announcer's clock, so a verdict read at 23:59:59.9 and announced
at 00:00:00.1 cannot report the old month's figures under the new month's key. The month is part of
the identity because the warning is a statement about a month, and six hours is longer than the gap
between the last message of one month and the first of the next: a window that outlived the rollover
would suppress the first warning of a month whose ledger reads zero.

**The `over` line is one per refused OCCASION**, and the caller names the occasion because only it
knows what one is. Two kinds of repetition made "one per refused customer message" false on their
own, and neither is traffic:

- **The same message, asked twice.** Chatwoot fans an incoming message to the conversation's
  assigned agent bot *and* to the inbox's, so two deliveries run concurrently under two ids and
  neither knows about the other. The webhook gate therefore keys its announcement by the Chatwoot
  message id **and the instance**: message ids are account-local, so a tenant running two Chatwoot
  deployments has two different customers' messages numbered the same, and a key without the account
  would hand the second one the first's window. Two *different* messages stay two lines, because each is a customer left unanswered
  and the count of refusals is what an operator reads off the Logs page.
- **The same burst, retried.** Advancing the watermark is the last thing a refusing debounce flush
  does, and it is a database write: a flush that says its piece and then dies is re-pended by the
  scheduler and runs again on the same burst. The flow line is keyed by the burst (the conversation
  plus the payload's own last message id) over a window sized off the scheduler's own ladder
  (`SPEND_CEILING_BURST_WINDOW_MS`), so one refused burst is one `error` line however many attempts
  it takes. The customer copy is fenced separately, by the notice cooldown.
- **The same occasion, asked eight times.** `over-ceiling` is a repairable nudge refusal, so the
  caller reschedules it every fifteen minutes for two hours (`nudge-retry.ts`) against a wall that is
  temporary by construction: one follow-up that could not go out paged the alert channels eight
  times, and fifty pending jobs paged them four hundred. `runAgentNudge` sizes the window to that
  ladder and keys it by the **occasion** rather than by the conversation, which independent jobs
  share: `nudgeOccasionKey` takes the **instance** — conversation ids are account-local for the same
  reason message ids are — and reads the nudge descriptor the caller already writes (`source`,
  `kind`, `step`, `refs`, `occasionId`), so an appointment reminder refused an hour after an inactivity
  follow-up keeps its own row. Derived from the descriptor rather than threaded in, because a
  parameter three callers must remember is the one the fourth forgets. `occasionId` is what a caller
  whose descriptor says none of the rest uses to name the occasion outright, and three needed it:
  an **inbound** nudge carries one fixed `kind`, no `step` and no `refs`, so two separate deliveries
  on one conversation described themselves identically — the receptor names the occasion with the
  delivery row's id, which is exactly one event, and a redelivery of that row is the same event on
  purpose. An **inactivity follow-up** says which RUNG it is (`step`) and not which CLIMB, so a
  conversation that goes quiet, is followed up, replies and goes quiet again had two episodes whose
  step 1 looked identical; the anchor is `lastInboundAt`, which is what an episode is here. A
  **redirect chat follow-up** has one stage, no step and no refs, and names its episode with the
  `originDisplayId` its own retirement already keys on. `occasionId` is read by the key and by
  nothing else, so unlike `refs` it never reaches the model. **Guardrails deliberately do
not**: on the output direction the reply is already written and paid for, so refusing there posts it
unscreened or drops a reply the customer is waiting for, and a ceiling that switched moderation off
would let a budget decide a safety question. Memory compaction is out for a sharper reason: skipping
it makes the *next* turn cost more, so gating it would raise spend rather than bound it.

## Refuse quietly, or throw

The two directions are not a style choice.

- **Customer-facing paths go quiet** (the webhook returns, the nudge returns `over-ceiling`, vision
  skips, the debounce flush drops the burst). The webhook must never be stranded, and an
  `over-ceiling` nudge is a *repairable* refusal (`isRepairableNudgeRefusal`), so the occasion
  survives a ceiling the operator raises in the next couple of hours.

  **It does not survive longer than that**, and the bound is worth saying out loud: repairable
  refusals ride the shared nudge ladder (8 attempts, 15 minutes apart), so about two hours after the
  first refusal the caller stamps the follow-up, discards the reminder, or advances the redirect
  ladder, exactly as it does for a provider that stayed down. A month's ceiling routinely outlasts
  that. What the repairable answer buys is the common case — someone raises the number, or the
  refusal happened near a rollover — not a guarantee that the occasion waits for the month to turn.
  Scheduling a retry at the ceiling's own horizon would mean a second kind of retry on a ladder five
  other outcomes share, which is a change to the retry contract rather than to this gate.
- **The playground throws** `429 errors.spendCeilingReached` (`assertPlaygroundSpendCeiling`). The
  operator is looking at the screen, and a turn that silently produced nothing would read as a
  broken provider. Every route that can reach it declares the 429, so it is in the generated
  OpenAPI and Eden clients are told about it: a normal outcome of the feature that only the running
  server knew about is not documented. The catalog's description names both producers, because the
  rate limiter answers 429 from its own handler on any route while these five list it for this.
- **The re-engage button establishes there is something to answer first.** Every gate here is about
  a TURN, and a click on a conversation whose last message is ours was always going to be a no-op:
  reporting a spent budget for it tells the operator to raise a number that would change nothing,
  and spends an authorization call on somebody else's endpoint for a turn that will not run. The
  tail is one expression used twice — once to decide there is a turn, once to build it — because a
  pre-check and a turn that disagree is how a gate refuses work that was never going to happen.

## An unreadable ceiling ALLOWS the call

The opposite direction from the durable turn claim (`#203`), and deliberately. There the false
answer let a writer erase a customer's message; here the false answer refuses to answer a customer
who is waiting because our own database hiccuped. The ledger keeps recording either way, so the next
message re-asks having lost nothing but the tokens of one turn.

## Configuration

`tenant.settings.spendCeiling`, read leniently at runtime (`readSpendCeilingConfig`, clamps and never
throws, so a malformed bag cannot break the webhook) and validated strictly on the way in
(`spendCeilingSettingsSchema`, so a ceiling typed with an extra zero comes back as a 422 the operator
can read). The reader never returns a block the writer would refuse, because `updateSpendCeiling`
merges the stored block with the operator's patch and validates the merge: a value past a maximum
would otherwise 422 every save on the screen over a field nobody touched.

A malformed count falls back to its **default**, and for the two token fields that default is `0`,
which is no ceiling on that half. That is the same direction the unreadable-ledger rule above takes:
a ceiling nobody typed is a ceiling that silences an agent for real customers on the strength of
corrupted data. It is not silent either — the console renders exactly what the reader returns, so
the ceiling screen shows the zero.

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `false` | whether the ceiling is enforced at all |
| `monthlyInboxTokens` | `0` | ceiling for customer traffic; `0` = none |
| `monthlyPlaygroundTokens` | `0` | ceiling for the playground; `0` = none |
| `overCeilingMessage` | a pt-BR sentence | what the customer is told; `null` says nothing |
| `handoffEnabled` | `true` | open a refused conversation for humans |
| `noticeCooldownSeconds` | `300` | cooldown on the copy and the note, never on the verdict |
| `warnAtPercent` | `80` | fraction of a ceiling that raises the warning; `0` = none |

The route's own body schema carries every maximum the service enforces, `overCeilingMessage`
included. They are two schemas over one shape, and where they disagreed the longer message passed the
boundary and threw a raw `ZodError` inside the service, which the global handler answers as a 500
rather than the documented 422.

REST: `GET /v1/tenant-settings` returns the block, `PUT /v1/tenant-settings/spend-ceiling` writes it,
and `GET /v1/tenant-settings/spend-ceiling/usage` returns what the month has cost per source against
the ceiling. The console renders all of that on **Resources → Advanced**
(`src/client/pages/resources/SpendCeilingCard.tsx`): the two bars come first, because nobody can pick
a monthly token budget without seeing what the month has already cost.
