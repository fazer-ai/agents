import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { MetricsTooSlowError } from "@/lib/errors";
import type { ScopedDb, TenantContext } from "@/lib/tenancy";
import { runScopedOn } from "@/lib/tenancy";
import type { DashboardFilter } from "@/modules/analytics/filter";
import { addDays, dayStart, localDay } from "@/modules/analytics/rollup/days";
import {
  alignedDays,
  BLOCK_SECTIONS,
  type Block,
  PART_DAYS,
  partSize,
  partSizeHold,
  resetPartSizes,
  WindowLoad,
} from "@/modules/analytics/rollup/engine";
import { COMPUTE, type Range } from "@/modules/analytics/rollup/sections";
import { settleDirty } from "@/modules/analytics/rollup/store";
import {
  type StreamEvent,
  streamFigures,
} from "@/modules/analytics/rollup/stream";
import {
  filterOfKey,
  recordView,
  spanOf,
  WARM_CHUNK_DAYS,
  warmViews,
  warmWindow,
} from "@/modules/analytics/rollup/warm";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { until } from "../utils/poll";

// KEEPING THE DASHBOARD'S DAYS WARM. A tenant whose old conversations keep changing drops its kept
// days between two visits; the warm-up pass computes them again for the views the console opened, so
// the next opening reads them. And a part that did not fit the budget teaches the next load its size.

setDefaultTimeout(120_000);

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const DAY = 86_400_000;
const TZ = "UTC";
let tenantId = 0n;
let otherTenantId = 0n;

function ctx(t = tenantId): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

async function seedTenant(slug: string, days: number): Promise<bigint> {
  const t = await suDb.tenant.create({
    data: { name: slug, slug: `${slug}-${process.pid}` },
  });
  const inst = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    accountId: 80_000 + (process.pid % 10_000) + (slug === "warm" ? 0 : 1),
    baseUrl: `https://${slug}.cw.example`,
    adminToken: "enc",
  });
  const agent = await suDb.agent.create({
    data: {
      tenantId: t.id,
      name: "Ana",
      systemPrompt: "x",
      modelConfig: { provider: "openai", model: "m1" },
    },
  });
  const inbox = await suDb.inbox.create({
    data: {
      tenantId: t.id,
      chatwootInstanceId: inst.id,
      chatwootInboxId: 1,
      name: "WhatsApp",
      agentId: agent.id,
    },
  });
  const today = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  );
  const ledger: Prisma.LlmUsageCreateManyInput[] = [];
  const logs: Prisma.ExecutionLogCreateManyInput[] = [];
  for (let d = 1; d <= days; d++)
    for (let k = 0; k < 2; k++) {
      const at = new Date(today - d * DAY + (k + 1) * 3_600_000);
      const cid = d * 10 + k;
      const conv = await suDb.conversation.create({
        data: {
          tenantId: t.id,
          chatwootInstanceId: inst.id,
          inboxId: inbox.id,
          chatwootConversationId: cid,
          status: k === 0 ? "resolved" : "open",
          resolvedBy: k === 0 ? "agent" : null,
          threadId: `${t.id}:${inst.id}:${cid}`,
          createdAt: at,
        },
      });
      ledger.push({
        tenantId: t.id,
        agentId: agent.id,
        inboxId: inbox.id,
        conversationId: conv.id,
        source: "inbox",
        model: "gpt-6-luna",
        promptTokens: 100,
        completionTokens: 10,
        costUsd: "0.0100000000",
        durationMs: 500,
        turnId: `t${cid}`,
        createdAt: new Date(at.getTime() + 60_000),
      });
      logs.push({
        tenantId: t.id,
        turnId: `t${cid}`,
        conversationId: conv.id,
        agentId: agent.id,
        inboxId: inbox.id,
        stage: "handoff",
        level: "info",
        status: "ok",
        source: "inbox",
        detail: { outcome: "taken_over" },
        createdAt: new Date(at.getTime() + 120_000),
      });
    }
  await suDb.llmUsage.createMany({ data: ledger });
  await suDb.executionLog.createMany({ data: logs });
  return t.id;
}

function window30(): DashboardFilter {
  const t = localDay(Date.now(), TZ);
  return {
    since: dayStart(addDays(t, -29), TZ),
    until: dayStart(addDays(t, 1), TZ),
    tz: TZ,
  };
}

function previous30(): DashboardFilter {
  const t = localDay(Date.now(), TZ);
  return {
    since: dayStart(addDays(t, -59), TZ),
    until: dayStart(addDays(t, -29), TZ),
    tz: TZ,
  };
}

