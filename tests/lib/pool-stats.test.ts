import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { Pool, type PoolClient } from "pg";
import {
  forgetPool,
  instrumentPool,
  LOCK_TIMEOUT_SQLSTATE,
  lockTimeoutsPerMinute,
  poolStats,
  recordLockTimeout,
  resetLockTimeouts,
} from "@/lib/pool-stats";
import { dbProbeFailed } from "@/tests/db-gate";

// A pool's queue and its lock timeouts, measured on real `pg` pools against the test database: the
// counts are `pg`'s own, and only when a waiter joined and which statements hit 55P03 are ours.

const url = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
if (url) {
  const probe = new Pool({ connectionString: url, max: 1 });
  try {
    await probe.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  } finally {
    await probe.end();
  }
}

const opened: Pool[] = [];
function pool(name: string, max: number): Pool {
  const p = instrumentPool(name, new Pool({ connectionString: url, max }));
  opened.push(p);
  return p;
}

afterEach(() => {
  forgetPool("t-queue");
  forgetPool("t-lock");
  forgetPool("t-lock-query");
  resetLockTimeouts();
});

afterAll(async () => {
  await Promise.all(opened.map((p) => p.end()));
});

describe("lock timeouts per minute", () => {
  test("count the last minute and forget older ones", () => {
    recordLockTimeout(1_000_000);
    recordLockTimeout(1_030_000);
    expect(lockTimeoutsPerMinute(1_050_000)).toBe(2);
    expect(lockTimeoutsPerMinute(1_075_000)).toBe(1);
    expect(lockTimeoutsPerMinute(1_100_000)).toBe(0);
  });
});

describe.skipIf(!dbUp)("a real pool", () => {
  test("a request queued behind a full pool is counted with its wait, and leaves when served (catches a saturated pool reported as idle)", async () => {
    const p = pool("t-queue", 1);
    const held = await p.connect();
    const of = () => poolStats().find((s) => s.name === "t-queue");
    expect(of()).toMatchObject({ inUse: 1, idle: 0, waiting: 0 });
    const asked = Date.now();
    const queued = p.connect();
    // `pg` puts the request on its queue synchronously when every client is out.
    expect(of()?.waiting).toBe(1);
    const late = poolStats(asked + 5_000).find((s) => s.name === "t-queue");
    expect(late?.oldestWaitMs).toBeGreaterThanOrEqual(4_900);
    held.release();
    const served = await queued;
    expect(of()).toMatchObject({ inUse: 1, waiting: 0, oldestWaitMs: 0 });
    served.release();
    expect(of()).toMatchObject({ inUse: 0, idle: 1, waiting: 0 });
  });

  test("a wait that was served stops counting, so the next one is timed from its own start (catches the oldest wait stuck on a request long gone)", async () => {
    const p = pool("t-queue", 1);
    const held = await p.connect();
    const firstAsked = Date.now();
    const first = p.connect();
    held.release();
    const served = await first;
    // The clock has to move past the first request for the two to be told apart.
    while (Date.now() <= firstAsked) {}
    const secondAsked = Date.now();
    const second = p.connect();
    const stat = poolStats(secondAsked).find((s) => s.name === "t-queue");
    expect(stat?.waiting).toBe(1);
    expect(stat?.oldestWaitMs).toBe(0);
    served.release();
    (await second).release();
  });

  test("a request queued behind one still opening a connection is timed from its own start (catches connection setup counted as queue time)", async () => {
    const p = pool("t-queue", 1);
    const openedAt = Date.now();
    const opening = p.connect();
    // The clock has to move past the opening request for the two to be told apart.
    while (Date.now() <= openedAt) {}
    const queuedAt = Date.now();
    const queued = p.connect();
    const stat = poolStats(queuedAt).find((s) => s.name === "t-queue");
    expect(stat?.waiting).toBe(1);
    expect(stat?.oldestWaitMs).toBe(0);
    (await opening).release();
    (await queued).release();
  });

  test("a second request racing the first for the one idle client is timed while it waits (catches a queued request reported with no wait)", async () => {
    const p = pool("t-queue", 1);
    (await p.connect()).release();
    const first = p.connect();
    const asked = Date.now();
    const second = p.connect();
    const held = await first;
    const stat = poolStats(asked + 5_000).find((s) => s.name === "t-queue");
    expect(stat?.waiting).toBe(1);
    expect(stat?.oldestWaitMs).toBeGreaterThanOrEqual(4_900);
    held.release();
    (await second).release();
  });

  test("a burst that queues behind an idle client while the pool still has room is timed (catches waiters reported with no wait during saturation)", async () => {
    const p = pool("t-queue", 2);
    (await p.connect()).release();
    const asked = Date.now();
    const burst = [p.connect(), p.connect(), p.connect()];
    // The first takes the idle client, the second a new connection, the third waits for either.
    const [a, b] = await Promise.all([burst[0], burst[1]]);
    const stat = poolStats(asked + 5_000).find((s) => s.name === "t-queue");
    expect(stat?.waiting).toBe(1);
    expect(stat?.oldestWaitMs).toBeGreaterThanOrEqual(4_900);
    a?.release();
    b?.release();
    (await burst[2])?.release();
  });

  test("a connect still opening a new connection, with room in the pool, is not a wait (catches connection setup reported as queueing)", async () => {
    const p = pool("t-queue", 2);
    const opening = p.connect();
    const of = (now: number) =>
      poolStats(now).find((s) => s.name === "t-queue");
    expect(of(Date.now() + 5_000)).toMatchObject({
      waiting: 0,
      oldestWaitMs: 0,
    });
    (await opening).release();
  });

  test("a statement that gives up on a lock is counted, through a client and through the pool, and still fails for its caller (catches 55P03 swallowed or missed)", async () => {
    const p = pool("t-lock", 3);
    await p.query(
      "CREATE TABLE IF NOT EXISTS pool_stats_lock_probe (id int primary key)",
    );
    const holder: PoolClient = await p.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "LOCK TABLE pool_stats_lock_probe IN ACCESS EXCLUSIVE MODE",
      );
      const waiter = await p.connect();
      try {
        await waiter.query("SET lock_timeout = 50");
        const failed = await waiter
          .query("SELECT * FROM pool_stats_lock_probe")
          .then(
            () => null,
            (e: { code?: string }) => e.code,
          );
        expect(failed).toBe(LOCK_TIMEOUT_SQLSTATE);
      } finally {
        waiter.release();
      }
      expect(lockTimeoutsPerMinute()).toBe(1);
      // pool.query hands its statement to a pooled client by callback: counted the same way. A pool
      // of its own, so the client is a new one and not one the promise path already watches.
      const viaPool = await pool("t-lock-query", 1)
        .query("SET lock_timeout = 50; SELECT * FROM pool_stats_lock_probe")
        .then(
          () => null,
          (e: { code?: string }) => e.code,
        );
      expect(viaPool).toBe(LOCK_TIMEOUT_SQLSTATE);
      expect(lockTimeoutsPerMinute()).toBe(2);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await p.query("DROP TABLE IF EXISTS pool_stats_lock_probe");
    }
  });
});
