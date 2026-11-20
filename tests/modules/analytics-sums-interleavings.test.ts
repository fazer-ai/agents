import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getBreakdown } from "@/modules/analytics/breakdown";
import { getDashboardCosts } from "@/modules/analytics/costs";
import type { DashboardFilter } from "@/modules/analytics/filter";
import { stepLedgerSums } from "@/modules/analytics/ledger-sums";
import { getKpis } from "@/modules/analytics/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "@/tests/utils/chatwoot";
import { until } from "@/tests/utils/poll";
import { TEST_TIMEOUT_MS } from "@/tests/utils/timeouts";

// THE SUMS UNDER CONCURRENT WRITES (docs/dashboard.md, "Ledger and conversation sums", the
// invariants): every write the figures read (a ledger row or a conversation inserted, updated or
// removed below the mark) is run against a job step at every point the step can be cut, committed in
// the gap, open across the whole step, or begun in the gap and committed after it. After each cell
// the figures read from the sums are the figures read from the rows, at once and after the job
// catches up. A write that waits on a lock the step holds is the same cell as the write after the
// step, and the cell runs it that way.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
// The writes' own pool: each write of a cell holds a connection, and the polls need one more.
let writer: PrismaClient | undefined;
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
    writer = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl, max: 20 }),
    });
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const db = app as PrismaClient;
const wr = writer as PrismaClient;

const noFetch = (async () => Response.json({})) as unknown as typeof fetch;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
// Every write lands two days back, well below any mark the job reaches.
const BACK = NOW - 2 * DAY;

interface Fx {
  tenantId: bigint;
  instanceId: bigint;
  agents: bigint[];
  inboxes: bigint[];
}
let fx: Fx;
let seq = 97_000 + (process.pid % 1000) * 70;

const ctx = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

async function seedTenant(slug: string): Promise<Fx> {
  const t = await suDb.tenant.create({
    data: { name: slug, slug: `${slug}-${process.pid}` },
  });
  const inst = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    accountId: 85_000 + (seq++ % 10_000) + (process.pid % 1000) * 10,
    baseUrl: `https://${slug}.cw.example`,
    adminToken: "enc",
  });
  const agents: bigint[] = [];
  for (const name of ["Ana", "Beto"])
    agents.push(
      (
        await suDb.agent.create({
          data: {
            tenantId: t.id,
            name,
            systemPrompt: "x",
            modelConfig: { provider: "openai", model: "m1" },
          },
        })
      ).id,
    );
  const inboxes: bigint[] = [];
  for (const n of [1, 2])
    inboxes.push(
      (
        await suDb.inbox.create({
          data: {
            tenantId: t.id,
            chatwootInstanceId: inst.id,
            chatwootInboxId: n,
            name: `in${n}`,
            agentId: n === 1 ? (agents[0] as bigint) : null,
          },
        })
      ).id,
    );
  return { tenantId: t.id, instanceId: inst.id, agents, inboxes };
}

type Tx = Prisma.TransactionClient;

function conversationData(at: number) {
  const n = seq++;
  return {
    tenantId: fx.tenantId,
    chatwootInstanceId: fx.instanceId,
    inboxId: fx.inboxes[1] as bigint,
    chatwootConversationId: n,
    status: "open",
    labels: ["vendas"],
    threadId: `${fx.tenantId}:${fx.instanceId}:${n}`,
    createdAt: new Date(at),
    chatwootCreatedAt: new Date(at),
  };
}

function turnData(conversationId: bigint, agentId: bigint, at: number) {
  return {
    tenantId: fx.tenantId,
    conversationId,
    agentId,
    inboxId: fx.inboxes[1] as bigint,
    source: "inbox",
    node: "agent",
    model: "m1",
    costUsd: 0.01,
    durationMs: 800,
    createdAt: new Date(at),
  };
}

// A conversation two days back with one turn of the first agent, committed before the cell.
async function counted(): Promise<{ conv: bigint; turn: bigint }> {
  const c = await suDb.conversation.create({ data: conversationData(BACK) });
  const u = await suDb.llmUsage.create({
    data: turnData(c.id, fx.agents[0] as bigint, BACK + HOUR),
  });
  return { conv: c.id, turn: u.id };
}

interface Op {
  name: string;
  prepare: () => Promise<{ conv: bigint; turn: bigint } | null>;
  write: (tx: Tx, t: { conv: bigint; turn: bigint } | null) => Promise<unknown>;
}

