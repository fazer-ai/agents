import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { withEntityLock } from "@/lib/locks";
import { asSuperAdminOn, runScopedOn, type ScopedDb } from "@/lib/tenancy";
import { upsertJobRow } from "@/modules/scheduler/service";
import { sysCtx } from "./config";
import { readMonitorConfig } from "./settings";

// Arms each monitor's `OCCURRENCE_ROUND` job while the monitor is ON: on every save of its block and
// at boot, so a lost row does not leave a monitor that stopped running without anyone switching it
// off. Off, there is no row at all, which is what keeps a switched-off monitor from spending a model.
// One row per monitor, each on its own cadence.

export const monitorRoundDedupeKey = (monitorId: bigint) =>
  `occurrences:${monitorId}`;

// The monitor a job runs, from its payload; null on a row armed before there were several monitors,
// which the migration rekeys (prisma/migrations/*_occurrence_monitors).
export function jobMonitorId(payload: Record<string, unknown>): bigint | null {
  return typeof payload.monitorId === "string"
    ? parseDbId(payload.monitorId)
    : null;
}

// Inside the caller's transaction: the reconcile below holds a lock on it, and a second connection
// from the same pool could be the one it is waiting for.
async function armRound(
  db: ScopedDb,
  tenantId: bigint,
  monitorId: bigint,
): Promise<void> {
  await upsertJobRow(db, {
    tenantId,
    kind: "OCCURRENCE_ROUND",
    dedupeKey: monitorRoundDedupeKey(monitorId),
    payload: { monitorId: String(monitorId) },
    // One perpetual row per monitor: a re-arm is the same work.
    rearm: "same-work",
    // Due now: the admin who just switched it on is waiting for the first round.
    runAt: new Date(),
  });
}

export async function cancelMonitorRound(
  db: ScopedDb,
  monitorId: bigint,
): Promise<void> {
  await db.schedulerJob.updateMany({
    where: {
      kind: "OCCURRENCE_ROUND",
      dedupeKey: monitorRoundDedupeKey(monitorId),
      status: "PENDING",
    },
    data: { status: "DONE" },
  });
}

// Reconciles the monitor's job against its block. Best-effort: a failure here never blocks the write.
// One reconcile at a time per monitor, each reading the block only once it holds the lock, so the last
// one to run reads the last save: an older save's decision can never cancel a newer one's job. A
// deleted monitor has no job. `afterRead` is a test seam, run between the read and the job write.
export async function syncMonitorRound(
  tenantId: bigint,
  monitorId: bigint,
  base: PrismaClient = basePrisma,
  afterRead?: () => Promise<void>,
): Promise<void> {
  try {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      withEntityLock(db, `occurrence-round:${monitorId}`, async () => {
        const row = await db.occurrenceMonitor.findFirst({
          where: { id: monitorId, tenantId },
          select: { config: true },
        });
        const enabled = row ? readMonitorConfig(row.config).enabled : false;
        await afterRead?.();
        if (enabled) await armRound(db, tenantId, monitorId);
        else await cancelMonitorRound(db, monitorId);
      }),
    );
  } catch (err) {
    logger.warn(
      { err, tenantId: String(tenantId), monitorId: String(monitorId) },
      "failed to sync the occurrence round job",
    );
  }
}

// Boot: every monitor that is on. One bad row is logged and skipped.
export async function ensureAllOccurrenceRounds(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const monitors = await asSuperAdminOn(base, (db) =>
    db.occurrenceMonitor.findMany({
      select: { id: true, tenantId: true, config: true },
    }),
  );
  for (const m of monitors) {
    try {
      if (!readMonitorConfig(m.config).enabled) continue;
      await runScopedOn(base, sysCtx(m.tenantId), (db) =>
        armRound(db, m.tenantId, m.id),
      );
    } catch (err) {
      logger.warn(
        { tenantId: String(m.tenantId), monitorId: String(m.id), err },
        "occurrence round re-arm failed for monitor; continuing",
      );
    }
  }
}
