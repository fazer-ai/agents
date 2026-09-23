import type { FlowLevel } from "@/modules/flowlog/stages";
import type { SchedulerJobKind } from "@/modules/scheduler/service";

// Which drain each job kind belongs to, and the rule for when a new drain is warranted.
//
// THE RULE: a lane is justified by CADENCE or by BUDGET. Never by duration.
//
// Duration was the reason this file exists, and it is the reason that no longer applies. The shared
// tick used to drain its batch one job at a time, so a slow kind delayed every kind claimed with it,
// and the only escape was a lane of one's own — which is how a design with two special cases and one
// queue holding everything else grew, one lane at a time, with nothing saying when the next was due
// (issue #165). The shared tick now drains concurrently, like the other two always have, so a slow
// job no longer delays anything. A kind that is merely slow needs no lane.
//
// What still justifies one:
//
//   CADENCE — the kind's latency is felt at a different timescale than the shared tick's. DEBOUNCE
//   is the case: a flush waiting up to a full scheduler interval is a customer watching a reply not
//   arrive, so it gets a fast tick of its own. Concurrency does not help here; the wait is until the
//   next tick, not behind another job.
//
//   BUDGET — the kind must be capped against a resource the shared lane does not cap. MEMORY_COMPACT
//   is the case: it fires for every agent on every closed attendance and takes permits from the same
//   model semaphore a customer's turn queues on, so its lane sizes its batch to a quarter of that
//   budget. Concurrency does not help here either; it is the opposite of what is wanted.
//
//   A CAP OF ITS OWN is the same question asked from the other side. OBSERVE is the case (issue
//   #621): its rows follow traffic, so the fixed batch cannot hold them, and the traffic share it
//   used to take is a ceiling of five rows a tick for the whole install, split with ingestion and the
//   recoveries. A label is read live, so a queue that grows without bound there is felt. Its lane is
//   drained BY THE SHARED TICK, with a claim of its own sized to the provider bound it already runs
//   under: the tick rate is right, only the cap was wrong, and a worker of its own would add a flag
//   an install can leave off.
//
// So the question for an eleventh kind is not "is it slow" but "does it need a different tick rate,
// or a cap of its own". If neither, it belongs here, and the compiler will ask: this map is exhaustive
// over SchedulerJobKind, so a kind added to the enum does not compile until it is placed.

export type SchedulerLane = "shared" | "debounce" | "compaction" | "observe";

