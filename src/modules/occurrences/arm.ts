import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { asSuperAdminOn, runScopedOn, type ScopedDb } from "@/lib/tenancy";
import { upsertJobRow } from "@/modules/scheduler/service";
import { readTenantOccurrences, sysCtx } from "./config";
import { readOccurrencesConfig } from "./settings";

// Arms the per-account `OCCURRENCE_ROUND` job while the monitor is ON: on every save of the block and
// at boot, so a lost row does not leave a monitor that stopped running without anyone switching it
// off. Off, there is no row at all, which is what keeps a switched-off monitor from spending a model.

export const OCCURRENCE_ROUND_DEDUPE_KEY = "occurrences";

// Inside the caller's transaction: the reconcile below holds a lock on it, and a second connection
// from the same pool could be the one it is waiting for.
async function armRound(db: ScopedDb, tenantId: bigint): Promise<void> {
  await upsertJobRow(db, {
    tenantId,
    kind: "OCCURRENCE_ROUND",
    dedupeKey: OCCURRENCE_ROUND_DEDUPE_KEY,
    // One perpetual row per account: a re-arm is the same work.
    rearm: "same-work",
    // Due now: the admin who just switched it on is waiting for the first round.
    runAt: new Date(),
  });
}

async function cancelRound(db: ScopedDb): Promise<void> {
  await db.schedulerJob.updateMany({
    where: {
      kind: "OCCURRENCE_ROUND",
      dedupeKey: OCCURRENCE_ROUND_DEDUPE_KEY,
      status: "PENDING",
    },
    data: { status: "DONE" },
  });
}

// Reconciles the job against the block. Best-effort: a failure here never blocks the settings write.
// One reconcile at a time per account, each reading the block only once it holds the lock, so the
// last one to run reads the last save: an older save's decision can never cancel a newer one's job.
// `afterRead` is a test seam, run between the read and the job write.
export async function syncTenantOccurrenceRound(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
  afterRead?: () => Promise<void>,
): Promise<void> {
  try {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      withEntityLock(db, `occurrence-round:${tenantId}`, async () => {
        const row = await db.tenant.findUnique({
          where: { id: tenantId },
          select: { settings: true },
        });
        const enabled = readOccurrencesConfig(row?.settings ?? {}).enabled;
        await afterRead?.();
        if (enabled) await armRound(db, tenantId);
        else await cancelRound(db);
      }),
    );
  } catch (err) {
    logger.warn(
      { err, tenantId: String(tenantId) },
      "failed to sync the occurrence round job",
    );
  }
}

// Boot: every account whose monitor is on. One bad row is logged and skipped.
export async function ensureAllOccurrenceRounds(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  for (const t of tenants) {
    try {
      if (!(await readTenantOccurrences(t.id, base)).enabled) continue;
      await runScopedOn(base, sysCtx(t.id), (db) => armRound(db, t.id));
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "occurrence round re-arm failed for tenant; continuing",
      );
    }
  }
}
