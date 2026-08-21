import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { Semaphore } from "@/lib/semaphore";
import {
  JOB_SPENDS_PROVIDER,
  sharedProviderConcurrency,
} from "@/modules/scheduler/lanes";
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
  const { deadLettered, applied } = await failJob(
    job.tenantId,
    job.id,
    job.claimSeq,
    job.attempts,
    error,
    base,
  );
  if (!applied) supersededWarning(job, "fail");
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
    const { applied } = await completeJob(
      job.tenantId,
      job.id,
      job.claimSeq,
      base,
    );
    if (!applied) supersededWarning(job, "done");
  } else if (result.outcome === "reschedule") {
    const { applied } = await rescheduleJob(
      job.tenantId,
      job.id,
      job.claimSeq,
      result.runAt,
      result.payload,
      base,
    );
    if (!applied) supersededWarning(job, "reschedule");
  } else {
    await fail(job, result.error ?? "failed", base);
  }
}

// The claim this run held was no longer the current one, so its outcome was DISCARDED: the row now
// belongs to a later claim, or to none. The handler still ran to completion, side effects included,
// which is why this is worth a line — the whole reason issue #164 was filed is that these orderings
// are invisible until someone traces them by hand, and a CAS that refuses in silence keeps them that
// way. Not an error: refusing is the guard working. A handler whose work must not be repeated needs
// its own exclusion (see the inFlight set in src/modules/memory/worker.ts); the token only decides
// which write lands.
function supersededWarning(job: ClaimedJob, outcome: string): void {
  logger.warn(
    { kind: job.kind, jobId: String(job.id), claimSeq: job.claimSeq, outcome },
    "scheduler: claim superseded, outcome discarded",
  );
}

export interface TickOptions {
  staleMs: number;
  batchSize: number;
  // NOTE: test-only isolation, the same fence claimDueJobs and reapStaleJobs already document. The
  // tick is cross-tenant by design (single leader in production), so two DB-backed suites running at
  // once claim each other's rows: the batch fills with the other run's jobs, or this process
  // executes them. Leave it unset in production.
  tenantId?: bigint;
  // NOTE: test-only, like tenantId. Production sizes this from the model budget
  // (sharedProviderConcurrency); a test that scaled its workload to that budget would be asserting
  // whatever AGENT_MODEL_CONCURRENCY happens to be on the machine running it — at 400 the bound is
  // 100 and the batch it would need exceeds the claim's own hard cap. Leave it unset in production.
  providerConcurrency?: number;
}

export async function runSchedulerTick(
  base: PrismaClient,
  opts: TickOptions,
): Promise<{ claimed: number; reaped: number }> {
  const reaped = await reapStaleJobs(
    opts.staleMs,
    base,
    new Date(),
    opts.tenantId,
  );
  // NOTE: The reaper is the other road to DEAD — a claim that crashed or hung never reaches failJob,
  // so without this a job that exhausts its attempts by hanging dies unannounced.
  for (const job of reaped) {
    if (job.status === "DEAD") {
      await dispatchDeadLetter(job, "reaped: the claim never finished", base);
    }
  }
  const jobs = await claimDueJobs(
    opts.batchSize,
    base,
    new Date(),
    opts.tenantId,
  );
  // NOTE: The batch drains CONCURRENTLY, which is what the debounce and compaction lanes always did
  // and this one did not (issue #165). Serially, the lane advanced at the speed of whatever was
  // running: one large document being indexed, or one follow-up whose model call is slow, delayed
  // every other job claimed with it — and the one where lateness is customer-visible is the
  // appointment reminder, which exists to arrive BEFORE something. The kinds that call a model are
  // still throttled, by the process-wide model semaphore they already go through, so concurrency
  // here does not widen that budget; it stops short jobs from queueing behind long ones.
  //
  // What this gives up is FIFO WITHIN a batch (the claim still orders by run_at; the drain no longer
  // waits). It costs one thing, and only in a state that is already broken: two reminders for the
  // same appointment can differ (`isLast` decides whether the last one asks for confirmation), so
  // running them out of order reads oddly. Reaching that state needs both to be overdue at once,
  // and enqueue skips offsets already past — so it takes the scheduler being hours behind, where the
  // reminders are late no matter what order they land in.
  //
  // allSettled: runClaimed never re-throws (it fails the job internally), but a stray throw must not
  // stall the tick.
  // The kinds that spend provider capacity go through a bound; the rest do not. Bounding the whole
  // drain would put a heartbeat back behind a nudge, which is the head-of-line blocking this change
  // removed — and leaving the costly ones unbounded lets a batch of twenty hold every model permit
  // while a customer's reply waits (see JOB_SPENDS_PROVIDER).
  const gate = new Semaphore(
    opts.providerConcurrency ??
      sharedProviderConcurrency(config.agent.modelConcurrency),
  );
  const settled = await Promise.allSettled(
    jobs.map((job) =>
      JOB_SPENDS_PROVIDER[job.kind]
        ? gate.run(() => runClaimed(job, base))
        : runClaimed(job, base),
    ),
  );
  // NOTE: allSettled DISCARDS rejections, and the serial loop this replaced did not: an `await` that
  // threw propagated out of the tick and startScheduler logged it. runClaimed swallows a handler's
  // own error (it fails the job instead), so a rejection here is the infrastructure underneath —
  // completeJob/failJob unable to reach the database — and the row stays CLAIMED until the reaper
  // takes it minutes later. Logged per job rather than re-thrown, because one unreachable row must
  // not decide the outcome of the other nineteen.
  for (const [i, r] of settled.entries()) {
    if (r.status !== "rejected") continue;
    const job = jobs[i];
    logger.error(
      { err: r.reason, kind: job?.kind, jobId: job ? String(job.id) : null },
      "scheduler: job left unfinished by a failed write",
    );
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
