import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";

// EMPTYING `execution_logs` IN A TEST, WITHOUT THE PREVIOUS CASE'S WRITE LANDING AFTERWARDS.
// `emitFlowEvent` returns before its row exists, so after a plain DELETE a write the previous case
// only scheduled lands in the table the current case believes it owns, and a reader ordered by
// `id asc` gets it FIRST. One helper rather than a settle at each clear site: an obligation spelled
// out per site is one a new site is written without, and tests/modules/flowlog-reader-scope.test.ts
// fails on a clear that goes around this. It matters in teardown too: a row landing between the
// clear and the tenant delete breaks that delete on a foreign key.
export async function clearFlowLog(
  db: PrismaClient,
  where: Prisma.ExecutionLogWhereInput,
): Promise<void> {
  await settleFlowEvents();
  await db.executionLog.deleteMany({ where });
}

// READING `execution_logs` IN A TEST, WITHOUT ANSWERING BEFORE THE ROW LANDS: the WAIT obligation,
// the third of three named in tests/modules/flowlog-reader-scope.test.ts, checkable because the wait
// has ONE SPELLING. A settle rather than a poll: a poll answers PRESENCE but not ABSENCE, where it
// spends the whole deadline and reports its first read, and a raw read passes BECAUSE the write has
// not landed, so "nothing was logged" is green for the wrong reason. The args pass through on
// purpose: the SCOPE guard reads the `where` keys off the call site, and swallowing them blinds it.
export async function flowLogRows(
  db: PrismaClient,
  args: Prisma.ExecutionLogFindManyArgs,
) {
  await settleFlowEvents();
  return db.executionLog.findMany(args);
}

export async function flowLogRow(
  db: PrismaClient,
  args: Prisma.ExecutionLogFindFirstArgs,
) {
  await settleFlowEvents();
  return db.executionLog.findFirst(args);
}

export async function flowLogCount(
  db: PrismaClient,
  args: Prisma.ExecutionLogCountArgs,
) {
  await settleFlowEvents();
  return db.executionLog.count(args);
}