async function open(
  f: DashboardFilter,
  blocks: Block[] = ["kpis", "costs", "handoffs"],
): Promise<StreamEvent[]> {
  const startedAt = new Date(Date.now() - 1_000);
  const events: StreamEvent[] = [];
  for await (const e of streamFigures(ctx(), f, blocks, undefined, appDb))
    events.push(e);
  // NOTE: The opening is recorded off the stream's path.
  await until("the opening is recorded", () =>
    suDb.dashboardView.findFirst({
      where: { tenantId, openedAt: { gte: startedAt } },
    }),
  );
  return events;
}

async function settleAll(t = tenantId) {
  const settle = (db: ScopedDb) => settleDirty(db, `dashboard-settle|${t}`);
  while ((await runScopedOn(appDb, ctx(t), settle)) > 0);
}

async function reset() {
  await settleAll();
  await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id IN (${tenantId}, ${otherTenantId})`;
  await suDb.$executeRaw`DELETE FROM dashboard_views WHERE tenant_id IN (${tenantId}, ${otherTenantId})`;
  resetPartSizes();
}

// Old conversations of every day of the window and the period before it, reopened and resolved
// again, each with a fresh billed call and a flow-log line: what a day of a busy tenant leaves.
async function churn(fromDaysAgo: number, toDaysAgo: number) {
  await appDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
    await tx.$executeRaw`
      UPDATE conversations SET status = 'resolved', resolved_by = 'human'
       WHERE tenant_id = ${tenantId} AND status = 'open'
         AND created_at BETWEEN now() - make_interval(days => ${fromDaysAgo})
                            AND now() - make_interval(days => ${toDaysAgo})`;
  });
  // NOTE: Queued an hour ago: the part's own check keeps out a change still fresh in the queue.
  await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
}

async function keptCount(t = tenantId): Promise<number> {
  const [r] = await suDb.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM dashboard_days WHERE tenant_id = ${t}`;
  return r?.n ?? 0;
}

async function pendingParts(f: DashboardFilter): Promise<[string, string][]> {
  const w = alignedDays(f);
  if (!w) throw new Error("not aligned");
  const load = new WindowLoad(
    ctx(),
    f,
    [
      ...BLOCK_SECTIONS.kpis,
      ...BLOCK_SECTIONS.costs,
      ...BLOCK_SECTIONS.handoffs,
    ],
    w,
    appDb,
  );
  await load.prepare();
  return load.progress().pending;
}

