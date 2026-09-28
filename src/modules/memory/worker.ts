import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import {
  claimDueCompactionJobs,
  reapStaleJobs,
} from "@/modules/scheduler/service";
import {
  announceReaped,
  jobDeadlineMs,
  runClaimed,
} from "@/modules/scheduler/worker";

// Dedicated drain for MEMORY_COMPACT jobs only, in the shape of src/modules/debounce/worker.ts: a
// summary is a model call with a 60s ceiling, and on the shared scheduler lane a batch of them would
// delay follow-ups and reminders (docs/graph.md, Its own claim lane). The batch drains concurrently,
// throttled only by the process-wide model semaphore.
//
// It reaps its OWN stale claims: the scheduler and this lane can be enabled independently, and with
// the scheduler off a row left CLAIMED by a dead process would never be re-pended.

// Same window the scheduler uses for its own reap: a claim older than this belongs to a process
// that is not coming back.
const DEFAULT_STALE_MS = 5 * 60_000;

// A QUARTER of the process-wide model budget, capped at budget-1: the summarizer takes permits from
// the same FIFO semaphore a customer's turn does, so this lane must never hold all of them. At a
// budget of 1 that is 0 and the lane does not run, which startCompactionWorker says at boot.
export function defaultBatchSize(
  budget: number = config.agent.modelConcurrency,
): number {
  return Math.min(Math.max(1, Math.floor(budget / 4)), Math.max(0, budget - 1));
}

// The rows this process is executing RIGHT NOW, excluded from the claim itself. `enqueueJob` re-arms
// by upserting the same row back to PENDING, so a new attendance arming this key mid-summary makes it
// claimable again, and a second handler would pay for a summary the generation fence in compact.ts
// then throws away. Per-process, like the worker: a second replica reintroduces the overlap, and the
// claim token keeps that wasteful rather than corrupting.
const inFlight = new Set<bigint>();

// Injectable so the tick can be tested without a DB or a provider.
export interface CompactionTickDeps {
  claim?: typeof claimDueCompactionJobs;
  run?: typeof runClaimed;
  reap?: typeof reapStaleJobs;
}

export async function runCompactionTick(
  base: PrismaClient,
  batchSize: number,
  deps: CompactionTickDeps = {},
  staleMs: number = DEFAULT_STALE_MS,
): Promise<{ claimed: number; reaped: number }> {
  const claim = deps.claim ?? claimDueCompactionJobs;
  const run = deps.run ?? runClaimed;
  const reap = deps.reap ?? reapStaleJobs;
  // NOTE: the reap runs even with nothing to claim: this lane is the only reaper of its own kind.
  const reaped = await reap(
    staleMs,
    base,
    new Date(),
    undefined,
    "MEMORY_COMPACT",
  );
  // NOTE: a hung summary is this lane's ordinary road to DEAD, and it never passes through failJob.
  await announceReaped(reaped, base);
  if (batchSize <= 0) return { claimed: 0, reaped: reaped.length };
  const jobs = await claim(batchSize, base, new Date(), undefined, [
    ...inFlight,
  ]);
  for (const job of jobs) inFlight.add(job.id);
  // NOTE: allSettled: runClaimed never re-throws, but a stray throw must not stall the tick.
  await Promise.allSettled(
    jobs.map((job) =>
      Promise.resolve(
        run(job, base, { deadlineMs: jobDeadlineMs(staleMs) }),
      ).finally(() => {
        inFlight.delete(job.id);
      }),
    ),
  );
  return { claimed: jobs.length, reaped: reaped.length };
}

interface Holder {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

const KEY = Symbol.for("fazerai.compaction.worker");

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  g[KEY] ??= { running: false };
  return g[KEY];
}

export interface StartOptions {
  base?: PrismaClient;
  intervalMs?: number;
  batchSize?: number;
  staleMs?: number;
}

export function startCompactionWorker(opts: StartOptions = {}): () => void {
  const h = holder();
  if (h.timer) return stopCompactionWorker;
  const base = opts.base ?? basePrisma;
  const intervalMs = opts.intervalMs ?? config.compactionWorker.intervalMs;
  const batchSize = opts.batchSize ?? defaultBatchSize();
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  if (batchSize <= 0) {
    logger.warn(
      "compaction lane idle: agent.modelConcurrency=%d leaves no model capacity a customer turn is not already waiting on. Closed attendances will not be compacted at this setting.",
      config.agent.modelConcurrency,
    );
  }
  h.timer = setInterval(() => {
    if (h.running) return;
    h.running = true;
    void runCompactionTick(base, batchSize, {}, staleMs)
      .catch((e) => logger.error({ err: e }, "compaction tick failed"))
      .finally(() => {
        h.running = false;
      });
  }, intervalMs);
  logger.info("compaction worker started (interval=%dms)", intervalMs);
  return stopCompactionWorker;
}

export function stopCompactionWorker(): void {
  const h = holder();
  if (h.timer) {
    clearInterval(h.timer);
    h.timer = undefined;
  }
}
