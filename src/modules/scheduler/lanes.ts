import type { FlowLevel } from "@/modules/flowlog/stages";
import type { SchedulerJobKind } from "@/modules/scheduler/service";

// Which drain each job kind belongs to. A lane is justified by CADENCE or by BUDGET, never by
// duration: the shared tick drains concurrently, so a kind that is merely slow needs no lane.
// CADENCE: its latency is felt at a different timescale than the shared tick's (DEBOUNCE).
// BUDGET: it must be capped against a resource the shared lane does not cap (MEMORY_COMPACT takes
// permits from the model semaphore a customer's turn queues on). A CAP OF ITS OWN at the shared tick
// rate is the same question from the other side (OBSERVE, whose rows follow traffic).
// The map is exhaustive over SchedulerJobKind, so a new kind does not compile until it is placed.

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
  // Shared: a turn drains the ingestion it needs before invoking (../../graph/ingest-job.ts,
  // drainPendingIngest), so cadence does not matter, and the debounce worker can be switched off
  // (DEBOUNCE_WORKER_ENABLED), which would leave a kind parked in that lane never drained.
  INGEST_MESSAGE: "shared",
  // Shared: it is a sweep, and neither reason applies. Its cadence is minutes by design (a delivery
  // is not stranded until nothing has moved it for ten), and the work it does is one indexed query
  // per tenant — the arming it may do costs nothing, and the flush that follows is a DEBOUNCE job
  // that gets claimed on its own lane with its own budget.
  DELIVERY_SWEEP: "shared",
  // Shared, and neither reason applies: one HTTP round trip to Langfuse per tenant per period, at
  // a cadence of minutes by design. The ceiling's gate reads the row it writes, so a late poll
  // costs staleness, which the row reports, and never a customer's turn.
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
  // Shared, for the takeover recovery's reasons: the reply has already been missing for the sweep's
  // staleness window, and it spends no model (one Chatwoot read and one enqueue). Retrying against
  // a Chatwoot that is down is `JOB_RETRY_BASE_MS`'s question, not the lane's.
  HUMAN_REPLY_RECOVERY: "shared",
  // A cap of its own, drained by the shared tick (a worker of its own would add a flag an install
  // can leave off). A label one shared tick late is not felt; on the
  // traffic share it waited behind every ingestion row armed before it and could not keep up with a
  // busy inbox. It still runs under the shared lane's provider concurrency, so a busy inbox's
  // observers cannot starve the replies on it.
  OBSERVE: "observe",
  // Shared: one Chatwoot send per rejected attachment, rare, and the customer already waited out
  // the channel's own failure report, so a tick's wait adds nothing felt.
  MEDIA_TEXT_FALLBACK: "shared",
  // Shared: one per knowledge source, every ten minutes, one paginated fetch and a reconcile. What
  // it creates is embedded by RAG_INGEST jobs, which are the ones that spend.
  KNOWLEDGE_SOURCE_SYNC: "shared",
  // Shared, for the DELIVERY_SWEEP reasons: a cadence of minutes by design, since a delivery is not
  // stranded until nothing has moved it for five, and one indexed query per tenant.
  INBOUND_SWEEP: "shared",
  // Shared, for the DELIVERY_RECOVERY reasons: the event already waited out the sweep's staleness
  // window, and what it may spend is a model turn, capped by the shared lane's provider concurrency.
  INBOUND_REDISPATCH: "shared",
  // Shared: a delayed judgement of one conversation, a handful of Chatwoot reads and no model.
  NOTHING_TO_ANSWER: "shared",
  // Shared, and neither reason applies. Cadence: the proposal waits in SCREENING for a person who
  // reads the queue in minutes, not seconds. Budget: one model call per proposal, under the shared
  // lane's provider concurrency like any other recovery-shaped call.
  SUGGESTION_REVIEW: "shared",
};