describe.skipIf(!dbUp)("keeping the dashboard's days warm", () => {
  const idle = config.dashboardWarm.idleDays;

  beforeAll(async () => {
    tenantId = await seedTenant("warm", 70);
    otherTenantId = await seedTenant("cold", 20);
  });

  beforeEach(reset);
  const hold = partSizeHold.ms;
  afterEach(() => {
    config.dashboardWarm.idleDays = idle;
    partSizeHold.ms = hold;
    resetPartSizes();
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const t of [tenantId, otherTenantId]) {
      await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${t}`;
      await suDb.$executeRaw`DELETE FROM dashboard_dirty WHERE tenant_id = ${t}`;
      await suDb.tenant.delete({ where: { id: t } });
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("an opening records its view with the days it spans", async () => {
    await open(window30());
    const views = await suDb.dashboardView.findMany({ where: { tenantId } });
    expect(views.map((v) => [v.filterKey, v.tz, v.spanDays])).toEqual([
      ["||", TZ, 30],
    ]);
  });

  test("after old conversations change, the warm pass computes the dropped days and the next opening computes none of them", async () => {
    await open(window30());
    await open(previous30());
    await churn(58, 2);
    await warmViews(appDb);
    const [queued] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_dirty
       WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
    expect(queued?.n).toBe(0);
    expect(await pendingParts(window30())).toEqual([]);
    expect(await pendingParts(previous30())).toEqual([]);
  });

  test("the warm days answer what a cold computation answers", async () => {
    await open(window30());
    await churn(40, 2);
    await warmViews(appDb);
    const warm = await open(window30());
    await reset();
    const cold = await open(window30());
    const last = (es: StreamEvent[]) => {
      const s = es.filter((e) => e.kind === "snapshot").pop();
      if (s?.kind !== "snapshot") throw new Error("no snapshot");
      return JSON.stringify(s.figures);
    };
    expect(last(warm)).toBe(last(cold));
  });

  test("the warm pass keeps no day of today or yesterday, and nothing for a view never opened or a tenant never visited", async () => {
    await open(window30());
    await warmViews(appDb);
    const today = localDay(Date.now(), TZ);
    const [live] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_days
       WHERE tenant_id = ${tenantId} AND day >= ${addDays(today, -1)}::date`;
    expect(live?.n).toBe(0);
    const [lisbon] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_days
       WHERE tenant_id = ${tenantId} AND (tz <> ${TZ} OR filter_key <> '||')`;
    expect(lisbon?.n).toBe(0);
    expect(await keptCount(otherTenantId)).toBe(0);
    expect(await keptCount()).toBeGreaterThan(0);
  });

  test("a view not opened within the idle days is not warmed", async () => {
    await open(window30());
    await suDb.$executeRaw`UPDATE dashboard_views SET opened_at = now() - interval '3 days' WHERE tenant_id = ${tenantId}`;
    config.dashboardWarm.idleDays = 2;
    await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
    await warmViews(appDb);
    expect(await keptCount()).toBe(0);
    config.dashboardWarm.idleDays = 4;
    await warmViews(appDb);
    expect(await keptCount()).toBeGreaterThan(0);
  });

  test("a pass with nothing changed computes nothing", async () => {
    await open(window30());
    await warmViews(appDb);
    const [before] = await suDb.$queryRaw<{ t: Date | null; n: number }[]>`
      SELECT MAX(computed_at) AS t, COUNT(*)::int AS n FROM dashboard_days WHERE tenant_id = ${tenantId}`;
    const { parts } = await warmViews(appDb);
    const [after] = await suDb.$queryRaw<{ t: Date | null; n: number }[]>`
      SELECT MAX(computed_at) AS t, COUNT(*)::int AS n FROM dashboard_days WHERE tenant_id = ${tenantId}`;
    expect(parts).toBe(0);
    expect(after).toEqual(before as { t: Date | null; n: number });
  });

  test("a view keeps the widest span opened while it is opened, and starts over once idle", async () => {
    const w30 = alignedDays(window30());
    const t = localDay(Date.now(), TZ);
    const w7 = alignedDays({
      since: dayStart(addDays(t, -6), TZ),
      until: dayStart(addDays(t, 1), TZ),
      tz: TZ,
    });
    if (!w30 || !w7) throw new Error("not aligned");
    const span = async () =>
      (await suDb.dashboardView.findFirst({ where: { tenantId } }))?.spanDays;
    await recordView(ctx(), {}, w30, appDb);
    await recordView(ctx(), {}, w7, appDb);
    expect(await span()).toBe(30);
    await recordView(ctx(), {}, { tz: TZ, first: null, last: null }, appDb);
    expect(await span()).toBeNull();
    await suDb.$executeRaw`UPDATE dashboard_views SET opened_at = now() - make_interval(days => ${idle + 1}) WHERE tenant_id = ${tenantId}`;
    await recordView(ctx(), {}, w7, appDb);
    expect(await span()).toBe(7);
  });

  test("a view keeps warm the days it reaches, up to the day before yesterday", () => {
    const now = Date.UTC(2026, 10, 6, 12);
    expect(warmWindow({ tz: TZ, spanDays: 30 }, now)).toEqual({
      tz: TZ,
      first: "2026-10-08",
      last: "2026-11-04",
    });
    expect(warmWindow({ tz: TZ, spanDays: null }, now)).toEqual({
      tz: TZ,
      first: null,
      last: "2026-11-04",
    });
    expect(warmWindow({ tz: TZ, spanDays: 1 }, now)).toBeNull();
  });

  test("a window reaches back to its first day from today, whatever its last day", () => {
    const now = Date.UTC(2026, 10, 6, 12);
    expect(
      spanOf({ tz: TZ, first: "2026-06-01", last: "2026-06-30" }, now),
    ).toBe(159);
    expect(spanOf({ tz: TZ, first: "2026-10-08", last: null }, now)).toBe(30);
    expect(spanOf({ tz: TZ, first: null, last: null }, now)).toBeNull();
  });

  test("a filter key reads back as the filter it was made from", () => {
    expect(filterOfKey("||")).toEqual({});
    expect(filterOfKey("inbox|7|9")).toEqual({
      source: "inbox",
      agentId: 7n,
      inboxId: 9n,
    });
    expect(filterOfKey("client|||anonymous")).toEqual({
      source: "client",
      audience: "anonymous",
    });
  });

  test("a part that did not fit teaches the next cold load its size, and no attempt of that size is thrown away again", async () => {
    const ledger = COMPUTE.ledger;
    const tries: number[] = [];
    COMPUTE.ledger = async (db, s, f, tz, r: Range, out) => {
      const n = Math.round((r.until.getTime() - r.since.getTime()) / DAY);
      tries.push(n);
      if (n > 4) throw new MetricsTooSlowError(15_000);
      return ledger(db, s, f, tz, r, out);
    };
    try {
      await open(window30(), ["costs"]);
      const first = tries.filter((n) => n > 4).length;
      expect(first).toBeGreaterThan(0);
      expect(partSize(tenantId, "ledger")).toBeLessThanOrEqual(4);
      await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
      tries.length = 0;
      await open(window30(), ["costs"]);
      expect(tries.filter((n) => n > 4)).toEqual([]);
    } finally {
      COMPUTE.ledger = ledger;
    }
  });

  test("a part that fits well inside the budget at the learned size lets the next one grow", async () => {
    const ledger = COMPUTE.ledger;
    let refuse = true;
    COMPUTE.ledger = async (db, s, f, tz, r: Range, out) => {
      const n = Math.round((r.until.getTime() - r.since.getTime()) / DAY);
      if (refuse && n > 2) throw new MetricsTooSlowError(15_000);
      return ledger(db, s, f, tz, r, out);
    };
    try {
      await open(window30(), ["costs"]);
      const learned = partSize(tenantId, "ledger");
      expect(learned).toBeLessThanOrEqual(2);
      refuse = false;
      // NOTE: Past the hold that follows a refusal.
      partSizeHold.ms = 0;
      await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
      await open(window30(), ["costs"]);
      expect(partSize(tenantId, "ledger")).toBeGreaterThan(learned);
      expect(partSize(tenantId, "ledger")).toBeLessThanOrEqual(
        PART_DAYS.ledger,
      );
    } finally {
      COMPUTE.ledger = ledger;
    }
  });

  test("a part that fits but takes half the budget or more does not grow the size", async () => {
    const ledger = COMPUTE.ledger;
    const timeout = config.metrics.timeoutMs;
    let refuse = true;
    COMPUTE.ledger = async (db, s, f, tz, r: Range, out) => {
      const n = Math.round((r.until.getTime() - r.since.getTime()) / DAY);
      if (refuse && n > 2) throw new MetricsTooSlowError(15_000);
      if (!refuse) await Bun.sleep(config.metrics.timeoutMs / 2 + 100);
      return ledger(db, s, f, tz, r, out);
    };
    try {
      await open(window30(), ["costs"]);
      const learned = partSize(tenantId, "ledger");
      refuse = false;
      partSizeHold.ms = 0;
      config.metrics.timeoutMs = 2_000;
      await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
      await open(window30(), ["costs"]);
      // NOTE: A part refused on a loaded machine may lower it further; it never grows.
      expect(partSize(tenantId, "ledger")).toBeLessThanOrEqual(learned);
    } finally {
      COMPUTE.ledger = ledger;
      config.metrics.timeoutMs = timeout;
    }
  });

  test("a range in the past is kept warm with everything after it", async () => {
    const t = localDay(Date.now(), TZ);
    const past: DashboardFilter = {
      since: dayStart(addDays(t, -66), TZ),
      until: dayStart(addDays(t, -51), TZ),
      tz: TZ,
    };
    await open(past);
    expect(
      (await suDb.dashboardView.findFirst({ where: { tenantId } }))?.spanDays,
    ).toBe(67);
    await warmViews(appDb);
    expect(await pendingParts(past)).toEqual([]);
  });

  test("a whole-history view is warmed in loads of a bounded number of days", async () => {
    const whole: DashboardFilter = {
      until: dayStart(addDays(localDay(Date.now(), TZ), 1), TZ),
      tz: TZ,
    };
    await open(whole, ["costs"]);
    await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
    const prepare = WindowLoad.prototype.prepare;
    const held: number[] = [];
    const spy = spyOn(WindowLoad.prototype, "prepare").mockImplementation(
      async function (this: WindowLoad, signal?: AbortSignal) {
        await prepare.call(this, signal);
        held.push(this.days.length);
      },
    );
    try {
      await warmViews(appDb);
    } finally {
      spy.mockRestore();
    }
    expect(held.length).toBeGreaterThan(2);
    expect(Math.max(...held)).toBeLessThanOrEqual(WARM_CHUNK_DAYS);
    expect(await pendingParts(whole)).toEqual([]);
  });

  test("a part another request already kept teaches nothing about its size", async () => {
    const ledger = COMPUTE.ledger;
    let refuse = true;
    COMPUTE.ledger = async (db, s, f, tz, r: Range, out) => {
      const n = Math.round((r.until.getTime() - r.since.getTime()) / DAY);
      if (refuse && n > 2) throw new MetricsTooSlowError(15_000);
      return ledger(db, s, f, tz, r, out);
    };
    try {
      await open(window30(), ["costs"]);
      const learned = partSize(tenantId, "ledger");
      refuse = false;
      await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
      const f = window30();
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      const late = new WindowLoad(ctx(), f, BLOCK_SECTIONS.costs, w, appDb);
      await late.prepare();
      const first = new WindowLoad(ctx(), f, BLOCK_SECTIONS.costs, w, appDb);
      await first.prepare();
      while (await first.step());
      expect(partSize(tenantId, "ledger")).toBe(learned);
      // NOTE: Past the hold, the late load finds every part kept and computes nothing.
      partSizeHold.ms = 0;
      while (await late.step());
      expect(partSize(tenantId, "ledger")).toBe(learned);
    } finally {
      COMPUTE.ledger = ledger;
    }
  });
});
