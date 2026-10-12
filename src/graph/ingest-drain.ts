import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import {
  ingestFallbackKeyPrefix,
  ingestKeyPrefix,
  retireCoveredFallbacks,
} from "@/graph/ingest-job";
import { currentPoolClass } from "@/lib/pool-class";
import {
  abandonClaimed,
  type ClaimedJob,
  claimDueByKeyPrefix,
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
    // Reap our own kind first (see ../modules/scheduler/service.ts on lanes with their own
    // worker): with the shared scheduler off nothing else re-pends a row a dead process left CLAIMED,
    // and a CLAIMED row counts as owed below, so one crash would make every later compaction on the
    // thread reschedule forever. Reaping from two places is harmless: the second finds it re-pended.
    const reaped = [
      ...(await reapStaleJobs(
        STALE_CLAIM_MS,
        base,
        new Date(),
        tenantId,
        "INGEST_MESSAGE",
      )),
      ...(await reapStaleJobs(
        STALE_CLAIM_MS,
        base,
        new Date(),
        tenantId,
        "INGEST_FALLBACK",
      )),
    ];
    // NOTE: no hook is registered for these kinds, so this loops over an empty list. It is here so a
    // kind that later says what its own loss means does not have to find this line first.
    await announceReaped(reaped, base);
    const run = async (claimed: ClaimedJob[], seen: bigint[]) => {
      for (const [i, job] of claimed.entries()) {
        seen.push(job.id);
        try {
          // On the turn's own pool: the turn waits on it, so it must not queue behind background work.
          await runClaimed(job, base, {
            deadlineMs: jobDeadlineMs(STALE_CLAIM_MS),
            poolClass: currentPoolClass(),
          });
        } catch (err) {
          // NOTE: the rows after this one are not run; they stop holding the shutdown drain open.
          abandonClaimed(claimed.slice(i + 1));
          throw err;
        }
      }
    };
    // A watcher's fallback whose time has come appends its message itself. One still waiting is left
    // to the append it stands in for, and counted as owed below, unless some route already queued it.
    // Asked again before every pass: an append in the pass brings an older fallback due
    // (`dueOlderFallbacks`), and a pass is smaller than the dedup window (INGEST_ID_WINDOW), so the
    // window cannot move past that fallback before the next pass runs it.
    const fallbackPrefix = ingestFallbackKeyPrefix(graphThreadId);
    await retireCoveredFallbacks(tenantId, graphThreadId, base);
    // Every due fallback, not one batch: a batch of them followed by a pass of newer appends would let
    // the window move past the fallbacks left for the next pass. A fallback that deferred for a turn is
    // rescheduled into the future, so it is not claimed again here.
    const runDueFallbacks = async () => {
      const ran: bigint[] = [];
      for (;;) {
        const due = await claimDueByKeyPrefix(
          "INGEST_FALLBACK",
          fallbackPrefix,
          50,
          base,
          tenantId,
          ran,
        );
        if (due.length === 0) return;
        await run(due, ran);
      }
    };
    // Every row this drain touched, kept out of the next pass. The claim already honours backoff
    // for a failed row (../modules/scheduler/service.ts), but a job that DEFERRED for a turn carries
    // no error and stays claimable, so without this it would be claimed and deferred once per pass,
    // five times over, inside a customer's turn.
    const seen: bigint[] = [];
    for (let pass = 0; pass < 5; pass++) {
      await runDueFallbacks();
      const claimed = await claimPendingByKeyPrefix(
        "INGEST_MESSAGE",
        prefix,
        50,
        base,
        tenantId,
        seen,
      );
      if (claimed.length === 0) break;
      await run(claimed, seen);
    }
    // A waiting fallback is a message that may still be the thread's only copy, so compaction waits
    // for it as it waits for a queued append.
    const owed =
      (await countOwedByKeyPrefix("INGEST_MESSAGE", prefix, base, tenantId)) +
      (await countOwedByKeyPrefix(
        "INGEST_FALLBACK",
        fallbackPrefix,
        base,
        tenantId,
      ));
    return owed === 0 ? "drained" : "incomplete";
  } catch (err) {
    logger.warn(
      { err, threadId: graphThreadId },
      "ingest: draining the thread before the turn failed, continuing",
    );
    return "incomplete";
  }
}
