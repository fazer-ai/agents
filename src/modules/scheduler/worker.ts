import type {
  PrismaClient,
  SchedulerJobKind,
} from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { Semaphore } from "@/lib/semaphore";
import { beginWork } from "@/lib/shutdown";
import { emitDeadLetter } from "@/modules/flowlog/dead-letter";
import {
  JOB_DEATH_LEVEL,
  JOB_SPENDS_PROVIDER,
  observeClaimLimit,
  sharedProviderConcurrency,
} from "@/modules/scheduler/lanes";
import { markRunning, markSettled } from "./running";
import {
  abandonClaimed,
  adoptClaimed,
  type ClaimedJob,
  claimDeadLetterAnnouncement,
  claimDueJobs,
  claimDueObserveJobs,
  claimDueTrafficJobs,
  completeJob,
  failJob,
  jobCancelledOnPurpose,
  REAPED_DEATH_ERROR,
  type ReapedJob,
  reapStaleJobs,
  reclaimAfterDeadline,
  rescheduleJob,
} from "./service";
import { StartWindow } from "./start-window";

// Single-replica worker that drains the scheduler. The handler registry decouples the scheduler
// from feature logic; a job kind with no handler fails (and eventually goes DEAD) rather than
// silently vanishing. `reschedule` is for "not yet" (out of hours) and clears the failure budget,
// because the pass completed; `fail` retries with backoff up to the cap.

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

// What a handler is given besides its row. `signal` aborts when the run's deadline fires. `commit` is
// called once the handler has done what it cannot take back (a message sent, a step stamped): a run
// past its deadline normally has its outcome discarded and its retry starts over, which would repeat
// committed work, so a run that committed has its outcome written after all.
export interface JobContext {
  signal: AbortSignal;
  commit: () => void;
}

export type JobHandler = (
  job: ClaimedJob,
  base: PrismaClient,
  ctx?: JobContext,
) => Promise<JobResult>;

// The window after which the reaper presumes a CLAIMED row crashed.
export const SCHEDULER_STALE_MS = 5 * 60_000;

// How long a run may take before it is ended: four fifths of the reaper's stale window, so a job is
// failed through failJob (with its backoff and budget) before the reaper would presume it crashed.
// Derived rather than configured, so a shorter window (a lane's own, a test's) carries its deadline.
export function jobDeadlineMs(staleMs: number): number {
  return Math.floor(staleMs * 0.8);
}

export interface RunClaimedOptions {
  // Defaults to the deadline under the scheduler's own stale window. A lane whose reaper watches a
  // different window passes its own.
  deadlineMs?: number;
}

// The reason a run's signal aborts with, and what the run is failed with.
export class JobDeadlineError extends Error {
  constructor(ms: number) {
    super(`deadline exceeded after ${Math.round(ms / 1000)}s`);
    this.name = "JobDeadlineError";
  }
}

// The handler's promise against the run's deadline. When the deadline fires first, the signal aborts
// with the JobDeadlineError and the race rejects with it at once, whether or not the handler listens.
// `onCut` receives the same ending under another reason, for the shutdown drain's bound.
function withinDeadline<T>(
  running: Promise<T>,
  ms: number,
  controller: AbortController,
  onCut?: (cut: (reason: Error) => void) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const end = (err: Error) => {
      clearTimeout(timer);
      controller.abort(err);
      reject(err);
    };
    const timer = setTimeout(() => end(new JobDeadlineError(ms)), ms);
    onCut?.(end);
    running.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const handlers = new Map<string, JobHandler>();

export function registerJobHandler(kind: string, handler: JobHandler): void {
  handlers.set(kind, handler);
}
export function getJobHandler(kind: string): JobHandler | undefined {
  return handlers.get(kind);
}
// The registry is process-global and a Bun worker shares one process across test files, so a test
// that installs a handler for a kind that had none needs this to put things back.
export function unregisterJobHandler(kind: string): void {
  handlers.delete(kind);
}

// Called when a job is DEAD-LETTERED, the only moment the scheduler can state that this work is
// definitively lost (a failure is not, since the next attempt may succeed). Registered per kind so
// the scheduler stays ignorant of what a loss means downstream. Optional: a kind without one gets the
// generic line; a hook is for a kind whose loss can be said better (attached to its conversation,
// suppressed when the row was re-armed underneath it).
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

// Best-effort over the whole function: nothing here may turn a failed job into a failed tick.
// `announceReaped` walks a batch of rows already DEAD, which no later reap returns, so a throw
// escaping here would silence every later death in that batch for good; hence the re-read sits inside
// the try. Every kind announces here. A registered hook owns the announcement, including the decision
// not to write one (it stays quiet when the row was re-armed underneath it).
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
    await announceJobDeath(job, error, base);
  } catch (err) {
    logger.warn(
      { err, jobId: String(job.id), kind: job.kind },
      "scheduler: dead-letter announcement failed",
    );
  }
}

