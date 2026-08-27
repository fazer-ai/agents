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

// READING `execution_logs` IN A TEST, WITHOUT ANSWERING BEFORE THE ROW LANDS (#419).
//
// The WAIT obligation, and the third of the three named in tests/modules/flowlog-reader-scope.test.ts.
// That file guards SCOPE and CLEAR and says this one "cannot be read off the source", because "is
// there a wait" is a question about control flow. That was true of the wait it had: a poll loop,
// which is a shape rather than a name. It stops being true once the wait has ONE SPELLING, which is
// the same move that made CLEAR checkable, and the argument for making it is that the comments the
// obligation was left to failed in the field. `chatwoot-command-dropped.test.ts` polls for the
// `command` row and reads the `route` row raw, three lines apart, and the raw one turned the CI red
// on a branch that touches no server file.
//
// A settle rather than a poll, and the difference is not only that it is faster and exact:
//
//   PRESENCE  a poll answers correctly, spending 50ms increments until the row shows up.
//   ABSENCE   a poll cannot answer at all: it spends the whole deadline and then reports the empty
//             read it started with. A raw read is worse: it passes BECAUSE the write has not landed,
//             so a test asserting "nothing was logged" is green for the reason that would make it
//             wrong. Settling is the only form that answers this one, and roughly a third of the
//             readers in the tree assert an absence.
//
// The args pass through rather than being wrapped away, and that is deliberate: the SCOPE guard
// reads the `where` keys off the call site, so a helper that swallowed them would buy this
// obligation by blinding the one already in place.
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
