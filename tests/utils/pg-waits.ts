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

type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

// Runs `act` while a superuser transaction holds a change to the row it is about to read, and
// commits that change only once `act` is parked behind it. An act that reads under the row's lock
// sees the committed change; one that reads first sees the value the change replaced, which is the
// difference an audit `before` or a guard re-read is asked about. Resolves with what `act` resolved.
export async function underConcurrentEdit<T>(
  su: PrismaClient,
  edit: (tx: Tx) => Promise<unknown>,
  act: () => Promise<T>,
): Promise<T> {
  let acting: Promise<T> | undefined;
  await su.$transaction(
    async (tx) => {
      await edit(tx);
      const [me] = await tx.$queryRaw<{ pid: number }[]>`
        SELECT pg_backend_pid() AS pid`;
      acting = act();
      acting.catch(() => {});
      if ((await waitUntilBlocked(su, me?.pid ?? -1, 1, 750)) < 0) {
        throw new Error("the act never waited on the edited row");
      }
    },
    { timeout: 30_000 },
  );
  return await (acting as Promise<T>);
}

const AUDIT_TRIGGER_FIXTURE_KEY = 546_999_999;

// Runs `body` holding the lock every test that puts a trigger on `audit_logs` takes, across processes.
// Trigger DDL queues behind any open insert on the table, and while queued it blocks every later
// insert: under `--parallel`, a file that parks a writer at its audit insert would see another file's
// CREATE or DROP TRIGGER stall audit writes that have nothing to do with either. The lock is held by
// a transaction of its own, so `body` keeps the rest of the pool.
export async function withAuditTriggerFixture<T>(
  db: PrismaClient,
  body: () => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const done = new Promise<void>((r) => {
    release = r;
  });
  let acquired!: () => void;
  const locked = new Promise<void>((r) => {
    acquired = r;
  });
  const holding = db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT pg_advisory_xact_lock(${AUDIT_TRIGGER_FIXTURE_KEY})`,
      );
      acquired();
      await done;
    },
    { maxWait: 30_000, timeout: 120_000 },
  );
  await Promise.race([locked, holding]);
  try {
    return await body();
  } finally {
    release();
    await holding;
  }
}
