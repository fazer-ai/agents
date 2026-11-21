import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getBreakdown } from "@/modules/analytics/breakdown";
import { getDashboardCosts } from "@/modules/analytics/costs";
import type { DashboardFilter } from "@/modules/analytics/filter";
import { getHealth } from "@/modules/analytics/health";
import {
  bucketMs,
  ensureLedgerSums,
  histogramPercentile,
  ledgerSumsHandler,
  MARKED_QUARTERS_PER_STEP,
  stepLedgerSums,
  ZERO_BUCKET,
} from "@/modules/analytics/ledger-sums";
import { getInstanceMetrics, getTimeseries } from "@/modules/analytics/service";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "@/tests/utils/chatwoot";
import { until } from "@/tests/utils/poll";
import { holdTestTimeout } from "@/tests/utils/timeouts";

// THE LEDGER'S QUARTER-HOUR SUMS (docs/dashboard.md, "Ledger sums"): every ledger block reads the
// same figures from the sums as from the rows, a row written below the mark by any route reaches the
// figures at once, and the job never sums a quarter a still-open transaction can write into. The
// oracle is each reader's own read of the rows, which it takes when the tenant has no sums state.

// These tests outlast bun's 5 s default on a loaded machine, wherever the file runs in a process.
holdTestTimeout();

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
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
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const db = app as PrismaClient;

// The Langfuse link is not under test: a fetch that answers nothing.
const noFetch = (async () => Response.json({})) as unknown as typeof fetch;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
// Five days of calls ending an hour ago: well below any mark the job can reach.
const FIRST = NOW - 5 * DAY;
const LAST = NOW - HOUR;

interface Fx {
  tenantId: bigint;
  agents: bigint[];
  inboxes: bigint[];
  convs: bigint[];
}
let fx: Fx;
let other: Fx;
let seq = 90_000 + (process.pid % 1000) * 50;

const ctx = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)] as T;

async function seedTenant(slug: string): Promise<Fx> {
  const t = await suDb.tenant.create({
    data: { name: slug, slug: `${slug}-${process.pid}` },
  });
  const inst = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    accountId: 70_000 + (seq++ % 10_000) + (process.pid % 1000) * 10,
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
            agentId: agents[n - 1] as bigint,
          },
        })
      ).id,
    );
  const convs: bigint[] = [];
  for (let i = 0; i < 6; i++) {
    const n = seq++;
    convs.push(
      (
        await suDb.conversation.create({
          data: {
            tenantId: t.id,
            chatwootInstanceId: inst.id,
            inboxId: inboxes[i % 2] as bigint,
            chatwootConversationId: n,
            status: "open",
            threadId: `${t.id}:${inst.id}:${n}`,
            createdAt: new Date(FIRST - HOUR),
          },
        })
      ).id,
    );
  }
  return { tenantId: t.id, agents, inboxes, convs };
}

// Calls of every shape a figure reads: agents, inboxes, none of them, every source and audience,
// models and call types, unpriced and free calls, timed and untimed.
async function seedCalls(f: Fx, seed: number, count: number) {
  const r = rng(seed);
  const rows: Prisma.LlmUsageCreateManyInput[] = [];
  for (let i = 0; i < count; i++) {
    const source = pick(r, ["inbox", "inbox", "playground", "client"]);
    const priced = r();
    rows.push({
      tenantId: f.tenantId,
      agentId: r() < 0.1 ? null : pick(r, f.agents),
      inboxId: source === "inbox" ? pick(r, f.inboxes) : null,
      conversationId: source === "inbox" ? pick(r, f.convs) : null,
      source,
      anonymous: source === "client" && r() < 0.5,
      model: pick(r, ["m1", "m2", "m3"]),
      node: pick(r, [null, "agent", "vision", "observer"]),
      promptTokens: Math.floor(r() * 2000),
      completionTokens: Math.floor(r() * 500),
      cachedReadTokens: Math.floor(r() * 300),
      cacheCreationTokens: Math.floor(r() * 50),
      durationMs: r() < 0.2 ? null : 50 + Math.floor(r() * 9000),
      costUsd:
        priced < 0.1 ? null : priced < 0.15 ? 0 : Math.round(r() * 1e6) / 1e8,
      createdAt: new Date(FIRST + Math.floor(r() * (LAST - FIRST))),
    });
  }
  await suDb.llmUsage.createMany({ data: rows });
}

