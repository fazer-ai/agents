import type { PrismaClient } from "@/../generated/prisma/client";

// An id for a `ClaimedJob` FIXTURE: a number `scheduler_jobs_id_seq` has already handed out and will
// never hand out again, so no insert in any file, in any order, on any shard, can land a row under
// it. `tests/modules/claimed-job-fixture-ids.test.ts` carries the failure this exists to prevent and
// the measurement behind it; the contract asserted here is in tests/modules/scheduler.test.ts.
//
// It lives here rather than in each file because #498 fixed the one file that had already broken by
// writing this query inline, and a recipe spelled out per file is one the next file gets written
// without, which is how every other literal in the tree got there in the first place.
//
// Burned from the sequence rather than taken from a high constant: any constant is reachable by
// enough inserts, and "enough" is a number nobody re-checks. `nextval` on the same database the test
// writes to is the only answer that stays true as the suite grows. Call it once per fixture that
// needs its own id; two calls never collide.
export async function burnSchedulerJobId(db: PrismaClient): Promise<bigint> {
  const [row] = await db.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('scheduler_jobs_id_seq')`;
  if (!row) throw new Error("burnSchedulerJobId: nextval returned no row");
  return BigInt(row.nextval);
}