// Every write the figures read, each on rows of its own, stamped below the mark.
const OPS: Op[] = [
  {
    name: "a first turn written back on a conversation with none",
    prepare: async () => {
      const c = await suDb.conversation.create({
        data: conversationData(BACK),
      });
      return { conv: c.id, turn: 0n };
    },
    write: (tx, t) =>
      tx.llmUsage.create({
        data: turnData(
          (t as { conv: bigint }).conv,
          fx.agents[0] as bigint,
          BACK + HOUR,
        ),
      }),
  },
  {
    name: "a second agent's turn on a counted conversation",
    prepare: counted,
    write: (tx, t) =>
      tx.llmUsage.create({
        data: turnData(
          (t as { conv: bigint }).conv,
          fx.agents[1] as bigint,
          BACK + HOUR,
        ),
      }),
  },
  {
    name: "a summed call repriced",
    prepare: counted,
    write: (tx, t) =>
      tx.llmUsage.update({
        where: { id: (t as { turn: bigint }).turn },
        data: { costUsd: 0.37, durationMs: 4_200 },
      }),
  },
  {
    name: "a summed call moved a day back",
    prepare: counted,
    write: (tx, t) =>
      tx.llmUsage.update({
        where: { id: (t as { turn: bigint }).turn },
        data: { createdAt: new Date(BACK - DAY) },
      }),
  },
  {
    name: "a conversation's only turn removed",
    prepare: counted,
    write: (tx, t) =>
      tx.llmUsage.delete({ where: { id: (t as { turn: bigint }).turn } }),
  },
  {
    name: "a conversation written back with its turn",
    prepare: async () => null,
    write: async (tx) => {
      const c = await tx.conversation.create({ data: conversationData(BACK) });
      await tx.llmUsage.create({
        data: turnData(c.id, fx.agents[1] as bigint, BACK + HOUR),
      });
    },
  },
  {
    name: "a counted conversation resolved and relabelled",
    prepare: counted,
    write: (tx, t) =>
      tx.conversation.update({
        where: { id: (t as { conv: bigint }).conv },
        data: { status: "resolved", resolvedBy: "agent", labels: ["vip"] },
      }),
  },
  {
    name: "a counted conversation removed",
    prepare: counted,
    write: (tx, t) =>
      tx.conversation.delete({ where: { id: (t as { conv: bigint }).conv } }),
  },
];