export const JOB_LANE: Record<SchedulerJobKind, SchedulerLane> = {
  FOLLOWUP: "shared",
  FOLLOWUP_SWEEP: "shared",
  WEBHOOK_RETRY: "shared",
  RAG_INGEST: "shared",
  HEARTBEAT: "shared",
  FLOWLOG_SWEEP: "shared",
  APPOINTMENT_REMINDER: "shared",
  REDIRECT_FOLLOWUP: "shared",
  // Cadence: a flush that waits a full scheduler interval is a customer watching a reply not arrive.
  DEBOUNCE: "debounce",
  // Budget: fires for every agent on every closed attendance, against the model semaphore a
  // customer's turn queues on, so its batch is sized to a fraction of that budget.
  MEMORY_COMPACT: "compaction",
  // Shared, and the first draft of this had it on the debounce tick for a cadence reason that no
  // longer holds. What waits behind a queued ingestion is the next turn's CONTEXT, and a turn now
  // drains what it needs before invoking (../../graph/ingest-job.ts, drainPendingIngest) instead of
  // hoping the tick got there first. With the barrier the cadence stops mattering, and the fast tick
  // turns into a liability: the debounce worker can be switched off (DEBOUNCE_WORKER_ENABLED), and
  // a kind parked in that lane would then never drain at all, silently, on an install that simply
  // does not use debounce.
  INGEST_MESSAGE: "shared",
  // Shared: it is a sweep, and neither reason applies. Its cadence is minutes by design (a delivery
  // is not stranded until nothing has moved it for ten), and the work it does is one indexed query
  // per tenant — the arming it may do costs nothing, and the flush that follows is a DEBOUNCE job
  // that gets claimed on its own lane with its own budget.
  DELIVERY_SWEEP: "shared",
  // Shared, and neither reason applies: one HTTP round trip to Langfuse per tenant per period, at
  // a cadence of minutes by design (issue #426). The ceiling's gate reads the row it writes, so a
  // late poll costs staleness, which the row reports, and never a customer's turn.
  SPEND_CEILING_POLL: "shared",
  // Shared, and neither reason applies. Cadence: the message it answers has been unanswered for at
  // least the sweep's staleness window, so a wait of one shared tick is not what the customer feels.
  // Budget: it does spend the model, but the cap that needs is the shared lane's own provider
  // concurrency (below), not a tick of its own — a lane would give it a budget INDEPENDENT of the
  // turns a live customer is queueing for, which is the opposite of what a recovery should get.
  DELIVERY_RECOVERY: "shared",
  // Shared, and neither reason applies — for the opposite mix of reasons to its neighbour above.
  // Cadence: what it recovers is a status, and the conversation has already been sitting in the
  // wrong one for the sweep's whole staleness window, so a shared tick changes nothing a person
  // notices. Budget: it spends no model at all, only two or three Chatwoot calls, and the shared
  // lane's provider concurrency is not the resource that bounds those.
  TAKEOVER_RECOVERY: "shared",
  // Shared, for the same two answers as the takeover recovery beside it and with the same arithmetic.
  // Cadence: what it recovers is a memory append, and the reply has already been missing from the
  // thread for the sweep's whole staleness window, so a shared tick is not what anyone feels.
  // Budget: it spends no model — one Chatwoot read and one enqueue — so a lane of its own would
  // reserve capacity nothing is contending for.
  //
  // How long it keeps trying against a Chatwoot that is down is not a lane question: see
  // `JOB_RETRY_BASE_MS` below (issue #744).
  HUMAN_REPLY_RECOVERY: "shared",
  // A cap of its own, drained by the shared tick (issue #621). Cadence is not the reason: a label that
  // lands one shared tick after the burst it describes is not a delay anyone feels. The cap is. On
  // the traffic share it waited behind every ingestion row armed before it, and one busy observed
  // inbox had a ceiling of 20 observations a minute against a demand of 31 in the p90 hour and 73 at
  // the peak. It still runs under the shared lane's provider concurrency, the same pool a customer's turn
  // queues on, so a busy inbox's observers cannot starve the replies on it.
  OBSERVE: "observe",
  // Shared (issue #587): one Chatwoot send per rejected attachment, rare, and the customer already
  // waited out the channel's own failure report, so a tick's wait adds nothing felt.
  MEDIA_TEXT_FALLBACK: "shared",
  // Shared (issue #794): one per knowledge source, every ten minutes, one paginated fetch and a
  // reconcile. What it creates is embedded by RAG_INGEST jobs, which are the ones that spend.
  KNOWLEDGE_SOURCE_SYNC: "shared",
};

