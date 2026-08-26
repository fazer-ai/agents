import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { Semaphore } from "@/lib/semaphore";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitDeadLetter } from "@/modules/flowlog/dead-letter";
import {
  JOB_DEATH_LEVEL,
  JOB_SPENDS_PROVIDER,
  sharedProviderConcurrency,
} from "@/modules/scheduler/lanes";
import {
  type ClaimedJob,
  claimDueJobs,
  claimDueTrafficJobs,
  completeJob,
  failJob,
  type ReapedJob,
  reapStaleJobs,
  rescheduleJob,
} from "./service";

// Single-replica worker that drains the scheduler. The handler registry decouples the scheduler
// from feature logic (follow-ups register their handlers); a job kind with no handler fails (and
// eventually goes DEAD) rather than silently vanishing. `reschedule` is for "not yet" (out of
// hours) and CLEARS the failure budget, because it means the pass completed (issue #287); `fail`
// retries with backoff up to the cap.

export type JobResult =
  | { outcome: "done" }
  // `payload`, when present, REPLACES the job's payload on reschedule (e.g. a follow-up advancing its
  // step index on the same row). Omit it to keep the current payload. `payloadPatch` MERGES instead,
  // which is what a handler wants when it only carries a field forward and another writer may have
  // stamped the row while it ran (see rescheduleJob). Pass at most one of the two.
  | {
      outcome: "reschedule";
      runAt: Date;
      payload?: Record<string, unknown>;
      payloadPatch?: Record<string, unknown>;
    }
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
// The counterpart, and it exists because the registry is process-global while a Bun worker shares
// one process across test files: a test that installs a handler for a kind that had none could put
// nothing back, so the stub outlived the file and the next file's scheduler test inherited it. With
// this, "install, use, put back" is expressible for both starting states.
export function unregisterJobHandler(kind: string): void {
  handlers.delete(kind);
}

// Called when a job is DEAD-LETTERED, which is the only moment the scheduler can state that this
// work is definitively lost — a failure is not that statement, because the next attempt may succeed
// (issue #71). Registered per kind so the scheduler stays ignorant of what a given job's loss means
// downstream.
//
// OPTIONAL, and what a kind gets by NOT registering one is no longer silence: it is the generic
// line below. A hook is for a kind whose loss can be said better than "a FOLLOWUP died" — attached
// to the conversation it belongs to, suppressed when the row was re-armed underneath it — and two
// kinds have earned one. Ten had not, and before issue #356 all ten died through an early return.
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

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Best-effort, and the guarantee covers the WHOLE function rather than the hook call it started on:
// nothing in here may turn a failed job into a failed tick. It runs AFTER the row is DEAD, so it can
// never be mistaken for part of the attempt, and by then the announcement is the only thing left to
// lose — but losing it is not the worst case. `announceReaped` walks a BATCH, so a throw escaping
// here takes every later dead job in that batch with it, and no subsequent reap will return them:
// they are already DEAD, and the reaper only claims rows still CLAIMED. One transient pool timeout
// would permanently silence a whole tick's worth of deaths.
//
// That is why the re-read below is inside the try and not beside it. A guard added to prevent one
// false report must not be able to destroy a batch of true ones.
//
// EVERY kind announces here, which is the whole of issue #356's biggest half. `if (!hook) return`
// used to be the exit for ten of the twelve kinds, and it was invisible: the hook is optional by
// design, so nothing anywhere counted how many kinds were leaving through it, and the count only
// ever went down when somebody happened to write a hook for one more (#196, #71).
//
// A registered hook OWNS the announcement, including the decision NOT to write one — both existing
// hooks re-read the row and stay quiet when it was re-armed underneath them, and a generic line
// written over that would re-report a loss the hook just established had not happened.
async function dispatchDeadLetter(
  job: ClaimedJob,
  error: string,
  base: PrismaClient,
): Promise<void> {
  try {
    const hook = deadLetterHandlers.get(job.kind);
    if (hook) {
      await hook(job, error, base);
      return;
    }
    // NOTE: RE-READ rather than trust the dead-letter that got us here, which is what both
    // hand-written hooks do and for the same reason (../memory/compact.ts spells it out). A re-arm
    // lands on THIS row — `upsertJobRow` keys on (tenant, kind, dedupeKey) — so a FOLLOWUP the
    // sweep re-arms in the window between the DEAD write and this line is work that is queued
    // again, and announcing it would page an operator about a loss that did not happen. Suppressing
    // costs nothing: a cause that is still broken fails the new arm too, and announces then.
    //
    // It NARROWS the window and cannot close it: the trail write is fire-and-forget, so a re-arm
    // landing between this read and that insert still gets announced over. What is left is a line
    // the next pass's own outcome follows, which is legible; closing it would mean writing the row
    // inside the job's transaction.
    //
    // Any status but DEAD suppresses, and a MISSING row suppresses too: for a kind with
    // JOB_DELETE_ON_DONE the row is gone precisely because the work completed, and no row is not
    // evidence that work was lost.
    //
    // And the row has to be DEAD for THIS claim. `claimSeq` is the token the claim handed out, and
    // the module already treats a moved one as "this run was retired" (`isRetired`, ../scheduler
    // /service.ts): a row re-armed, re-claimed by another drain and dead AGAIN reads as DEAD here
    // while belonging to a later attempt — which announces its own death with its own error. Status
    // alone would report the old error and let the new one report a second time.
    const row = await runScopedOn(base, sysCtx(job.tenantId), (db) =>
      db.schedulerJob.findUnique({
        where: { id: job.id },
        select: { status: true, claimSeq: true },
      }),
    );
    if (row?.status !== "DEAD" || row.claimSeq !== job.claimSeq) return;
    // NOTE: the attempt count is deliberately absent, for the reason measured in
    // ../memory/compact.ts: the two roads to DEAD disagree about the number while meaning the same
    // thing (failJob hands the hook the claim it was given, the reaper increments in SQL). What
    // tells the roads apart is the error itself, and only the reaper writes "the claim never
    // finished".
    emitDeadLetter({
      tenantId: job.tenantId,
      unit: "job",
      level: JOB_DEATH_LEVEL[job.kind],
      error,
      detail: {
        kind: job.kind,
        jobId: String(job.id),
        // NOTE: ids by construction (a dedupe key has to be stable), and the only field on this
        // line an operator can act on: it says WHICH follow-up, WHICH document, WHICH reminder.
        ...(job.dedupeKey ? { dedupeKey: job.dedupeKey } : {}),
      },
      base,
    });
  } catch (err) {
    logger.warn(
      { err, jobId: String(job.id), kind: job.kind },
      "scheduler: dead-letter announcement failed",
    );
  }
}

