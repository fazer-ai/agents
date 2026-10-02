import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { sanitizeErrorMessage } from "@/lib/redact";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { leadSourceScanDueAt, leadSourceScanKey } from "./scan-jobs";
import { runLeadSource } from "./sources";

// The recurring side of a lead source: `LeadSource.enabled` + `intervalMin` drive one perpetual
// scheduler row per source (`lead-source:<id>`), armed by the source's write paths and re-armed by
// every run of this handler, due when `lastRunAt + intervalMin` passes (or now, for a source that
// never ran). The shared tick claims it like every other shared-lane row, so a due scan is at most
// one SCHEDULER_WORKER_INTERVAL_MS late.
//
// The run itself is the same `runLeadSource` the manual POST /sources/:id/run calls: it records
// lastRunAt/lastStatus/lastError and audits `merchant_source.run`, so a scheduled scan is
// indistinguishable from a manual one on the row and in the trail.

const sysCtx = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

async function leadSourceScanHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const raw = (job.payload as { sourceId?: unknown } | null)?.sourceId;
  const sourceId = parseDbId(typeof raw === "string" ? raw : null);
  if (sourceId === null) return { outcome: "done" };
  const ctx = sysCtx(job.tenantId);
  const source = await runScopedOn(base, ctx, (db) =>
    db.leadSource.findUnique({
      where: { id: sourceId },
      select: { enabled: true, intervalMin: true, lastRunAt: true },
    }),
  );
  // Gone or switched off while the row waited: the scan ends with it. A disabled source is not
  // rescheduled; enabling it again re-arms the row from the update path.
  if (!source?.enabled) return { outcome: "done" };
  // The row's runAt was armed off a lastRunAt a manual /run may have moved since, so the due
  // question is re-asked against the row's CURRENT stamp: a scan that already ran inside the
  // interval is not run twice, the job just waits out the rest of it.
  const dueAt = leadSourceScanDueAt(source.lastRunAt, source.intervalMin);
  const now = Date.now();
  if (dueAt.getTime() > now) {
    return { outcome: "reschedule", runAt: dueAt };
  }
  try {
    const result = await runLeadSource(ctx, sourceId, {}, base);
    const lastRunAt = result.source.lastRunAt ?? new Date();
    return {
      outcome: "reschedule",
      // The interval and stamp are read back off the run's own write, so an intervalMin saved
      // while the scan was out lands on the next run rather than a stale read of this one.
      runAt: new Date(lastRunAt.getTime() + result.source.intervalMin * 60_000),
    };
  } catch (err) {
    // The failure is already the source's own bookkeeping (runLeadSource writes
    // lastStatus/lastError on its way out). The row is the schedule's, so it reschedules rather
    // than dead-lettering: a source left broken keeps its interval instead of silently losing the
    // loop, and one bad source never blocks another's row.
    logger.warn(
      {
        err: sanitizeErrorMessage(err),
        tenantId: String(job.tenantId),
        sourceId: String(sourceId),
      },
      "lead source scan: run failed, keeping the interval",
    );
    return {
      outcome: "reschedule",
      runAt: new Date(now + source.intervalMin * 60_000),
    };
  }
}

let registered = false;
export function registerLeadSourceScanHandler(): void {
  if (registered) return;
  registerJobHandler("LEAD_SOURCE_SCAN", leadSourceScanHandler);
  registered = true;
}

// Boot: every enabled source gets its perpetual row back, due when its interval since the last run
// ends (never run = due now). Never later than a row already pending: a boot that pushed the run
// one interval out would starve the scan on an app restarted more often than its interval, and
// would postpone a scan a save just armed. Best-effort per source, like the other boot re-arms.
export async function ensureAllLeadSourceScans(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const [sources, pending] = await asSuperAdminOn(base, (db) =>
    Promise.all([
      db.leadSource.findMany({
        where: { enabled: true },
        select: {
          id: true,
          tenantId: true,
          intervalMin: true,
          lastRunAt: true,
        },
      }),
      db.schedulerJob.findMany({
        where: { kind: "LEAD_SOURCE_SCAN", status: "PENDING" },
        select: { tenantId: true, dedupeKey: true, runAt: true },
      }),
    ]),
  );
  const pendingAt = new Map(
    pending.map((j) => [`${j.tenantId}:${j.dedupeKey}`, j.runAt.getTime()]),
  );
  const now = Date.now();
  for (const s of sources) {
    try {
      const key = `${s.tenantId}:${leadSourceScanKey(s.id)}`;
      await enqueueJob({
        tenantId: s.tenantId,
        kind: "LEAD_SOURCE_SCAN",
        dedupeKey: leadSourceScanKey(s.id),
        runAt: bootScanAt(s, pendingAt.get(key), now),
        rearm: "same-work",
        payload: { sourceId: String(s.id) },
        base,
      });
    } catch (err) {
      logger.warn(
        {
          err: sanitizeErrorMessage(err),
          sourceId: String(s.id),
        },
        "lead source scan: boot re-arm failed",
      );
    }
  }
}

// When a source's row is due after a boot: at lastRunAt + interval (now if that has passed or it
// never ran), or the pending row's time when that is sooner.
export function bootScanAt(
  source: { intervalMin: number; lastRunAt: Date | null },
  pendingAt: number | undefined,
  now: number,
): Date {
  const due = leadSourceScanDueAt(
    source.lastRunAt,
    source.intervalMin,
    now,
  ).getTime();
  return new Date(pendingAt === undefined ? due : Math.min(due, pendingAt));
}
