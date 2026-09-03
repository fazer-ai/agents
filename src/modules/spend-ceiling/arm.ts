import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { cancelPendingJob, enqueueJob } from "@/modules/scheduler/service";
import { readSpendCeilingConfig } from "./settings";

// WHO KEEPS THE POLL ALIVE (issue #426). The month's cost is read from Langfuse by one
// `SPEND_CEILING_POLL` scheduler job per tenant, self-re-arming like the heartbeat, and this is the
// side that arms it: on every save of the ceiling block, and once at boot for every tenant whose
// ceiling is on, so a row lost to a reset is not a ceiling that quietly stops refreshing.
//
// Armed only while the ceiling is ON, because a poll is one Langfuse query per tenant per period
// preceded by a vault decryption, and a tenant that bounds nothing has no figure to keep fresh.
// A tenant with the ceiling on and no Langfuse IS armed: its poll writes the reason on the row,
// which is what the console shows, and the day Langfuse is configured the loop is already there.
//
// Kept apart from ./poll.ts so the settings service can import it without pulling the Langfuse
// side (and its own settings reader) into a cycle.

export const SPEND_POLL_DEDUPE_KEY = "spend-ceiling";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function ceilingEnabled(
  tenantId: bigint,
  base: PrismaClient,
): Promise<boolean> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    }),
  );
  return readSpendCeilingConfig(row?.settings ?? {}).enabled;
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

// Reconciles the per-tenant poll against the ceiling block. Best-effort: a failure here never
// blocks the settings write (the same discipline `syncTenantHeartbeat` follows).
export async function syncTenantSpendPoll(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  try {
    if (await ceilingEnabled(tenantId, base)) {
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

// Boot: every tenant whose ceiling is on. Per-tenant failures are logged and skipped, so one bad
// row cannot leave the rest of the fleet unarmed.
export async function ensureAllSpendPolls(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true, settings: true } }),
  );
  for (const t of tenants) {
    if (!readSpendCeilingConfig(t.settings).enabled) continue;
    try {
      await armSpendPoll(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "spend ceiling poll re-arm failed for tenant; continuing",
      );
    }
  }
}
