import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import {
  type ClaimedJob,
  claimDueJobs,
  completeJob,
  failJob,
  reapStaleJobs,
  rescheduleJob,
} from "./service";

// Single-replica worker that drains the scheduler. The handler registry decouples the scheduler
// from feature logic (follow-ups register their handlers); a job kind with no handler fails (and
// eventually goes DEAD) rather than silently vanishing. `reschedule` is for "not yet" (out of
// hours) and does not consume an attempt; `fail` retries with backoff up to the cap.

export type JobResult =
  | { outcome: "done" }
  // `payload`, when present, REPLACES the job's payload on reschedule (e.g. a follow-up advancing its
  // step index on the same row). Omit it to keep the current payload.
  | { outcome: "reschedule"; runAt: Date; payload?: Record<string, unknown> }
  | { outcome: "fail"; error?: string };

export type JobHandler = (
  job: ClaimedJob,
  base: PrismaClient,
) => Promise<JobResult>;

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}
export function getJobHandler(kind: string): JobHandler | undefined {
  return handlers.get(kind);
}

// Called when a job is DEAD-LETTERED, which is the only moment the scheduler can state that this
// work is definitively lost — a failure is not that statement, because the next attempt may succeed
// (issue #71). Registered per kind so the scheduler stays ignorant of what a given job's loss means
// downstream; a kind with no hook simply dies quietly, as before.
export type DeadLetterHandler = (
  job: ClaimedJob,
  error: string,
  base: PrismaClient,
) => Promise<void>;

const deadLetterHandlers = new Map<string, DeadLetterHandler>();

export function registerDeadLetterHandler(
  kind: string,
  handler: DeadLetterHandler,
): void {
  deadLetterHandlers.set(kind, handler);
}
export function getDeadLetterHandler(
  kind: string,
): DeadLetterHandler | undefined {
  return deadLetterHandlers.get(kind);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best-effort: a hook that throws must not turn a failed job into a failed tick, and it runs AFTER
// the row is DEAD so it can never be mistaken for part of the attempt.
async function dispatchDeadLetter(
  job: ClaimedJob,
  error: string,
  base: PrismaClient,
): Promise<void> {
  const hook = deadLetterHandlers.get(job.kind);
  if (!hook) return;
  try {
    await hook(job, error, base);
  } catch (err) {
    logger.warn(
      { err, jobId: String(job.id), kind: job.kind },
      "scheduler: dead-letter hook failed",
    );
  }
}

// Records a failure and, when it was the one that dead-lettered the job, notifies whoever registered
// a hook for that kind.
async function fail(
  job: ClaimedJob,
  error: string,
  base: PrismaClient,
): Promise<void> {
  const { deadLettered } = await failJob(
    job.tenantId,
    job.id,
    job.attempts,
    error,
    base,
  );
  if (deadLettered) await dispatchDeadLetter(job, error, base);
}

// Runs one claimed job through its handler and records the outcome (under the job's tenant scope).
export async function runClaimed(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const handler = getJobHandler(job.kind);
  if (!handler) {
    await fail(job, `no handler: ${job.kind}`, base);
    return;
  }
  let result: JobResult;
  try {
    result = await handler(job, base);
  } catch (err) {
    await fail(job, errMsg(err), base);
    return;
  }
  if (result.outcome === "done") {
    await completeJob(job.tenantId, job.id, base);
  } else if (result.outcome === "reschedule") {
    await rescheduleJob(
      job.tenantId,
      job.id,
      result.runAt,
      result.payload,
      base,
    );
  } else {
    await fail(job, result.error ?? "failed", base);
  }
}

export interface TickOptions {
  staleMs: number;
  batchSize: number;
}

export async function runSchedulerTick(
  base: PrismaClient,
  opts: TickOptions,
): Promise<{ claimed: number; reaped: number }> {
  const reaped = await reapStaleJobs(opts.staleMs, base);
  // NOTE: The reaper is the other road to DEAD — a claim that crashed or hung never reaches failJob,
  // so without this a job that exhausts its attempts by hanging dies unannounced.
  for (const job of reaped) {
    if (job.status === "DEAD") {
      await dispatchDeadLetter(job, "reaped: the claim never finished", base);
    }
  }
  const jobs = await claimDueJobs(opts.batchSize, base);
  for (const job of jobs) {
    await runClaimed(job, base);
  }
  return { claimed: jobs.length, reaped: reaped.length };
}

interface Holder {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

const KEY = Symbol.for("fazerai.scheduler.worker");

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  g[KEY] ??= { running: false };
  return g[KEY];
}

export interface StartOptions {
  base?: PrismaClient;
  intervalMs?: number;
  staleMs?: number;
  batchSize?: number;
}

// Idempotent singleton (survives `bun --hot` reloads via globalThis, so no ghost timers). The tick
// is non-overlapping (a `running` guard). Returns the stop function.
export function startScheduler(opts: StartOptions = {}): () => void {
  const h = holder();
  if (h.timer) return stopScheduler;
  const base = opts.base ?? basePrisma;
  const intervalMs = opts.intervalMs ?? config.schedulerWorker.intervalMs;
  const staleMs = opts.staleMs ?? 5 * 60_000;
  const batchSize = opts.batchSize ?? 20;
  h.timer = setInterval(() => {
    if (h.running) return;
    h.running = true;
    void runSchedulerTick(base, { staleMs, batchSize })
      .catch((err) => logger.error({ err }, "scheduler tick failed"))
      .finally(() => {
        h.running = false;
      });
  }, intervalMs);
  logger.info("scheduler worker started (interval=%dms)", intervalMs);
  return stopScheduler;
}

export function stopScheduler(): void {
  const h = holder();
  if (h.timer) {
    clearInterval(h.timer);
    h.timer = undefined;
  }
}
