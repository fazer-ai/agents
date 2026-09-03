# Spend ceiling (per-tenant spend gate)

Nothing in the system could refuse a model call because a tenant had already spent enough. `LlmUsage`
is an accurate ledger, but it is written **after** each call and every reader of it is a projection:
the first time an operator learned a month had gone wrong was the dashboard, or the provider's
invoice. This feature is the gate that ledger was missing. Before a billed call, the runtime reads
the calendar month's **cost in dollars** for the tenant and refuses once the configured ceiling is
reached.

## Why money, and where it comes from

The first version (#146) counted **tokens**, because tokens are written by our own callback and
summable on an index that already exists. It was cheap and correct about the thing it counted, and
the thing it counted was the wrong thing: a token count cannot bound a bill (#426). Output is billed
several times higher than input on every provider; a cached read is a discounted subset of the
prompt and was charged at full weight; and `LlmUsage.model` was on every row while the ceiling
ignored it, so a token on a small model and a token on a frontier model, one to two orders of
magnitude apart in price, moved the ceiling by the same amount. The number the operator typed did
not track the invoice it exists to bound, and no arithmetic on their side could recover it.

Cost in this codebase comes from **Langfuse** (`src/modules/analytics/langfuse-costs.ts`), which
keeps the price table. The ceiling is therefore denominated in **USD as Langfuse costs the month's
generations**, and the accepted trade is that it is enforceable only where Langfuse is configured
for the tenant (`langfuse.enabled` plus a `langfuse` vault credential with valid keys, see
`resolveLangfuseConfig`); an install without it keeps no ceiling, and the console says so. "Configured"
means the credential RESOLVES, asked the way the poll asks it: a reference to a deleted or malformed
vault entry is what the poll writes on the row as `langfuse-not-configured`, and the console's flag
agrees with the row rather than with the reference. A
maintained external price table is worth more than a local one we would have to keep correct
against six providers, OpenRouter and an operator-supplied `openai-compatible` base URL.

**The gate never asks Langfuse.** That would put a scoped transaction, a vault decryption and an
HTTP round trip with a ten-second timeout in front of every customer message, and the error branch
has no good answer: failing open spends without limit, failing closed lets a third-party outage
silence every agent of the tenant. Instead a periodic scheduler job, `SPEND_CEILING_POLL`
(`src/modules/spend-ceiling/poll.ts`), reads the month's cost per source into a local row,
`spend_cost_snapshots` (one per tenant, source and calendar month), and the gate reads the row. That
moves the failure from **availability to staleness**, which is a failure the row can be honest about.

- **One job per tenant, armed only while the ceiling is on** (`src/modules/spend-ceiling/arm.ts`):
  on every save of the block, and once at boot for every tenant whose ceiling is on, so a row lost to
  a reset is not a ceiling deciding on a figure frozen at its last poll. Self-re-arming like the
  heartbeat; the handler never throws, so a Langfuse down for an hour never walks the scheduler's
  ladder to `DEAD`. The cadence is `SPEND_CEILING_POLL_INTERVAL_MS` (default 5 min).
- **The two sources are told apart by the trace's environment.** Every trace goes out under
  `environmentForSource` (`<env>` for inbox, `<env>-playground` for the playground), which is a
  filterable column of the Langfuse metrics API, so the poll runs one query per source: the
  `observations` view, `sum(totalCost)` and `count` per `providedModelName`, generations only, from
  `monthStart` to the instant of the poll. **And by the trace's `userId`, the tenant's slug**: the
  environment is deployment-wide, not per tenant, so a Langfuse project two tenants point at, or one
  carrying another generator's traces in the same environment, would otherwise be summed into every
  tenant's month and refuse one tenant's customers over another's spend. `userId` is a filterable
  column of the observations view (joined from the trace, measured on v3), and every trace of ours
  carries the slug. A tenant whose slug cannot be read is a failed poll, never the project's total.
- **The figure is monotonic inside a month.** Langfuse ingests asynchronously and the lag correlates
  with load, so during the burst the ceiling exists for a total can read *lower* than the last one.
  A lower answer is never written over a higher one, and a poll that errors touches only the failure
  pair (`pollError`, `pollFailedAt`); the last good figure and its `polledAt` stand. `pollFailedAt`
  is the instant the current failure streak began, which is what the console's "failing since"
  means. Both writes run under the row's advisory lock: a save re-arms the job, which resets a
  claimed row to pending, so two polls of one tenant can overlap, and two read-then-writes that
  each saw the previous figure would let the lower answer land last.
- **The figure follows the month, not the project.** A tenant that points its Langfuse at another
  project mid-month starts a new series there, and the floor above would sit on the old project's
  last figure while the new one climbed from zero underneath it: $40 there plus $20 here would be a
  $40 row. So the poll asks Langfuse which project it is talking to (`GET /api/public/projects`, one
  call per poll on the same credential) and keeps the answer on the row (`projectKey`, keyed under
  the instance); when it changes, what the row stood at is carried (`carriedUsd` and the two
  counters, taken once, at the switch), and the figure is the carry plus the current project's own
  total. Identity is the project's id, never the credential: a key rotated inside a project carries
  nothing. A project that cannot be named is a failed poll. Switching back to the first project in
  the same month counts its spend twice, which is the over-refusing direction. The names of the
  models the old project could not price travel with the figure (`carriedUnpricedModels`): it is
  never asked again, and its calls stay in the carried counters.
- **The overshoot bound is the poll period plus the ingestion lag, and the two add.** A tenant can
  spend for up to that long past the number before the gate sees it. Lowering the period buys lead
  time at one Langfuse query per tenant per period.
- **A stale figure still decides.** Spend only grows inside a month, so the last good figure is a
  floor of the truth: the gate keeps refusing on it (and keeps *allowing* on it, under-refusing by
  exactly the lag), and past three missed polls (`SPEND_SNAPSHOT_STALE_AFTER_MS`) the console says so
  beside the bar. The poll's failure is announced once per six hours on the `spend_ceiling` stage at
  `warn`, so a channel widened to warnings hears about it. A ceiling that fails closed on staleness
  was rejected for the same reason the direct call was: a third-party outage must not silence a
  tenant.
- **A row the poll could not refresh for want of a Langfuse is no ceiling.** When the tenant's
  Langfuse stops resolving (the block switched off, the credential deleted or malformed), the poll
  keeps the last figure on the row and marks it `langfuse-not-configured`. The console says the
  ceiling cannot be enforced, and the gate agrees with that sentence (`snapshotUnenforceable`): the
  call goes through, with the frozen figure still reported beside the ceiling so a reader sees what
  stopped being enforced. Otherwise a tenant that removed Langfuse at $50 of a $10 ceiling would be
  refused for the rest of the month on a number nothing can refresh. This is the one failure that
  opens the gate; every other failure is staleness, and stale decides. The gate learns of it at the
  next poll, so the window between the credential going away and the gate opening is at most one
  poll period.
- **The reconciliation ships with it.** Langfuse prices a model it does not know at zero, silently, so
  a tenant on OpenRouter or a self-hosted endpoint would get a ceiling that never trips, which is worse
  than none because the screen says it is enforcing. The same query counts generations per model, so
  a model with calls and no cost is named on the row (`unpricedModels`), and the console compares
  what Langfuse costed (`costedCalls`) against what the local ledger recorded (`ledgerCalls`) on the
  same screen that shows the bar. **Priced is counted per generation, not per model**: a price
  added mid-month leaves the earlier calls unpriced (Langfuse does not re-price, measured on v3),
  and a call with no usage block is unpriced under a priced model. The metrics API cannot filter on
  a measure, but `avg(totalCost)` skips NULL where `count` does not, so `sum / avg` is the number of
  generations that carried a cost; a model with any call the price did not reach is named. The
  names follow the counters: an answer behind the row (ingestion lag) leaves the counters standing
  and keeps the names too, and an answer at or past the row re-reads the list, so a model priced
  since drops off.
- **A billed call no callback saw reaches Langfuse by hand.** Vision reaches its provider by raw
  fetch, so the LangChain handler never observes it, and Langfuse only prices the generations it was
  shown: the ledger had the row and the ceiling had nothing, which left an extraction-only playground
  free to run under the ceiling indefinitely. `recordDirectUsage` (`src/graph/usage.ts`) now writes
  both books: the ledger row, and a Langfuse generation (`recordDirectGeneration`) under the same
  trace identity as a turn (id = turnId, `userId` = slug, the source's environment) with usage keyed
  the way the handler keys it, so one model definition prices both paths and the poll's filters find
  it. A tenant with no Langfuse keeps the row and skips the trace.
- **A month nobody has polled yet is nothing spent, and the console says so.** The first poll writes
  the row; until then the ceiling cannot refuse on a figure it does not have, which is the same
  direction the unreadable-ceiling rule takes, and the card says beside the bar that nothing has
  been read yet rather than showing "$0 of $20" as if it were enforcing.

**A block written in tokens is no ceiling, and says so.** A `spendCeiling` block saved before this
change carries `monthlyInboxTokens` / `monthlyPlaygroundTokens`, and there is no price to convert
them with. The reader answers `0` on both dollar halves and sets `legacyTokens` with the numbers,
the console shows them with a notice that nothing is enforced, and the first save that **names a
dollar field** retires them (the writer then stores the schema's own shape, which does not carry the
old keys). A patch that names none, such as the API changing only the customer's sentence, keeps the
block in tokens: the operator has not seen the new unit, and merging against synthesized zeroes would
drop the one warning that the old ceiling is no longer enforced. Deliberately not migrated: a ceiling
nobody typed in the new unit is a ceiling that silences an agent on the strength of a guess.

Money is compared in **cents** (`decideSpend`): `0.1 + 0.2` is not `0.3` to a double, and a ceiling
of thirty cents met exactly by three dimes has to read as reached. The writer rounds a third decimal
to the cent rather than refusing it; the reader drops it.

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

It is a gate, not a reservation. Each caller reads the month **as last polled** and decides; the
cost of its own call reaches Langfuse after the provider answers and the snapshot on the next poll.
So turns that start while the figure sits just under the ceiling all read the same figure and all
proceed, and the month can end above the number by whatever is spent inside the poll period plus the
ingestion lag (see above). The overshoot is bounded by that window, not by the traffic that follows:
the first poll to land past the line closes it for everyone after it.

The alternative is a reservation — a counter written before the call and reconciled after — and it
is refused for the reason the ledger is the only source here. A reservation is a second number that
has to stay correct across a crashed process, a provider timeout, and a call whose real cost is
known only at the end; a ceiling built on it would fail in the direction where a tenant is refused
because of money nobody ever spent. A turn is seconds and the window is a month, so the error this
design accepts is small, one-sided, and self-correcting; the error the other design accepts is not.

**The warning has the same shape, and therefore the same bound.** It is evaluated by the gate, on the
snapshot as it stood before the turn, so what it promises is that the first verdict landing at or past
`warnAtPercent` warns. It does not promise that the ceiling is never reached without a warning
first: a single turn that spends more than the band between the fraction and the ceiling (20% of the
ceiling at the default 80) takes a tenant from `allowed` straight to `over`, and the operator's first
line about that month is the `over` one. That is the same read-then-act property as the overshoot
above, and closing it would mean re-reading the snapshot after every call rather than before every
turn. The band is what buys the lead time, so an operator who wants more of it lowers the fraction;
a tenant whose single turn can cross the whole band had no lead time to give.

## The window

The **calendar month**, in UTC, closed at both ends: `[monthStart, monthEnd)`, where `monthEnd` is
the first instant of the next month and is exclusive. It is the cycle the provider's invoice follows
and the number an operator compares this against. A rolling window measures consumption more
honestly and never zeroes at once, which is the property that would have to be explained to whoever
signs the invoice.

The snapshot is keyed by `monthStart`, derived inside `readSpendSnapshot` from a single instant
naming the month, so no caller can name the wrong month. That instant is the verdict's own
`evaluatedAt`: a verdict captured at 23:59:59.9 whose read runs at 00:00:00.1 would otherwise answer
the new month's row for the month it was asked about, and refuse a tenant whose budget had just
reset. The poll's own window is `[monthStart, now)`, and the console's ledger count is
`[monthStart, monthEnd)`.

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
message re-asks having lost nothing but the cost of one turn.

## Configuration

`tenant.settings.spendCeiling`, read leniently at runtime (`readSpendCeilingConfig`, clamps and never
throws, so a malformed bag cannot break the webhook) and validated strictly on the way in
(`spendCeilingSettingsSchema`, so a ceiling typed with an extra zero comes back as a 422 the operator
can read). The reader never returns a block the writer would refuse, because `updateSpendCeiling`
merges the stored block with the operator's patch and validates the merge: a value past a maximum
would otherwise 422 every save on the screen over a field nobody touched.

A malformed figure falls back to its **default**, and for the two dollar fields that default is `0`,
which is no ceiling on that half. That is the same direction the unreadable-ceiling rule above takes:
a ceiling nobody typed is a ceiling that silences an agent for real customers on the strength of
corrupted data. It is not silent either — the console renders exactly what the reader returns, so
the ceiling screen shows the zero.

| field | default | meaning |
| --- | --- | --- |
| `enabled` | `false` | whether the ceiling is enforced at all |
| `monthlyInboxUsd` | `0` | ceiling for customer traffic, USD to the cent; `0` = none |
| `monthlyPlaygroundUsd` | `0` | ceiling for the playground; `0` = none |
| `overCeilingMessage` | a pt-BR sentence | what the customer is told; `null` says nothing |
| `handoffEnabled` | `true` | open a refused conversation for humans |
| `noticeCooldownSeconds` | `300` | cooldown on the copy and the note, never on the verdict |
| `warnAtPercent` | `80` | fraction of a ceiling that raises the warning; `0` = none |
| `legacyTokens` | `null` | read-only: the token ceilings a pre-#426 block carried, never enforced; cleared by the first save |

The poll's cadence is an environment setting, `SPEND_CEILING_POLL_INTERVAL_MS` (default `300000`).

The route's own body schema carries every maximum the service enforces, `overCeilingMessage`
included. They are two schemas over one shape, and where they disagreed the longer message passed the
boundary and threw a raw `ZodError` inside the service, which the global handler answers as a 500
rather than the documented 422.

REST: `GET /v1/tenant-settings` returns the block, `PUT /v1/tenant-settings/spend-ceiling` writes it,
and `GET /v1/tenant-settings/spend-ceiling/usage` returns what the month has cost per source against
the ceiling, with the snapshot's health (`polledAt`, `pollError`, `pollFailedAt`, `stale`), the
reconciliation (`tracedCalls`, `costedCalls`, `ledgerCalls`, `unpricedModels`), whether Langfuse is
configured, and the legacy marker. The console renders all of that on **Resources → Advanced**
(`src/client/pages/resources/SpendCeilingCard.tsx`): the two bars come first, because nobody can pick
a monthly budget without seeing what the month has already cost, and every way the figure can be
wrong has a sentence beside the bar.