// Steps the job until its sums reach the latest mark it can take: the first step only takes a
// candidate, and a step waits while a transaction older than the candidate is still open.
// Steps until caught up. A transaction of another test file, open on the same server, holds the
// mark back while it lasts, so a step that waits on one is retried a moment later.
async function sumUp(tenantId: bigint): Promise<void> {
  await until(
    "the sums to catch up",
    async () => {
      const s = await stepLedgerSums(db, tenantId);
      return s.caughtUp && s.summedUntil !== null;
    },
    { everyMs: 50, deadlineMs: 60_000 },
  );
}

async function summedUntil(tenantId: bigint): Promise<Date | null> {
  const [row] = await suDb.$queryRaw<{ at: Date | null }[]>(Prisma.sql`
    SELECT summed_until AS at FROM ledger_sums_state WHERE tenant_id = ${tenantId}`);
  return row?.at ?? null;
}

// Every ledger block of a view, as the console asks for it.
async function blocks(tenantId: bigint, f: DashboardFilter) {
  const costs = await getDashboardCosts(ctx(tenantId), f, db, noFetch);
  const breakdown = Object.fromEntries(
    await Promise.all(
      (["agent", "inbox", "model", "node"] as const).map(async (d) => [
        d,
        await getBreakdown(ctx(tenantId), f, d, db),
      ]),
    ),
  );
  const health = (await getHealth(ctx(tenantId), f, db)).latency;
  const metrics = (await getInstanceMetrics(ctx(tenantId), f, db)).llm;
  const series = await getTimeseries(ctx(tenantId), f, db);
  return JSON.parse(
    JSON.stringify({ costs, breakdown, health, metrics, series }, (_, v) =>
      typeof v === "bigint" ? String(v) : v,
    ),
  );
}

// The same blocks read from the rows: the tenant's state is moved aside for the read.
async function rawBlocks(tenantId: bigint, f: DashboardFilter) {
  const [state] = await suDb.$queryRaw<
    { summed_until: Date; candidate_at: Date; candidate_xid: string }[]
  >(Prisma.sql`
    DELETE FROM ledger_sums_state WHERE tenant_id = ${tenantId}
    RETURNING summed_until, candidate_at, candidate_xid::text`);
  try {
    return await blocks(tenantId, f);
  } finally {
    if (state)
      await suDb.$executeRaw(Prisma.sql`
        INSERT INTO ledger_sums_state (tenant_id, summed_until, candidate_at, candidate_xid)
        VALUES (${tenantId}, ${state.summed_until}, ${state.candidate_at}, ${state.candidate_xid}::xid8)`);
  }
}

const VIEWS: [string, () => DashboardFilter][] = [
  [
    "three local days",
    () => ({
      since: new Date(Math.floor((NOW - 4 * DAY) / DAY) * DAY + 3 * HOUR),
      until: new Date(Math.floor((NOW - DAY) / DAY) * DAY + 3 * HOUR),
      tz: "America/Sao_Paulo",
    }),
  ],
  [
    "a window cut off the quarter hour, running to now",
    () => ({
      since: new Date(FIRST + 7 * 60_000 + 13_000),
      tz: "Asia/Kathmandu",
    }),
  ],
  ["all time", () => ({ tz: "UTC" })],
  [
    "one agent's real traffic",
    () => ({
      since: new Date(FIRST),
      agentId: fx.agents[0],
      source: "inbox",
    }),
  ],
  ["one inbox", () => ({ since: new Date(FIRST), inboxId: fx.inboxes[1] })],
  [
    "anonymous client traffic",
    () => ({ since: new Date(FIRST), audience: "anonymous" }),
  ],
];

beforeAll(async () => {
  if (!dbUp) return;
  fx = await seedTenant("lsums");
  other = await seedTenant("lsums-other");
  await seedCalls(fx, 11, 900);
  await seedCalls(other, 12, 400);
  await sumUp(fx.tenantId);
  await sumUp(other.tenantId);
}, 120_000);

