import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { ingestKeyPrefix } from "@/graph/ingest-job";
import {
  claimPendingByKeyPrefix,
  countOwedByKeyPrefix,
  reapStaleJobs,
} from "@/modules/scheduler/service";
import {
  announceReaped,
  jobDeadlineMs,
  runClaimed,
} from "@/modules/scheduler/worker";

// Kept apart from ./ingest-job.ts on purpose. The handler there reaches for `armCompaction`, and
// compaction is one of the readers that has to call this, so importing the handler's module to get
// the drain would close that circle. Nothing here knows what a memory is; it moves rows.

// Best-effort, and the return says so. `incomplete` is every way the thread can still owe something:
// a throw, five passes that did not empty the queue, a job that FAILED (runClaimed reschedules it),
// and above all one that DEFERRED because a turn held the thread, which leaves compaction's own
// in-flight check clear. A turn ignores it (for it, one late reply, and it cannot wait); compaction
// refuses to read on it, since there the message would be summarised away for good. Asked of the
// QUEUE, not the jobs this call ran: a row another process's tick claimed owes just as much.
export type IngestDrainOutcome = "drained" | "incomplete";

// How long a claim may sit before it is presumed crashed. The same value the compaction lane uses for
// its own reap; shorter would re-pend a row an ingestion is still legitimately working on.
const STALE_CLAIM_MS = 5 * 60_000;

// The barrier: with the append queued, a turn drains its own thread before invoking instead of
// trusting a tick to have got there, so the drain cadence does not decide correctness. Called BEFORE
// the turn takes `ingest:<thread>` and marks itself: the ingestion takes that lock, so draining inside
// it would deadlock, and a message after the drain belongs to the next turn. Rows already CLAIMED are
// left to the tick: both serialize on `ingest:<thread>`, so either the append lands before the turn
// loads the channel or the executor finds the thread marked and defers; waiting on a claim would poll
// inside a customer's turn for a window one lock acquisition wide. A throw never fails the turn.
export async function drainPendingIngest(
  tenantId: bigint,
  graphThreadId: string,
  base: PrismaClient,
): Promise<IngestDrainOutcome> {
  const prefix = ingestKeyPrefix(graphThreadId);
  try {
    // NOTE: reap our own kind first (see ../modules/scheduler/service.ts on lanes with their own
    // worker): with the shared scheduler off nothing else re-pends a row a dead process left CLAIMED,
    // and a CLAIMED row counts as owed below, so one crash would make every later compaction on the
    // thread reschedule forever. Reaping from two places is harmless: the second finds it re-pended.
    const reaped = await reapStaleJobs(
      STALE_CLAIM_MS,
      base,
      new Date(),
      tenantId,
      "INGEST_MESSAGE",
    );
    // NOTE: no hook is registered for this kind, so this loops over an empty list. It is here so a
    // kind that later says what its own loss means does not have to find this line first.
    await announceReaped(reaped, base);
    // NOTE: every row this drain touched, kept out of the next pass. The claim already honours backoff
    // for a failed row (../modules/scheduler/service.ts), but a job that DEFERRED for a turn carries
    // no error and stays claimable, so without this it would be claimed and deferred once per pass,
    // five times over, inside a customer's turn.
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
        await runClaimed(job, base, {
          deadlineMs: jobDeadlineMs(STALE_CLAIM_MS),
        });
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
