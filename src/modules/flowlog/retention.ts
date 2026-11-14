import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { isPrismaTransactionError, postgresCodeOf } from "@/lib/pg-error";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";

// Retention sweep for the high-write execution_logs table (+ terminal alert_deliveries, the turn
// limit's delivered turns, and the agents' kept full turn detail). One FLOWLOG_SWEEP job per tenant, armed at boot and self-rearming every
// 24h (a reschedule does NOT consume an attempt). Deletes run RLS-scoped to the job's tenant, one
// bounded batch per transaction, so each batch commits on its own and a pass that stops keeps what it
// deleted. A pass runs for at most SWEEP_PASS_MS; a backlog it leaves is taken by the next run,
// SWEEP_CATCHUP_MS later, until the table is back within the window.

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
// A table starts at SWEEP_START_ROWS per batch, and each full batch sizes the next by its own time,
// aiming at SWEEP_TARGET_BATCH_MS: twice the rows at most when it ran fast, half at least when it ran
// slow, between SWEEP_MIN_BATCH_ROWS and SWEEP_BATCH_ROWS. The batch is sized by what it costs, so
// it does not have to run out of time to learn its size: a statement cancelled by its budget is a
// timeout the database screen counts and alerts on. A timeout still halves the batch, as the
// exception it should be.
export const SWEEP_BATCH_ROWS = 5000;
const SWEEP_START_ROWS = 1000;
const SWEEP_MIN_BATCH_ROWS = 100;
const SWEEP_TARGET_BATCH_MS = 1000;
// The shared scheduler lane awaits every handler it claimed before its next tick, so a pass is held to
// what one transaction was allowed before, and a backlog drains over many short passes.
export const SWEEP_PASS_MS = 5 * 1000;
export const SWEEP_CATCHUP_MS = 30 * 1000;
// A pause between batches: housekeeping, so it leaves the write bandwidth to the turns.
const SWEEP_PAUSE_MS = 100;
const TURN_DELIVERY_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
// The proactive breaker's automatic limit reads the largest 24h of the last 30 days from these rows.
const PROACTIVE_DELIVERY_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface SweepOptions {
  /** The first batch's size. */
  batchRows?: number;
  /** The time a batch aims at; 0 keeps every batch at `batchRows`. */
  targetBatchMs?: number;
  passMs?: number;
  pauseMs?: number;
}

// The batch size each tenant's table settled on, so the next pass starts there. Kept per process; a
// restart starts again at SWEEP_START_ROWS.
const batchSizes = new Map<string, number>();
// The tables each tenant's current sweep has not finished yet, in order, so a catch-up pass takes up
// where the last one stopped and never checks again a table the same sweep already finished.
const tablesLeft = new Map<string, number[]>();

/** Test-only: forget the batch sizes and the tables each tenant's sweep has left. Production never calls it. */
export function forgetSweepBatchSizesForTest(): void {
  batchSizes.clear();
  tablesLeft.clear();
}

/** Test-only: the batch size a tenant's table settled on (`<tenantId>:<table index>`). */
export function sweepBatchSizeForTest(key: string): number | undefined {
  return batchSizes.get(key);
}

// The size of the batch after a full one of `size` rows that took `ms`.
export function nextBatchSize(
  size: number,
  ms: number,
  targetMs = SWEEP_TARGET_BATCH_MS,
): number {
  if (targetMs <= 0) return size;
  const factor = Math.min(2, Math.max(0.5, targetMs / Math.max(ms, 1)));
  return Math.min(
    SWEEP_BATCH_ROWS,
    Math.max(SWEEP_MIN_BATCH_ROWS, Math.round(size * factor)),
  );
}

interface TableSweep {
  deleted: number;
  done: boolean;
  timeouts: number;
}

