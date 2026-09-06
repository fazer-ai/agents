import type { PrismaClient } from "@/../generated/prisma/client";

// How many backends are parked behind `pid`, DIRECTLY or through another waiter.
//
// The chain is the point. Counting only direct blockers is what makes a rendezvous lie the moment the
// writers under test start queueing on the SAME lock: Postgres then reports the second one as blocked
// by the first WRITER and not by the holder, so a direct count sees one waiter forever and the test
// dies by timeout looking like the fix broke something.
export async function blockedByChain(
  db: PrismaClient,
  pid: number,
): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ n: bigint }>>`
    WITH RECURSIVE waiting AS (
      SELECT a.pid, unnest(pg_blocking_pids(a.pid)) AS blocker
        FROM pg_stat_activity a
       WHERE cardinality(pg_blocking_pids(a.pid)) > 0
    ),
    chain AS (
      SELECT pid FROM waiting WHERE blocker = ${pid}
      UNION
      SELECT w.pid FROM waiting w JOIN chain c ON w.blocker = c.pid
    )
    SELECT count(*)::bigint AS n FROM chain`;
  return Number(row?.n ?? 0n);
}

// Waits until at least `n` backends are parked behind `pid`, and answers with the iteration it
// happened on — never with a bare boolean, so a caller can assert the rendezvous FIRED rather than
// fall through its own timeout and measure whatever order the delay produced. -1 means it never did.
export async function waitUntilBlocked(
  db: PrismaClient,
  pid: number,
  n: number,
  iterations = 300,
): Promise<number> {
  for (let i = 0; i < iterations; i += 1) {
    if ((await blockedByChain(db, pid)) >= n) return i;
    await new Promise((r) => setTimeout(r, 20));
  }
  return -1;
}