// Whether ONE job of this kind spends capacity at an external provider the rest of the product also
// queues for. Separate from the lane: the lane says which tick drains it, this says how many may run
// at once inside that tick (sharedProviderConcurrency), so twenty due follow-ups cannot hold every
// model permit while a customer's reply waits. RAG_INGEST is here because `embedTexts` bypasses the
// model semaphore, so nothing else bounds its embedding batches. A kind marked false is bounded only
// by the batch size, so HEARTBEAT and the sweeps never queue behind a nudge.
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
  // true, which is why the sweep arms a DELIVERY_RECOVERY per lost row and that kind carries the spend.
  DELIVERY_SWEEP: false,
  // It asks Langfuse, not a model provider: no tokens, no embeddings.
  SPEND_CEILING_POLL: false,
  // It runs the delivery path, which runs a real agent turn: a model call, and whatever tools the
  // turn decides to use. The whole reason it is a kind of its own rather than work the sweep does
  // inline.
  DELIVERY_RECOVERY: true,
  // Not folded into DELIVERY_RECOVERY: it re-runs only the takeover (a fence, a claim, a toggle and
  // a reconcile) and never reaches a model, so it must not take a permit from the semaphore a
  // customer's turn queues on.
  TAKEOVER_RECOVERY: false,
  // It reads one page of messages and arms an ingest job. The model is spent later, by whatever turn
  // reads the thread next, where the append is just another message in the channel.
  HUMAN_REPLY_RECOVERY: false,
  // One model call per tick, on the agent's own model.
  OBSERVE: true,
  // One Chatwoot send, no model.
  MEDIA_TEXT_FALLBACK: false,
  // A fetch and database writes; the embedding it causes is spent by the RAG_INGEST jobs it arms.
  KNOWLEDGE_SOURCE_SYNC: false,
  // It reads rows and arms jobs. Re-dispatching inline would make this true, and that is why it
  // arms an INBOUND_REDISPATCH instead, the same split as DELIVERY_SWEEP and DELIVERY_RECOVERY.
  INBOUND_SWEEP: false,
  // It runs `processInboundDelivery`, which for a payment or an operator event runs the agent's
  // nudge turn: a model call. Most re-dispatches are a conversion recorded in one query, but the
  // flag is about what ONE job may do.
  INBOUND_REDISPATCH: true,
  NOTHING_TO_ANSWER: false,
  SUGGESTION_REVIEW: true,
};

// How many OBSERVE rows one shared tick claims: enough to keep the provider bound busy for about one
// tick. An observation is two short model calls (a few seconds), so about four rounds of `concurrency`
// fit in the 15s default interval; a tick that overruns SKIPS the next one (the worker's non-overlap
// guard), so claiming more halves the rate. The rounds are the WHOLE tick's: provider-spending rows
// already claimed (`alreadyGated`) take slots from them. Never below one round, so a tick full of
// follow-ups still moves the labels.
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

// Whether a finished job's row is DELETED rather than marked DONE. Almost nothing wants this: a DONE
// row records that the work happened, and most kinds key their dedupeKey to a recurring unit (a
// conversation's follow-up, a thread's compaction), so re-arming reuses it. INGEST_MESSAGE's key
// names ONE MESSAGE (or a burst's second message would overwrite the first), so its rows follow
// traffic, nothing reuses them, and nothing sweeps `scheduler_jobs`: left DONE they pile up forever.
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
  // One perpetual row per tenant.
  INBOUND_SWEEP: false,
  // Kept, because it is armed `once` and its row is what remembers the attempt was made: deleted, the
  // next sweep pass would arm the same attempt again. Rows exist only for stranded deliveries, which
  // are rare, and at most one per processing attempt of each.
  INBOUND_REDISPATCH: false,
  // One row per thread, but a thread gets one only when a blank message arrived, and a finished
  // judgement is never read again. The retirement deletes a waiting row itself
  // (`retireNothingToAnswer`); only a row retired mid-run stays, as a DONE tombstone the next arm
  // reuses.
  NOTHING_TO_ANSWER: true,
  // KEPT on DONE, because the kind registers a dead-letter hook (it releases a SCREENING item) and the
  // revoke's generic death line is reserved for kinds without one. One row per proposal the agent
  // made, which is far below traffic.
  SUGGESTION_REVIEW: false,
};

// Whether the NUMBER of rows of this kind follows inbound traffic rather than a population the
// install controls. Such rows are armed for `now`, so they are the oldest, and a claim ordered by
// run_at would fill every fixed-size batch with them and never reach an appointment reminder. The
// shared tick claims them separately, with a share of the batch, so the fixed-rate kinds keep the
// rest. Ingestion needs no lane of its own: every reader of a memory thread drains it first
// (../../graph/ingest-drain.ts), so the tick is only a backstop and a lane would only add a worker
// flag an install can leave off.
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
  // One row per DELIVERY the sweep declared lost, and one pass can declare a whole batch (a deploy
  // strands every delivery in flight), armed for `now`: the shape that starves a reminder. The cost:
  // the claim is FIFO on `run_at`, so a recovery waits behind ingestion rows armed before it, but
  // only behind older work, and past `MAX_RECOVERY_AGE_MS` it is discarded, since a reply that late
  // is stale whatever delayed it.
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
  // FALSE because it has a lane of its own, which is DEBOUNCE's answer: its rows do follow traffic
  // (one per observed conversation, re-armed by every burst), but no claim that holds a fixed-rate
  // kind ever holds it, so there is nothing for it to starve.
  OBSERVE: false,
  // One per REJECTED attachment, which is a small fraction of traffic on a normal day and ALL of the
  // audio traffic during a media-upload outage, when every voice reply fails the same way. Armed for
  // `now`, so they are the oldest rows of the batch too: the recoveries' shape, and their answer.
  MEDIA_TEXT_FALLBACK: true,
  // One per knowledge source, whatever the traffic.
  KNOWLEDGE_SOURCE_SYNC: false,
  INBOUND_SWEEP: false,
  // One per stranded delivery, and deliveries follow what the senders post.
  INBOUND_REDISPATCH: true,
  // One per conversation that received a blank message.
  NOTHING_TO_ANSWER: true,
  // One per proposal, and proposals follow the conversations the agent and the observer read.
  SUGGESTION_REVIEW: true,
};

