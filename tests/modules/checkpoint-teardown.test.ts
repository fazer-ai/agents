import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import { getCheckpointer } from "@/graph/checkpointer";
import type { TenantContext } from "@/lib/tenancy";
import { deleteAgent } from "@/modules/agents/service";
import {
  reconnectChatwootInstance,
  removeChatwootInstance,
} from "@/modules/chatwoot/management";
import { upsertPlaygroundSession } from "@/modules/playground/sessions";
import { savePlaygroundTurnNote } from "@/modules/playground/turn-notes";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE CHECKPOINTS OF WHAT A TEARDOWN REMOVES GO WITH IT. The `langgraph` tables have no tenant and no
// foreign key, so only the teardown itself can take a removed account's or a deleted agent's threads.
// Each test seeds checkpoint rows straight in SQL, under thread ids of the shapes the runtime writes,
// beside neighbours whose ids share every character but the separator, and runs the real teardown.
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
    // The checkpointer creates its tables on first use; the rows below are written beside it.
    await getCheckpointer();
    pool = new Pool({ connectionString: appUrl, max: 4 });
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;
const cp = pool as Pool;

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: 1n, role: "SUPER_ADMIN" };
}

// Deletes these threads' rows, whatever the teardown left.
async function dropThreads(ids: string[]) {
  for (const t of ["checkpoint_blobs", "checkpoint_writes", "checkpoints"]) {
    await cp.query(
      `DELETE FROM langgraph.${t} WHERE thread_id = ANY($1::text[])`,
      [ids],
    );
  }
}

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

