import type { PrismaClient } from "@/../generated/prisma/client";

// An id for a `ClaimedJob` FIXTURE: a number `scheduler_jobs_id_seq` has already handed out and never
// will again, so no insert in any file, order or shard can land a row under it
// (tests/modules/claimed-job-fixture-ids.test.ts has the failure it prevents; the contract is
// asserted in tests/modules/scheduler.test.ts). One helper, so no file writes the query inline.
// Burned from the sequence rather than taken from a high constant: any constant is reachable by
// enough inserts, and `nextval` on the database the test writes to stays true as the suite grows.
// Call it once per fixture that needs its own id; two calls never collide.
export async function burnSchedulerJobId(db: PrismaClient): Promise<bigint> {
  const [row] = await db.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('scheduler_jobs_id_seq')`;
  if (!row) throw new Error("burnSchedulerJobId: nextval returned no row");
  return BigInt(row.nextval);
}
