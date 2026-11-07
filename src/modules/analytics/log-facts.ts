import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import {
  type JobContext,
  type JobResult,
  registerJobHandler,
} from "@/modules/scheduler/worker";

// THE FLOW-LOG LINES THE DASHBOARD COUNTS, KEPT AS FACTS (docs/dashboard.md, "Log facts"). Triggers on
// `execution_logs` keep `dashboard_log_facts` in step with every line written, rewritten or deleted
// since the migration that created them (prisma/migrations/20261107220000_dashboard_log_facts). The
// lines written before it are filled in here, one hour of lines per transaction, by a job per tenant
// armed at boot; until a tenant's job finishes, its readers read the flow log as they always did.

// One transaction's worth of lines: an hour of a tenant's transfer, silence and follow-up lines is a
// few thousand at the busiest, well inside a scoped transaction's budget.
const SLICE_MS = 60 * 60 * 1000;
// How long one run fills before it hands the lane back and reschedules itself, far under the run's
// deadline (worker.ts, jobDeadlineMs).
const RUN_BUDGET_MS = 30_000;

const DEDUPE_KEY = "dashboard-log-facts-backfill";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Whether the readers of this scope can read the facts: no tenant it sees is still being filled in.
// Under a tenant that is its own row; under the fleet, every tenant's.
export async function logFactsReady(db: ScopedDb): Promise<boolean> {
  const [row] = await db.$queryRaw<{ pending: boolean }[]>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM dashboard_log_facts_state WHERE backfilled_at IS NULL) AS pending`);
  return !row?.pending;
}

// Fills one slice of a tenant's earlier lines and moves the cursor past it, in one transaction.
// Returns whether the tenant is done. The lines are locked FOR KEY SHARE in a subquery, and only the
// rows that lock returns are written: a delete still uncommitted when the slice reaches its line holds
// the slice until it commits, and the line it took is skipped; a delete that comes after waits for
// this commit, and its trigger then sees the fact and removes it with the line.
export async function backfillLogFactsSlice(
  base: PrismaClient,
  tenantId: bigint,
): Promise<boolean> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const state = await db.dashboardLogFactsState.findUnique({
      where: { tenantId },
      select: { cursorAt: true, backfilledAt: true },
    });
    if (!state || state.backfilledAt) return true;
    let from = state.cursorAt;
    if (!from) {
      const [first] = await db.$queryRaw<{ at: Date | null }[]>(Prisma.sql`
        SELECT MIN(created_at) AS at FROM execution_logs WHERE tenant_id = ${tenantId}`);
      from = first?.at ?? new Date();
    }
    const to = new Date(from.getTime() + SLICE_MS);
    await db.$executeRaw(Prisma.sql`
      SELECT dashboard_log_fact_put(s.l) FROM (
        SELECT l
          FROM execution_logs l
         WHERE l.tenant_id = ${tenantId}
           AND l.created_at >= ${from} AND l.created_at < ${to}
           AND (l.stage = 'handoff'
                OR (l.stage = 'tool' AND (l.detail->>'tool') IN ('handoff_to_human', 'skip_reply'))
                OR (l.stage = 'generate' AND (l.detail->>'trigger') = 'followup'))
           FOR KEY SHARE OF l) s`);
    // Every line from the migration on has its fact from the trigger, so the slices end at now.
    const done = to.getTime() > Date.now();
    await db.dashboardLogFactsState.update({
      where: { tenantId },
      data: { cursorAt: to, ...(done ? { backfilledAt: new Date() } : {}) },
    });
    return done;
  });
}

export async function logFactsBackfillHandler(
  job: ClaimedJob,
  base: PrismaClient,
  ctx?: JobContext,
): Promise<JobResult> {
  const stopAt = Date.now() + RUN_BUDGET_MS;
  while (Date.now() < stopAt && !ctx?.signal.aborted) {
    if (await backfillLogFactsSlice(base, job.tenantId)) {
      return { outcome: "done" };
    }
  }
  return { outcome: "reschedule", runAt: new Date() };
}

let registered = false;
export function registerLogFactsBackfillHandler(): void {
  if (registered) return;
  registerJobHandler("DASHBOARD_LOG_FACTS_BACKFILL", logFactsBackfillHandler);
  registered = true;
}

export async function ensureLogFactsBackfill(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "DASHBOARD_LOG_FACTS_BACKFILL",
    dedupeKey: DEDUPE_KEY,
    rearm: "same-work",
    runAt: new Date(),
    base,
  });
}

// Arms the backfill of every tenant still waiting for it (called once at boot). A finished tenant is
// not armed again; a tenant created after the facts never waits.
export async function ensureAllLogFactsBackfills(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const pending = await asSuperAdminOn(base, (db) =>
    db.dashboardLogFactsState.findMany({
      where: { backfilledAt: null },
      select: { tenantId: true },
    }),
  );
  // One tenant failing (deleted between the list and the write) must not leave the rest unarmed.
  for (const p of pending) {
    try {
      await ensureLogFactsBackfill(p.tenantId, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(p.tenantId), err },
        "dashboard log facts backfill arm failed for tenant; continuing",
      );
    }
  }
}