describe.skipIf(!dbUp)("teardowns take their checkpoints", () => {
  let tenantId = 0n;
  let otherTenantId = 0n;
  const seeded: string[] = [];
  async function seed(ids: string[]) {
    seeded.push(...ids);
    await seedThreads(ids);
  }

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Checkpoint sweep", slug: `cp-sweep-${process.pid}` },
    });
    tenantId = t.id;
    const o = await suDb.tenant.create({
      data: { name: "Checkpoint other", slug: `cp-other-${process.pid}` },
    });
    otherTenantId = o.id;
  });

  afterAll(async () => {
    await dropThreads(seeded);
    await cp.end();
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
          ? "https://chat.cp-sweep.example.com"
          : "https://chat.cp-other.example.com",
      adminToken: encryptJson("ADMIN"),
    });
  }

  function accountThreads(tenant: bigint, instance: bigint, n: number) {
    return [
      ...range(n, (i) => `${tenant}:${instance}:${i + 1}`),
      ...range(n, (i) => `${tenant}:${instance}:ci:${i + 1}`),
    ];
  }

  test("removing an account deletes its conversations' checkpoints and no one else's", async () => {
    const gone = await account(15511);
    const stays = await account(15512);
    const other = await account(15511, otherTenantId);
    const goneIds = accountThreads(tenantId, gone.id, 150);
    const staysIds = accountThreads(tenantId, stays.id, 20);
    const otherIds = accountThreads(otherTenantId, other.id, 20);
    const playground = [`${tenantId}:playground:1:a`];
    await seed([...goneIds, ...staysIds, ...otherIds, ...playground]);

    await removeChatwootInstance(ctx(tenantId), gone.id, appDb);

    expect(await left(goneIds)).toEqual(none);
    expect(await left(staysIds)).toEqual(all(staysIds.length));
    expect(await left(otherIds)).toEqual(all(otherIds.length));
    expect(await left(playground)).toEqual(all(1));
  }, 60_000);

  // At the size the tables reach: the account's threads among many more of other accounts. None of
  // the statements may delete them all at once (the plans each batch runs are pinned in
  // tests/graph/checkpoint-sweep.test.ts).
  test("a large account's checkpoints go in batches", async () => {
    const big = await account(15516);
    const ids = accountThreads(tenantId, big.id, 1_500);
    const crowd = range(20_000, (i) => `${otherTenantId}:${i % 7}:crowd-${i}`);
    await seed([...ids, ...crowd]);
    let statements = 0;
    const counter = `CREATE FUNCTION test_1551_count() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_notify('test_1551_count', (SELECT count(*) FROM old_rows)::text);
        RETURN NULL;
      END $$`;
    await suDb.$executeRawUnsafe(counter);
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER test_1551_count AFTER DELETE ON langgraph.checkpoints
         REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION test_1551_count()`,
    );
    const listener = await cp.connect();
    let largest = 0;
    listener.on("notification", (n) => {
      statements++;
      largest = Math.max(largest, Number(n.payload));
    });
    await listener.query("LISTEN test_1551_count");
    try {
      await removeChatwootInstance(ctx(tenantId), big.id, appDb);
    } finally {
      await listener.query("UNLISTEN test_1551_count");
      listener.release();
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS test_1551_count ON langgraph.checkpoints",
      );
      await suDb.$executeRawUnsafe("DROP FUNCTION IF EXISTS test_1551_count()");
    }

    expect(await left(ids)).toEqual(none);
    expect(await left(crowd.slice(0, 500))).toEqual(all(500));
    expect(statements).toBeGreaterThan(1);
    expect(largest).toBeLessThanOrEqual(100);
  }, 120_000);

  // The sweep runs before the account row goes: a removal that stopped in the middle of it leaves the
  // account in place and disconnected, and running it again deletes the rest.
  test("a removal stopped in the middle of its checkpoints is finished by running it again", async () => {
    const gone = await account(15513);
    const ids = accountThreads(tenantId, gone.id, 120);
    await seed(ids);
    // Lets the sweep's first batch commit and fails its second, as a process dying there would.
    const trap = `CREATE FUNCTION test_1551_stop() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT count(*) FROM langgraph.checkpoints WHERE thread_id LIKE '${tenantId}:${gone.id}:%') < 150 THEN
          RAISE EXCEPTION 'stopped in the middle';
        END IF;
        RETURN NULL;
      END $$`;
    await suDb.$executeRawUnsafe(trap);
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER test_1551_stop AFTER DELETE ON langgraph.checkpoints
         FOR EACH STATEMENT EXECUTE FUNCTION test_1551_stop()`,
    );
    try {
      await expect(
        removeChatwootInstance(ctx(tenantId), gone.id, appDb),
      ).rejects.toThrow();
    } finally {
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS test_1551_stop ON langgraph.checkpoints",
      );
      await suDb.$executeRawUnsafe("DROP FUNCTION IF EXISTS test_1551_stop()");
    }
    const halfway = await left(ids);
    expect(halfway.checkpoints).toBeGreaterThan(0);
    expect(halfway.checkpoints).toBeLessThan(ids.length);
    const [still] = await suDb.$queryRaw<[{ disconnected: boolean }]>`
      SELECT disconnected_at IS NOT NULL AS disconnected FROM chatwoot_instances WHERE id = ${gone.id}`;
    expect(still?.disconnected).toBe(true);

    await removeChatwootInstance(ctx(tenantId), gone.id, appDb);

    expect(await left(ids)).toEqual(none);
    const [row] = await suDb.$queryRaw<[{ n: bigint }]>`
      SELECT count(*) AS n FROM chatwoot_instances WHERE id = ${gone.id}`;
    expect(Number(row?.n)).toBe(0);
  }, 60_000);

  // A reconnect is the operator taking the account back: its memory stays, and the removal stops.
  // The account's lock is held by a transaction on the main pool, and the checkpoints are deleted on
  // the checkpointer's: a batch that outlives that transaction's budget would commit after the lock
  // was gone, when a reconnect may already have taken the account back. It is cut off at its
  // deadline instead, and deletes nothing.
  test("a checkpoint batch that outlives its account lock's budget deletes nothing", async () => {
    const slow = await account(15517);
    const ids = accountThreads(tenantId, slow.id, 20);
    await seed(ids);
    const stall = `CREATE FUNCTION test_1551_stall() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM old_rows WHERE thread_id LIKE '${tenantId}:${slow.id}:%') THEN
          PERFORM pg_sleep(${(config.dbTx.timeoutMs + 1_500) / 1000});
        END IF;
        RETURN NULL;
      END $$`;
    await suDb.$executeRawUnsafe(stall);
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER test_1551_stall AFTER DELETE ON langgraph.checkpoints
         REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION test_1551_stall()`,
    );
    try {
      await expect(
        removeChatwootInstance(ctx(tenantId), slow.id, appDb),
      ).rejects.toThrow();
    } finally {
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS test_1551_stall ON langgraph.checkpoints",
      );
      await suDb.$executeRawUnsafe("DROP FUNCTION IF EXISTS test_1551_stall()");
    }

    expect(await left(ids)).toEqual(all(ids.length));
  }, 60_000);

  // DB_TX_TIMEOUT_MS may be set to a second or less; the batch's commit margin is cut to fit, so the
  // removal still has time to run instead of failing every batch at its deadline.
  test("an account is removed under a transaction budget of one second", async () => {
    const acc = await account(15518);
    const ids = accountThreads(tenantId, acc.id, 10);
    await seed(ids);
    const was = config.dbTx.timeoutMs;
    config.dbTx.timeoutMs = 1_000;
    try {
      await removeChatwootInstance(ctx(tenantId), acc.id, appDb);
    } finally {
      config.dbTx.timeoutMs = was;
    }

    expect(await left(ids)).toEqual(none);
  }, 60_000);

  test("an account reconnected in the middle of its checkpoint sweep keeps the rest of them", async () => {
    const back = await account(15514);
    const ids = accountThreads(tenantId, back.id, 120);
    await seed(ids);
    // Reconnected from inside the first sweep batch's delete, as an operator would from the console.
    const trap = `CREATE FUNCTION test_1551_reconnect() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_notify('test_1551', 'deleted');
        RETURN NULL;
      END $$`;
    await suDb.$executeRawUnsafe(trap);
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER test_1551_reconnect AFTER DELETE ON langgraph.checkpoints
         FOR EACH STATEMENT EXECUTE FUNCTION test_1551_reconnect()`,
    );
    const listener = await cp.connect();
    let reconnecting: Promise<unknown> | null = null;
    listener.on("notification", () => {
      reconnecting ??= reconnectChatwootInstance(
        ctx(tenantId),
        back.id,
        appDb,
      ).catch(() => undefined);
    });
    await listener.query("LISTEN test_1551");
    try {
      await expect(
        removeChatwootInstance(ctx(tenantId), back.id, appDb),
      ).rejects.toThrow();
      await reconnecting;
    } finally {
      await listener.query("UNLISTEN test_1551");
      listener.release();
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS test_1551_reconnect ON langgraph.checkpoints",
      );
      await suDb.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS test_1551_reconnect()",
      );
    }

    const after = await left(ids);
    expect(after.checkpoints).toBeGreaterThan(0);
    const [row] = await suDb.$queryRaw<[{ n: bigint }]>`
      SELECT count(*) AS n FROM chatwoot_instances WHERE id = ${back.id} AND disconnected_at IS NULL`;
    expect(Number(row?.n)).toBe(1);
  }, 60_000);

  // A turn admitted before the claim keeps writing its conversation's checkpoints until it ends. Its
  // thread claim says it is running: the removal refuses while it holds one, deletes nothing of the
  // account's, and the same call finishes once it is done.
  test("an account with a turn still running is not removed until the turn ends", async () => {
    const acc = await account(15519);
    const ids = accountThreads(tenantId, acc.id, 10);
    await seed(ids);
    await suDb.$executeRaw`
      INSERT INTO agent_threads
        (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id, turn_holders, turn_epoch, turn_held_until, updated_at)
      VALUES (${tenantId}, ${acc.id}, 1, ${`${tenantId}:${acc.id}:ci:1`}, 1, 1, now() + interval '60 seconds', now())`;

    await expect(
      removeChatwootInstance(ctx(tenantId), acc.id, appDb),
    ).rejects.toMatchObject({
      translationKey: "errors.chatwootRemovalTurnRunning",
    });
    expect(await left(ids)).toEqual(all(ids.length));

    await suDb.$executeRaw`
      UPDATE agent_threads SET turn_holders = 0, turn_held_until = NULL
       WHERE chatwoot_instance_id = ${acc.id}`;
    await removeChatwootInstance(ctx(tenantId), acc.id, appDb);

    expect(await left(ids)).toEqual(none);
  }, 60_000);

  // A playground turn that ran while its agent was deleted finishes after the delete took the agent's
  // sessions: it recreates no session and no note, and its thread goes.
  test("a playground turn that outlives its agent's delete leaves nothing behind", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Outlived",
        systemPrompt: "Be helpful.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    const threadId = `${tenantId}:playground:${agent.id}:late`;
    await deleteAgent(ctx(tenantId), agent.id, appDb);
    // What the turn writes once the delete has committed: its checkpoint, a note, its session.
    await seed([threadId]);
    await savePlaygroundTurnNote(appDb, {
      ctx: ctx(tenantId),
      agentId: agent.id,
      threadId,
      messageId: null,
      anchorMessageId: null,
      userMessageId: null,
      userText: null,
      reply: "late",
      guardrails: [],
    });
    await upsertPlaygroundSession(
      appDb,
      ctx(tenantId),
      agent.id,
      threadId,
      "late",
    );

    expect(await left([threadId])).toEqual(none);
    expect(
      await suDb.playgroundSession.count({ where: { agentId: agent.id } }),
    ).toBe(0);
    expect(
      await suDb.playgroundTurnNote.count({ where: { agentId: agent.id } }),
    ).toBe(0);
  });

  test("deleting an agent deletes its playground sessions and their checkpoints", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Doomed",
        systemPrompt: "Be helpful.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    const keeper = await suDb.agent.create({
      data: {
        tenantId,
        name: "Keeper",
        systemPrompt: "Be helpful.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    const mine = [
      ...range(3, (i) => `${tenantId}:playground:${agent.id}:s${i}`),
      // A thread whose turn never recorded a session.
      `${tenantId}:playground:${agent.id}:nosession`,
    ];
    const theirs = range(2, (i) => `${tenantId}:playground:${keeper.id}:s${i}`);
    await seed([...mine, ...theirs]);
    for (const [agentId, threadId] of [
      ...mine.slice(0, 3).map((t) => [agent.id, t] as const),
      ...theirs.map((t) => [keeper.id, t] as const),
    ]) {
      await suDb.playgroundSession.create({
        data: { tenantId, agentId, threadId },
      });
    }

    await deleteAgent(ctx(tenantId), agent.id, appDb);

    expect(await left(mine)).toEqual(none);
    expect(await left(theirs)).toEqual(all(theirs.length));
    const sessions = await suDb.playgroundSession.findMany({
      where: { tenantId },
      select: { agentId: true },
    });
    expect(sessions.map((s) => s.agentId)).toEqual([keeper.id, keeper.id]);
  });
});
