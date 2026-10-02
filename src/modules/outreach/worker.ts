import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { sanitizeErrorMessage } from "@/lib/redact";
import {
  claimDueOutreachJobs,
  deliverOutreachJob,
  type OutreachBatchSummary,
  reapStaleSending,
} from "./send";

// The outreach worker: a single-replica interval tick that drains due APPROVED
// jobs. It exists only while config.outreach.enabled is on - index.ts does not
// start it otherwise, and processOutreachBatch still no-ops on the flag so an
// imported call graph can never run sends behind a disabled feature.
//
// Concurrency is deliberately small: sends to the same account serialize on
// the account row's slot reservation anyway, and a slow tick is the SAFE side
// for outreach. FOR UPDATE SKIP LOCKED in the claim keeps the pattern correct
// if a second replica ever briefly runs.

const CLAIM_LIMIT = 20;
const SEND_CONCURRENCY = 3;
const STALE_SENDING_MS = 60_000;

export interface OutreachWorkerOptions {
  base?: PrismaClient;
  claimLimit?: number;
  staleMs?: number;
  // NOTE: injectable for tests - the zca_bridge transport takes it as its fetch.
  fetchImpl?: typeof fetch;
  now?: Date;
  // NOTE: test-only isolation, mirroring the outbound worker's. Scopes the
  // claim + reap to one tenant so suites sharing the test database cannot steal
  // each other's rows. Unset in production = global claim.
  tenantId?: bigint;
}

function errMsg(err: unknown): string {
  return sanitizeErrorMessage(err, 500);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

export async function processOutreachBatch(
  opts: OutreachWorkerOptions = {},
): Promise<OutreachBatchSummary> {
  const empty: OutreachBatchSummary = {
    reaped: 0,
    claimed: 0,
    sent: 0,
    readyForManual: 0,
    deferred: 0,
    retried: 0,
    failed: 0,
  };
  // The flag is the whole point: no flag, no sends, no matter who calls.
  if (!config.outreach.enabled) return empty;
  const base = opts.base ?? basePrisma;
  const reaped = await reapStaleSending(
    base,
    opts.staleMs ?? STALE_SENDING_MS,
    opts.tenantId,
  );
  const claimed = await claimDueOutreachJobs(
    base,
    opts.claimLimit ?? CLAIM_LIMIT,
    opts.tenantId,
  );
  const outcomes = await mapWithConcurrency(
    claimed,
    SEND_CONCURRENCY,
    (job) => deliverOutreachJob(base, job, opts),
  );
  const count = (o: string) => outcomes.filter((x) => x === o).length;
  return {
    reaped,
    claimed: claimed.length,
    sent: count("sent"),
    readyForManual: count("ready_for_manual"),
    deferred: count("deferred"),
    retried: count("retried"),
    failed: count("failed"),
  };
}

// ── worker lifecycle ──

const WORKER_KEY = Symbol.for("agents.outreachWorker");

interface WorkerState {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

// The state lives on globalThis (not a module `let`) so `bun --hot`
// re-evaluating this module does not orphan the old interval and spawn a
// phantom second worker.
function workerState(): WorkerState {
  const g = globalThis as unknown as Record<symbol, WorkerState | undefined>;
  if (!g[WORKER_KEY]) g[WORKER_KEY] = { running: false };
  return g[WORKER_KEY] as WorkerState;
}

async function tick(base: PrismaClient, state: WorkerState): Promise<void> {
  if (state.running) return; // single-replica reentrancy guard
  state.running = true;
  try {
    const summary = await processOutreachBatch({ base });
    if (summary.claimed > 0 || summary.reaped > 0) {
      logger.info(
        "Outreach tick: reaped=%d claimed=%d sent=%d ready_manual=%d deferred=%d retried=%d failed=%d",
        summary.reaped,
        summary.claimed,
        summary.sent,
        summary.readyForManual,
        summary.deferred,
        summary.retried,
        summary.failed,
      );
    }
  } catch (err) {
    logger.error("Outreach tick failed: %s", errMsg(err));
  } finally {
    state.running = false;
  }
}

export function startOutreachWorker(opts: OutreachWorkerOptions = {}): void {
  const state = workerState();
  if (state.timer) return; // singleton (survives bun --hot via globalThis)
  const base = opts.base ?? basePrisma;
  const intervalMs = config.outreach.intervalMs;
  state.timer = setInterval(() => void tick(base, state), intervalMs);
  // NOTE: unref so the tick timer never keeps the process alive at shutdown.
  state.timer.unref?.();
  logger.info("Outreach worker started (interval %dms)", intervalMs);
}

export function stopOutreachWorker(): void {
  const state = workerState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}