// Whether ONE job of this kind spends capacity at an external provider that the rest of the product
// is also queueing for. A separate question from the lane, deliberately: the lane says which tick
// drains it, this says how many may run at once inside that tick, and a single flag answering both
// would be wrong exactly where they diverge (issue #180 review).
//
// It exists because making the shared drain concurrent created a BUDGET problem inside a lane —
// twenty due follow-ups start twenty nudges, and with the default AGENT_MODEL_CONCURRENCY they can
// hold every permit in the process-wide model semaphore while a customer's reply waits behind a
// proactive one. The serial drain took at most one permit; that was its one virtue.
//
// RAG_INGEST is here for a different provider and a sharper reason: `embedTexts` does not go through
// that semaphore at all, so nothing else bounds it. Twenty documents due at once (a bulk import, a
// reindex) meant twenty embedding batches in flight, provider rate limits, and documents landing in
// FAILED for no reason a reader could see.
//
// A kind NOT listed here is bounded only by the batch size, which is the point: HEARTBEAT and the
// sweeps do a query and finish, and making them queue behind a nudge is the head-of-line blocking
// this lane just stopped doing.
export const JOB_SPENDS_PROVIDER: Record<SchedulerJobKind, boolean> = {
  FOLLOWUP: true,
  APPOINTMENT_REMINDER: true,
  REDIRECT_FOLLOWUP: true,
  RAG_INGEST: true,
  FOLLOWUP_SWEEP: false,
  WEBHOOK_RETRY: false,
  HEARTBEAT: false,
  FLOWLOG_SWEEP: false,
  DEBOUNCE: false,
  MEMORY_COMPACT: false,
  // No model, no embedding: it appends to a checkpointer channel and writes one row.
  INGEST_MESSAGE: false,
  // It reads and writes rows and emits log lines. Answering the stranded message would make this
  // true, and that is exactly why answering is not done here (issue #295): the sweep arms a
  // DELIVERY_RECOVERY per row it declares lost, and that kind carries the spend.
  DELIVERY_SWEEP: false,
  // It asks Langfuse, not a model provider: no tokens, no embeddings.
  SPEND_CEILING_POLL: false,
  // It runs the delivery path, which runs a real agent turn: a model call, and whatever tools the
  // turn decides to use. The whole reason it is a kind of its own rather than work the sweep does
  // inline.
  DELIVERY_RECOVERY: true,
  // The other half of why it is not the same kind as the one above (issue #439): it re-runs the
  // TAKEOVER and nothing else — a fence, a claim, a toggle and a reconcile — and never reaches a
  // model. Folded into DELIVERY_RECOVERY it would take a permit from the semaphore a customer's turn
  // queues on, to make two HTTP calls.
  TAKEOVER_RECOVERY: false,
  // It reads one page of messages and arms an ingest job. The MODEL is spent later, by whatever turn
  // reads the thread next — and by then the append is just another message in the channel, which is
  // the whole point of the ingestion being a job rather than a turn (issue #194).
  HUMAN_REPLY_RECOVERY: false,
  // One model call per tick, on the agent's own model.
  OBSERVE: true,
  // One Chatwoot send, no model.
  MEDIA_TEXT_FALLBACK: false,
  // A fetch and database writes; the embedding it causes is spent by the RAG_INGEST jobs it arms.
  KNOWLEDGE_SOURCE_SYNC: false,
};

// How many OBSERVE rows one shared tick claims (issue #621): enough to keep the provider bound busy
// for about one tick, and no more. One observation is two short model calls, measured at 3.0s p50
// and 3.7s p90 in production, so `concurrency` of them finish in about 3.5s and four rounds fit
// inside the 15s default interval. A tick that overruns its interval does not start the next one
// late, it SKIPS it (the worker's non-overlap guard), so claiming more than fits halves the rate
// instead of raising it.
//
// THE ROUNDS ARE THE WHOLE TICK'S, not the observe lane's (PR review, round 1): the fixed batch and
// the traffic share go through the same bound, so every provider-spending row they already claimed
// takes a slot from those four rounds. Never below one round, so a tick full of follow-ups still
// moves the labels, and never below one row, for the floor `sharedProviderConcurrency` keeps.
export function observeClaimLimit(
  concurrency: number,
  alreadyGated = 0,
): number {
  const bound = Math.max(1, concurrency);
  return Math.max(bound, 4 * bound - alreadyGated);
}

// How many provider-spending jobs the shared lane may run at once, out of the model budget. NEVER
// the whole of it, and never zero: the same arithmetic the compaction lane uses (see
// defaultBatchSize), for the same reason — nobody is waiting on a proactive nudge, somebody is
// always waiting on the turn it would starve. A floor of 1 keeps the lane alive at a budget of 1,
// where the alternative is proactive work that never runs at all.
export function sharedProviderConcurrency(budget: number): number {
  return Math.max(1, Math.min(Math.floor(budget / 4), Math.max(1, budget - 1)));
}

