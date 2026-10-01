import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { resolveLangfuseConfig } from "@/graph/observability";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { cancelPendingJob, enqueueJob } from "@/modules/scheduler/service";
import { readSpendCeilingConfig } from "./settings";

// Arms the per-tenant `SPEND_CEILING_POLL` job: on every save of the ceiling or Langfuse block, and at
// boot, so a lost row does not leave a figure that stops refreshing. Armed while the ceiling is ON (a
// tenant with no Langfuse IS armed, and its poll writes the reason on the row) and, with the ceiling
// off, while Langfuse is configured, so the console always has the month's cost. Kept apart from
// ./poll.ts so the settings service imports it without a cycle.

export const SPEND_POLL_DEDUPE_KEY = "spend-ceiling";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function wantsSpendPoll(
  tenantId: bigint,
  base: PrismaClient,
): Promise<boolean> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const row = await db.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    if (readSpendCeilingConfig(row?.settings ?? {}).enabled) return true;
    return (await resolveLangfuseConfig(db, tenantId)) !== null;
  });
}

// Idempotent: `enqueueJob` upserts on (tenant, kind, dedupeKey), so the second save keeps exactly
// one row. Due NOW, not one period from now: the operator who just switched the ceiling on is
// looking at a bar that reads zero until the first poll lands.
async function armSpendPoll(
  tenantId: bigint,
  base: PrismaClient,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "SPEND_CEILING_POLL",
    dedupeKey: SPEND_POLL_DEDUPE_KEY,
    // One perpetual row per tenant: a re-arm is the same work, and a poll that keeps failing must
    // not be handed five fresh attempts each time the ceiling is saved. The handler never throws
    // anyway (../spend-ceiling/poll.ts), so the count is moot in practice.
    rearm: "same-work",
    runAt: new Date(),
    base,
  });
}

// Reconciles the per-tenant poll against the ceiling and Langfuse blocks. Best-effort: a failure here never
// blocks the settings write (the same discipline `syncTenantHeartbeat` follows).
export async function syncTenantSpendPoll(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  try {
    if (await wantsSpendPoll(tenantId, base)) {
      await armSpendPoll(tenantId, base);
    } else {
      await cancelPendingJob(
        tenantId,
        "SPEND_CEILING_POLL",
        SPEND_POLL_DEDUPE_KEY,
        base,
      );
    }
  } catch (err) {
    logger.warn(
      { err, tenantId: String(tenantId) },
      "failed to sync the spend ceiling poll job",
    );
  }
}

// Boot: every tenant that wants the poll. Per-tenant failures are logged and skipped, so one bad row
// cannot leave the rest of the fleet unarmed.
export async function ensureAllSpendPolls(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  for (const t of tenants) {
    try {
      if (!(await wantsSpendPoll(t.id, base))) continue;
      await armSpendPoll(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "spend ceiling poll re-arm failed for tenant; continuing",
      );
    }
  }
}
