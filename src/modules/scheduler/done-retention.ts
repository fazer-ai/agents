import { Prisma } from "@/../generated/prisma/client";
import { JOB_DONE_RETENTION_MS } from "@/modules/scheduler/lanes";
import type { SchedulerJobKind } from "@/modules/scheduler/service";

// The DONE rows the retention pass deletes (src/modules/flowlog/retention.ts), as one predicate: past
// their kind's window in JOB_DONE_RETENTION_MS, and with no failure budget left on them. A row that
// still counts attempts was retired mid-budget, and a `same-work` arm carries those attempts into the
// next run; deleted, the next arm would start the budget over. A kind kept for good is never named.
export function expiredDoneJobs(now: Date): Prisma.Sql {
  const byWindow = new Map<number, SchedulerJobKind[]>();
  for (const [kind, ms] of Object.entries(JOB_DONE_RETENTION_MS) as [
    SchedulerJobKind,
    number | null,
  ][]) {
    if (ms === null) continue;
    byWindow.set(ms, [...(byWindow.get(ms) ?? []), kind]);
  }
  const windows = [...byWindow].map(
    ([ms, kinds]) =>
      Prisma.sql`(kind IN (${Prisma.join(kinds)}) AND updated_at < ${new Date(now.getTime() - ms)})`,
  );
  return Prisma.sql`status = 'DONE' AND attempts = 0 AND (${Prisma.join(windows, " OR ")})`;
}