// Whether a finished job's row is DELETED rather than marked DONE. Almost nothing wants this: a
// DONE row is the record that the work happened, and every other kind keys its dedupeKey to a unit
// of work that recurs (a conversation's follow-up, a thread's compaction), so the row count is
// bounded by units and re-arming reuses it.
//
// INGEST_MESSAGE is the exception because its key names ONE MESSAGE — it has to, or the second
// message of a burst would overwrite the first — so its rows are bounded by traffic and nothing
// reuses them. Nothing sweeps `scheduler_jobs` either, so left DONE they accumulate forever, along
// with the unique and status indexes over them.
export const JOB_DELETE_ON_DONE: Record<SchedulerJobKind, boolean> = {
  FOLLOWUP: false,
  FOLLOWUP_SWEEP: false,
  WEBHOOK_RETRY: false,
  RAG_INGEST: false,
  HEARTBEAT: false,
  FLOWLOG_SWEEP: false,
  APPOINTMENT_REMINDER: false,
  REDIRECT_FOLLOWUP: false,
  DEBOUNCE: false,
  MEMORY_COMPACT: false,
  INGEST_MESSAGE: true,
  DELIVERY_SWEEP: false,
  SPEND_CEILING_POLL: false,
  // Same reason as INGEST_MESSAGE, and the same shape: the key names ONE ledger row — it has to, or
  // a second stranded delivery would overwrite the first — so nothing ever reuses the row and the
  // count is bounded by how many deliveries have ever been stranded. What the record of the work is
  // here is the ledger row itself, which is terminal either way.
  DELIVERY_RECOVERY: true,
  // Same key, same shape, same answer: it names ONE ledger row, nothing reuses it, and the row that
  // records the work is the ledger row.
  TAKEOVER_RECOVERY: true,
  // Same key, same shape, same answer: it names ONE ledger row, nothing reuses it, and the record of
  // the work is the ledger row plus the ingest job it arms.
  HUMAN_REPLY_RECOVERY: true,
  // The key names ONE CONVERSATION (`observe:<thread>`), like DEBOUNCE's, and the row is re-armed by
  // every burst on it; a DONE row is the record of the last verdict.
  OBSERVE: false,
  // KEPT on DONE although its key names one message: the row IS the memory that the text already
  // went out, and a redelivered failure webhook arms it `once`. Deleted, the next redelivery would
  // find no row and send the text again. Bounded by the channel's failure rate on media (~0.1%).
  MEDIA_TEXT_FALLBACK: false,
  // One row per source, re-armed by its own reschedule: bounded by sources, reused forever.
  KNOWLEDGE_SOURCE_SYNC: false,
};

