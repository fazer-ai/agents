import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import {
  Annotation,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PrismaPg } from "@prisma/adapter-pg";
import type { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  RETAIN_SQL,
  RETENTION_PROBES,
  retainCheckpointBatch,
  retainCheckpoints,
} from "@/graph/checkpoint-retention";
import {
  CHECKPOINT_TABLES,
  type CheckpointTable,
  deleteCheckpointThreads,
} from "@/graph/checkpoint-sweep";
import { getCheckpointPool } from "@/graph/checkpointer";
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";
import { seedChatwootInstance } from "../utils/chatwoot";

// A LIVE THREAD KEEPS ONLY WHAT THE SAVER RESUMES FROM. Threads are written two ways: straight
// in SQL, where each row's role is spelled out (an old checkpoint, the newest of its namespace, a blob
// version only an old checkpoint names, a parent's TASKS write), and through the real PostgresSaver
// and a real graph, where a pruned thread is read and continued beside a twin that was never pruned.
// Every pass is scoped to this file's threads.
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
const appDb = app as PrismaClient;
const cp = pool as Pool;
const HOUR = 60 * 60 * 1000;

// The graph the runtime's turns look like: a messages channel that holds the whole conversation, a
// counter channel, and a step that sometimes goes through a second node. Message ids do not depend on
// the thread, so two threads fed the same turns hold the same values.
const State = Annotation.Root({
  ...MessagesAnnotation.spec,
  turns: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
});

function buildGraph(saver: PostgresSaver) {
  return new StateGraph(State)
    .addNode("agent", (s: typeof State.State) => {
      const n = s.messages.length;
      const last = s.messages.at(-1) as BaseMessage;
      return {
        messages: [
          new AIMessage({
            id: `ai-${n}`,
            content: `resposta ${n} para ${String(last.content)}`,
          }),
        ],
        turns: 1,
      };
    })
    .addNode("tools", () => ({ turns: 0 }))
    .addEdge(START, "agent")
    .addConditionalEdges("agent", (s: typeof State.State) =>
      s.turns % 3 === 0 ? "tools" : END,
    )
    .addEdge("tools", END)
    .compile({ checkpointer: saver });
}

