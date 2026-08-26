import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";

// Retention sweep for the high-write execution_logs table (+ terminal alert_deliveries). One
// FLOWLOG_SWEEP job per tenant, armed at boot and self-rearming every 24h (a reschedule does NOT
// consume an attempt). Deletes run RLS-scoped to the job's tenant — no cross-tenant bypass needed —
// in bounded batches so a large backlog never holds a long transaction.

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const BATCH = 5000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function flowlogSweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const tenantId = job.tenantId;
  const cutoff = new Date(
    Date.now() - config.flowlog.retentionDays * 86_400_000,
  );
  await runScopedOn(base, sysCtx(tenantId), async (db) => {
    // Batched delete (RLS fences each statement to this tenant): loop until a short batch.
    while (true) {
      const deleted = await db.$executeRaw(Prisma.sql`
        DELETE FROM execution_logs
        WHERE id IN (
          SELECT id FROM execution_logs
          WHERE created_at < ${cutoff}
          LIMIT ${BATCH}
        )`);
      if (deleted < BATCH) break;
    }
    // Prune terminal alert deliveries (a row the worker will never touch again) past the cutoff.
    await db.$executeRaw(Prisma.sql`
      DELETE FROM alert_deliveries
      WHERE status IN ('DELIVERED', 'DEAD') AND created_at < ${cutoff}`);
  });
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
  };
}

let registered = false;
export function registerFlowlogRetentionHandler(): void {
  if (registered) return;
  registerJobHandler("FLOWLOG_SWEEP", flowlogSweepHandler);
  registered = true;
}

// Arms the per-tenant retention sweep (idempotent — enqueueJob upserts one live row per
// (tenant, kind, dedupeKey), re-arming run_at). First run is delayed a sweep interval out.
export async function ensureFlowlogSweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "FLOWLOG_SWEEP",
    dedupeKey: "flowlog-sweep",
    // NOTE: One perpetual row per tenant, same shape as the follow-up sweep: a completed pass
    // clears the budget (issue #287), and a boot re-arming it must not.
    rearm: "same-work",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
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
