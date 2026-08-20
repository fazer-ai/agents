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
  // allSettled: runClaimed never re-throws (it fails the job internally), but a stray throw must not
  // stall the tick.
  await Promise.allSettled(jobs.map((job) => run(job, base)));
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
  const batchSize = opts.batchSize ?? 20;
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