// Deletes, one transaction per batch, the rows `batch(n)` picks up to n at a time, until a batch comes
// back short (done) or the pass deadline passes (not done). A batch that runs out of time (statement
// timeout, lock timeout, or the transaction outliving its budget) is retried at half the size, down to
// SWEEP_MIN_BATCH_ROWS, in this pass if time is left and in the next one otherwise.
async function deleteInBatches(
  base: PrismaClient,
  ctx: TenantContext,
  key: string,
  batch: (rows: number) => Prisma.Sql,
  deadline: number,
  o: Required<SweepOptions>,
): Promise<TableSweep> {
  let deleted = 0;
  let timeouts = 0;
  let size = batchSizes.get(key) ?? o.batchRows;
  while (Date.now() < deadline) {
    let n: number;
    const started = Date.now();
    try {
      n = await runScopedOn(base, ctx, (db) => db.$executeRaw(batch(size)));
    } catch (error) {
      if (!ranOutOfTime(error) || size <= SWEEP_MIN_BATCH_ROWS) throw error;
      timeouts++;
      size = Math.max(SWEEP_MIN_BATCH_ROWS, Math.floor(size / 2));
      batchSizes.set(key, size);
      continue;
    }
    deleted += n;
    if (n < size) return { deleted, done: true, timeouts };
    size = nextBatchSize(size, Date.now() - started, o.targetBatchMs);
    batchSizes.set(key, size);
    if (o.pauseMs > 0) await new Promise((r) => setTimeout(r, o.pauseMs));
  }
  return { deleted, done: false, timeouts };
}

function ranOutOfTime(error: unknown): boolean {
  const code = postgresCodeOf(error);
  return (
    code === "57014" || code === "55P03" || isPrismaTransactionError(error)
  );
}

// One pass over the five tables. `done` is false when the deadline cut it short with rows left.
export async function sweepFlowlog(
  base: PrismaClient,
  tenantId: bigint,
  opts: SweepOptions = {},
): Promise<TableSweep> {
  const o: Required<SweepOptions> = {
    batchRows: opts.batchRows ?? SWEEP_START_ROWS,
    targetBatchMs: opts.targetBatchMs ?? SWEEP_TARGET_BATCH_MS,
    passMs: opts.passMs ?? SWEEP_PASS_MS,
    pauseMs: opts.pauseMs ?? SWEEP_PAUSE_MS,
  };
  const deadline = Date.now() + o.passMs;
  const ctx = sysCtx(tenantId);
  const cutoff = new Date(
    Date.now() - config.flowlog.retentionDays * 86_400_000,
  );
  const now = new Date();
  const turnCutoff = new Date(Date.now() - TURN_DELIVERY_RETENTION_MS);
  const proactiveCutoff = new Date(
    Date.now() - PROACTIVE_DELIVERY_RETENTION_MS,
  );
  // `id = ANY(ARRAY(...))`, never `id IN (...)`: the array is computed once, and the delete walks the
  // primary key. Planned as a semi join, the IN form rescanned the tenant's rows once per row picked:
  // 29 s for a batch of 100 over 700k expired rows, measured under RLS.
  const passes: ((rows: number) => Prisma.Sql)[] = [
    (rows) => Prisma.sql`
      DELETE FROM execution_logs WHERE id = ANY(ARRAY(
        SELECT id FROM execution_logs WHERE created_at < ${cutoff} LIMIT ${rows}))`,
    // Terminal alert deliveries (a row the worker will never touch again) past the cutoff.
    (rows) => Prisma.sql`
      DELETE FROM alert_deliveries WHERE id = ANY(ARRAY(
        SELECT id FROM alert_deliveries
         WHERE status IN ('DELIVERED', 'DEAD') AND created_at < ${cutoff} LIMIT ${rows}))`,
    // NOTE: The turn limit counts the last hour and the proactive limit the last day, so a reply's
    // row goes once two days have passed, whatever the log retention is. A proactive row stays a
    // month, since the breaker's automatic limit is the largest day of the last thirty.
    (rows) => Prisma.sql`
      DELETE FROM agent_turn_deliveries WHERE id = ANY(ARRAY(
        SELECT id FROM agent_turn_deliveries
         WHERE (NOT proactive AND delivered_at < ${turnCutoff})
            OR delivered_at < ${proactiveCutoff}
         LIMIT ${rows}))`,
    // NOTE: An agent's full turn detail leaves at the expiry each row was written with (the
    // agent's own days, never past this cutoff), not at `FLOWLOG_RETENTION_DAYS`. Pointers first,
    // then texts: a text's expiry is the latest of its pointers', so by the time it is due no pointer
    // to it is left. Each is a range over its own `(tenant_id, expires_at)` index, never a join, and
    // the outer predicate is repeated so a text whose expiry a concurrent write just moved forward
    // is re-checked under its row lock and kept.
    (rows) => Prisma.sql`
      DELETE FROM full_detail_refs WHERE id = ANY(ARRAY(
        SELECT id FROM full_detail_refs WHERE expires_at < ${now} LIMIT ${rows}))
        AND expires_at < ${now}`,
    (rows) => Prisma.sql`
      DELETE FROM full_detail_contents WHERE id = ANY(ARRAY(
        SELECT id FROM full_detail_contents WHERE expires_at < ${now} LIMIT ${rows}))
        AND expires_at < ${now}`,
  ];
  // A sweep is done when each table has come back within the window once, over as many passes as it
  // takes: a pass works only the tables the sweep has left, from the one the last pass stopped on. So
  // a table that spends the budget (a backlog, or a slow check) keeps neither the tables after it from
  // being swept nor the sweep from ever finishing.
  const tenantKey = String(tenantId);
  const left = tablesLeft.get(tenantKey) ?? [...passes.keys()];
  let deleted = 0;
  let timeouts = 0;
  while (left.length > 0) {
    const i = left[0] as number;
    const r = await deleteInBatches(
      base,
      ctx,
      `${tenantId}:${i}`,
      passes[i] as (rows: number) => Prisma.Sql,
      deadline,
      o,
    );
    deleted += r.deleted;
    timeouts += r.timeouts;
    if (!r.done) {
      tablesLeft.set(tenantKey, left);
      return { deleted, done: false, timeouts };
    }
    left.shift();
  }
  tablesLeft.delete(tenantKey);
  return { deleted, done: true, timeouts };
}

