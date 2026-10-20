import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import {
  type LockConnection,
  LockConnectionTimeout,
  NEWEST_CHECKPOINT_SQL,
  reconcileCheckpointBatch,
  reconcileCheckpoints,
  reconcileWalkSql,
  threadOwner,
  withinGrace,
} from "@/graph/checkpoint-reconcile";
import {
  CHECKPOINT_TABLES,
  deleteCheckpointThreads,
  SWEEP_START,
  type SweepCursor,
} from "@/graph/checkpoint-sweep";
import { getCheckpointPool } from "@/graph/checkpointer";
import { currentPoolClass } from "@/lib/pool-class";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE CHECKPOINTS OF A THREAD WHOSE OWNER IS GONE ARE DELETED BY A PERIODIC PASS. The
// rows are seeded straight in SQL under thread ids of the shapes the runtime writes, with the age the
// pass reads (the newest checkpoint's `ts`), beside live threads that share every character but the
// owner. Every pass here is scoped to this file's tenants: the walk covers the whole key, and other
// files' threads have owners this file did not seed.
const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
let pool: Pool | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    pool = await getCheckpointPool();
    await pool.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
// The runtime role: the owners are read through it, as the fleet, the way the app reads them.
const appDb = app as PrismaClient;
const cp = pool as Pool;

const HOUR = 60 * 60 * 1000;

