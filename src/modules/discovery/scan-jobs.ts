import type { ScopedDb } from "@/lib/tenancy";
import { upsertJobRow } from "@/modules/scheduler/service";

// The scheduler-row half of a lead source's recurring scan: `LeadSource.enabled` +
// `intervalMin` drive one perpetual `LEAD_SOURCE_SCAN` row per source, armed by the
// source's write paths inside their own transaction (./sources.ts) and re-armed by
// the handler's reschedule (./schedule.ts). A source that committed without its row
// would be enabled and never scanned, with nothing but a restart to notice.

// One live scheduler row per source; the dedupe key names the source, so a re-arm
// reuses the row instead of stacking another schedule on it.
export function leadSourceScanKey(sourceId: bigint): string {
  return `lead-source:${sourceId}`;
}

// When the source is next due: `lastRunAt + intervalMin`, or `now` when it never
// ran - a never-run source is due. `now` is a parameter so the arming path and
// the handler's due re-check share the one computation.
export function leadSourceScanDueAt(
  lastRunAt: Date | null,
  intervalMin: number,
  now: number = Date.now(),
): Date {
  return lastRunAt === null
    ? new Date(now)
    : new Date(lastRunAt.getTime() + intervalMin * 60_000);
}

// Arms the source's scan row, INSIDE the caller's transaction (the same reason
// armSourceSync lives on the write path in ../rag/source.ts). `new-work`: the
// caller is an operator's act - a create, an enable, an interval change - which
// starts a fresh failure budget like any other save does.
export async function armLeadSourceScan(
  db: ScopedDb,
  tenantId: bigint,
  sourceId: bigint,
  runAt: Date,
): Promise<void> {
  await upsertJobRow(db, {
    tenantId,
    kind: "LEAD_SOURCE_SCAN",
    dedupeKey: leadSourceScanKey(sourceId),
    runAt,
    rearm: "new-work",
    payload: { sourceId: String(sourceId) },
  });
}

// Retires the source's waiting row, inside the caller's transaction: a source
// re-enabled right after this commits arms under the same key, and a cancel
// running later would mark that arm DONE and leave it enabled and never
// scanned. A row already claimed finds the source disabled or gone and stops.
export async function cancelLeadSourceScanOn(
  db: ScopedDb,
  sourceId: bigint,
): Promise<void> {
  await db.schedulerJob.updateMany({
    where: {
      kind: "LEAD_SOURCE_SCAN",
      dedupeKey: leadSourceScanKey(sourceId),
      status: "PENDING",
    },
    data: { status: "DONE" },
  });
}
