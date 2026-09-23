import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { claimDueDebounceJobs } from "@/modules/scheduler/service";
import { runClaimed } from "@/modules/scheduler/worker";

// Dedicated FAST drain for DEBOUNCE jobs only (inbound message coalescing). Kept separate from the
// scheduler so the per-agent debounce window (seconds) is honored without running the reaper/sweep at
// that cadence; the scheduler's reaper still re-pends a stranded CLAIMED debounce job. Same single-
// replica discipline as the other workers (globalThis singleton survives `bun --hot`). The claim uses
// FOR UPDATE SKIP LOCKED, so it is still correct if briefly doubled.
//
// SLOTS, NOT BATCHES (issue #807). The lane holds at most `slots` jobs in flight, and every tick
// fills only the slots that are free, without waiting for any job it started. It used to claim a
// batch and await the whole of it before the next tick could claim, so the slowest job of a batch
// held every tenant's replies: measured, one model call that took 5 min 36 s left four other
// conversations due and unclaimed for up to 6 minutes, and a burst on one agent moved another
// agent's first reply from ~75 s to 291 s with 1 to 3 model calls in flight against a budget of 20.
//
// The lane is sized by the model semaphore (config.agent.modelConcurrency), which stays the only
// throttle on model calls: fewer slots would cap the lane below what the operator configured, and
// more would leave claimed rows waiting for a permit while the reaper's stale window runs on them.

// The rows this process is executing RIGHT NOW, kept out of the claim itself. Without the batch
// barrier a row can become claimable while its own run is still in flight, by two production
// roads: a message arriving during the flush re-arms the SAME row back to PENDING (armDebounce's
// upsert), and a run longer than the reaper's stale window is re-pended by the reaper. Either one
// claimed again would run the same flush twice at once. Per-process, which is what this worker is
// by construction (single replica, globalThis singleton).
const inFlight = new Set<bigint>();

// `claim`/`run` are injectable so the drain can be tested without a DB or Chatwoot; production uses
// the defaults.
export interface DebounceTickDeps {
  claim?: typeof claimDueDebounceJobs;
  run?: typeof runClaimed;
}

// Claims up to the free slots and starts the jobs, and returns as soon as they are STARTED.
// `settled` resolves when every job this tick started has finished; the worker never waits on it,
// tests do.
export async function runDebounceTick(
  base: PrismaClient,
  slots: number,
  deps: DebounceTickDeps = {},
): Promise<{ claimed: number; settled: Promise<void> }> {
  const claim = deps.claim ?? claimDueDebounceJobs;
  const run = deps.run ?? runClaimed;
  const free = slots - inFlight.size;
  // NOTE: not a claim of zero. claimWhere clamps its limit to at least 1, so asking with a full
  // lane would take one job past the slots on every tick.
  if (free <= 0) return { claimed: 0, settled: Promise.resolve() };
  const jobs = await claim(free, base, new Date(), undefined, [...inFlight]);
  for (const job of jobs) inFlight.add(job.id);
  // allSettled: runClaimed never re-throws (it fails the job internally), but a stray throw must not
  // strand a slot. The async wrapper turns a synchronous throw into a rejection, so `finally` runs.
  const settled = Promise.allSettled(
    jobs.map((job) =>
      (async () => run(job, base))().finally(() => {
        inFlight.delete(job.id);
      }),
    ),
  ).then(() => {});
  return { claimed: jobs.length, settled };
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
  slots?: number;
  deps?: DebounceTickDeps;
}

export function startDebounceWorker(opts: StartOptions = {}): () => void {
  const h = holder();
  if (h.timer) return stopDebounceWorker;
  const base = opts.base ?? basePrisma;
  const intervalMs = opts.intervalMs ?? config.debounceWorker.intervalMs;
  h.timer = setInterval(() => {
    // NOTE: `running` covers the CLAIM only, so two claims never overlap. The tick resolves once its
    // jobs have started, and the next tick fills whatever slots have freed by then.
    if (h.running) return;
    h.running = true;
    void runDebounceTick(
      base,
      opts.slots ?? config.agent.modelConcurrency,
      opts.deps,
    )
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