// THE SECOND ROAD TO DEAD, and the one with nothing else to read: a claim that crashed or hung never
// reaches failJob, so it carries no `lastError` explaining anything — just a row that stopped moving.
// Every caller of `reapStaleJobs` owes this call.
//
// It is a shared function rather than the loop it replaced because reaping is NOT the scheduler
// tick's alone: a lane with its own worker reaps its own kind (the compaction lane, the ingest
// drain), for reasons written at those call sites, and the loop was copied to none of them. Which
// reaper announced was therefore decided by whichever won the atomic UPDATE — the scheduler's, and
// the announcement happened; the lane's, and it did not. A kind whose lane runs with the scheduler
// worker disabled — a configuration the boot sequence supports — never announced at all.
//
// Free for a kind with no hook registered, which is what makes "every reaper calls it" a rule a
// fourth lane can follow without knowing which kinds have one.
export async function announceReaped(
  reaped: ReapedJob[],
  base: PrismaClient,
): Promise<void> {
  for (const job of reaped) {
    if (job.status === "DEAD") {
      await dispatchDeadLetter(job, "reaped: the claim never finished", base);
    }
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
      job.kind,
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
      result.payloadPatch,
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
  await announceReaped(reaped, base);
  // TWO CLAIMS, ONE DRAIN. The fixed-rate kinds take the batch; the traffic-proportional ones take a
  // share of it on top (../scheduler/lanes.ts, JOB_TRAFFIC_PROPORTIONAL). A single claim ordered by
  // run_at cannot serve both: ingestion rows are armed for `now` and arrive at the rate contacts
  // write, so on a busy fleet they are always the oldest and always fill the batch, and an
  // appointment reminder — a kind whose whole purpose is to arrive before something — is never
  // claimed at all, however overdue it gets.
  //
  // A share rather than the whole batch again, because these are the rows that can be unbounded, and
  // a quarter of a batch every tick is generous for work whose latency nothing waits on: every
  // reader of a memory thread drains it before reading, so the tick is only the backstop for threads
  // nobody touches.
  // The `max(1, …)` survives mutation, and knowingly: `claimWhere` clamps its own limit to at least
  // one, so a batch smaller than four would claim a traffic row either way and no test can separate
  // the two. It stays because that clamp is a hard CAP for the claim, not a floor for this caller —
  // making the floor depend on it would put this rule in another module, in a line written for the
  // opposite purpose.
  const trafficShare = Math.max(1, Math.floor(opts.batchSize / 4));
  const jobs = [
    ...(await claimDueJobs(opts.batchSize, base, new Date(), opts.tenantId)),
    ...(await claimDueTrafficJobs(
      trafficShare,
      base,
      new Date(),
      opts.tenantId,
    )),
  ];
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