// Threads as the checkpointer writes them, a checkpoint, two blobs and a write each, the checkpoint
// stamped `ago` milliseconds back.
async function seedThreads(ids: string[], ago = 2 * HOUR) {
  const ts = new Date(Date.now() - ago).toISOString();
  await cp.query(
    `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
     SELECT t, '', 'c1', jsonb_build_object('ts', $2::text), '{}'::jsonb FROM unnest($1::text[]) t`,
    [ids, ts],
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

describe("whose thread it is, read from its id", () => {
  test("an account thread names its instance exactly, in both of its shapes", () => {
    expect(threadOwner("1:1:ci:5")).toEqual({
      kind: "account",
      tenantId: 1n,
      instanceId: 1n,
    });
    expect(threadOwner("1:10:5")).toEqual({
      kind: "account",
      tenantId: 1n,
      instanceId: 10n,
    });
  });

  test("detached threads name their agent or are their own row", () => {
    expect(threadOwner("3:playground:8:abc")).toEqual({
      kind: "playground",
      tenantId: 3n,
      agentId: 8n,
    });
    expect(threadOwner("3:client:8:abc")).toEqual({
      kind: "client",
      tenantId: 3n,
      threadId: "3:client:8:abc",
    });
  });

  test("a shape it does not know goes only with its tenant, and an id with no tenant never goes", () => {
    expect(threadOwner("4:something:else")).toEqual({
      kind: "other",
      tenantId: 4n,
    });
    expect(threadOwner("4:1:ci")).toEqual({ kind: "other", tenantId: 4n });
    expect(threadOwner("x:1:2")).toBeNull();
    expect(threadOwner("")).toBeNull();
  });
});

describe("the grace, read from a checkpoint's ts", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  test("a timestamp older than the grace is not protected, a younger one is", () => {
    expect(withinGrace("2026-10-20T10:00:00.000Z", HOUR, now)).toBe(false);
    expect(withinGrace("2026-10-20T11:30:00.000Z", HOUR, now)).toBe(true);
  });

  test("an age that does not read as a timestamp is protected", () => {
    expect(withinGrace(null, HOUR, now)).toBe(true);
    expect(withinGrace("not a date", HOUR, now)).toBe(true);
    expect(withinGrace("2026-99-01T00:00:00Z", HOUR, now)).toBe(true);
    expect(withinGrace("2026-02-31T00:00:00Z", HOUR, now)).toBe(true);
  });
});

describe.skipIf(!dbUp)("the checkpoint reconciler", () => {
  let tenantId = 0n;
  let otherTenantId = 0n;
  // A tenant id no row has, above every one this database has handed out.
  let goneTenant = 0n;
  const seeded: string[] = [];
  async function seed(ids: string[], ago?: number) {
    seeded.push(...ids);
    await seedThreads(ids, ago);
  }
  const mine = (id: string) =>
    [tenantId, otherTenantId, goneTenant].some((t) => id.startsWith(`${t}:`));
  const pass = (opts: Parameters<typeof reconcileCheckpoints>[1] = {}) =>
    reconcileCheckpoints(cp, { pauseMs: 0, scope: mine, base: appDb, ...opts });

  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Reconcile", slug: `cp-reconcile-${process.pid}` },
      })
    ).id;
    otherTenantId = (
      await suDb.tenant.create({
        data: {
          name: "Reconcile other",
          slug: `cp-reconcile-o-${process.pid}`,
        },
      })
    ).id;
    goneTenant = otherTenantId + 1_000_000n + BigInt(process.pid);
  });

  afterAll(async () => {
    await deleteCheckpointThreads(cp, seeded);
    await suDb.$executeRaw`DELETE FROM tenants WHERE id IN (${tenantId}, ${otherTenantId})`;
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  async function account(accountId: number, tenant = tenantId) {
    return seedChatwootInstance(suDb, {
      tenantId: tenant,
      accountId,
      accountName: `Account ${accountId}`,
      baseUrl:
        tenant === tenantId
          ? "https://chat.cp-reconcile.example.com"
          : "https://chat.cp-reconcile-o.example.com",
      adminToken: encryptJson("ADMIN"),
    });
  }

  async function agent(name: string) {
    return suDb.agent.create({
      data: {
        tenantId,
        name,
        systemPrompt: "Be helpful.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
  }

  test("a removed account's threads go, and a live account's stay", async () => {
    const gone = await account(15591);
    const live = await account(15592);
    await suDb.chatwootInstance.delete({ where: { id: gone.id } });
    const goneIds = [
      `${tenantId}:${gone.id}:42`,
      `${tenantId}:${gone.id}:ci:7`,
    ];
    const liveIds = [
      `${tenantId}:${live.id}:42`,
      `${tenantId}:${live.id}:ci:7`,
    ];
    await seed([...goneIds, ...liveIds]);

    expect(await pass()).not.toBeNull();

    expect(await left(goneIds)).toEqual(none);
    expect(await left(liveIds)).toEqual(all(2));
  }, 60_000);

  test("an account of the same id in another tenant does not keep the thread", async () => {
    const theirs = await account(15593, otherTenantId);
    const stray = `${tenantId}:${theirs.id}:ci:1`;
    const owned = `${otherTenantId}:${theirs.id}:ci:1`;
    await seed([stray, owned]);

    await pass();

    expect(await left([stray])).toEqual(none);
    expect(await left([owned])).toEqual(all(1));
  }, 60_000);

  test("every thread of a tenant that no longer exists goes, whatever its shape", async () => {
    const live = await account(15594);
    const keeper = await agent("Keeper");
    const goneIds = [
      `${goneTenant}:9:ci:1`,
      `${goneTenant}:9:5`,
      `${goneTenant}:playground:9:abc`,
      `${goneTenant}:client:9:abc`,
      `${goneTenant}:something:else`,
    ];
    const liveIds = [
      `${tenantId}:${live.id}:ci:1`,
      `${tenantId}:playground:${keeper.id}:abc`,
      `${tenantId}:something:else`,
    ];
    await seed([...goneIds, ...liveIds]);

    await pass();

    expect(await left(goneIds)).toEqual(none);
    expect(await left(liveIds)).toEqual(all(3));
  }, 60_000);

  test("a deleted agent's playground threads go, and a live agent's stay", async () => {
    const keeper = await agent("Kept");
    const doomed = await agent("Deleted");
    await suDb.agent.delete({ where: { id: doomed.id } });
    const goneIds = [`${tenantId}:playground:${doomed.id}:a`];
    const liveIds = [`${tenantId}:playground:${keeper.id}:b`];
    await seed([...goneIds, ...liveIds]);

    await pass();

    expect(await left(goneIds)).toEqual(none);
    expect(await left(liveIds)).toEqual(all(1));
  }, 60_000);

  test("a client thread goes with its detached_threads row, and stays while the row does", async () => {
    const owner = await agent("Client owner");
    const kept = `${tenantId}:client:${owner.id}:with-row`;
    const stray = `${tenantId}:client:${owner.id}:no-row`;
    await suDb.detachedThread.create({
      data: { threadId: kept, tenantId, agentId: owner.id, kind: "client" },
    });
    await seed([kept, stray]);

    await pass();

    expect(await left([stray])).toEqual(none);
    expect(await left([kept])).toEqual(all(1));
    expect(await suDb.detachedThread.count({ where: { threadId: kept } })).toBe(
      1,
    );
  }, 60_000);

  test("a thread whose newest checkpoint is younger than the grace is kept until it is older", async () => {
    const fresh = [`${goneTenant}:9:ci:3`];
    await seed(fresh, 0);

    await pass({ graceMs: HOUR });
    expect(await left(fresh)).toEqual(all(1));

    // The same thread, aged past the grace.
    await pass({ graceMs: 0 });
    expect(await left(fresh)).toEqual(none);
  }, 60_000);

  test("a thread with an unreadable or missing age is never taken for being old", async () => {
    const odd = `${goneTenant}:9:ci:4`;
    seeded.push(odd);
    await cp.query(
      `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
       VALUES ($1, '', 'c1', '{"ts": "not a date"}'::jsonb, '{}'::jsonb)`,
      [odd],
    );

    await pass({ graceMs: 0 });

    expect((await left([odd])).checkpoints).toBe(1);
  }, 60_000);

  test("an ownerless thread with a timestamp-shaped but impossible age is kept, and the pass goes on", async () => {
    const odd = `${goneTenant}:9:ci:5`;
    const after = `${goneTenant}:9:ci:6`;
    seeded.push(odd);
    await cp.query(
      `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
       VALUES ($1, '', 'c1', '{"ts": "2026-99-01T00:00:00Z"}'::jsonb, '{}'::jsonb)`,
      [odd],
    );
    await seed([after]);

    expect(await pass({ graceMs: 0 })).not.toBeNull();

    expect((await left([odd])).checkpoints).toBe(1);
    expect(await left([after])).toEqual(none);
  }, 60_000);

  // The pass holds its lock on a connection of the checkpointer's pool, which can be a pool of one.
  test("a pass finishes on a pool of a single connection", async () => {
    // A second checkout from this pool fails after the bound instead of waiting forever.
    const one = new Pool({
      connectionString: appUrl,
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    const goneIds = [`${goneTenant}:66:1`];
    await seed(goneIds);
    try {
      expect(
        await reconcileCheckpoints(one, {
          pauseMs: 0,
          scope: mine,
          base: appDb,
        }),
      ).not.toBeNull();
      expect(await left(goneIds)).toEqual(none);
    } finally {
      await one.end();
    }
  }, 60_000);

  // A turn on the same pool gets its connection between two batches, not after the whole pass.
  test("a pass gives the pool's only connection back between batches", async () => {
    const one = new Pool({
      connectionString: appUrl,
      max: 1,
      connectionTimeoutMillis: 5_000,
    });
    const goneIds = range(300, (i) => `${goneTenant}:55:${i}`);
    await seed(goneIds);
    let passDone = false;
    try {
      const running = reconcileCheckpoints(one, {
        pauseMs: 100,
        threads: 5,
        scope: mine,
        base: appDb,
      }).finally(() => {
        passDone = true;
      });
      const turn = await one.query<{ ok: number }>("SELECT 1 AS ok");
      expect(turn.rows[0]?.ok).toBe(1);
      expect(passDone).toBe(false);
      expect(await running).not.toBeNull();
      expect(await left(goneIds)).toEqual(none);
    } finally {
      await one.end();
    }
  }, 120_000);

  test("a pass runs on the background pool", async () => {
    const seen = new Set<string>();
    await reconcileCheckpoints(cp, {
      pauseMs: 0,
      base: appDb,
      scope: (id) => {
        seen.add(currentPoolClass());
        return mine(id);
      },
    });
    expect([...seen]).toEqual(["background"]);
  }, 60_000);

  // A server that accepts the socket and never answers: the lock's connect gives up after its
  // bound, and the pass fails, instead of waiting forever with every later pass behind it.
  test("the lock's connection is bounded like the pools'", async () => {
    const sockets: Socket[] = [];
    const silent: Server = createServer((s) => {
      sockets.push(s);
    });
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
    const address = silent.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const saved = config.langgraphDatabaseUrl;
    config.langgraphDatabaseUrl = `postgres://nobody:nothing@127.0.0.1:${port}/none`;
    try {
      await expect(
        reconcileCheckpoints(cp, { pauseMs: 0, scope: mine, base: appDb }),
      ).rejects.toMatchObject({ code: "ETIMEDOUT" });
    } finally {
      config.langgraphDatabaseUrl = saved;
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => silent.close(() => r()));
    }
  }, 60_000);

  // A thread the grace kept in `checkpoints` may be past it by the time the walk reaches the other
  // tables: its writes and blobs stay while it still has a checkpoint.
  test("a thread's writes and blobs stay while it still has a checkpoint", async () => {
    const kept = `${goneTenant}:44:1`;
    await seed([kept]);

    for (const table of ["checkpoint_writes", "checkpoint_blobs"] as const) {
      await reconcileCheckpointBatch(
        cp,
        { table, after: "" },
        { scope: (id) => id === kept, base: appDb, graceMs: 0 },
      );
    }

    expect(await left([kept])).toEqual(all(1));
  }, 60_000);

  // The lock lives as long as its connection; a pass whose connection is gone stops before the next
  // batch instead of deleting beside whoever holds the lock now.
  test("a pass whose lock connection is gone stops before its next batch", async () => {
    const goneIds = range(20, (i) => `${goneTenant}:33:${i}`);
    await seed(goneIds);
    let calls = 0;
    const lockConnection = async () => ({
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ ok: true }] };
        throw new Error("Connection terminated unexpectedly");
      },
      end: async () => {},
    });

    await expect(
      reconcileCheckpoints(cp, {
        pauseMs: 0,
        scope: mine,
        base: appDb,
        lockConnection:
          lockConnection as unknown as () => Promise<LockConnection>,
      }),
    ).rejects.toThrow("Connection terminated");
    expect(await left(goneIds)).toEqual(all(20));
  }, 60_000);

  // A connection that opened and then stops answering: the pass fails on its deadline instead of
  // waiting forever with every later pass behind it.
  test("a lock connection that stops answering fails the pass on its deadline", async () => {
    const goneIds = range(5, (i) => `${goneTenant}:22:${i}`);
    await seed(goneIds);
    let calls = 0;
    const lockConnection = async () => ({
      query: (() => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ rows: [{ ok: true }] })
          : new Promise(() => {});
      }) as unknown as LockConnection["query"],
      end: () => new Promise<void>(() => {}),
    });

    await expect(
      reconcileCheckpoints(cp, {
        pauseMs: 0,
        scope: mine,
        base: appDb,
        lockQueryMs: 50,
        lockConnection,
      }),
    ).rejects.toBeInstanceOf(LockConnectionTimeout);
    expect(await left(goneIds)).toEqual(all(5));
  }, 60_000);

  test("what a sweep stopped between tables left behind goes too", async () => {
    const rest = `${goneTenant}:9:ci:8`;
    await seed([rest]);
    await cp.query("DELETE FROM langgraph.checkpoints WHERE thread_id = $1", [
      rest,
    ]);

    await pass();

    expect(await left([rest])).toEqual(none);
  }, 60_000);

  test("an id whose tenant does not read is never taken", async () => {
    // Under this file's scope by its text, but with no tenant of its own.
    const weird = `x${goneTenant}:9:ci:1`;
    await seed([weird]);

    await reconcileCheckpoints(cp, {
      pauseMs: 0,
      scope: (id) => id === weird,
      base: appDb,
    });

    expect(await left([weird])).toEqual(all(1));
  }, 60_000);

  test("a second pass while one runs returns at once, and the first finishes the work", async () => {
    const goneIds = range(40, (i) => `${goneTenant}:77:${i}`);
    await seed(goneIds);

    const [a, b] = await Promise.all([pass(), pass()]);

    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect(await left(goneIds)).toEqual(none);
    // And a pass with nothing left to do changes nothing.
    const again = await pass();
    expect(again).toEqual({
      checkpoints: 0,
      checkpoint_writes: 0,
      checkpoint_blobs: 0,
    });
  }, 60_000);

  test("a batch takes a bounded set of threads and the next one starts after them", async () => {
    const goneIds = range(30, (i) => `${goneTenant}:88:${i}`);
    await seed(goneIds);
    let cursor: SweepCursor | null = SWEEP_START;
    let batches = 0;
    const deletedPerBatch: number[] = [];
    while (cursor !== null) {
      const res = await reconcileCheckpointBatch(cp, cursor, {
        scope: mine,
        base: appDb,
        threads: 7,
        probes: 100,
      });
      if (cursor.table === "checkpoints" && res.deleted > 0)
        deletedPerBatch.push(res.deleted);
      cursor = res.next;
      batches += 1;
      if (batches > 5_000) throw new Error("the walk never ended");
    }

    expect(Math.max(...deletedPerBatch)).toBeLessThanOrEqual(7);
    expect(deletedPerBatch.reduce((a, b) => a + b, 0)).toBe(30);
    expect(await left(goneIds)).toEqual(none);
  }, 120_000);

  test("a batch that runs out of rows comes back to the same threads", async () => {
    const long = `${goneTenant}:99:1`;
    seeded.push(long);
    await cp.query(
      `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
       SELECT $1, '', lpad(i::text, 6, '0'), jsonb_build_object('ts', $2::text), '{}'::jsonb
         FROM generate_series(1, 25) i`,
      [long, new Date(Date.now() - 2 * HOUR).toISOString()],
    );
    const res = await reconcileCheckpointBatch(cp, SWEEP_START, {
      scope: (id) => id === long,
      base: appDb,
      rows: 10,
    });

    expect(res.next).toEqual(SWEEP_START);
    expect(await pass({ rows: 10 })).not.toBeNull();
    expect(await left([long])).toEqual(none);
  }, 60_000);

  // The walk and the age read go through the primary key at any size: a pass is one probe per
  // thread, and the newest checkpoint of a long thread is one backward step of the index.
  test("a pass reads through the primary key, never a table scan", async () => {
    const base = `${goneTenant}`;
    await seed(range(3_000, (i) => `${base}:${i % 5}:${i}`));
    await cp.query(
      "ANALYZE langgraph.checkpoints, langgraph.checkpoint_blobs, langgraph.checkpoint_writes",
    );
    const plans = [
      ...(await Promise.all(
        CHECKPOINT_TABLES.map(
          async (t) =>
            (
              await cp.query(`EXPLAIN ${reconcileWalkSql(t)}`, ["", 500])
            ).rows,
        ),
      )),
      (
        await cp.query(`EXPLAIN ${NEWEST_CHECKPOINT_SQL}`, [
          [`${base}:1:1`, `${base}:1:6`],
        ])
      ).rows,
    ].map((rows) => rows.map((r) => r["QUERY PLAN"]).join("\n"));

    for (const plan of plans) {
      expect(plan).not.toContain("Seq Scan");
      expect(plan).toMatch(/Index/);
    }
  }, 120_000);
});
