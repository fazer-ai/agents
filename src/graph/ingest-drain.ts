import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { claimPendingByKeyPrefix } from "@/modules/scheduler/service";
import { runClaimed } from "@/modules/scheduler/worker";

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
// Best-effort by construction. A drain that throws must not fail the customer's turn: the cost of
// giving up here is a reply written without one earlier message, which is what happens today anyway
// whenever the message has not arrived yet.
export async function drainPendingIngest(
  tenantId: bigint,
  graphThreadId: string,
  base: PrismaClient,
): Promise<void> {
  try {
    // Every row this drain has touched, kept out of the next pass. Ignoring run_at is what lets the
    // barrier see a job deferred for an earlier turn, and the same waiver defeats failure backoff:
    // a row that just failed is due again immediately, so without this a transient checkpointer
    // error would be retried five times inside one turn and dead-letter the message in
    // milliseconds — spending the whole budget that exists for coming back LATER.
    const seen: bigint[] = [];
    for (let pass = 0; pass < 5; pass++) {
      const claimed = await claimPendingByKeyPrefix(
        "INGEST_MESSAGE",
        `ingest:${graphThreadId}:`,
        50,
        base,
        tenantId,
        seen,
      );
      if (claimed.length === 0) return;
      for (const job of claimed) {
        seen.push(job.id);
        await runClaimed(job, base);
      }
    }
  } catch (err) {
    logger.warn(
      { err, threadId: graphThreadId },
      "ingest: draining the thread before the turn failed, continuing",
    );
  }
}