// The generic dead-letter line, for a hook that announces the death like every kind and then adds
// its own: true when this call wrote it (the row is still this claim's death), false when the row
// moved on, was re-armed or was already announced, which is also when the hook should say nothing.
export async function announceJobDeath(
  job: ClaimedJob,
  error: string,
  base: PrismaClient,
): Promise<boolean> {
  // NOTE: claim the announcement rather than trust the dead-letter that got us here: a re-arm lands
  // on this same row, and announcing re-queued work would page an operator about a loss that did not
  // happen (a still-broken cause fails the new arm and announces then). A claim, not a read, because
  // a missing row cannot tell an erased death from a completed one; the token it leaves lets the
  // revoke see whether this line is owed (DEAD_LETTER_ANNOUNCED). The trail write is fire-and-forget,
  // so a re-arm between claim and insert is still announced over; closing that needs the job's tx.
  if (!(await claimDeadLetterAnnouncement(job, base))) return false;
  // NOTE: the attempt count is deliberately absent: the two roads to DEAD disagree about the number
  // while meaning the same thing (../memory/compact.ts). The error tells the roads apart.
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
  return true;
}

// The second road to DEAD: a claim that crashed or hung never reaches failJob, so it carries no
// `lastError`. Every caller of `reapStaleJobs` owes this call, because a lane with its own worker
// reaps its own kind (the compaction lane, the ingest drain), possibly with the scheduler worker
// disabled, and whichever reaper wins the UPDATE is the only one that sees the death. Free for a kind
// with no hook, so a new lane can call it without knowing which kinds have one.
export async function announceReaped(
  reaped: ReapedJob[],
  base: PrismaClient,
): Promise<void> {
  for (const job of reaped) {
    if (job.status === "DEAD") {
      await dispatchDeadLetter(job, REAPED_DEATH_ERROR, base);
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
    job.kind,
    error,
    base,
  );
  if (!applied) await supersededWarning(job, "fail", base);
  if (deadLettered) await dispatchDeadLetter(job, error, base);
}

// Runs one claimed job through its handler, under a deadline, and records the outcome (under the
// job's tenant scope). When the deadline fires the handler's signal aborts, the run is failed through
// failJob, and this returns, so the lane's slot is free whether or not the handler listened. Until the
// handler does return, its row stays out of every claim in this process (./running.ts), so the retry
// never runs beside it.
export async function runClaimed(
  job: ClaimedJob,
  base: PrismaClient = basePrisma,
  opts: RunClaimedOptions = {},
): Promise<void> {
  // The shutdown drain waits for this run until its outcome is written, and at its bound ends it the
  // way the deadline does, so the row is failed for retry before the process exits.
  // The registration lasts until the handler has returned too: a cut run that had committed still has
  // its late outcome to write (settleAfterDeadline).
  let cut: ((reason: Error) => void) | undefined;
  let late: Promise<unknown> | undefined;
  const end = beginWork(job.kind, (reason) => cut?.(reason));
  if (!adoptClaimed(job)) {
    end();
    return;
  }
  try {
    await runWithDeadline(
      job,
      base,
      opts,
      (c) => {
        cut = c;
      },
      (l) => {
        late = l;
      },
    );
  } finally {
    if (late) void late.finally(end);
    else end();
  }
}

async function runWithDeadline(
  job: ClaimedJob,
  base: PrismaClient,
  opts: RunClaimedOptions,
  onCut: (cut: (reason: Error) => void) => void,
  onLate: (late: Promise<unknown>) => void,
): Promise<void> {
  const handler = getJobHandler(job.kind);
  if (!handler) {
    await fail(job, `no handler: ${job.kind}`, base);
    return;
  }
  const deadlineMs = opts.deadlineMs ?? jobDeadlineMs(SCHEDULER_STALE_MS);
  const controller = new AbortController();
  const startedAt = Date.now();
  let committed = false;
  // What the deadline failed the run with, which the late write asks the row to still carry.
  let failedWith = "";
  // Resolved once the deadline's failure is written (or the run ended without one), so a late outcome
  // is never written under it.
  let failureWritten!: () => void;
  const failureSettled = new Promise<void>((r) => {
    failureWritten = r;
  });
  markRunning(job.id);
  // The async wrapper turns a synchronous throw into a rejection, so the row always leaves the
  // running set.
  const running = (async () =>
    handler(job, base, {
      signal: controller.signal,
      commit: () => {
        committed = true;
      },
    }))();
  const lateChain = running
    .catch(() => null)
    .then(async (late) => {
      if (!controller.signal.aborted) return;
      await failureSettled;
      if (committed && late && late.outcome !== "fail") {
        await settleAfterDeadline(job, late, base, startedAt, failedWith);
      } else {
        lateOutcomeDiscarded(job, startedAt, base);
      }
    })
    .catch((err) =>
      logger.warn(
        { err, kind: job.kind, jobId: String(job.id) },
        "scheduler: could not write the outcome of a run past its deadline",
      ),
    )
    // NOTE: only now, so the row stays out of every claim until its late outcome, if any, is written.
    .finally(() => markSettled(job.id));
  onLate(lateChain);
  let result: JobResult;
  try {
    result = await withinDeadline(running, deadlineMs, controller, onCut);
  } catch (err) {
    failedWith = errMsg(err);
    try {
      await fail(job, failedWith, base);
    } finally {
      failureWritten();
    }
    return;
  }
  failureWritten();
  await settle(job, result, base);
}

// The outcome of a run that still held its claim.
async function settle(
  job: ClaimedJob,
  result: JobResult,
  base: PrismaClient,
): Promise<void> {
  if (result.outcome === "done") {
    const { applied } = await completeJob(
      job.tenantId,
      job.id,
      job.claimSeq,
      job.kind,
      base,
    );
    if (!applied) await supersededWarning(job, "done", base);
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
    if (!applied) await supersededWarning(job, "reschedule", base);
  } else {
    await fail(job, result.error ?? "failed", base);
  }
}

// A run failed at its deadline that had committed (JobContext.commit): the row is taken back from the
// failure and the outcome written through the ordinary path, so a step stamped is followed by its next
// step and a reminder sent is not sent again. Taken back only if nothing touched the row since the
// failure; otherwise the outcome is discarded like any other late one.
async function settleAfterDeadline(
  job: ClaimedJob,
  result: JobResult,
  base: PrismaClient,
  startedAt: number,
  failedWith: string,
): Promise<void> {
  const { applied } = await reclaimAfterDeadline(
    job.tenantId,
    job.id,
    job.claimSeq,
    job.attempts,
    failedWith,
    base,
  );
  if (!applied) {
    lateOutcomeDiscarded(job, startedAt, base);
    return;
  }
  logger.warn(
    {
      kind: job.kind,
      jobId: String(job.id),
      claimSeq: job.claimSeq,
      heldMs: Date.now() - startedAt,
      outcome: result.outcome,
    },
    "scheduler: handler returned after its deadline having committed, outcome written",
  );
  await settle(job, result, base);
}

// A handler that returned after its deadline had already ended its run: whatever it returned was not
// recorded, because the run was failed at the deadline. Worth a line for the same reason the
// superseded one is: it is the only trace of how long the handler really held on.
function lateOutcomeDiscarded(
  job: ClaimedJob,
  startedAt: number,
  base: PrismaClient,
): void {
  const heldMs = Date.now() - startedAt;
  logger.warn(
    { kind: job.kind, jobId: String(job.id), claimSeq: job.claimSeq, heldMs },
    "scheduler: handler returned after its deadline, outcome discarded",
  );
  announceDiscardedOutcome(job, "deadline", base, { heldMs });
}

// The claim this run held was no longer current, so its outcome was discarded. Not an error (the CAS
// working), but the only trace of the ordering, and the handler's side effects still happened. Work
// that must not be repeated needs its own exclusion (see inFlight in src/modules/memory/worker.ts).
async function supersededWarning(
  job: ClaimedJob,
  outcome: string,
  base: PrismaClient,
): Promise<void> {
  logger.warn(
    { kind: job.kind, jobId: String(job.id), claimSeq: job.claimSeq, outcome },
    "scheduler: claim superseded, outcome discarded",
  );
  // NOTE: a row retired on purpose while this run held it (/reset, the episode ending) carries
  // `cancelledAt`: the fence is the design and nothing was lost, so nothing to announce.
  if (
    SUPERSEDE_ANNOUNCED.has(job.kind) &&
    !(await jobCancelledOnPurpose(job, base))
  ) {
    announceDiscardedOutcome(job, "superseded", base, { outcome });
  }
}

// Which superseded claims are worth a flow line. Usually a supersede is the guard working (a debounce
// flush is superseded by every message landing while it runs). Nothing re-arms a claimed FOLLOWUP, so
// a superseded one is an ordering nobody designed, and it can lose the step that labels and resolves.
// A kind joins this set when its supersede stops being routine.
const SUPERSEDE_ANNOUNCED: ReadonlySet<SchedulerJobKind> = new Set([
  "FOLLOWUP",
]);

// A discarded outcome, on the record operators read. `dead_letter` because the outcome is gone (a
// retry recomputes from scratch) and that is the stage alert channels subscribe to for lost work;
// `warn` because the row itself is still live. `detail.discarded` says which road.
function announceDiscardedOutcome(
  job: ClaimedJob,
  discarded: "deadline" | "superseded",
  base: PrismaClient,
  extra: Record<string, unknown>,
): void {
  const threadId =
    typeof job.payload.threadId === "string" ? job.payload.threadId : null;
  emitDeadLetter({
    tenantId: job.tenantId,
    unit: "job",
    level: "warn",
    error:
      discarded === "deadline"
        ? "scheduler: handler returned after its deadline, outcome discarded"
        : "scheduler: claim superseded, outcome discarded",
    detail: {
      kind: job.kind,
      jobId: String(job.id),
      discarded,
      ...(job.dedupeKey ? { dedupeKey: job.dedupeKey } : {}),
      ...extra,
    },
    threadId,
    base,
  });
}

export interface TickOptions {
  staleMs: number;
  batchSize: number;
  // NOTE: test-only isolation, the same fence claimDueJobs and reapStaleJobs document: the tick is
  // cross-tenant, so concurrent DB-backed suites claim each other's rows. Unset in production.
  tenantId?: bigint;
  // NOTE: test-only. Production sizes this from the model budget (sharedProviderConcurrency), which
  // depends on the machine's AGENT_MODEL_CONCURRENCY. Unset in production.
  providerConcurrency?: number;
  // The bound provider-spending jobs run under. `startScheduler` passes the one it also hands to the
  // observe drain, so the two share a single budget; absent, the tick bounds itself.
  gate?: Semaphore;
  // False when a fast drain owns the observe lane (`startScheduler`), so the tick leaves OBSERVE
  // rows to it. Absent, the tick claims them itself, with `observeClaimLimit`.
  claimObserve?: boolean;
  // False when the traffic drain owns the traffic-proportional kinds (`startScheduler`). Absent,
  // the tick claims a quarter of its batch of them.
  claimTraffic?: boolean;
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
  // Two claims, one drain. Fixed-rate kinds take the batch; traffic-proportional ones take a
  // quarter on top (../scheduler/lanes.ts, JOB_TRAFFIC_PROPORTIONAL). One claim ordered by run_at
  // would be filled by ingestion rows armed for `now`, and an appointment reminder would never be
  // claimed. A quarter suffices: every reader of a memory thread drains it first, so the tick is only
  // the backstop. The `max(1, ...)` is this caller's floor; claimWhere's clamp is a cap, not a floor.
  const trafficShare = Math.max(1, Math.floor(opts.batchSize / 4));
  const providerConcurrency =
    opts.providerConcurrency ??
    sharedProviderConcurrency(config.agent.modelConcurrency);
  // A third claim, for the observe lane: OBSERVE's latency is read live, so it cannot wait
  // behind ingestion in the traffic share. Its limit is sized to the provider bound below, minus the
  // provider-spending rows the first two claims took, so it only spends permits the lane already had.
  // NOTE: a claim that throws leaves the rows the earlier ones took unrun; they stay CLAIMED for the
  // reaper and stop holding the shutdown drain open.
  const jobs: ClaimedJob[] = [];
  try {
    jobs.push(
      ...(await claimDueJobs(opts.batchSize, base, new Date(), opts.tenantId)),
    );
    if (opts.claimTraffic !== false) {
      jobs.push(
        ...(await claimDueTrafficJobs(
          trafficShare,
          base,
          new Date(),
          opts.tenantId,
        )),
      );
    }
    if (opts.claimObserve !== false) {
      jobs.push(
        ...(await claimDueObserveJobs(
          observeClaimLimit(
            providerConcurrency,
            jobs.filter((job) => JOB_SPENDS_PROVIDER[job.kind]).length,
          ),
          base,
          new Date(),
          opts.tenantId,
        )),
      );
    }
  } catch (err) {
    abandonClaimed(jobs);
    throw err;
  }
  // The batch drains concurrently so short jobs do not queue behind long ones (an appointment
  // reminder must arrive before something). It gives up FIFO within a batch, which only shows when the
  // scheduler is hours behind. allSettled: runClaimed never re-throws, but a stray throw must not stall
  // the tick. Kinds that spend provider capacity go through a bound, the rest do not: bounding the whole
  // drain puts a heartbeat behind a nudge, and leaving them unbounded lets a batch hold every model
  // permit while a customer's reply waits (JOB_SPENDS_PROVIDER).
  const gate = opts.gate ?? new Semaphore(providerConcurrency);
  // The deadline follows the stale window THIS tick reaps with, so neither can be passed in
  // without the other.
  const deadlineMs = jobDeadlineMs(opts.staleMs);
  const settled = await Promise.allSettled(
    jobs.map((job) =>
      JOB_SPENDS_PROVIDER[job.kind]
        ? gate.run(() => runClaimed(job, base, { deadlineMs }))
        : runClaimed(job, base, { deadlineMs }),
    ),
  );
  // NOTE: allSettled discards rejections. runClaimed swallows a handler's own error, so a rejection
  // here is the infrastructure underneath (completeJob/failJob unable to reach the database) and the
  // row stays CLAIMED until the reaper takes it. Logged per job so one row cannot decide the rest.
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

// How many observations the drain is running RIGHT NOW. Per process, which is what this worker is by
// construction.
let observeRunning = 0;
// Set when the observe drain had a free slot and found no provider permit, cleared when it gets one.
// While set, the traffic drain leaves one permit free (runTrafficTick): a freed permit is otherwise
// retaken by the traffic refill in the same turn, and a recovery backlog would starve the observers.
let observeRefused = false;

export interface ObserveTickOptions {
  // How many observations may run at once. `startScheduler` passes the provider bound.
  slots: number;
  // The bound the shared tick's provider-spending jobs also run under.
  gate: Semaphore;
  staleMs: number;
  // NOTE: test-only isolation, as on TickOptions. Unset in production.
  tenantId?: bigint;
  // Called each time a row finishes, so the caller can fill the freed slot at once.
  onFreed?: () => void;
}

// The FAST drain of the observe lane: a verdict is read while the conversation is happening, so a
// due OBSERVE row is claimed at this cadence and not the shared tick's. SLOTS, NOT BATCHES, as the
// debounce lane: a tick fills the free slots and returns once its rows have STARTED. A PERMIT IS
// TAKEN BEFORE THE ROW IS CLAIMED, from the gate the shared tick's provider work runs under, so
// observers take no concurrency the scheduler did not already have and a claimed row never spends
// its stale window waiting for capacity. The reaper stays on the shared tick. `settled` resolves
// when every row this tick started has finished; the worker never waits on it, tests do.
export async function runObserveTick(
  base: PrismaClient,
  opts: ObserveTickOptions,
): Promise<{ claimed: number; settled: Promise<void> }> {
  const permits: (() => void)[] = [];
  while (permits.length < opts.slots - observeRunning) {
    const permit = opts.gate.tryAcquire();
    if (!permit) break;
    permits.push(permit);
  }
  // NOTE: not a claim of zero. claimWhere clamps its limit to at least 1, so asking with no permit
  // in hand would take one row the drain cannot start.
  observeRefused = permits.length === 0 && opts.slots > observeRunning;
  if (permits.length === 0) return { claimed: 0, settled: Promise.resolve() };
  let jobs: ClaimedJob[];
  try {
    // A row re-armed while its own run is in flight is left out by the claim itself (./running.ts).
    jobs = await claimDueObserveJobs(
      permits.length,
      base,
      new Date(),
      opts.tenantId,
    );
  } catch (err) {
    for (const permit of permits) permit();
    throw err;
  }
  // The permits nothing was claimed for go back at once.
  for (const permit of permits.splice(jobs.length)) permit();
  observeRunning += jobs.length;
  const deadlineMs = jobDeadlineMs(opts.staleMs);
  // allSettled: runClaimed never re-throws, but a stray throw must not strand a slot or a permit.
  const settled = Promise.allSettled(
    jobs.map((job, i) =>
      (async () => runClaimed(job, base, { deadlineMs }))()
        .catch((err) =>
          logger.error(
            { err, kind: job.kind, jobId: String(job.id) },
            "scheduler: job left unfinished by a failed write",
          ),
        )
        .finally(() => {
          permits[i]?.();
          observeRunning -= 1;
          opts.onFreed?.();
        }),
    ),
  ).then(() => {});
  return { claimed: jobs.length, settled };
}

// How many traffic-proportional jobs the drain is running RIGHT NOW. Per process, as observeRunning.
let trafficRunning = 0;

export interface TrafficTickOptions {
  // How many may run at once (config.schedulerWorker.trafficConcurrency).
  slots: number;
  // How many may start in any minute (config.schedulerWorker.trafficPerMinute).
  window: StartWindow;
  // The bound the shared tick's provider-spending jobs also run under.
  gate: Semaphore;
  staleMs: number;
  // NOTE: test-only isolation, as on TickOptions. Unset in production.
  tenantId?: bigint;
  // Called each time a row finishes, so the caller can fill the freed slot at once.
  onFreed?: () => void;
}

// The provider permits the traffic drain may take now: the free ones, less one owed to the observe
// drain after it was refused (`observeRefused`). Read, never taken and handed back, so asking does
// not wake whoever waits on a free permit.
export function trafficPermitsFree(gate: Semaphore): number {
  return Math.max(0, gate.free - (observeRefused ? 1 : 0));
}

// The drain of the traffic-proportional kinds (./lanes.ts, JOB_TRAFFIC_PROPORTIONAL), in SLOTS as
// the observe drain: it claims into the free slots, as many as the start window allows, and returns
// once its rows have STARTED. Concurrency bounds what runs at once, the window the sustained rate
// (the CPU a backlog takes from live traffic). Provider permits are taken BEFORE the claim, which
// takes no more spending rows than it holds (`spendCap`): a claimed row never waits for capacity,
// so every claim is a start and the observe drain never queues behind a backlog. `waitMs` is how
// long until the window admits another start when it is what stopped the claim; `wantsPermit`, that
// a spending row may be due and waiting on a permit.
export async function runTrafficTick(
  base: PrismaClient,
  opts: TrafficTickOptions,
): Promise<{
  claimed: number;
  waitMs: number | null;
  wantsPermit: boolean;
  settled: Promise<void>;
}> {
  const free = opts.slots - trafficRunning;
  const now = Date.now();
  const allowed = Math.min(free, opts.window.available(now));
  if (allowed <= 0) {
    return {
      claimed: 0,
      waitMs: free > 0 ? opts.window.nextFreeAt(now) - now : null,
      wantsPermit: false,
      settled: Promise.resolve(),
    };
  }
  const permits: (() => void)[] = [];
  const take = Math.min(allowed, trafficPermitsFree(opts.gate));
  while (permits.length < take) {
    const permit = opts.gate.tryAcquire();
    if (!permit) break;
    permits.push(permit);
  }
  let jobs: ClaimedJob[];
  try {
    jobs = await claimDueTrafficJobs(
      allowed,
      base,
      new Date(),
      opts.tenantId,
      permits.length,
    );
  } catch (err) {
    for (const permit of permits) permit();
    throw err;
  }
  const spending = jobs.filter((job) => JOB_SPENDS_PROVIDER[job.kind]).length;
  // Every permit held went to a row and the claim still came up short: the cap may have bound.
  const wantsPermit =
    jobs.length < allowed &&
    permits.length < allowed &&
    spending === permits.length;
  for (const permit of permits.splice(spending)) permit();
  opts.window.record(Date.now(), jobs.length);
  trafficRunning += jobs.length;
  const deadlineMs = jobDeadlineMs(opts.staleMs);
  // allSettled: runClaimed never re-throws, but a stray throw must not strand a slot or a permit.
  const settled = Promise.allSettled(
    jobs.map((job) => {
      const permit = JOB_SPENDS_PROVIDER[job.kind]
        ? permits.shift()
        : undefined;
      return (async () => runClaimed(job, base, { deadlineMs }))()
        .catch((err) =>
          logger.error(
            { err, kind: job.kind, jobId: String(job.id) },
            "scheduler: job left unfinished by a failed write",
          ),
        )
        .finally(() => {
          permit?.();
          trafficRunning -= 1;
          opts.onFreed?.();
        });
    }),
  ).then(() => {});
  return { claimed: jobs.length, waitMs: null, wantsPermit, settled };
}

interface Holder {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
  observeTimer?: ReturnType<typeof setInterval>;
  // `observing` covers the CLAIM only, so two claims never overlap; `observeAgain` remembers a
  // drain asked for meanwhile (a slot freed mid-claim), which runs as soon as the claim returns.
  observing: boolean;
  observeAgain: boolean;
  // Set while the drain runs: asks for a drain at a given instant (`wakeObserveDrainAt`).
  wakeObserve?: (atMs: number) => void;
  trafficTimer?: ReturnType<typeof setInterval>;
  // As `observing` and `observeAgain`, for the traffic drain.
  draining: boolean;
  drainAgain: boolean;
  // The one wake-up armed for when the start window admits again.
  trafficWake?: ReturnType<typeof setTimeout>;
  // Set while the traffic drain waits for a provider permit to free (`wantsPermit`).
  trafficPermitWake?: () => void;
  // The wake-ups not fired yet, by the instant they are for, so stopping clears them.
  observeWakes: Map<number, ReturnType<typeof setTimeout>>;
}

// How far apart two wake-ups have to be to get a timer each. A burst arms its row on every message,
// and the instants it names land within milliseconds of each other.
const OBSERVE_WAKE_GRAIN_MS = 100;

// Asks the observe drain to run when a row just armed becomes due, so the row does not also wait
// for the drain's next interval on top of its own window. A hint from the process that armed the
// row: with no drain running here it does nothing, and the interval still finds the row either way.
export function wakeObserveDrainAt(runAt: Date): void {
  holder().wakeObserve?.(runAt.getTime());
}

const KEY = Symbol.for("fazerai.scheduler.worker");

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  g[KEY] ??= {
    running: false,
    observing: false,
    observeAgain: false,
    observeWakes: new Map(),
    draining: false,
    drainAgain: false,
  };
  return g[KEY];
}

export interface StartOptions {
  base?: PrismaClient;
  intervalMs?: number;
  // The observe drain's own cadence (config.observeWorker.intervalMs).
  observeIntervalMs?: number;
  staleMs?: number;
  batchSize?: number;
  // NOTE: test-only, as on TickOptions: the fence and the bound a test needs to own.
  tenantId?: bigint;
  providerConcurrency?: number;
  // The traffic drain's bounds; production reads config.schedulerWorker.
  trafficConcurrency?: number;
  trafficPerMinute?: number;
}

// Idempotent singleton (survives `bun --hot` reloads via globalThis, so no ghost timers). The tick
// is non-overlapping (a `running` guard). It also starts the observe lane's fast drain, which has
// no switch of its own: an install that runs the scheduler runs it. Returns the stop function.
export function startScheduler(opts: StartOptions = {}): () => void {
  const h = holder();
  if (h.timer) return stopScheduler;
  const base = opts.base ?? basePrisma;
  const intervalMs = opts.intervalMs ?? config.schedulerWorker.intervalMs;
  const observeIntervalMs =
    opts.observeIntervalMs ?? config.observeWorker.intervalMs;
  const staleMs = opts.staleMs ?? SCHEDULER_STALE_MS;
  const batchSize = opts.batchSize ?? 20;
  const providerConcurrency =
    opts.providerConcurrency ??
    sharedProviderConcurrency(config.agent.modelConcurrency);
  // ONE bound for both drains: an observation takes a permit the shared tick's follow-ups would
  // otherwise use, never one on top of them.
  const gate = new Semaphore(providerConcurrency);
  h.timer = setInterval(() => {
    if (h.running) return;
    h.running = true;
    void runSchedulerTick(base, {
      staleMs,
      batchSize,
      gate,
      providerConcurrency,
      claimObserve: false,
      claimTraffic: false,
      ...(opts.tenantId === undefined ? {} : { tenantId: opts.tenantId }),
    })
      .catch((err) => logger.error({ err }, "scheduler tick failed"))
      .finally(() => {
        h.running = false;
      });
  }, intervalMs);
  const drainObserve = () => {
    // A drain asked for after the worker stopped (a row finishing late) claims nothing.
    if (!h.observeTimer) return;
    if (h.observing) {
      h.observeAgain = true;
      return;
    }
    h.observing = true;
    h.observeAgain = false;
    void runObserveTick(base, {
      slots: providerConcurrency,
      gate,
      staleMs,
      onFreed: drainObserve,
      ...(opts.tenantId === undefined ? {} : { tenantId: opts.tenantId }),
    })
      .catch((err) => logger.error({ err }, "observe tick failed"))
      .finally(() => {
        h.observing = false;
        if (h.observeAgain) drainObserve();
      });
  };
  h.observeTimer = setInterval(drainObserve, observeIntervalMs);
  const trafficSlots =
    opts.trafficConcurrency ?? config.schedulerWorker.trafficConcurrency;
  const window = new StartWindow(
    opts.trafficPerMinute ?? config.schedulerWorker.trafficPerMinute,
  );
  const drainTraffic = () => {
    if (!h.trafficTimer) return;
    if (h.draining) {
      h.drainAgain = true;
      return;
    }
    h.draining = true;
    h.drainAgain = false;
    void runTrafficTick(base, {
      slots: trafficSlots,
      window,
      gate,
      staleMs,
      onFreed: drainTraffic,
      ...(opts.tenantId === undefined ? {} : { tenantId: opts.tenantId }),
    })
      .then(({ waitMs, wantsPermit }) => {
        if (wantsPermit && !h.trafficPermitWake) {
          h.trafficPermitWake = gate.onFree(() => {
            if (trafficPermitsFree(gate) === 0) return;
            h.trafficPermitWake?.();
            h.trafficPermitWake = undefined;
            drainTraffic();
          });
          // A permit freed while the claim was out notified nobody: look once more now.
          if (trafficPermitsFree(gate) > 0) h.drainAgain = true;
        }
        // The window stopped the claim: wake when it admits again rather than at the next interval.
        if (waitMs !== null && !h.trafficWake) {
          h.trafficWake = setTimeout(() => {
            h.trafficWake = undefined;
            drainTraffic();
          }, waitMs);
        }
      })
      .catch((err) => logger.error({ err }, "traffic tick failed"))
      .finally(() => {
        h.draining = false;
        if (h.drainAgain) drainTraffic();
      });
  };
  h.trafficTimer = setInterval(drainTraffic, intervalMs);
  h.wakeObserve = (atMs) => {
    const slot =
      Math.ceil(atMs / OBSERVE_WAKE_GRAIN_MS) * OBSERVE_WAKE_GRAIN_MS;
    const wait = slot - Date.now();
    if (h.observeWakes.has(slot)) return;
    h.observeWakes.set(
      slot,
      setTimeout(
        () => {
          h.observeWakes.delete(slot);
          drainObserve();
        },
        Math.max(0, wait),
      ),
    );
  };
  logger.info(
    "scheduler worker started (interval=%dms, observe=%dms)",
    intervalMs,
    observeIntervalMs,
  );
  return stopScheduler;
}

export function stopScheduler(): void {
  const h = holder();
  if (h.timer) {
    clearInterval(h.timer);
    h.timer = undefined;
  }
  if (h.observeTimer) {
    clearInterval(h.observeTimer);
    h.observeTimer = undefined;
  }
  if (h.trafficTimer) {
    clearInterval(h.trafficTimer);
    h.trafficTimer = undefined;
  }
  if (h.trafficWake) {
    clearTimeout(h.trafficWake);
    h.trafficWake = undefined;
  }
  h.trafficPermitWake?.();
  h.trafficPermitWake = undefined;
  h.wakeObserve = undefined;
  for (const timer of h.observeWakes.values()) clearTimeout(timer);
  h.observeWakes.clear();
}
