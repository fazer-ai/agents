import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";

// EMPTYING `execution_logs` IN A TEST, WITHOUT THE PREVIOUS CASE'S WRITE LANDING AFTERWARDS (#375).
//
// `emitFlowEvent` returns before its row exists, so a plain DELETE empties the table of the rows that
// EXIST and nothing more. A write the previous case only scheduled lands into the table the current
// case believes it owns, and a reader ordered by `id asc` is handed that row FIRST — which is how a
// case asserting what a requeue logged came to read a neighbouring case's death line instead.
//
// One helper rather than a `settleFlowEvents()` above each of the two dozen clear sites: the settle
// is not optional at any of them, and an obligation spelled out per site is one a new site is written
// without. tests/modules/flowlog-reader-scope.test.ts fails on a clear that goes around this.
//
// It matters in teardown too, and not only between cases: a row landing after `afterAll` cleared the
// table but before it deletes the tenant takes the tenant delete down with it, on a foreign key.
export async function clearFlowLog(
  db: PrismaClient,
  where: Prisma.ExecutionLogWhereInput,
): Promise<void> {
  await settleFlowEvents();
  await db.executionLog.deleteMany({ where });
}
