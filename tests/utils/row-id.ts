import type { PrismaClient } from "@/../generated/prisma/client";

// An id that names no row of `table`, now or later: a number its `id` sequence has already handed out
// and never will again. A test that asserts "this id does not exist" needs one, and a literal cannot
// be it: CI provisions a fresh database per shard, so the sequence starts low and the rows the same
// describe seeds can land on `42`. Burned rather than a high constant, for the reason
// `burnSchedulerJobId` (tests/utils/scheduler.ts) gives. Needs a role that may call `nextval`
// on the sequence: the superuser client the test seeds with.
export async function burnRowId(
  db: PrismaClient,
  table: string,
): Promise<bigint> {
  const [row] = await db.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval(pg_get_serial_sequence(${table}, 'id'))`;
  if (row?.nextval == null)
    throw new Error(`burnRowId: ${table} has no id sequence`);
  return BigInt(row.nextval);
}
