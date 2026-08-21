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

export function kindsInLane(lane: SchedulerLane): SchedulerJobKind[] {
  return (Object.keys(JOB_LANE) as SchedulerJobKind[]).filter(
    (kind) => JOB_LANE[kind] === lane,
  );
}
