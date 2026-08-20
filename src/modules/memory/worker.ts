import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { claimDueCompactionJobs } from "@/modules/scheduler/service";
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
// workers (globalThis singleton survives `bun --hot`, non-overlapping tick); the scheduler's reaper
// still re-pends a stranded CLAIMED job, since it reaps by status and not by kind.

// `claim`/`run` are injectable so the tick can be tested without a DB or a provider; production uses
// the defaults.
export interface CompactionTickDeps {
  claim?: typeof claimDueCompactionJobs;
  run?: typeof runClaimed;
}

export async function runCompactionTick(
  base: PrismaClient,
  batchSize: number,
  deps: CompactionTickDeps = {},
): Promise<{ claimed: number }> {
  const claim = deps.claim ?? claimDueCompactionJobs;
  const run = deps.run ?? runClaimed;
  const jobs = await claim(batchSize, base);
  // allSettled: runClaimed never re-throws (it fails the job internally), but a stray throw must not
  // stall the tick.
  await Promise.allSettled(jobs.map((job) => run(job, base)));
  return { claimed: jobs.length };
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
}

export function startCompactionWorker(opts: StartOptions = {}): () => void {
  const h = holder();
  if (h.timer) return stopCompactionWorker;
  const base = opts.base ?? basePrisma;
  const intervalMs = opts.intervalMs ?? config.compactionWorker.intervalMs;
  const batchSize = opts.batchSize ?? 20;
  h.timer = setInterval(() => {
    if (h.running) return;
    h.running = true;
    void runCompactionTick(base, batchSize)
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