// Whether the NUMBER of rows of this kind follows inbound traffic, rather than a population the
// install controls. A third question about a kind, and the reason it is not the lane's: everything
// here shares one tick, and one FIFO batch of a fixed size.
//
// Every other kind is bounded by something that does not scale with how much a contact writes — one
// per agent, per appointment, per closed attendance, per retry. INGEST_MESSAGE is one per MESSAGE the
// agent did not answer, so a busy fleet can arm more of them per tick than the batch can hold. Being
// armed for `now`, they are also the oldest rows, so a claim ordered by run_at fills every batch with
// them and never reaches an appointment reminder — a kind that exists to arrive BEFORE something —
// no matter how long it waits.
//
// The answer is not a lane of its own. Ingestion's tick latency does not matter at all: every reader
// of a memory thread drains it before reading (../../graph/ingest-drain.ts), so the tick is a
// backstop for threads nobody touches, and a lane would only add a worker flag that an install can
// leave off. What it needs is a CAP — the shared tick claims these separately, with a share of the
// batch, so the fixed-rate kinds always have the rest.
export const JOB_TRAFFIC_PROPORTIONAL: Record<SchedulerJobKind, boolean> = {
  FOLLOWUP: false,
  FOLLOWUP_SWEEP: false,
  WEBHOOK_RETRY: false,
  DEBOUNCE: false,
  RAG_INGEST: false,
  HEARTBEAT: false,
  FLOWLOG_SWEEP: false,
  APPOINTMENT_REMINDER: false,
  REDIRECT_FOLLOWUP: false,
  MEMORY_COMPACT: false,
  INGEST_MESSAGE: true,
  // One row per tenant, re-armed forever. Bounded by the install's tenant count, not by traffic.
  DELIVERY_SWEEP: false,
  // One row per tenant with the ceiling on, re-armed forever. Bounded by the install's tenant
  // count, not by traffic.
  SPEND_CEILING_POLL: false,
  // One row per DELIVERY the sweep declared lost, and a single sweep pass can declare a whole batch
  // of them at once — the deploy that stranded them stranded every delivery that was in flight. They
  // are armed for `now`, so they are also the oldest rows, which is the exact shape that fills every
  // batch and starves a reminder that exists to arrive BEFORE something.
  //
  // THE COST OF THIS ANSWER, stated because the two kinds in this share want opposite things from
  // it: the claim is FIFO on `run_at`, so a recovery waits behind whatever ingestion rows were armed
  // before it — and ingestion's own tick latency explicitly does not matter (a turn drains its
  // thread before reading), while a recovery's does. FIFO bounds it — a recovery only ever waits for
  // work older than itself — and past `MAX_RECOVERY_AGE_MS` the recovery is discarded, which is the
  // right answer for a different reason: a reply that late is stale whatever delayed it. Reserving
  // capacity here would be mechanism for a backlog nobody has measured.
  DELIVERY_RECOVERY: true,
  // Armed by the same pass, from the same deploy, off the same traffic: one row per delivery that
  // was carrying a colleague's reply when the process died. Fewer than of the kind above — most
  // stranded deliveries carry a customer message, not a reply — but what decides this answer is that
  // the number follows inbound traffic rather than a population the install controls.
  //
  // The cost paragraph above does NOT carry over, and the difference is worth naming: this kind has
  // no age ceiling to discard it, because what it recovers does not go stale (recover-takeover.ts).
  // A conversation the agent is wrongly holding stays wrong however long the queue was.
  TAKEOVER_RECOVERY: true,
  // Armed by the same pass on the same rows as the takeover recovery, so the count follows the same
  // traffic — one per stranded delivery that was carrying a colleague's reply. The two are armed
  // together and neither waits on the other: they answer different questions about the same row.
  HUMAN_REPLY_RECOVERY: true,
  // FALSE now that it has a lane of its own (issue #621), which is DEBOUNCE's answer for DEBOUNCE's
  // reason: its row count does follow traffic, one row per observed conversation re-armed by every
  // burst, but no claim that holds a fixed-rate kind ever holds it, so there is nothing for it to
  // starve. The traffic share is what it left, not what protects the reminders from it.
  OBSERVE: false,
  // One per REJECTED attachment, which is a small fraction of traffic on a normal day and ALL of the
  // audio traffic during a media-upload outage, when every voice reply fails the same way. Armed for
  // `now`, so they are the oldest rows of the batch too: the population and the shape are the
  // recoveries' above, and so is the answer (review round 8).
  MEDIA_TEXT_FALLBACK: true,
  // One per knowledge source, whatever the traffic.
  KNOWLEDGE_SOURCE_SYNC: false,
};

