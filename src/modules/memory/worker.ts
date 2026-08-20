import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import {
  claimDueCompactionJobs,
  reapStaleJobs,
} from "@/modules/scheduler/service";
import { runClaimed } from "@/modules/scheduler/worker";

// Dedicated drain for MEMORY_COMPACT jobs only, in the shape the debounce lane already established
// (src/modules/debounce/worker.ts) and for the mirror-image reason.
//
// The scheduler tick awaits its claimed jobs ONE AT A TIME, and a summary is a model call with a 60s
// ceiling. Compaction is also the first job kind that fires for every agent on every closed
// attendance — it ships on by default — so on the shared lane a batch of them would hold up the jobs
// a customer actually feels: a follow-up that stops chasing, an appointment reminder that arrives
// late. Nothing here is time-sensitive in return (the resolve trigger already waits out a 15-minute
// grace), which is why this lane is slow-and-parallel where debounce is fast-and-parallel.
//
// The batch drains CONCURRENTLY: the jobs are keyed per thread, take a lock on their own thread, and
// must not serialize behind one another — that would rebuild the queue this lane exists to avoid. The
// only throttle is the process-wide model semaphore (config.agent.modelConcurrency), which the
// summarizer goes through like every other generation. Same single-replica discipline as the other
// workers (globalThis singleton survives `bun --hot`, non-overlapping tick).
//
// It reaps its OWN stale claims rather than leaning on the scheduler's reaper, because the two
// worker flags are independent: with the scheduler disabled and this lane enabled — a configuration
// the boot sequence explicitly supports — a row left CLAIMED by a process that died mid-summary
// would never be re-pended, and this tick only claims PENDING ones. That attendance would then wait
// for a future boundary to re-arm the same key, which for a resolved conversation may never come.

// `claim`/`run` are injectable so the tick can be tested without a DB or a provider; production uses
// the defaults.
// Same window the scheduler uses for its own reap: a claim older than this belongs to a process
// that is not coming back.
const DEFAULT_STALE_MS = 5 * 60_000;

// A QUARTER of the process-wide model budget, never the whole of it. The summarizer takes permits
// from the same FIFO semaphore a customer's turn does (config.agent.modelConcurrency), so a batch
// sized at that budget lets compaction hold every permit and a turn that just arrived waits behind
// summaries — up to their 60s ceiling. Nobody is waiting on this lane; somebody is always waiting on
// the other one, which is the whole reason the two are separated at all.
export function defaultBatchSize(): number {
  return Math.max(1, Math.floor(config.agent.modelConcurrency / 4));
}

// The rows this process is executing RIGHT NOW, by job id. `enqueueJob` re-arms by upserting the
// same physical row back to PENDING, status and all, so a new attendance arming this key while its
// summary is still running makes the row claimable again — and the next tick would run a SECOND
// handler on it. Both would cut overlapping raw prefixes and write two durable summaries with
// different last-message ids, so the memory head describes the same events twice; the older handler
// would also complete or fail a row the newer claim owns (both are guarded only by id + CLAIMED).
//
// Per-process, which is what these workers already are by construction (single replica, globalThis
// singleton). The general form — any kind, any handler — needs a claim generation on the row and is
// tracked separately; this closes the window that is wide, because only this kind holds a claim for
// up to a minute while every attendance boundary re-arms it.
const inFlight = new Set<string>();

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
  const reaped = await reap(
    staleMs,
    base,
    new Date(),
    undefined,
    "MEMORY_COMPACT",
  );
  const jobs = await claim(batchSize, base);
  // A row already executing here is LEFT ALONE — not run, and not pushed back to PENDING either,
  // which would only re-create the double claim one tick later. Its owner decides its fate, and the
  // reaper above re-pends it if that owner dies.
  const mine = jobs.filter((job) => !inFlight.has(String(job.id)));
  const skipped = jobs.length - mine.length;
  if (skipped > 0) {
    logger.info(
      "compaction: %d job(s) already running in this process, left to their owner",
      skipped,
    );
  }
  for (const job of mine) inFlight.add(String(job.id));
  // allSettled: runClaimed never re-throws (it fails the job internally), but a stray throw must not
  // stall the tick.
  await Promise.allSettled(
    mine.map((job) =>
      Promise.resolve(run(job, base)).finally(() => {
        inFlight.delete(String(job.id));
      }),
    ),
  );
  return { claimed: mine.length, reaped: reaped.length };
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
