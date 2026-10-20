import { afterAll, describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import {
  CHECKPOINT_TABLES,
  deleteCheckpointThreads,
  deleteThreadsSql,
  SWEEP_PROBES,
  SWEEP_ROWS,
  SWEEP_START,
  SWEEP_THREADS,
  type SweepCursor,
  SweepDeadlineError,
  sweepCheckpointBatch,
  walkSql,
} from "@/graph/checkpoint-sweep";
import { getCheckpointPool } from "@/graph/checkpointer";
import { dbProbeFailed } from "@/tests/db-gate";

// The sweep that takes a teardown's checkpoints (src/graph/checkpoint-sweep.ts), against the real
// `langgraph` tables: rows seeded straight in SQL under thread ids of the shapes the runtime writes,
// beside neighbours whose ids share every character but a separator. The teardowns that call it are
// in tests/modules/checkpoint-teardown.test.ts.
const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let pool: Pool | undefined;
if (appUrl) {
  try {
    pool = await getCheckpointPool();
    await pool.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const cp = pool as Pool;

// Threads as the checkpointer writes them: a checkpoint, two blobs and a write each.
async function seedThreads(ids: string[]) {
  await cp.query(
    `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
     SELECT t, '', 'c1', '{}'::jsonb, '{}'::jsonb FROM unnest($1::text[]) t`,
    [ids],
  );
  await cp.query(
    `INSERT INTO langgraph.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
     SELECT t, '', ch, '1', 'json', convert_to(repeat('x', 200), 'UTF8')
       FROM unnest($1::text[]) t, unnest(ARRAY['messages', 'summary']) ch`,
    [ids],
  );
  await cp.query(
    `INSERT INTO langgraph.checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob)
     SELECT t, '', 'c1', 'task', 0, 'messages', 'json', convert_to('{}', 'UTF8') FROM unnest($1::text[]) t`,
    [ids],
  );
}

// How many of these threads still have rows, in each of the three tables.
async function left(ids: string[]) {
  const res = await cp.query<{ c: string; b: string; w: string }>(
    `SELECT (SELECT count(DISTINCT thread_id) FROM langgraph.checkpoints WHERE thread_id = ANY($1::text[])) AS c,
            (SELECT count(DISTINCT thread_id) FROM langgraph.checkpoint_blobs WHERE thread_id = ANY($1::text[])) AS b,
            (SELECT count(DISTINCT thread_id) FROM langgraph.checkpoint_writes WHERE thread_id = ANY($1::text[])) AS w`,
    [ids],
  );
  const r = res.rows[0];
  return {
    checkpoints: Number(r?.c),
    blobs: Number(r?.b),
    writes: Number(r?.w),
  };
}

const none = { checkpoints: 0, blobs: 0, writes: 0 };
const all = (n: number) => ({ checkpoints: n, blobs: n, writes: n });

function range(n: number, f: (i: number) => string): string[] {
  return Array.from({ length: n }, (_, i) => f(i));
}

describe.skipIf(!dbUp)("checkpoint sweep", () => {
  const seeded: string[] = [];
  async function seed(ids: string[]) {
    seeded.push(...ids);
    await seedThreads(ids);
  }

  afterAll(async () => {
    await deleteCheckpointThreads(cp, seeded);
  });

  // `1:1:` is a different account from `1:10:` and `1:1x`, and under en_US those sort among each
  // other: the sweep keeps exactly the prefix, byte for byte.
  test("a sweep takes the threads under its prefix and nothing that only resembles it", async () => {
    const base = `9${process.pid}`;
    const mine = [
      ...range(7, (i) => `${base}:1:${i}`),
      ...range(4, (i) => `${base}:1:ci:${i}`),
    ];
    const near = [
      ...range(5, (i) => `${base}:10:${i}`),
      ...range(3, (i) => `${base}1:1:${i}`),
      `${base}:playground:1:abc`,
    ];
    await seed([...mine, ...near]);

    // Small batches, so the cursor is crossed many times.
    let cursor: SweepCursor | null = SWEEP_START;
    let batches = 0;
    while (cursor !== null) {
      const r = await sweepCheckpointBatch(cp, `${base}:1:`, cursor, {
        probes: 50,
        threads: 2,
      });
      expect(r.deleted).toBeLessThanOrEqual(2);
      cursor = r.next;
      batches++;
    }

    expect(batches).toBeGreaterThanOrEqual(6);
    expect(await left(mine)).toEqual(none);
    expect(await left(near)).toEqual(all(near.length));
  });

  // A batch stops walking at the threads it deletes, and the next starts there: walking 2,000 ids to
  // keep 50 and starting over from the 50th walked the same ids again in every batch (40 times over
  // for a large account).
  test("the batches of one sweep never walk the same ids twice", async () => {
    const base = `7${process.pid}`;
    await seed([
      ...range(120, (i) => `${base}:2:${i}`),
      ...range(300, (i) => `${base}:3:${i}`),
    ]);
    let probed = 0;
    let batches = 0;
    let cursor: SweepCursor | null = SWEEP_START;
    while (cursor !== null) {
      const r = await sweepCheckpointBatch(cp, `${base}:2:`, cursor, {
        threads: 10,
      });
      probed += r.probed;
      batches++;
      cursor = r.next;
    }

    // Counted after, plus the ones it deleted from each table: other files write to these tables
    // meanwhile, and a thread they add can only make the bound looser.
    let total = 0;
    for (const t of CHECKPOINT_TABLES) {
      total +=
        120 +
        Number(
          (
            await cp.query<{ n: string }>(
              `SELECT count(DISTINCT thread_id) AS n FROM langgraph.${t}`,
            )
          ).rows[0]?.n,
        );
    }
    expect(batches).toBeGreaterThanOrEqual(12);
    // Each batch starts at the last id the one before it walked in its table, which it does not walk
    // again.
    expect(probed).toBeLessThanOrEqual(total);
  });

  // The teardown's lock is held by a transaction on another pool, which its budget can end mid-batch:
  // a batch that cannot confirm it still holds it, or is past its deadline, deletes nothing.
  test("a batch whose guard fails or whose deadline passed deletes nothing", async () => {
    const base = `5${process.pid}`;
    const ids = range(5, (i) => `${base}:1:${i}`);
    await seed(ids);

    await expect(
      sweepCheckpointBatch(cp, `${base}:1:`, SWEEP_START, {
        guard: {
          deadline: Date.now() + 60_000,
          beforeCommit: async () => {
            throw new Error("the guard is gone");
          },
        },
      }),
    ).rejects.toThrow("the guard is gone");
    expect(await left(ids)).toEqual(all(5));

    await expect(
      sweepCheckpointBatch(cp, `${base}:1:`, SWEEP_START, {
        guard: { deadline: Date.now() - 1, beforeCommit: async () => {} },
      }),
    ).rejects.toBeInstanceOf(SweepDeadlineError);
    expect(await left(ids)).toEqual(all(5));
  });

  // The deadline is absolute: a statement gets the time left until it, so a slow delete cannot hold
  // its rows past it.
  test("a batch's statement is cut at its deadline", async () => {
    const base = `4${process.pid}`;
    const ids = range(3, (i) => `${base}:1:${i}`);
    await seed(ids);
    const fn = `CREATE FUNCTION langgraph.test_1551_slow() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM old_rows WHERE thread_id LIKE '${base}:%') THEN
          PERFORM pg_sleep(2.5);
        END IF;
        RETURN NULL;
      END $$`;
    await cp.query(fn);
    for (const t of CHECKPOINT_TABLES) {
      await cp.query(
        `CREATE TRIGGER test_1551_slow AFTER DELETE ON langgraph.${t}
           REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION langgraph.test_1551_slow()`,
      );
    }
    const began = Date.now();
    try {
      await expect(
        sweepCheckpointBatch(cp, `${base}:1:`, SWEEP_START, {
          guard: { deadline: began + 1_500, beforeCommit: async () => {} },
        }),
      ).rejects.toThrow();
    } finally {
      for (const t of CHECKPOINT_TABLES) {
        await cp.query(
          `DROP TRIGGER IF EXISTS test_1551_slow ON langgraph.${t}`,
        );
      }
      await cp.query("DROP FUNCTION IF EXISTS langgraph.test_1551_slow()");
    }

    // Cut at the deadline (1.5 s), not after the delete (2.5 s).
    expect(Date.now() - began).toBeLessThan(2_300);
    expect(await left(ids)).toEqual(all(3));
  });

  // `bun --hot` keeps the holder across a reload, so a saver set up by code that had no registry is
  // still the one in use: its own pool is read instead of failing every teardown until a restart.
  test("the pool is found for a saver set up before the registry existed", async () => {
    const h = (globalThis as unknown as Record<symbol, { pools?: unknown }>)[
      Symbol.for("fazerai.langgraph.checkpointer")
    ];
    const pools = h?.pools;
    if (h) h.pools = undefined;
    try {
      const found = await getCheckpointPool();
      expect((await found.query("SELECT 1 AS one")).rows[0]).toEqual({
        one: 1,
      });
    } finally {
      if (h) h.pools = pools;
    }
  });

  // A thread keeps its checkpoint history, so one thread alone can outgrow a batch: each batch takes
  // a bounded number of rows from each table and the next one goes on from the same cursor.
  test("a thread with more rows than a batch takes goes over several batches", async () => {
    const base = `3${process.pid}`;
    const thread = `${base}:1:long`;
    await seed([thread]);
    await cp.query(
      `INSERT INTO langgraph.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
       SELECT $1, '', 'messages', g::text, 'json', convert_to('{}', 'UTF8') FROM generate_series(2, 31) g`,
      [thread],
    );

    let batches = 0;
    let cursor: SweepCursor | null = SWEEP_START;
    while (cursor !== null) {
      const r = await sweepCheckpointBatch(cp, `${base}:1:`, cursor, {
        rows: 10,
      });
      cursor = r.next;
      batches++;
    }

    expect(batches).toBeGreaterThanOrEqual(4);
    expect(await left([thread])).toEqual(none);
  });

  // A removal can stop between batches (the account reconnects) and the thread is read again from
  // its newest checkpoint: until that checkpoint goes, every blob and write it names stays.
  test("between any two batches a thread is either whole or has no checkpoint left", async () => {
    const base = `2${process.pid}`;
    const thread = `${base}:1:long`;
    await seed([thread]);
    await cp.query(
      `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
       SELECT $1, '', 'd' || lpad(g::text, 2, '0'), '{}'::jsonb, '{}'::jsonb FROM generate_series(1, 30) g`,
      [thread],
    );
    await cp.query(
      `INSERT INTO langgraph.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
       SELECT $1, '', 'messages', g::text, 'json', convert_to('{}', 'UTF8') FROM generate_series(2, 31) g`,
      [thread],
    );
    const whole = async () => {
      const r = await cp.query<{ newest: boolean; b: string; w: string }>(
        `SELECT EXISTS (SELECT 1 FROM langgraph.checkpoints WHERE thread_id = $1 AND checkpoint_id = 'd30') AS newest,
                (SELECT count(*) FROM langgraph.checkpoint_blobs WHERE thread_id = $1) AS b,
                (SELECT count(*) FROM langgraph.checkpoint_writes WHERE thread_id = $1) AS w`,
        [thread],
      );
      return r.rows[0];
    };

    let cursor: SweepCursor | null = SWEEP_START;
    let batches = 0;
    while (cursor !== null) {
      cursor = (
        await sweepCheckpointBatch(cp, `${base}:1:`, cursor, { rows: 7 })
      ).next;
      batches++;
      const now = await whole();
      if (now?.newest) {
        expect(Number(now.b)).toBe(32);
        expect(Number(now.w)).toBe(1);
      } else {
        const c = await cp.query(
          "SELECT 1 FROM langgraph.checkpoints WHERE thread_id = $1",
          [thread],
        );
        expect(c.rowCount).toBe(0);
      }
    }

    expect(batches).toBeGreaterThanOrEqual(6);
    expect(await left([thread])).toEqual(none);
  });

  // A thread with a long history: picking its oldest rows reads them in key order and stops at the
  // batch's bound, instead of reading and sorting all of them in every batch.
  test("a batch picks a long thread's oldest checkpoints without reading all of them", async () => {
    const base = `1${process.pid}`;
    const thread = `${base}:1:long`;
    seeded.push(thread);
    await cp.query(
      `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
       SELECT $1, '', lpad(g::text, 6, '0'), '{}'::jsonb, '{}'::jsonb FROM generate_series(1, 20000) g`,
      [thread],
    );
    await cp.query("ANALYZE langgraph.checkpoints");
    const plan = (
      await cp.query(`EXPLAIN ${deleteThreadsSql("checkpoints")}`, [
        [thread, `${base}:1:other`],
        SWEEP_ROWS,
      ])
    ).rows
      .map((r) => r["QUERY PLAN"])
      .join("\n");

    expect(plan).not.toContain("Sort");
    expect(plan).not.toContain("Seq Scan");
  });

  test("a prefix without its separator is refused", async () => {
    await expect(sweepCheckpointBatch(cp, "1:1")).rejects.toThrow();
  });

  // Each table is walked on its own; a thread that lost its blobs some other way still goes whole.
  test("a thread missing some of its rows is still found and deleted whole", async () => {
    const base = `8${process.pid}`;
    const ids = range(3, (i) => `${base}:4:${i}`);
    await seed(ids);
    await cp.query(
      "DELETE FROM langgraph.checkpoint_blobs WHERE thread_id = ANY($1::text[])",
      [ids],
    );

    // To the end of the key: other files share these tables, and their threads may sit before ours.
    let cursor: SweepCursor | null = SWEEP_START;
    while (cursor !== null) {
      cursor = (await sweepCheckpointBatch(cp, `${base}:4:`, cursor)).next;
    }

    expect(await left(ids)).toEqual(none);
  });

  // The tables hold millions of rows in production, under a collation in which the prefix itself
  // cannot be searched. Both statements a batch runs reach their rows through the primary key: a
  // scan per batch would outgrow the removal's budget.
  test("a batch walks and deletes through the primary key, never a table scan", async () => {
    const base = `6${process.pid}`;
    await seed(range(3_000, (i) => `${base}:${i % 5}:${i}`));
    // With statistics that know the rows are there: on a table the planner reads as a few pages, a
    // scan is the right plan, and it is not the production case.
    await cp.query(
      "ANALYZE langgraph.checkpoints, langgraph.checkpoint_blobs, langgraph.checkpoint_writes",
    );
    const plans = [
      ...(await Promise.all(
        CHECKPOINT_TABLES.map(
          async (t) =>
            (
              await cp.query(`EXPLAIN ${walkSql(t)}`, [
                "",
                SWEEP_PROBES,
                `${base}:1:`,
                SWEEP_THREADS,
              ])
            ).rows,
        ),
      )),
      ...(await Promise.all(
        CHECKPOINT_TABLES.map(
          async (t) =>
            (
              await cp.query(`EXPLAIN ${deleteThreadsSql(t)}`, [
                [`${base}:1:1`, `${base}:1:6`],
                SWEEP_ROWS,
              ])
            ).rows,
        ),
      )),
    ].map((rows) => rows.map((r) => r["QUERY PLAN"]).join("\n"));

    for (const plan of plans) {
      expect(plan).not.toContain("Seq Scan");
      expect(plan).toMatch(/Index|Bitmap/);
    }
  });
});