// What one kind's death means to the operator, read by the generic dead-letter announcement in
// ./worker.ts. Exhaustive with no default, so a new kind does not compile until someone decides it.
// The rule: `error` where the system accepted work and lost it, `warn` where the operator has their
// own way back to it. Nothing is `info`: `AlertChannel.minLevel` does not accept it, and a line
// nobody can subscribe to is not an announcement.
export const JOB_DEATH_LEVEL: Record<SchedulerJobKind, FlowLevel> = {
  // A lead that will never be followed up, and nothing on the conversation says so.
  FOLLOWUP: "error",
  // The sweep that ARMS the follow-ups. Its death stops every future one, for every contact.
  FOLLOWUP_SWEEP: "error",
  // The retry drain for outbound deliveries; without it a subscriber's events stop arriving.
  WEBHOOK_RETRY: "error",
  // Registers its own hook (../debounce/handler.ts), which announces a lost burst as a private note
  // on the customer's conversation. This is the level of the GENERIC line that stands in when nothing
  // registered one (`registerDebounceHandler` runs only under DEBOUNCE_WORKER_ENABLED, while the
  // reaper can still reap a stale DEBOUNCE claim). An unanswered burst is a customer waiting on nobody.
  DEBOUNCE: "error",
  // An indexing failure is stamped FAILED by ../rag/documents.ts, which announces it at `warn` with
  // a re-index in reach. What reaches here is a throw before that catch (the scoped load,
  // `resolveEmbeddingStatus`): the job dies while the document is still PENDING, and
  // `retryDocument` refuses anything not FAILED or UNINDEXED, so the operator has no way back.
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
  // Self-rescheduling: its death is stranded deliveries going unreported from then on.
  DELIVERY_SWEEP: "error",
  // Self-rescheduling, and the handler never throws (a failing Langfuse is written on the row),
  // so a death here is the loop itself gone: the ceiling keeps deciding on a figure frozen at the
  // last poll, under-refusing by everything spent since, and nothing on the console moves.
  SPEND_CEILING_POLL: "error",
  // `error`: with a recovery armed, the sweep's line for the stranded delivery is `info`, since the
  // recovery is what decides whether the message was lost. A recovery that ENDS says so itself
  // (../chatwoot/recover-delivery.ts); one that dies here never got to, and the customer's message
  // is still unanswered.
  DELIVERY_RECOVERY: "error",
  // `warn`: nothing was lost to page about (the sweep closed the row PROCESSED with no loss line).
  // What dies is a conversation left `pending` on the bot after a person answered on it, which that
  // person's next reply takes over on its own; an `error` would announce something that self-heals.
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
  // Self-rescheduling: its death is stranded inbound events going unretried from then on, silently.
  INBOUND_SWEEP: "error",
  // `error`, and not the recovery family's `warn`, because nothing announced this loss before the
  // job died: the sender got a 2xx, the row is still PENDING or PROCESSING, and no line said so. A
  // payment the agent never acknowledged, or an operator's event never relayed, with no way back but
  // this line. (A delivery that runs out of ITS OWN attempts is announced by the processor, at
  // `error`, and does not reach here: that path returns normally.)
  INBOUND_REDISPATCH: "error",
  // The conversation stays pending with nobody on it, exactly as before this job existed, and
  // nobody else will notice: this is the alert.
  NOTHING_TO_ANSWER: "warn",
  // `warn`: the dead-letter hook releases the item to the pending list unreviewed, so nothing is
  // lost; what died is the dedup a person now does by eye.
  SUGGESTION_REVIEW: "warn",
};

// The base of `backoffMs` in ./service.ts for one kind's retries. With `MAX_ATTEMPTS` 5 a failing
// job gets four backoffs, each between half and all of `base * 2^attempt`: 37 seconds in all at the
// 2s base, enough for a blip. The recovery family uses one minute (about 18 minutes in all): each is
// armed ONCE by the sweep pass that found the stranded delivery and nothing re-arms it
// (./chatwoot/delivery-sweep.ts), so this ladder is what must outlast a Chatwoot restart (more tries
// at the same spacing would spend a longer outage just as fast). Longer would
// only delay the dead-letter line: the work is already late, and `MAX_RECOVERY_AGE_MS` discards a
// delivery recovery at six hours. Exhaustive, so a new kind does not compile until it is placed.
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
  INBOUND_SWEEP: 2_000,
  // The recovery family's base, for its reason: armed once per attempt and nothing re-arms the same
  // attempt, so this ladder is what outlasts a database restart that made the dispatch throw.
  INBOUND_REDISPATCH: 60_000,
  // The judgement is already half an hour late by design; a minute between retries changes nothing.
  NOTHING_TO_ANSWER: 60_000,
  SUGGESTION_REVIEW: 2_000,
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