// The base client with a gate before one statement of the job step's transaction: the step stops
// before its statement number `at` (the scope's own setup is 0) until resumed.
function cutAt(base: PrismaClient, at: number) {
  let n = 0;
  let reached: () => void = () => {};
  const reachedP = new Promise<"cut">((r) => {
    reached = () => r("cut");
  });
  let resume: () => void = () => {};
  const resumed = new Promise<void>((r) => {
    resume = r;
  });
  const wrapTx = (tx: object): object =>
    new Proxy(tx, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (
          (p === "$queryRaw" || p === "$executeRaw") &&
          typeof v === "function"
        )
          return async (...args: unknown[]) => {
            if (n++ === at) {
              reached();
              await resumed;
            }
            return v.apply(t, args);
          };
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  const wrap = (c: object): object =>
    new Proxy(c, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "$extends" && typeof v === "function")
          return (...args: unknown[]) => wrap(v.apply(t, args));
        if (p === "$transaction" && typeof v === "function")
          return (fn: (tx: object) => Promise<unknown>, opts?: unknown) =>
            v.call(t, (tx: object) => fn(wrapTx(tx)), opts);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
  return { base: wrap(base) as PrismaClient, reached: reachedP, resume };
}

// A write in a transaction of its own, held open until released once its write is in. `waiting`
// answers whether its connection waits on a lock, which is how the cell tells a write the step holds
// back from one still running.
class RolledBack extends Error {}

// The writes still open, released when a cell fails half way so the file ends.
const stillOpen = new Set<() => void>();

// Each test stops itself a little before the runner's time: a body the runner gives up on keeps
// running beside the next test and rewrites the state that test reads. Every wait of the file
// checks it, and stopping releases the writes still open.
let stopAt = Number.POSITIVE_INFINITY;
function inTime(): void {
  if (Date.now() <= stopAt) return;
  for (const release of stillOpen) release();
  throw new Error(
    "past the test's time: stopped so the next test starts clean",
  );
}
function held(write: (tx: Tx) => Promise<unknown>) {
  let end: (rollBack: boolean) => void = () => {};
  const released = new Promise<boolean>((r) => {
    end = r;
  });
  const release = () => end(false);
  const abort = () => end(true);
  let wrote: () => void = () => {};
  let isWritten = false;
  let failed: (err: unknown) => void = () => {};
  // Rejects when the write's transaction fails before its write is in, so a cell never waits on a
  // write that will not come.
  const written = new Promise<void>((r, reject) => {
    wrote = () => {
      isWritten = true;
      r();
    };
    failed = reject;
  });
  let gotPid: (pid: number) => void = () => {};
  let noPid: (err: unknown) => void = () => {};
  const pid = new Promise<number>((r, reject) => {
    gotPid = r;
    noPid = reject;
  });
  pid.catch(() => undefined);
  const done = wr.$transaction(
    async (tx) => {
      const [me] = await tx.$queryRaw<{ pid: number }[]>(
        Prisma.sql`SELECT pg_backend_pid() AS pid`,
      );
      gotPid((me as { pid: number }).pid);
      await write(tx);
      wrote();
      if (await released) throw new RolledBack();
    },
    { timeout: 60_000, maxWait: 5_000 },
  );
  stillOpen.add(release);
  done.then(
    () => stillOpen.delete(release),
    () => stillOpen.delete(release),
  );
  done.catch((err) => {
    noPid(err);
    if (!isWritten) failed(err);
  });
  written.catch(() => undefined);
  return {
    pid,
    written,
    release,
    abort,
    done: done.catch((err) => {
      if (!(err instanceof RolledBack)) throw err;
    }),
    isWritten: () => isWritten,
  };
}
type Held = ReturnType<typeof held>;

async function waitsOnLock(pid: number): Promise<boolean> {
  const [row] = await suDb.$queryRaw<{ waits: boolean }[]>(Prisma.sql`
    SELECT COALESCE(bool_or(wait_event_type = 'Lock'), false) AS waits
      FROM pg_stat_activity WHERE pid = ${pid}`);
  return Boolean(row?.waits);
}

// The connections, other than the writes', that wait on a lock one of the writes holds: the step.
async function heldBackBy(ws: Held[]): Promise<Held[]> {
  const pids = await Promise.all(ws.map((w) => w.pid));
  const rows = await suDb.$queryRaw<{ blocker: number }[]>(Prisma.sql`
    SELECT DISTINCT unnest(pg_blocking_pids(pid)) AS blocker FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> ALL(${pids}::int[])`);
  const blockers = new Set(rows.map((r) => r.blocker));
  return ws.filter((_, i) => blockers.has(pids[i] as number));
}

// Every write is in, or waits on a lock (of the step: the writes touch rows of their own).
async function settled(ws: Held[]): Promise<void> {
  await until(
    "the writes to be in or to wait on the step",
    async () => {
      inTime();
      for (const w of ws) {
        if (w.isWritten()) continue;
        // A write whose transaction failed surfaces here rather than as a wait that never ends.
        await Promise.race([w.written, Bun.sleep(0)]);
        if (!(await waitsOnLock(await w.pid))) return false;
      }
      return true;
    },
    { everyMs: 5, deadlineMs: 15_000 },
  );
}

// Lets the step run until `stop` resolves, committing at once any write it waits on. Answers what
// `stop` resolved to.
async function drive<T>(stop: Promise<T>, ws: Held[]): Promise<T> {
  let over = false;
  const ran = stop.finally(() => {
    over = true;
  });
  while (!over) {
    inTime();
    for (const w of await heldBackBy(ws)) w.release();
    await Promise.race([ran, Bun.sleep(10)]);
  }
  return ran;
}

// Steps until caught up. The mark waits out the oldest transaction running anywhere on the server,
// so this file needs a server where no other database holds a transaction open for long: on a
// Postgres shared with other checkouts, one of theirs holds the mark back. The deadline sits below
// the per-test time, so such a wait fails here naming the holder (its database, application and
// age), and the test's body does not run on into the next test.
async function sumUp(tenantId: bigint): Promise<void> {
  try {
    await until(
      "the sums to catch up",
      async () => {
        inTime();
        const s = await stepLedgerSums(db, tenantId);
        return s.caughtUp && s.summedUntil !== null;
      },
      { everyMs: 50, deadlineMs: 20_000 },
    );
  } catch (err) {
    // The mark waits for the oldest transaction running on the whole server: the holder is the
    // transaction whose id is oldest, found by the lock every transaction holds on its own id.
    const [lock] = await suDb.$queryRaw<
      { pid: number; xid: string }[]
    >(Prisma.sql`
      SELECT pid, transactionid::text AS xid FROM pg_locks
       WHERE locktype = 'transactionid' AND mode = 'ExclusiveLock' AND pid <> pg_backend_pid()
       ORDER BY age(transactionid) DESC LIMIT 1`);
    const [holder] = lock
      ? await suDb.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
          SELECT datname, application_name, state, backend_xmin::text AS xmin,
                 extract(epoch FROM now() - xact_start)::int AS seconds, left(query, 120) AS query
            FROM pg_stat_activity WHERE pid = ${lock.pid}`)
      : [];
    throw new Error(
      `${(err as Error).message}; the oldest transaction on the server: ${
        lock ? JSON.stringify({ ...lock, ...holder }) : "none with an id"
      }`,
    );
  }
}

const VIEWS: [string, () => DashboardFilter][] = [
  ["all time", () => ({ tz: "UTC" })],
  ["the second agent", () => ({ agentId: fx.agents[1], tz: "UTC" })],
];

async function figures(tenantId: bigint) {
  const out: Record<string, unknown> = {};
  for (const [name, view] of VIEWS) {
    const f = view();
    const c = ctx(tenantId);
    const kpis = await getKpis(c, f, db);
    const costs = await getDashboardCosts(c, f, db, noFetch);
    const byAgent = await getBreakdown(c, f, "agent", db);
    out[name] = { kpis, costs, byAgent };
  }
  return JSON.parse(
    JSON.stringify(out, (_, v) => (typeof v === "bigint" ? String(v) : v)),
  );
}

async function rawFigures(tenantId: bigint) {
  const [state] = await suDb.$queryRaw<
    { summed_until: Date; candidate_at: Date; candidate_xid: string }[]
  >(Prisma.sql`
    DELETE FROM ledger_sums_state WHERE tenant_id = ${tenantId}
    RETURNING summed_until, candidate_at, candidate_xid::text`);
  try {
    return await figures(tenantId);
  } finally {
    if (state)
      await suDb.$executeRaw(Prisma.sql`
        INSERT INTO ledger_sums_state (tenant_id, summed_until, candidate_at, candidate_xid)
        VALUES (${tenantId}, ${state.summed_until}, ${state.candidate_at}, ${state.candidate_xid}::xid8)`);
  }
}

type Shape =
  | "commits in the gap"
  | "open across the step"
  | "begins in the gap";

// One cell: every write, each on rows of its own, against a step cut before statement `at`. Answers
// whether the step reached the cut, which ends the walk over `at` for that shape.
async function cell(shape: Shape, at: number): Promise<boolean> {
  const targets: Awaited<ReturnType<Op["prepare"]>>[] = [];
  for (const op of OPS) targets.push(await op.prepare());
  // Marks of the quarters the writes touch, left for the step to settle: a step settling a quarter
  // while a write lands in it is the case a lost mark would show.
  await counted();
  const start = () =>
    OPS.map((op, i) => held((tx) => op.write(tx, targets[i] ?? null)));
  const endAll = async (ws: Held[]) => {
    for (const w of ws) {
      await w.written;
      w.release();
    }
    await Promise.all(ws.map((w) => w.done));
  };
  const cut = cutAt(db, at);
  const across = shape === "open across the step" ? start() : [];
  await Promise.all(across.map((w) => w.written));
  const step = stepLedgerSums(cut.base, fx.tenantId);
  const reached =
    (await drive(
      Promise.race([cut.reached, step.then(() => "stepped" as const)]),
      across,
    )) === "cut";
  if (!reached) {
    // The step ran whole before the cut: the writes come after it.
    await step;
    await endAll(across.length > 0 ? across : start());
    return false;
  }
  if (shape === "open across the step") {
    cut.resume();
    await drive(step, across);
    await endAll(across);
    return true;
  }
  const ws = start();
  await settled(ws);
  // Committed in the gap: each write that is in commits before the step goes on.
  if (shape === "commits in the gap")
    for (const w of ws)
      if (w.isWritten()) {
        w.release();
        await w.done;
      }
  cut.resume();
  await drive(step, ws);
  await endAll(ws);
  return true;
}

beforeAll(async () => {
  if (!dbUp) return;
  fx = await seedTenant("isums");
  for (let i = 0; i < 6; i++) await counted();
  await sumUp(fx.tenantId);
}, 120_000);

beforeEach(() => {
  stopAt = Date.now() + TEST_TIMEOUT_MS - 3_000;
});

afterEach(() => {
  stopAt = Number.POSITIVE_INFINITY;
  for (const release of stillOpen) release();
});

afterAll(async () => {
  for (const release of stillOpen) release();
  if (dbUp && fx)
    await suDb.tenant
      .delete({ where: { id: fx.tenantId } })
      .catch(() => undefined);
  await su?.$disconnect();
  await app?.$disconnect();
  await writer?.$disconnect();
});

describe.skipIf(!dbUp)("the sums under concurrent writes", () => {
  // Each shape walks the cuts of a step in slices, so every test fits the suite's per-test time,
  // which each test names, since bun applies its default to every file a run takes after the first.
  // The first slice sits inside the step and the last runs past its end, which the walk proves by a
  // step that ends before its cut; a slice between them may meet the end of a shorter step.
  const SLICE = 2;
  const SLICES = 16;
  for (const shape of [
    "commits in the gap",
    "open across the step",
    "begins in the gap",
  ] as const)
    for (let k = 0; k < SLICES; k++)
      test(
        `every write the figures read, ${shape}, at cuts ${k * SLICE} to ${k === SLICES - 1 ? "the end" : (k + 1) * SLICE - 1} of a job step`,
        async () => {
          const last = k === SLICES - 1;
          let ended = false;
          for (
            let at = k * SLICE;
            last ? at < 80 : at < (k + 1) * SLICE;
            at++
          ) {
            inTime();
            const reached = await cell(shape, at);
            expect(
              await figures(fx.tenantId),
              `${shape}, the step cut before its statement ${at}, at once`,
            ).toEqual(await rawFigures(fx.tenantId));
            await sumUp(fx.tenantId);
            expect(
              await figures(fx.tenantId),
              `${shape}, the step cut before its statement ${at}, after the job`,
            ).toEqual(await rawFigures(fx.tenantId));
            if (!reached) {
              ended = true;
              break;
            }
          }
          if (k === 0) expect(ended).toBe(false);
          if (last) expect(ended).toBe(true);
        },
        TEST_TIMEOUT_MS,
      );

  for (const ending of ["commits", "rolls back"] as const)
    test(
      `a step that meets a conversation's removal in flight waits it out, and the removal ${ending}`,
      async () => {
        const deadlocks = async () =>
          (
            await suDb.$queryRaw<{ n: bigint }[]>(Prisma.sql`
            SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()`)
          )[0]?.n ?? 0n;
        const before = await deadlocks();
        const t = await counted();
        // A turn on it below the mark, so the step rebuilds the conversation's runs.
        await suDb.llmUsage.create({
          data: turnData(t.conv, fx.agents[1] as bigint, BACK + HOUR),
        });
        const removal = held((tx) =>
          tx.conversation.delete({ where: { id: t.conv } }),
        );
        await removal.written;
        const step = stepLedgerSums(db, fx.tenantId);
        // The step reaches the conversation and waits on the removal's lock.
        await until(
          "the step to wait on the removal",
          async () => (await heldBackBy([removal])).length > 0,
          { everyMs: 5, deadlineMs: 20_000 },
        );
        if (ending === "commits") removal.release();
        else removal.abort();
        await removal.done;
        await step;
        expect(await figures(fx.tenantId), "at once").toEqual(
          await rawFigures(fx.tenantId),
        );
        await sumUp(fx.tenantId);
        expect(await figures(fx.tenantId), "after the job").toEqual(
          await rawFigures(fx.tenantId),
        );
        const runs = await suDb.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT count(*) AS n FROM conversation_agent_runs WHERE conversation_id = ${t.conv}`);
        expect(Number(runs[0]?.n)).toBe(ending === "commits" ? 0 : 2);
        expect(await deadlocks()).toBe(before);
      },
      TEST_TIMEOUT_MS,
    );
});