// WHAT ONE KIND'S DEATH MEANS TO THE OPERATOR, at the only moment the scheduler can state it
// (issue #356). Read by the generic dead-letter announcement in ./worker.ts.
//
// A Record over SchedulerJobKind, like its three neighbours above, and for the sharper reason here:
// the thing this issue is about is a kind reaching DEAD with nobody having decided what that means.
// A default would cover today's twelve and hand the thirteenth the same silence in a new shape —
// this does not compile until the new kind has been asked the question.
//
// The rule the answers follow: `error` where the system accepted work and lost it, `warn` where the
// operator has their own way back to it. Nothing is `info`, because `AlertChannel.minLevel` does not
// accept `info` and a line nobody can subscribe to is not an announcement.
//
// Every answer here is currently `error`, and that is a result rather than a default — one entry was
// `warn` until a review round showed the reasoning behind it was about the wrong failure (see
// RAG_INGEST). A table where the answers agree is not a table that could be replaced by a default:
// the default would hand the thirteenth kind an answer nobody chose, and the RAG_INGEST entry is the
// evidence that the answer is not obvious even for the twelve that exist.
export const JOB_DEATH_LEVEL: Record<SchedulerJobKind, FlowLevel> = {
  // A lead that will never be followed up, and nothing on the conversation says so.
  FOLLOWUP: "error",
  // The sweep that ARMS the follow-ups. Its death stops every future one, for every contact.
  FOLLOWUP_SWEEP: "error",
  // The retry drain for outbound deliveries; without it a subscriber's events stop arriving.
  WEBHOOK_RETRY: "error",
  // Registers its own hook (../debounce/handler.ts), which announces where a burst's loss is
  // actually felt: a private note on the customer's own conversation, by #71's decision, and not a
  // trail line at all. This is the level of the GENERIC line that stands in when nothing registered
  // one — a real state, since `registerDebounceHandler` runs only under DEBOUNCE_WORKER_ENABLED
  // while the scheduler's reaper can still reap a stale DEBOUNCE claim. A burst that is never
  // answered is a customer waiting on nobody, so it is not an advisory.
  DEBOUNCE: "error",
  // NOT the recoverable case, which is the one this entry was written for and got wrong. A document
  // whose INDEXING failed is stamped FAILED by ../rag/documents.ts, which announces it itself at
  // `warn` — the knowledge-base page shows it with a re-index in reach. What reaches THIS line is
  // the other half: a throw before that catch is entered (the scoped load, `resolveEmbeddingStatus`)
  // propagates out of the handler, so after five of them the job is DEAD while the document is still
  // PENDING — and `retryDocument` refuses anything that is not FAILED or UNINDEXED with a 409. The
  // operator has no way back to it at all.
  RAG_INGEST: "error",
  // Self-rescheduling: one death ends the loop, and outbound heartbeats stop for good.
  HEARTBEAT: "error",
  // Self-rescheduling, and the hardest of them to notice from outside: retention silently stops.
  FLOWLOG_SWEEP: "error",
  // A customer who is not reminded of an appointment, and nobody learns.
  APPOINTMENT_REMINDER: "error",
  REDIRECT_FOLLOWUP: "error",
  // Registers its own hook (../memory/compact.ts); same standing-in reason as DEBOUNCE, since that
  // registration runs under the scheduler OR the compaction worker. `error` because the hook itself
  // decided `error` with the reason written above it: a corrected configuration heals the NEXT
  // attendance, and the one this job was carrying is gone. The stand-in must not undercut the line
  // it stands in for.
  MEMORY_COMPACT: "error",
  // A message the turn will never see. The customer wrote and is waiting.
  INGEST_MESSAGE: "error",
  // Self-rescheduling: its death is stranded deliveries going unreported from then on, which is the
  // silence #282 had just finished closing.
  DELIVERY_SWEEP: "error",
  // Self-rescheduling, and the handler never throws (a failing Langfuse is written on the row),
  // so a death here is the loop itself gone: the ceiling keeps deciding on a figure frozen at the
  // last poll, under-refusing by everything spent since, and nothing on the console moves.
  SPEND_CEILING_POLL: "error",
  // The one `warn` here, and it is the rule above applied rather than an exception to it: the
  // operator has their own way back to this work, twice over. The sweep already announced this exact
  // delivery at `error` when it declared the row DEAD, and the row is still in the
  // `WHERE status = 'DEAD'` worklist that #228 exists to produce. What died is the AUTOMATIC second
  // attempt, which leaves the state exactly as the sweep left it — already paged, still listed. A
  // second `error` would be the same customer message waking somebody twice, which is how a channel
  // stops being read.
  DELIVERY_RECOVERY: "warn",
  // `warn`, and by the same rule read the other way round: nothing paged anybody about this row in
  // the first place, because nothing was lost to page about — the sweep closed it PROCESSED and
  // wrote no loss line. What dies with the job is a conversation left `pending` on the bot after a
  // person answered on it: the state every install had for the whole life of issue #430, and one the
  // NEXT reply from that person takes over on its own. An `error` here would announce, at the level
  // of a customer's lost message, something that self-heals.
  TAKEOVER_RECOVERY: "warn",
  // `warn`, by the rule its neighbour reads the other way round: what dies with the job is the
  // SECOND attempt at an append the receiver already reported losing, at `error`, on the
  // conversation — so the operator has been told, and telling them again at the same level is the
  // same reply waking somebody twice.
  HUMAN_REPLY_RECOVERY: "warn",
  // `warn`, by the rule above: what dies is a label that was not refreshed, on a conversation a person
  // is already reading and can label by hand, and the next burst on it arms the same row again. No
  // customer message was lost and nothing they wait on stopped.
  OBSERVE: "warn",
  // `error`: the customer's reply was lost at the channel and the text that would replace it was
  // lost here too, with no way back for the operator but reading the conversation.
  MEDIA_TEXT_FALLBACK: "error",
  // `warn`: the base keeps the last content it synced, the agent keeps answering from it, and the
  // source records the failure where the operator reads it. A failed run does not reach here at all
  // (the handler records it and reschedules); only a throw that escapes the handler does.
  KNOWLEDGE_SOURCE_SYNC: "warn",
};

