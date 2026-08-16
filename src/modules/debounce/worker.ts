import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { claimDueDebounceJobs } from "@/modules/scheduler/service";
import { runClaimed } from "@/modules/scheduler/worker";

// Dedicated FAST drain for DEBOUNCE jobs only (inbound message coalescing). Kept separate from the
// scheduler so the per-agent debounce window (seconds) is honored without running the reaper/sweep at
// that cadence; the scheduler's reaper still re-pends a stranded CLAIMED debounce job. Same single-
// replica discipline as the other workers (globalThis singleton survives `bun --hot`, non-overlapping
// tick). The claim uses FOR UPDATE SKIP LOCKED, so it is still correct if briefly doubled.

// `claim`/`run` are injectable so runDebounceTick can be tested without a DB or Chatwoot; production
// uses the defaults.
export interface DebounceTickDeps {
  claim?: typeof claimDueDebounceJobs;
  run?: typeof runClaimed;
}

export async function runDebounceTick(
  base: PrismaClient,
  batchSize: number,
  deps: DebounceTickDeps = {},
): Promise<{ claimed: number }> {
  const claim = deps.claim ?? claimDueDebounceJobs;
  const run = deps.run ?? runClaimed;
  const jobs = await claim(batchSize, base);
  // Drain the whole claimed batch concurrently (distinct conversations, disjoint per-conversation
  // state). The ONLY throttle is the process-wide model semaphore (config.agent.modelConcurrency);
  // conversations must not serialize behind one another here. allSettled: runClaimed never re-throws
  // (it internally fails the job), but a stray throw must not stall the tick.
  await Promise.allSettled(jobs.map((job) => run(job, base)));
  return { claimed: jobs.length };
}

interface Holder {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

const KEY = Symbol.for("fazerai.debounce.worker");

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

export function startDebounceWorker(opts: StartOptions = {}): () => void {
  const h = holder();
  if (h.timer) return stopDebounceWorker;
  const base = opts.base ?? basePrisma;
  const intervalMs = opts.intervalMs ?? config.debounceWorker.intervalMs;
  const batchSize = opts.batchSize ?? 20;
  h.timer = setInterval(() => {
    if (h.running) return;
    h.running = true;
    void runDebounceTick(base, batchSize)
      .catch((e) => logger.error({ err: e }, "debounce tick failed"))
      .finally(() => {
        h.running = false;
      });
  }, intervalMs);
  logger.info("debounce worker started (interval=%dms)", intervalMs);
  return stopDebounceWorker;
}

export function stopDebounceWorker(): void {
  const h = holder();
  if (h.timer) {
    clearInterval(h.timer);
    h.timer = undefined;
  }
}