afterAll(async () => {
  if (dbUp) {
    for (const f of [fx, other])
      if (f)
        await suDb.tenant
          .delete({ where: { id: f.tenantId } })
          .catch(() => undefined);
  }
  await su?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!dbUp)("the ledger's quarter-hour sums", () => {
  test("the job sums the tenant's ledger up to a mark below now, and only its own", async () => {
    const until = (await summedUntil(fx.tenantId)) as Date;
    expect(until.getTime()).toBeGreaterThan(LAST);
    expect(until.getTime()).toBeLessThan(Date.now());
    const [counts] = await suDb.$queryRaw<{ mine: number; theirs: number }[]>(
      Prisma.sql`
      SELECT COALESCE(SUM(requests) FILTER (WHERE tenant_id = ${fx.tenantId}), 0)::int AS mine,
             COALESCE(SUM(requests) FILTER (WHERE tenant_id = ${other.tenantId}), 0)::int AS theirs
        FROM ledger_quarter_sums`,
    );
    expect(counts).toEqual({ mine: 900, theirs: 400 });
  });

  for (const [name, view] of VIEWS)
    test(`every ledger block reads the same from the sums as from the rows: ${name}`, async () => {
      expect(await blocks(fx.tenantId, view())).toEqual(
        await rawBlocks(fx.tenantId, view()),
      );
    });

  for (const [name, view] of VIEWS.slice(0, 2))
    test(`the cost of each local day is that day's priced calls: ${name}`, async () => {
      const f = view();
      const tz = f.tz as string;
      const expected = await suDb.$queryRaw<{ date: string; cost: number }[]>(
        Prisma.sql`SELECT to_char(created_at AT TIME ZONE 'UTC' AT TIME ZONE ${tz}::text, 'YYYY-MM-DD') AS date,
                          SUM(cost_usd)::float8 AS cost
                     FROM llm_usage
                    WHERE tenant_id = ${fx.tenantId} AND cost_usd IS NOT NULL
                      AND created_at >= ${f.since} AND created_at < ${f.until ?? new Date()}
                    GROUP BY 1 ORDER BY 1`,
      );
      const costs = await getDashboardCosts(ctx(fx.tenantId), f, db, noFetch);
      const read = costs.days
        .filter(
          (d) => d.costUsd !== 0 || expected.some((e) => e.date === d.date),
        )
        .map((d) => [d.date, Number(d.costUsd.toFixed(9))]);
      expect(read).toEqual(
        expected.map((e) => [e.date, Number(e.cost.toFixed(9))]),
      );
    });

  test("a call written days back, after its quarter was summed, is in the figures at once and after the next run", async () => {
    const at = new Date(NOW - 3 * DAY + 7 * 60_000);
    const view = { since: new Date(FIRST), tz: "UTC" };
    const before = (await blocks(fx.tenantId, view)).costs.requests;
    await suDb.llmUsage.create({
      data: {
        tenantId: fx.tenantId,
        source: "inbox",
        model: "m-late",
        costUsd: 1.5,
        createdAt: at,
      },
    });
    const marked = await suDb.ledgerSumMark.count({
      where: { tenantId: fx.tenantId },
    });
    expect(marked).toBeGreaterThan(0);
    const now = await blocks(fx.tenantId, view);
    expect(now.costs.requests).toBe(before + 1);
    expect(now).toEqual(await rawBlocks(fx.tenantId, view));
    await sumUp(fx.tenantId);
    expect(
      await suDb.ledgerSumMark.count({ where: { tenantId: fx.tenantId } }),
    ).toBe(0);
    expect(await blocks(fx.tenantId, view)).toEqual(now);
  });

  test("a call written by an app whose clock runs behind by more than the grace still reaches the figures", async () => {
    // The row's instant is the app's, ten minutes before the database's own clock: below what the
    // last run may have summed.
    await sumUp(fx.tenantId);
    const until = (await summedUntil(fx.tenantId)) as Date;
    const at = new Date(until.getTime() - 60_000);
    const view = { since: new Date(FIRST), tz: "UTC" };
    const before = (await blocks(fx.tenantId, view)).costs.requests;
    await suDb.llmUsage.create({
      data: {
        tenantId: fx.tenantId,
        source: "inbox",
        model: "m-behind",
        costUsd: 0.25,
        createdAt: at,
      },
    });
    expect((await blocks(fx.tenantId, view)).costs.requests).toBe(before + 1);
    await sumUp(fx.tenantId);
    const after = await blocks(fx.tenantId, view);
    expect(after.costs.requests).toBe(before + 1);
    expect(after).toEqual(await rawBlocks(fx.tenantId, view));
  });

  test("the mark does not move while a transaction older than the candidate is open, and moves once it commits", async () => {
    const t = await seedTenant("lsums-open");
    try {
      // A transaction with an id, open across two runs: its row lands in a quarter the job would
      // otherwise sum.
      let release: () => void = () => {};
      const released = new Promise<void>((r) => {
        release = r;
      });
      let wrote: () => void = () => {};
      const written = new Promise<void>((r) => {
        wrote = r;
      });
      const open = suDb.$transaction(
        async (tx) => {
          await tx.llmUsage.create({
            data: {
              tenantId: t.tenantId,
              source: "inbox",
              model: "m-open",
              costUsd: 2,
            },
          });
          wrote();
          await released;
        },
        { timeout: 60_000, maxWait: 5_000 },
      );
      await written;
      await stepLedgerSums(db, t.tenantId);
      const held = await stepLedgerSums(db, t.tenantId);
      await stepLedgerSums(db, t.tenantId);
      expect(held.summedUntil).toBeNull();
      expect(await summedUntil(t.tenantId)).toBeNull();
      release();
      await open;
      await sumUp(t.tenantId);
      expect(await summedUntil(t.tenantId)).not.toBeNull();
      const view = { tz: "UTC" };
      const figures = await blocks(t.tenantId, view);
      expect(figures.costs.requests).toBe(1);
      expect(figures).toEqual(await rawBlocks(t.tenantId, view));
    } finally {
      await suDb.tenant.delete({ where: { id: t.tenantId } });
    }
  });

  test("transactions that overlap without end do not hold the mark back forever", async () => {
    const t = await seedTenant("lsums-overlap");
    // A transaction with an id, open until released.
    const openTx = async (model: string) => {
      let release: () => void = () => {};
      const released = new Promise<void>((r) => {
        release = r;
      });
      let wrote: () => void = () => {};
      const written = new Promise<void>((r) => {
        wrote = r;
      });
      const done = suDb.$transaction(
        async (tx) => {
          await tx.llmUsage.create({
            data: { tenantId: t.tenantId, source: "inbox", model, costUsd: 1 },
          });
          wrote();
          await released;
        },
        { timeout: 60_000, maxWait: 5_000 },
      );
      await written;
      return { release, done };
    };
    try {
      const a = await openTx("m-a");
      await stepLedgerSums(db, t.tenantId);
      // B begins after the candidate, while A, older than it, is still open.
      const b = await openTx("m-b");
      await stepLedgerSums(db, t.tenantId);
      a.release();
      await a.done;
      // A has ended and B is younger than the candidate: the mark moves, though B is still open.
      await stepLedgerSums(db, t.tenantId);
      expect(await summedUntil(t.tenantId)).not.toBeNull();
      b.release();
      await b.done;
    } finally {
      await suDb.tenant.delete({ where: { id: t.tenantId } });
    }
  });

  test("a job step that waits on an older open transaction gives its time back instead of polling", async () => {
    const t = await seedTenant("lsums-wait");
    await suDb.llmUsage.create({
      data: {
        tenantId: t.tenantId,
        source: "inbox",
        model: "m-w",
        costUsd: 1,
        createdAt: new Date(NOW - DAY),
      },
    });
    await sumUp(t.tenantId);
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    let wrote: () => void = () => {};
    const written = new Promise<void>((r) => {
      wrote = r;
    });
    const open = suDb.$transaction(
      async (tx) => {
        await tx.llmUsage.create({
          data: {
            tenantId: t.tenantId,
            source: "inbox",
            model: "m-w",
            costUsd: 1,
          },
        });
        wrote();
        await released;
      },
      { timeout: 60_000, maxWait: 5_000 },
    );
    try {
      await written;
      // A candidate taken while the transaction is open, which the handler then waits on.
      await stepLedgerSums(db, t.tenantId);
      expect(await summedUntil(t.tenantId)).not.toBeNull();
      const started = Date.now();
      const result = await ledgerSumsHandler(
        { tenantId: t.tenantId } as unknown as ClaimedJob,
        db,
      );
      expect(result.outcome).toBe("reschedule");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      release();
      await open;
      await suDb.tenant.delete({ where: { id: t.tenantId } });
    }
  });

  test("a run cut short with work left runs again at once, and a run that is done waits", async () => {
    const t = await seedTenant("lsums-rerun");
    try {
      await seedCalls(t, 3, 300);
      await sumUp(t.tenantId);
      // A repricing marks more quarters than one step settles.
      await suDb.$executeRaw(Prisma.sql`
        UPDATE llm_usage SET cost_usd = COALESCE(cost_usd, 0) + 1 WHERE tenant_id = ${t.tenantId}`);
      expect(
        await suDb.ledgerSumMark.count({ where: { tenantId: t.tenantId } }),
      ).toBeGreaterThan(MARKED_QUARTERS_PER_STEP);
      // The run is stopped after its first step, as a spent budget stops it.
      let checks = 0;
      const signal = {
        get aborted() {
          return checks++ > 0;
        },
      } as AbortSignal;
      const job = { tenantId: t.tenantId } as unknown as ClaimedJob;
      const cut = await ledgerSumsHandler(job, db, { signal } as never);
      expect(
        cut.outcome === "reschedule" && cut.runAt.getTime(),
      ).toBeLessThanOrEqual(Date.now());
      await sumUp(t.tenantId);
      const done = await ledgerSumsHandler(job, db);
      expect(
        done.outcome === "reschedule" && done.runAt.getTime(),
      ).toBeGreaterThan(Date.now() + 30_000);
    } finally {
      await suDb.tenant.delete({ where: { id: t.tenantId } });
    }
  });

  test("calls of zero milliseconds keep a bucket of their own", async () => {
    const t = await seedTenant("lsums-zero");
    try {
      const at = new Date(NOW - 2 * DAY);
      await suDb.llmUsage.createMany({
        data: [...Array(9).fill(0), 1].map((ms: number) => ({
          tenantId: t.tenantId,
          source: "inbox",
          model: "m-zero",
          durationMs: ms,
          createdAt: at,
        })),
      });
      await sumUp(t.tenantId);
      const view = { since: new Date(FIRST), tz: "UTC" };
      const health = await getHealth(ctx(t.tenantId), view, db);
      const row = health.latency.find((r) => r.model === "m-zero");
      expect(row?.p50Ms).toBe(0);
      expect((await blocks(t.tenantId, view)).health).toEqual(
        (await rawBlocks(t.tenantId, view)).health,
      );
    } finally {
      await suDb.tenant.delete({ where: { id: t.tenantId } });
    }
  });

  test("a tenant whose first row is stamped ahead of the safe mark starts no further than it", async () => {
    const t = await suDb.tenant.create({
      data: { name: "lsums-ahead", slug: `lsums-ahead-${process.pid}` },
    });
    try {
      await suDb.llmUsage.create({
        data: {
          tenantId: t.id,
          source: "inbox",
          model: "m-ahead",
          costUsd: 1,
          createdAt: new Date(NOW + DAY),
        },
      });
      await sumUp(t.id);
      const at = await summedUntil(t.id);
      expect(at).not.toBeNull();
      expect((at as Date).getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      await suDb.tenant.delete({ where: { id: t.id } });
    }
  });

  test("a re-price, a removal and a move of summed calls are in the figures at once and after the next run", async () => {
    const view = { since: new Date(FIRST), tz: "America/Sao_Paulo" };
    await suDb.$executeRaw(Prisma.sql`
      UPDATE llm_usage SET cost_usd = cost_usd * 2
       WHERE tenant_id = ${fx.tenantId} AND model = 'm2' AND cost_usd IS NOT NULL`);
    // A call moved to another day leaves the quarter it was summed in as well as reaching its new one.
    expect(
      await suDb.$executeRaw(Prisma.sql`
        UPDATE llm_usage SET created_at = created_at + interval '1 day'
         WHERE id IN (SELECT id FROM llm_usage WHERE tenant_id = ${fx.tenantId} AND model = 'm1'
                         AND created_at < ${new Date(NOW - 3 * DAY)} ORDER BY id LIMIT 20)`),
    ).toBe(20);
    await suDb.$executeRaw(Prisma.sql`
      DELETE FROM llm_usage WHERE tenant_id = ${fx.tenantId} AND model = 'm3' AND node = 'vision'`);
    const now = await blocks(fx.tenantId, view);
    expect(now).toEqual(await rawBlocks(fx.tenantId, view));
    await sumUp(fx.tenantId);
    expect(
      await suDb.ledgerSumMark.count({ where: { tenantId: fx.tenantId } }),
    ).toBe(0);
    expect(await blocks(fx.tenantId, view)).toEqual(now);
  });

  test("a repricing of more quarters than a step settles is settled over steps, right all along", async () => {
    const view = { since: new Date(FIRST), tz: "America/Sao_Paulo" };
    await suDb.$executeRaw(Prisma.sql`
      UPDATE llm_usage SET cost_usd = cost_usd * 3
       WHERE tenant_id = ${fx.tenantId} AND cost_usd IS NOT NULL AND created_at < ${new Date(NOW - DAY)}`);
    const marked = async () => {
      const [r] = await suDb.$queryRaw<{ n: number }[]>(Prisma.sql`
        SELECT COUNT(DISTINCT quarter)::int AS n FROM ledger_sum_marks WHERE tenant_id = ${fx.tenantId}`);
      return r?.n ?? 0;
    };
    const before = await marked();
    expect(before).toBeGreaterThan(MARKED_QUARTERS_PER_STEP);
    // A step takes the marked quarters of the earliest marked UTC day, and no other day.
    const [first] = await suDb.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(DISTINCT quarter)::int AS n FROM ledger_sum_marks
       WHERE tenant_id = ${fx.tenantId}
         AND date_trunc('day', quarter) = (SELECT date_trunc('day', min(quarter)) FROM ledger_sum_marks
                                            WHERE tenant_id = ${fx.tenantId})`);
    await stepLedgerSums(db, fx.tenantId);
    expect(await marked()).toBe(before - (first?.n ?? 0));
    const now = await blocks(fx.tenantId, view);
    expect(now).toEqual(await rawBlocks(fx.tenantId, view));
    await sumUp(fx.tenantId);
    expect(await marked()).toBe(0);
    expect(await blocks(fx.tenantId, view)).toEqual(now);
  });

  test("a step settles the marks of one day, however sparse the marked days", async () => {
    // One row a day repriced, on every day of the ledger: one marked quarter per day.
    await suDb.$executeRaw(Prisma.sql`
      UPDATE llm_usage SET cost_usd = COALESCE(cost_usd, 0) + 1
       WHERE id IN (SELECT DISTINCT ON (date_trunc('day', created_at)) id FROM llm_usage
                     WHERE tenant_id = ${fx.tenantId} AND created_at < ${new Date(NOW - DAY)}
                     ORDER BY date_trunc('day', created_at), id)`);
    const days = async () => {
      const [r] = await suDb.$queryRaw<{ n: number }[]>(Prisma.sql`
        SELECT COUNT(DISTINCT date_trunc('day', quarter))::int AS n FROM ledger_sum_marks
         WHERE tenant_id = ${fx.tenantId}`);
      return r?.n ?? 0;
    };
    const before = await days();
    expect(before).toBeGreaterThan(2);
    await stepLedgerSums(db, fx.tenantId);
    expect(await days()).toBe(before - 1);
    await sumUp(fx.tenantId);
    const view = { since: new Date(FIRST), tz: "UTC" };
    expect(await blocks(fx.tenantId, view)).toEqual(
      await rawBlocks(fx.tenantId, view),
    );
  });

  test("a removed tenant takes its sums and marks with it", async () => {
    const t = await seedTenant("lsums-gone");
    await seedCalls(t, 13, 50);
    await sumUp(t.tenantId);
    await suDb.tenant.delete({ where: { id: t.tenantId } });
    const [left] = await suDb.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT ((SELECT COUNT(*) FROM ledger_quarter_sums WHERE tenant_id = ${t.tenantId})
            + (SELECT COUNT(*) FROM ledger_latency_days WHERE tenant_id = ${t.tenantId})
            + (SELECT COUNT(*) FROM ledger_sum_marks WHERE tenant_id = ${t.tenantId})
            + (SELECT COUNT(*) FROM ledger_sums_state WHERE tenant_id = ${t.tenantId}))::int AS n`);
    expect(left?.n).toBe(0);
  });

  test("a tenant's job is armed once, however often it is asked for", async () => {
    await ensureLedgerSums(fx.tenantId, suDb);
    await ensureLedgerSums(fx.tenantId, suDb);
    const jobs = await suDb.schedulerJob.count({
      where: { tenantId: fx.tenantId, kind: "LEDGER_SUMS" },
    });
    expect(jobs).toBe(1);
  });
});

describe("a percentile read from the latency histogram", () => {
  test("is within the bucket's half width of percentile_cont over the exact values", () => {
    const r = rng(7);
    for (let round = 0; round < 50; round++) {
      const values = Array.from({ length: 1 + Math.floor(r() * 400) }, () =>
        Math.max(2, Math.floor(r() ** 3 * 60_000)),
      );
      const buckets = new Map<
        number,
        { bucket: number; calls: number; min: number; max: number }
      >();
      for (const v of values) {
        const b = 1 + Math.floor(Math.log(v) / Math.log(1.05));
        const at = buckets.get(b) ?? { bucket: b, calls: 0, min: v, max: v };
        at.calls += 1;
        at.min = Math.min(at.min, v);
        at.max = Math.max(at.max, v);
        buckets.set(b, at);
      }
      const hist = [...buckets.values()];
      const sorted = [...values].sort((a, b) => a - b);
      for (const p of [0.5, 0.9]) {
        const pos = p * (sorted.length - 1);
        const lo = sorted[Math.floor(pos)] as number;
        const hi = sorted[Math.ceil(pos)] as number;
        // `percentile_cont`'s reading of the exact values.
        const exact = lo + (pos - Math.floor(pos)) * (hi - lo);
        const read = histogramPercentile(hist, p) as number;
        expect(Math.abs(read - exact) / exact).toBeLessThanOrEqual(0.026);
      }
    }
    expect(histogramPercentile([], 0.5)).toBeNull();
    expect(bucketMs(ZERO_BUCKET)).toBe(0);
  });

  test("reads durations below one second, and zero, apart", () => {
    const bucketOf = (s: number) =>
      s <= 0 ? ZERO_BUCKET : 1 + Math.floor(Math.log(s) / Math.log(1.05));
    const values = [0, 0.1, 0.1, 0.5, 0.9, 0.9];
    const buckets = new Map<
      number,
      { bucket: number; calls: number; min: number; max: number }
    >();
    for (const v of values) {
      const b = bucketOf(v);
      const at = buckets.get(b) ?? { bucket: b, calls: 0, min: v, max: v };
      at.calls += 1;
      at.min = Math.min(at.min, v);
      at.max = Math.max(at.max, v);
      buckets.set(b, at);
    }
    // percentile_cont(0.5) over the values: between 0.1 and 0.5.
    expect(histogramPercentile([...buckets.values()], 0.5)).toBeCloseTo(0.3, 9);
    expect(histogramPercentile([...buckets.values()], 0)).toBe(0);
  });

  test("reads a bucket that holds one value as that value", () => {
    const one = { bucket: 84, calls: 3, min: 60, max: 60 };
    expect(histogramPercentile([one], 0.5)).toBe(60);
    expect(histogramPercentile([one], 0.9)).toBe(60);
  });
});