describe.skipIf(!dbUp)("the checkpoint retention pass", () => {
  let tenantId = 0n;
  let prefix = "";
  let goneTenant = 0n;
  let saver: PostgresSaver;
  let graph: ReturnType<typeof buildGraph>;
  const seeded: string[] = [];
  let n = 0;
  const thread = () => {
    const id = `${prefix}:${700000 + n++}`;
    seeded.push(id);
    return id;
  };
  // Where this file's threads begin. A batch walks every thread from its cursor before the scope
  // filters them, so one started at "" in a database that kept other files' threads may never reach
  // these.
  const start = () => `${prefix}:`;
  const only =
    (...ids: string[]) =>
    (id: string) =>
      ids.includes(id);
  const pass = (
    ids: string[],
    opts: Parameters<typeof retainCheckpoints>[1] = {},
  ) =>
    retainCheckpoints(cp, {
      pauseMs: 0,
      graceMs: 0,
      scope: only(...ids),
      base: appDb,
      ...opts,
    });

  async function turn(id: string, i: number) {
    await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: `h-${i}`, content: `mensagem ${i}` }),
        ],
      },
      { configurable: { thread_id: id } },
    );
  }

  // What the saver resumes a thread from, and what a reader gets back.
  async function resumed(id: string) {
    const cfg = { configurable: { thread_id: id } };
    const st = await graph.getState(cfg);
    const tuple = await saver.getTuple(cfg);
    return {
      checkpointId: tuple?.config.configurable?.checkpoint_id,
      values: JSON.parse(JSON.stringify(st.values)),
      next: st.next,
      pendingWrites: tuple?.pendingWrites?.map(([t, c, v]) => [
        t,
        c,
        JSON.stringify(v),
      ]),
    };
  }

  async function counts(ids: string[]) {
    const out: Record<CheckpointTable, number> = {
      checkpoints: 0,
      checkpoint_writes: 0,
      checkpoint_blobs: 0,
    };
    for (const t of CHECKPOINT_TABLES) {
      out[t] =
        (
          await cp.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM langgraph.${t} WHERE thread_id = ANY($1::text[])`,
            [ids],
          )
        ).rows[0]?.n ?? 0;
    }
    return out;
  }

  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Retention", slug: `cp-retention-${process.pid}` },
      })
    ).id;
    const instance = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      accountName: "Account 1",
      baseUrl: "https://chat.cp-retention.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    prefix = `${tenantId}:${instance.id}`;
    goneTenant = tenantId + 1_000_000n + BigInt(process.pid);
    saver = new PostgresSaver(cp, undefined, { schema: "langgraph" });
    graph = buildGraph(saver);
    // More than a batch of threads no test here owns, sorting before this file's, as a database the
    // suite has run on keeps them: every batch below must still reach its own thread.
    const others = Array.from(
      { length: RETENTION_PROBES + 1 },
      (_, i) => `${tenantId}:0:${i}`,
    );
    seeded.push(...others);
    await cp.query(
      `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
       SELECT t, '', 'c1', '{}'::jsonb, '{}'::jsonb FROM unnest($1::text[]) t`,
      [others],
    );
  });

  afterAll(async () => {
    await deleteCheckpointThreads(cp, seeded);
    await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // Rows written in SQL, by role. Every checkpoint is two hours old unless `ts` says otherwise.
  async function seedRows(
    id: string,
    rows: {
      checkpoints: [
        ns: string,
        cid: string,
        parent: string | null,
        versions: Record<string, string>,
        v?: number,
      ][];
      blobs: [ns: string, channel: string, version: string][];
      writes: [ns: string, cid: string, channel: string][];
    },
    ts = new Date(Date.now() - 2 * HOUR).toISOString(),
  ) {
    for (const [ns, cid, parent, versions, v = 4] of rows.checkpoints) {
      await cp.query(
        `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb, '{}'::jsonb)`,
        [
          id,
          ns,
          cid,
          parent,
          JSON.stringify({
            v,
            id: cid,
            ts,
            channel_values: {},
            channel_versions: versions,
            versions_seen: {},
          }),
        ],
      );
    }
    for (const [ns, channel, version] of rows.blobs) {
      await cp.query(
        `INSERT INTO langgraph.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
         VALUES ($1, $2, $3, $4, 'json', convert_to($5, 'UTF8'))`,
        [id, ns, channel, version, JSON.stringify(`${channel}@${version}`)],
      );
    }
    let idx = 0;
    for (const [ns, cid, channel] of rows.writes) {
      await cp.query(
        `INSERT INTO langgraph.checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx, channel, type, blob)
         VALUES ($1, $2, $3, 'task', '', $4, $5, 'json', convert_to($6, 'UTF8'))`,
        [id, ns, cid, idx++, channel, JSON.stringify(`${cid}:${channel}`)],
      );
    }
  }

  async function rowsOf(id: string) {
    const q = async (sql: string) =>
      (await cp.query(sql, [id])).rows.map((r) => Object.values(r).join("/"));
    return {
      checkpoints: await q(
        "SELECT checkpoint_ns, checkpoint_id FROM langgraph.checkpoints WHERE thread_id = $1 ORDER BY 1, 2",
      ),
      blobs: await q(
        "SELECT checkpoint_ns, channel, version FROM langgraph.checkpoint_blobs WHERE thread_id = $1 ORDER BY 1, 2, 3",
      ),
      writes: await q(
        "SELECT checkpoint_ns, checkpoint_id, channel FROM langgraph.checkpoint_writes WHERE thread_id = $1 ORDER BY 1, 2, 3",
      ),
    };
  }

  test("each namespace keeps its newest checkpoint, the blob versions it names, its writes and its parent's TASKS writes", async () => {
    const id = thread();
    await seedRows(id, {
      checkpoints: [
        ["", "c1", null, { messages: "1" }],
        ["", "c2", "c1", { messages: "2", summary: "1" }],
        ["", "c3", "c2", { messages: "3", summary: "1" }],
        // A namespace whose newest is older, by id, than the root's newest is still its own.
        ["sub", "a1", null, { messages: "1" }],
        ["sub", "a2", "a1", { messages: "2" }],
      ],
      blobs: [
        ["", "messages", "1"],
        ["", "messages", "2"],
        ["", "messages", "3"],
        ["", "summary", "1"],
        ["sub", "messages", "1"],
        ["sub", "messages", "2"],
      ],
      writes: [
        ["", "c1", "__pregel_tasks"],
        ["", "c2", "__pregel_tasks"],
        ["", "c3", "messages"],
        ["sub", "a1", "messages"],
        ["sub", "a2", "messages"],
      ],
    });
    const before = await counts([id]);
    const totals = await pass([id]);
    expect(await rowsOf(id)).toEqual({
      checkpoints: ["/c3", "sub/a2"],
      blobs: ["/messages/3", "/summary/1", "sub/messages/2"],
      writes: ["/c2/__pregel_tasks", "/c3/messages", "sub/a2/messages"],
    });
    const after = await counts([id]);
    expect(totals).toMatchObject({
      threads: 1,
      checkpoints: before.checkpoints - after.checkpoints,
      checkpoint_writes: before.checkpoint_writes - after.checkpoint_writes,
      checkpoint_blobs: before.checkpoint_blobs - after.checkpoint_blobs,
    });
    expect(totals?.bytes).toBeGreaterThan(0);
  });

  // Under async durability a step's writes can be stored before its checkpoint is: they name an id
  // greater than every committed checkpoint, and they stay until that checkpoint lands and after.
  test("the writes of a checkpoint not stored yet stay, and still belong to it once it is", async () => {
    const id = thread();
    await seedRows(id, {
      checkpoints: [
        ["", "c1", null, { messages: "1" }],
        ["", "c2", "c1", { messages: "2" }],
      ],
      blobs: [
        ["", "messages", "1"],
        ["", "messages", "2"],
      ],
      writes: [
        ["", "c1", "messages"],
        ["", "c3", "__interrupt__"],
        ["", "c3", "messages"],
      ],
    });
    await pass([id]);
    expect(await rowsOf(id)).toEqual({
      checkpoints: ["/c2"],
      blobs: ["/messages/2"],
      writes: ["/c3/__interrupt__", "/c3/messages"],
    });
    await seedRows(id, {
      checkpoints: [["", "c3", "c2", { messages: "3" }]],
      blobs: [["", "messages", "3"]],
      writes: [],
    });
    await pass([id]);
    expect(await rowsOf(id)).toEqual({
      checkpoints: ["/c3"],
      blobs: ["/messages/3"],
      writes: ["/c3/__interrupt__", "/c3/messages"],
    });
  });

  // A checkpoint of format v<4 reads the pending sends from its parent's TASKS writes, with no need of
  // the parent's row: what the saver hands back is the same before and after the pass.
  test("a legacy checkpoint resumes with the sends it reads from its parent", async () => {
    const id = thread();
    await seedRows(id, {
      checkpoints: [
        ["", "c1", null, { messages: "1" }, 3],
        ["", "c2", "c1", { messages: "2" }, 3],
      ],
      blobs: [
        ["", "messages", "1"],
        ["", "messages", "2"],
      ],
      writes: [
        ["", "c1", "__pregel_tasks"],
        ["", "c1", "messages"],
      ],
    });
    const cfg = { configurable: { thread_id: id } };
    const before = await saver.getTuple(cfg);
    await pass([id]);
    expect(await rowsOf(id)).toEqual({
      checkpoints: ["/c2"],
      blobs: ["/messages/2"],
      writes: ["/c1/__pregel_tasks"],
    });
    const after = await saver.getTuple(cfg);
    expect(JSON.stringify(after?.checkpoint)).toBe(
      JSON.stringify(before?.checkpoint),
    );
    expect(after?.checkpoint.channel_values.__pregel_tasks).toBeDefined();
  });

  test("a pruned thread resumes and continues exactly like a twin that was never pruned", async () => {
    const pruned = thread();
    const twin = thread();
    for (let i = 0; i < 15; i++) {
      await turn(pruned, i);
      await turn(twin, i);
    }
    const before = await resumed(pruned);
    const totals = await pass([pruned]);
    expect(totals?.checkpoints).toBeGreaterThan(30);
    expect((await counts([pruned])).checkpoints).toBe(1);
    expect((await counts([twin])).checkpoints).toBeGreaterThan(30);

    const after = await resumed(pruned);
    expect(after).toEqual(before);
    const { checkpointId: _a, ...prunedView } = after;
    const { checkpointId: _b, ...twinView } = await resumed(twin);
    expect(prunedView).toEqual(twinView);

    await turn(pruned, 99);
    await turn(twin, 99);
    const { checkpointId: _c, ...p2 } = await resumed(pruned);
    const { checkpointId: _d, ...t2 } = await resumed(twin);
    expect(p2).toEqual(t2);
  }, 60_000);

  // A long thread does not fit one batch: each statement stops at its row bound, and the next batch
  // takes the same thread again until nothing is left.
  test("a long thread goes over several bounded batches and resumes the same", async () => {
    const long = thread();
    for (let i = 0; i < 40; i++) await turn(long, i);
    const before = await resumed(long);
    let batches = 0;
    let after = start();
    for (;;) {
      const res = await retainCheckpointBatch(cp, after, {
        rows: 7,
        graceMs: 0,
        scope: only(long),
        base: appDb,
      });
      batches++;
      for (const t of CHECKPOINT_TABLES)
        expect(res.deleted[t]).toBeLessThanOrEqual(7);
      if (res.next === null) break;
      after = res.next;
    }
    expect(batches).toBeGreaterThan(10);
    expect((await counts([long])).checkpoints).toBe(1);
    expect(await resumed(long)).toEqual(before);
  }, 60_000);

  // The writes and blobs are checked against every checkpoint their thread still has, so they wait
  // until a batch has left the thread its newest checkpoint: with thousands of old checkpoints that
  // check would grow with their count, past the batch's cut.
  test("writes and blobs wait while the batch's threads still have old checkpoints", async () => {
    const id = thread();
    const cps = Array.from(
      { length: 10 },
      (_, i) => `c${String(i).padStart(2, "0")}`,
    );
    await seedRows(id, {
      checkpoints: cps.map(
        (c, i) =>
          ["", c, i ? (cps[i - 1] ?? null) : null, { messages: String(i) }] as [
            string,
            string,
            string | null,
            Record<string, string>,
          ],
      ),
      blobs: cps.map(
        (_, i) => ["", "messages", String(i)] as [string, string, string],
      ),
      writes: cps.map((c) => ["", c, "messages"] as [string, string, string]),
    });
    const opts = { rows: 3, graceMs: 0, scope: only(id), base: appDb };
    const first = await retainCheckpointBatch(cp, start(), opts);
    expect(first.deleted).toEqual({
      checkpoints: 3,
      checkpoint_writes: 0,
      checkpoint_blobs: 0,
    });
    expect(first.next).toBe(start());
    let after: string | null = start();
    while (after !== null) {
      const res = await retainCheckpointBatch(cp, after, opts);
      if (res.deleted.checkpoint_writes > 0 || res.deleted.checkpoint_blobs > 0)
        expect((await counts([id])).checkpoints).toBe(1);
      after = res.next;
    }
    expect(await rowsOf(id)).toEqual({
      checkpoints: ["/c09"],
      blobs: ["/messages/9"],
      writes: ["/c09/messages"],
    });
  });

  // The stored-bytes bound: with a budget smaller than any row, each statement still takes its first
  // row, and only that one, so a thread of large blobs goes one row at a time instead of one statement
  // running past the batch's cut.
  test("a statement stops at its byte budget, and the thread still goes whole", async () => {
    const heavy = thread();
    for (let i = 0; i < 6; i++) await turn(heavy, i);
    const before = await resumed(heavy);
    let after = start();
    let batches = 0;
    for (;;) {
      const res = await retainCheckpointBatch(cp, after, {
        bytes: 1,
        graceMs: 0,
        scope: only(heavy),
        base: appDb,
      });
      batches++;
      for (const t of CHECKPOINT_TABLES)
        expect(res.deleted[t]).toBeLessThanOrEqual(1);
      if (res.next === null) break;
      after = res.next;
    }
    expect(batches).toBeGreaterThan(10);
    expect((await counts([heavy])).checkpoints).toBe(1);
    expect(await resumed(heavy)).toEqual(before);
  }, 60_000);

  test("a thread whose newest checkpoint is younger than the grace is left whole", async () => {
    const young = thread();
    for (let i = 0; i < 3; i++) await turn(young, i);
    const before = await counts([young]);
    const totals = await pass([young], { graceMs: HOUR });
    expect(await counts([young])).toEqual(before);
    expect(totals?.threads).toBe(0);
  });

  // A thread whose owner is gone is the reconciler's: it deletes the thread whole, and two passes
  // deleting rows of the same thread in two orders would deadlock one of them.
  test("a thread with no owner is left to the reconciler", async () => {
    const orphan = `${goneTenant}:1:1`;
    seeded.push(orphan);
    await seedRows(orphan, {
      checkpoints: [
        ["", "c1", null, { messages: "1" }],
        ["", "c2", "c1", { messages: "2" }],
      ],
      blobs: [
        ["", "messages", "1"],
        ["", "messages", "2"],
      ],
      writes: [["", "c1", "messages"]],
    });
    const before = await counts([orphan]);
    await pass([orphan]);
    expect(await counts([orphan])).toEqual(before);
  });

  test("a second pass deletes nothing, and a one-checkpoint thread keeps its writes", async () => {
    const single = thread();
    await seedRows(single, {
      checkpoints: [["", "c1", null, { messages: "1" }]],
      blobs: [["", "messages", "1"]],
      writes: [
        ["", "c1", "messages"],
        ["", "c1", "summary"],
      ],
    });
    const multi = thread();
    for (let i = 0; i < 5; i++) await turn(multi, i);
    await pass([single, multi]);
    const between = {
      single: await rowsOf(single),
      multi: await counts([multi]),
    };
    const second = await pass([single, multi]);
    expect(second).toEqual({
      threads: 0,
      checkpoints: 0,
      checkpoint_writes: 0,
      checkpoint_blobs: 0,
      bytes: 0,
    });
    expect({
      single: await rowsOf(single),
      multi: await counts([multi]),
    }).toEqual(between);
    expect(between.single.writes).toEqual(["/c1/messages", "/c1/summary"]);
  });

  // Turns write while the pass deletes from the same thread: every condition is read when its
  // statement runs, so the checkpoint a turn just wrote is the newest and keeps what it names.
  test("turns written while the pass runs lose nothing", async () => {
    const busy = thread();
    const twin = thread();
    for (let i = 0; i < 20; i++) {
      await turn(busy, i);
      await turn(twin, i);
    }
    const passes = (async () => {
      for (let k = 0; k < 15; k++) await pass([busy], { rows: 2, pauseMs: 1 });
    })();
    for (let i = 20; i < 35; i++) {
      await turn(busy, i);
      await turn(twin, i);
    }
    await passes;
    await pass([busy]);
    const { checkpointId: _a, ...b } = await resumed(busy);
    const { checkpointId: _b, ...t } = await resumed(twin);
    expect(b).toEqual(t);
    expect((await counts([busy])).checkpoints).toBe(1);
  }, 120_000);

  test("a second pass while one runs returns at once", async () => {
    const id = thread();
    for (let i = 0; i < 4; i++) await turn(id, i);
    const [a, b] = await Promise.all([
      pass([id], { pauseMs: 50, rows: 1 }),
      pass([id], { pauseMs: 50, rows: 1 }),
    ]);
    expect([a, b].filter((r) => r === null)).toHaveLength(1);
    expect((await counts([id])).checkpoints).toBe(1);
  }, 60_000);

  // A thread deleted whole (`deleteThread`, on a reset or a playground session) locks its blobs, then
  // its checkpoints. A batch holds one table's rows at a time, so a deletion that holds the blobs while
  // the batch waits on them still gets the checkpoints, and both finish.
  test("a thread deleted whole while a batch prunes it does not deadlock either one", async () => {
    const id = thread();
    for (let i = 0; i < 6; i++) await turn(id, i);
    const holder = await cp.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SET LOCAL lock_timeout = '5s'");
      await holder.query(
        "SELECT 1 FROM langgraph.checkpoint_blobs WHERE thread_id = $1 FOR UPDATE",
        [id],
      );
      const batch = retainCheckpointBatch(cp, start(), {
        graceMs: 0,
        scope: only(id),
        base: appDb,
      });
      // Until the batch is waiting on the blobs this transaction holds.
      await until("the batch to wait on the held blobs", async () => {
        const waiting = await cp.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%DELETE FROM langgraph.checkpoint_blobs%'`,
        );
        return (waiting.rowCount ?? 0) > 0;
      });
      await holder.query(
        "SELECT 1 FROM langgraph.checkpoints WHERE thread_id = $1 FOR UPDATE",
        [id],
      );
      for (const t of ["checkpoint_blobs", "checkpoints", "checkpoint_writes"])
        await holder.query(`DELETE FROM langgraph.${t} WHERE thread_id = $1`, [
          id,
        ]);
      await holder.query("COMMIT");
      await batch;
    } finally {
      holder.release();
    }
    expect(await counts([id])).toEqual({
      checkpoints: 0,
      checkpoint_writes: 0,
      checkpoint_blobs: 0,
    });
  }, 60_000);

  // The batch's deletes run with sequential scans off: on a small table the planner would rather read
  // it whole, which is the read the pass must not make.
  test("a batch deletes with sequential scans off, before its first statement", async () => {
    const id = thread();
    for (let i = 0; i < 3; i++) await turn(id, i);
    const sent: string[] = [];
    const recording = {
      connect: async () => {
        const client = await cp.connect();
        return new Proxy(client, {
          get(target, prop, receiver) {
            if (prop === "query")
              return (sql: string, params?: unknown[]) => {
                sent.push(sql);
                return target.query(sql, params);
              };
            return Reflect.get(target, prop, receiver);
          },
        });
      },
    } as unknown as Pool;
    await retainCheckpointBatch(recording, start(), {
      graceMs: 0,
      scope: only(id),
      base: appDb,
    });
    const off = sent.indexOf("SET LOCAL enable_seqscan = off");
    const firstDelete = sent.findIndex((q) => q.includes("DELETE FROM"));
    expect(off).toBeGreaterThan(-1);
    expect(firstDelete).toBeGreaterThan(off);
    expect((await counts([id])).checkpoints).toBe(1);
  });

  // Every statement reaches its rows through the primary key, at any size, for a batch of the size a
  // pass takes: the walk is one probe per thread, and each delete and each lookup of `checkpoints`
  // names the batch's threads by the key's leading column.
  test("the deletes read through the primary key, never a table scan", async () => {
    const base = `${goneTenant}:9`;
    const ids = Array.from({ length: 3_000 }, (_, i) => `${base}:${i}`);
    seeded.push(...ids);
    await cp.query(
      `INSERT INTO langgraph.checkpoints (thread_id, checkpoint_ns, checkpoint_id, checkpoint, metadata)
       SELECT t, '', 'c' || k, jsonb_build_object('channel_versions', jsonb_build_object('messages', k::text)), '{}'::jsonb
         FROM unnest($1::text[]) t, generate_series(1, 3) k`,
      [ids],
    );
    await cp.query(
      `INSERT INTO langgraph.checkpoint_blobs (thread_id, checkpoint_ns, channel, version, type, blob)
       SELECT t, '', 'messages', k::text, 'json', convert_to('x', 'UTF8')
         FROM unnest($1::text[]) t, generate_series(1, 3) k`,
      [ids],
    );
    await cp.query(
      `INSERT INTO langgraph.checkpoint_writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, blob)
       SELECT t, '', 'c' || k, 'task', 0, 'messages', 'json', convert_to('x', 'UTF8')
         FROM unnest($1::text[]) t, generate_series(1, 3) k`,
      [ids],
    );
    await cp.query(
      "ANALYZE langgraph.checkpoints, langgraph.checkpoint_blobs, langgraph.checkpoint_writes",
    );
    // As the batch runs them: in a transaction with sequential scans off, where a Seq Scan in the plan
    // means the statement has no path through an index at all.
    const client = await cp.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      for (const t of CHECKPOINT_TABLES) {
        const plan = (
          await client.query(`EXPLAIN ${RETAIN_SQL[t]}`, [
            ids.slice(0, 100),
            5000,
            32 * 1024 * 1024,
          ])
        ).rows
          .map((r) => r["QUERY PLAN"])
          .join("\n");
        expect(plan).not.toContain("Seq Scan");
        expect(plan).toMatch(/Index/);
      }
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }, 120_000);
});