let handlerOptionsForTest: SweepOptions = {};
/** Test-only: the options the job handler passes to `sweepFlowlog`. Production never calls it. */
export function setSweepOptionsForTest(opts: SweepOptions): void {
  handlerOptionsForTest = opts;
}

export async function flowlogSweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const { deleted, done, timeouts } = await sweepFlowlog(
    base,
    job.tenantId,
    handlerOptionsForTest,
  );
  if (timeouts > 0)
    logger.warn(
      { tenantId: String(job.tenantId), timeouts },
      "flowlog sweep: a batch ran out of time and was cut to half its size",
    );
  if (!done)
    logger.info(
      { tenantId: String(job.tenantId), deleted },
      "flowlog sweep: pass ran out of time with a backlog left; running again shortly",
    );
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + (done ? SWEEP_INTERVAL_MS : SWEEP_CATCHUP_MS)),
  };
}

let registered = false;
export function registerFlowlogRetentionHandler(): void {
  if (registered) return;
  registerJobHandler("FLOWLOG_SWEEP", flowlogSweepHandler);
  registered = true;
}

// How long after boot the sweep runs. A boot re-arm overwrites `run_at`, so a day out here meant an
// instance restarted more often than daily never ran its sweep, and a restart during a drain left the
// rest for the next day.
export const SWEEP_BOOT_DELAY_MS = 10 * 60 * 1000;

// Arms the per-tenant retention sweep (idempotent — enqueueJob upserts one live row per
// (tenant, kind, dedupeKey), re-arming run_at) SWEEP_BOOT_DELAY_MS out.
export async function ensureFlowlogSweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "FLOWLOG_SWEEP",
    dedupeKey: "flowlog-sweep",
    // NOTE: One perpetual row per tenant, same shape as the follow-up sweep: a completed pass
    // clears the budget, and a boot re-arming it must not.
    rearm: "same-work",
    runAt: new Date(Date.now() + SWEEP_BOOT_DELAY_MS),
    base,
  });
}

// Arms the sweep for every existing tenant (called once at boot). A tenant created later is swept
// after the next restart; retention windows (days) dwarf restart cadence, so that lag is harmless.
export async function ensureAllFlowlogSweeps(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  // Same best-effort discipline as ensureAllTenantSweeps: one tenant failing (deleted between the
  // list and the write, transient error) must not deprive every later tenant of its boot re-arm.
  for (const t of tenants) {
    try {
      await ensureFlowlogSweep(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "flowlog sweep re-arm failed for tenant; continuing",
      );
    }
  }
}
