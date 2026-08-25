import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import {
  claimPendingByKeyPrefix,
  countOwedByKeyPrefix,
  reapStaleJobs,
} from "@/modules/scheduler/service";
import { announceReaped, runClaimed } from "@/modules/scheduler/worker";

// Kept apart from ./ingest-job.ts on purpose. The handler there reaches for `armCompaction`, and
// compaction is one of the readers that has to call this — importing the handler's module to get the
// drain would close that circle. Nothing here knows what a memory is; it moves rows.

// THE BARRIER. Queuing the append bought a place to defer to and cost synchronous ordering: a turn
// can now start while messages meant for its context are still rows. Nothing in the old design had
// to think about this, because the append had already happened by the time the webhook returned.
//
// So a turn drains its own thread before invoking, rather than trusting a tick to have got there
// first. That is also what freed the job from the fast lane (../modules/scheduler/lanes.ts): with
// the reader fetching what it needs, the drain cadence stops deciding correctness.
//
// CALLED BEFORE THE TURN TAKES `ingest:<thread>` AND MARKS ITSELF, never inside: the ingestion this
// drains takes that same lock, and draining from within it would deadlock. The gap that leaves is
// real and is the right one — a message arriving after the drain belongs to the next turn, not this
// one, and it will find the thread marked and defer.
//
// WHAT IT TAKES, AND WHAT IT DELIBERATELY LEAVES. It claims rows that are PENDING; a row already
// CLAIMED is one the tick is executing right now, and it is left alone because the two paths already
// serialize on `ingest:<thread>`. Only two orders exist and neither loses the message: the executor
// takes the lock first and its append lands BEFORE this turn marks itself and loads the channel, so
// the turn reads it; or the turn takes it first, and the executor finds the thread marked and defers
// with nothing written, so the message is folded in for the next turn. Waiting on a claim would buy
// promptness in a window the width of one lock acquisition, at the price of polling inside a
// customer's turn.
//
// Best-effort by construction, and it SAYS SO IN THE RETURN. A drain that throws must not fail the
// customer's turn — the cost of giving up is a reply written without one earlier message, which is
// what happens anyway whenever the message has not arrived yet — but that cost is not the same for
// every reader, so the outcome is reported rather than swallowed.
//
// `incomplete` covers every way this can end with the thread still owing something: a throw, five
// passes that did not exhaust the queue, a job that FAILED (runClaimed absorbs the outcome and
// reschedules it), and above all a job that DEFERRED because a turn held the thread. That last one
// is the reason this return type exists: an ingestion deferred for a turn that then finishes leaves
// compaction's own in-flight check clear, and compaction would rewrite the attendance without the
// message. A turn discards this answer on purpose — for it, `incomplete` is one late reply, and it
// has no way to wait; compaction refuses to read on it, because for compaction the same message is
// summarised out of existence and nothing writes it back.
//
// Asked of the QUEUE, not of the jobs this call happened to run: what compaction needs to know is
// whether the thread owes anything at all, and a row claimed by the tick in another process owes
// just as much as one this loop left behind.
export type IngestDrainOutcome = "drained" | "incomplete";

// How long a claim may sit before it is presumed crashed. The same value the compaction lane uses for
// its own reap; shorter would re-pend a row an ingestion is still legitimately working on.
const STALE_CLAIM_MS = 5 * 60_000;

export async function drainPendingIngest(
  tenantId: bigint,
  graphThreadId: string,
  base: PrismaClient,
): Promise<IngestDrainOutcome> {
  const prefix = `ingest:${graphThreadId}:`;
  try {
    // REAP OUR OWN KIND FIRST, for the reason ../modules/scheduler/service.ts already states about a
    // lane with its own worker: the worker flags are independent, so with the shared scheduler off
    // nothing else re-pends a row that a dead process left CLAIMED. Ingestion has no tick of its own
    // at all — these readers ARE its independent path — and a CLAIMED row counts as owed below, so
    // without this one crash would make every later compaction on that thread reschedule forever.
    // Reaping the same kind from two places is harmless: the second pass finds it already re-pended.
    const reaped = await reapStaleJobs(
      STALE_CLAIM_MS,
      base,
      new Date(),
      tenantId,
      "INGEST_MESSAGE",
    );
    // No hook is registered for this kind today, so this is a loop over an empty list. It is here so
    // that a kind which later says what its own loss means does not have to find this line first.
    await announceReaped(reaped, base);
    // Every row this drain has touched, kept out of the next pass. It used to carry the failure case
    // too, and no longer does: the claim itself now honours backoff for a row that has failed
    // (../modules/scheduler/service.ts). What is left is the DEFERRAL loop, which the claim cannot
    // see — a job that stands down for a turn carries no error and no spent budget, so it stays
    // claimable exactly like a fresh row, and
    // without this the same row would be claimed and deferred once per pass, five times over, inside
    // a customer's turn.
    const seen: bigint[] = [];
    for (let pass = 0; pass < 5; pass++) {
      const claimed = await claimPendingByKeyPrefix(
        "INGEST_MESSAGE",
        prefix,
        50,
        base,
        tenantId,
        seen,
      );
      if (claimed.length === 0) break;
      for (const job of claimed) {
        seen.push(job.id);
        await runClaimed(job, base);
      }
    }
    const owed = await countOwedByKeyPrefix(
      "INGEST_MESSAGE",
      prefix,
      base,
      tenantId,
    );
    return owed === 0 ? "drained" : "incomplete";
  } catch (err) {
    logger.warn(
      { err, threadId: graphThreadId },
      "ingest: draining the thread before the turn failed, continuing",
    );
    return "incomplete";
  }
}