// HOW FAR APART ONE KIND'S RETRIES ARE, as the base of `backoffMs` in ./service.ts (issue #744).
// `MAX_ATTEMPTS` is 5, so a failing job gets four backoffs before it is DEAD, each between half and
// all of `base * 2^attempt`. The jitter is a fixed function of the attempt, so the ladder is too: at
// the 2s base the four add up to 37 seconds, which is the 39 measured once the tick is counted. That
// is enough for a blip, which is what every kind below that keeps it is retrying against.
//
// The recovery family is the exception, and for the reason it exists at all. Each of the three is
// armed ONCE, by the sweep pass that found the stranded delivery, and nothing arms it again: the
// sweep reads PENDING and PROCESSING, and the row it armed from is DEAD or PROCESSED by then
// (./chatwoot/delivery-sweep.ts). So the job's own ladder is the only thing that outlasts a Chatwoot
// that went away, and the commonest way to go away is a restart, which takes longer than 39 seconds.
// Measured on issue #728: the five tries of a `HUMAN_REPLY_RECOVERY` ran from 22:44:11 to 22:44:50,
// the account came back right after, and the reply never reached the memory.
//
// At a one-minute base the same four add up to 18 minutes. Not more attempts at the same
// spacing, which would spend a longer outage just as fast; and no longer than that, because the
// work is already late — the sweep only declares a delivery stranded after ten minutes without
// movement — and `MAX_RECOVERY_AGE_MS` discards a delivery recovery at six hours regardless. What a
// longer ladder costs is a later dead-letter line, and all three announce at `warn` (above) because
// the operator already has the loss on record.
//
// Exhaustive over SchedulerJobKind like its neighbours, so a new kind does not compile until someone
// has asked whether its retries are against a blip or against an outage.
export const JOB_RETRY_BASE_MS: Record<SchedulerJobKind, number> = {
  FOLLOWUP: 2_000,
  FOLLOWUP_SWEEP: 2_000,
  WEBHOOK_RETRY: 2_000,
  RAG_INGEST: 2_000,
  DEBOUNCE: 2_000,
  HEARTBEAT: 2_000,
  FLOWLOG_SWEEP: 2_000,
  APPOINTMENT_REMINDER: 2_000,
  REDIRECT_FOLLOWUP: 2_000,
  MEMORY_COMPACT: 2_000,
  INGEST_MESSAGE: 2_000,
  DELIVERY_SWEEP: 2_000,
  SPEND_CEILING_POLL: 2_000,
  DELIVERY_RECOVERY: 60_000,
  TAKEOVER_RECOVERY: 60_000,
  HUMAN_REPLY_RECOVERY: 60_000,
  OBSERVE: 2_000,
  MEDIA_TEXT_FALLBACK: 2_000,
  KNOWLEDGE_SOURCE_SYNC: 2_000,
};

export function kindsInLane(
  lane: SchedulerLane,
  // Narrow to one side of JOB_TRAFFIC_PROPORTIONAL. Omitted ⇒ the whole lane.
  trafficProportional?: boolean,
): SchedulerJobKind[] {
  return (Object.keys(JOB_LANE) as SchedulerJobKind[]).filter(
    (kind) =>
      JOB_LANE[kind] === lane &&
      (trafficProportional === undefined ||
        JOB_TRAFFIC_PROPORTIONAL[kind] === trafficProportional),
  );
}
