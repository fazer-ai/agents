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
// So the question for an eleventh kind is not "is it slow" but "does it need a different tick rate,
// or a cap of its own". If neither, it belongs here, and the compiler will ask: this map is exhaustive
// over SchedulerJobKind, so a kind added to the enum does not compile until it is placed.

export type SchedulerLane = "shared" | "debounce" | "compaction";

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
};

// How many provider-spending jobs the shared lane may run at once, out of the model budget. NEVER
// the whole of it, and never zero: the same arithmetic the compaction lane uses (see
// defaultBatchSize), for the same reason — nobody is waiting on a proactive nudge, somebody is
// always waiting on the turn it would starve. A floor of 1 keeps the lane alive at a budget of 1,
// where the alternative is proactive work that never runs at all.
export function sharedProviderConcurrency(budget: number): number {
  return Math.max(1, Math.min(Math.floor(budget / 4), Math.max(1, budget - 1)));
}

export function kindsInLane(lane: SchedulerLane): SchedulerJobKind[] {
  return (Object.keys(JOB_LANE) as SchedulerJobKind[]).filter(
    (kind) => JOB_LANE[kind] === lane,
  );
}
