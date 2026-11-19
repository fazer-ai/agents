import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { getHandoffReasons } from "@/modules/analytics/activity";
import { getDashboardCosts } from "@/modules/analytics/costs";
import { addDays, dayStart } from "@/modules/analytics/days";
import type { DashboardFilter } from "@/modules/analytics/filter";
import { grainOfDays, groupOf, windowDays } from "@/modules/analytics/grain";
import { stepLedgerSums } from "@/modules/analytics/ledger-sums";
import { getTimeseries } from "@/modules/analytics/service";
import { getOutcomeTrend } from "@/modules/analytics/trends";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { metricsTimeseries } from "@/modules/mcp/read";
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";
import { seedChatwootInstance } from "../utils/chatwoot";

// LONG WINDOWS ARE GROUPED BY WEEK OR BY MONTH. Up to 92 local days a series has a point per day,
// up to 730 one per local week starting on Monday, past that one per local month, and every route
// says which it used. A group's figure is the figure of the group's own days read at once, so a
// conversation seen on two days of one week counts once in that week, as it would in a one-week view.

describe("the grain a window takes", () => {
  test("day up to 92 days, week up to 730, month past that", () => {
    expect(grainOfDays(1)).toBe("day");
    expect(grainOfDays(92)).toBe("day");
    expect(grainOfDays(93)).toBe("week");
    expect(grainOfDays(730)).toBe("week");
    expect(grainOfDays(731)).toBe("month");
  });

  test("a window's days are the local days it covers", () => {
    const tz = "America/Sao_Paulo";
    const since = dayStart("2026-01-01", tz);
    expect(windowDays(since, dayStart("2026-01-02", tz), tz)).toBe(1);
    expect(windowDays(since, dayStart("2026-04-04", tz), tz)).toBe(93);
    // Ending mid-day counts the day it ends in.
    expect(
      windowDays(since, new Date(dayStart("2026-01-03", tz).getTime() + 1), tz),
    ).toBe(3);
    expect(windowDays(since, since, tz)).toBe(0);
  });

  test("a day's group starts on Monday, or on the first of the month", () => {
    expect(groupOf("2026-03-09", "week")).toBe("2026-03-09");
    expect(groupOf("2026-03-15", "week")).toBe("2026-03-09");
    expect(groupOf("2026-03-16", "week")).toBe("2026-03-16");
    // A week crossing a year.
    expect(groupOf("2026-01-01", "week")).toBe("2025-12-29");
    expect(groupOf("2026-03-15", "month")).toBe("2026-03-01");
    expect(groupOf("2026-03-15", "day")).toBe("2026-03-15");
  });
});

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

const SP = "America/Sao_Paulo";
const noFetch = (() => {
  throw new Error("no network in this test");
}) as unknown as typeof fetch;

const ctx = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// The local days `first` to `last`, both inclusive, as the console sends them.
function view(first: string, last: string, tz: string): DashboardFilter {
  return {
    since: dayStart(first, tz),
    until: dayStart(addDays(last, 1), tz),
    tz,
  };
}

// 365 local days ending on Wednesday 2026-03-18.
const YEAR = (tz: string) => view("2025-03-19", "2026-03-18", tz);

let tenant = 0n;
let empty = 0n;
let seq = 7000 + (process.pid % 1000) * 10;

describe.skipIf(!dbUp)("grouped series (DB)", () => {
  const keptDays = config.flowlog.retentionDays;

  beforeAll(async () => {
    config.flowlog.retentionDays = 100_000;
    const mk = async (name: string) =>
      (
        await suDb.tenant.create({
          data: { name, slug: `${name}-${process.pid}` },
        })
      ).id;
    tenant = await mk("grain");
    empty = await mk("grain-empty");
    const inst = await seedChatwootInstance(suDb, {
      tenantId: tenant,
      accountId: 60_000 + (process.pid % 10_000),
      baseUrl: "https://grain.cw.example",
      adminToken: "enc",
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "Ana",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "m1" },
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 1,
        name: "WhatsApp",
        agentId: agent.id,
      },
    });
    const conv = async (at: string, handoff = false) => {
      const n = seq++;
      return (
        await suDb.conversation.create({
          data: {
            tenantId: tenant,
            chatwootInstanceId: inst.id,
            inboxId: inbox.id,
            chatwootConversationId: n,
            status: "open",
            threadId: `${tenant}:${inst.id}:${n}`,
            createdAt: new Date(at),
            lastEventAt: new Date(at),
            ...(handoff ? { assigneeType: "User", assigneeId: 7 } : {}),
          },
        })
      ).id;
    };
    const usage = (conversationId: bigint, at: string, cost: number) =>
      suDb.llmUsage.create({
        data: {
          tenantId: tenant,
          agentId: agent.id,
          inboxId: inbox.id,
          conversationId,
          source: "inbox",
          model: "m1",
          node: "agent",
          promptTokens: 10,
          completionTokens: 1,
          costUsd: cost,
          createdAt: new Date(at),
        },
      });
    const handoff = (conversationId: bigint, at: string) =>
      suDb.executionLog.create({
        data: {
          tenantId: tenant,
          turnId: crypto.randomUUID(),
          conversationId,
          agentId: agent.id,
          inboxId: inbox.id,
          stage: "tool",
          level: "info",
          status: "ok",
          source: "inbox",
          detail: { tool: "handoff_to_human", args: {} },
          createdAt: new Date(at),
        },
      });
    // Monday 2026-03-09 and Wednesday 2026-03-11, 10:00 in Sao Paulo.
    const x = await conv("2026-03-09T13:00:00Z");
    const y = await conv("2026-03-11T13:00:00Z", true);
    await usage(x, "2026-03-09T13:00:00Z", 1);
    await usage(x, "2026-03-11T13:00:00Z", 2);
    await usage(y, "2026-03-11T13:00:00Z", 4);
    // Sunday 23:30 in Sao Paulo, already Monday in UTC.
    await usage(y, "2026-03-16T02:30:00Z", 8);
    // Monday 00:30 in Sao Paulo.
    await usage(x, "2026-03-16T03:30:00Z", 16);
    // The tenant's first record, over a year before the end of the views.
    const o = await conv("2025-02-10T13:00:00Z");
    await usage(o, "2025-02-10T13:00:00Z", 32);
    // The same conversation handed over twice in one Sao Paulo week.
    await handoff(y, "2026-03-11T13:00:00Z");
    await handoff(y, "2026-03-16T02:30:00Z");
  });

  afterAll(async () => {
    config.flowlog.retentionDays = keptDays;
    for (const id of [tenant, empty]) {
      if (!id) continue;
      for (const table of [
        "execution_logs",
        "llm_usage",
        "conversations",
        "inboxes",
        "agents",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${id}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a year of costs is grouped by local week, each week one read of its days", async () => {
    const c = await getDashboardCosts(ctx(tenant), YEAR(SP), appDb, noFetch);
    expect(c.grain).toBe("week");
    for (const d of c.days) expect(groupOf(d.date, "week")).toBe(d.date);
    const w1 = c.days.find((d) => d.date === "2026-03-09");
    const w2 = c.days.find((d) => d.date === "2026-03-16");
    expect(w1?.costUsd).toBeCloseTo(15, 6);
    // The divisor is the funnel's: the two conversations created that week, none the next.
    expect(w1?.conversations).toBe(2);
    expect(w2?.costUsd).toBeCloseTo(16, 6);
    expect(w2?.conversations).toBe(0);
    expect(c.days.reduce((s, d) => s + (d.costUsd ?? 0), 0)).toBeCloseTo(
      c.totalCostUsd,
      6,
    );
  });

  test("the week is the viewer's: a Sunday night in Sao Paulo is Monday in UTC", async () => {
    const c = await getDashboardCosts(ctx(tenant), YEAR("UTC"), appDb, noFetch);
    expect(c.grain).toBe("week");
    expect(c.days.find((d) => d.date === "2026-03-09")?.costUsd).toBeCloseTo(
      7,
      6,
    );
    expect(c.days.find((d) => d.date === "2026-03-16")?.costUsd).toBeCloseTo(
      24,
      6,
    );
  });

  test("the timeseries groups the same way and says so", async () => {
    const t = await getTimeseries(ctx(tenant), YEAR(SP), appDb);
    expect(t.grain).toBe("week");
    const w1 = t.points.find((p) => p.bucket === "2026-03-09");
    expect(w1?.calls).toBe(4);
    expect(w1?.conversations).toBe(2);
    expect(t.points.find((p) => p.bucket === "2026-03-16")?.calls).toBe(1);
  });

  test("the funnel over time counts a week's conversations once", async () => {
    const tr = await getOutcomeTrend(ctx(tenant), YEAR(SP), undefined, appDb);
    expect(tr.grain).toBe("week");
    const w1 = tr.days.find((d) => d.date === "2026-03-09");
    expect(w1?.total).toBe(2);
    expect(w1?.involved).toBe(2);
    expect(w1?.handoff).toBe(1);
    const split = await getOutcomeTrend(ctx(tenant), YEAR(SP), "inbox", appDb);
    expect(split.grain).toBe("week");
    expect(split.series?.[0]?.days.map((d) => d.date)).toEqual(["2026-03-09"]);
  });

  test("a conversation handed over twice in one week is one handoff that week", async () => {
    const h = await getHandoffReasons(ctx(tenant), YEAR(SP), appDb);
    expect(h.grain).toBe("week");
    expect(h.days).toEqual([
      { date: "2026-03-09", cause: "agent", conversations: 1 },
    ]);
  });

  test("92 days is by day, 93 by week, 730 by week, 731 by month", async () => {
    const at = async (first: string) =>
      (await getTimeseries(ctx(tenant), view(first, "2026-03-18", SP), appDb))
        .grain;
    expect(await at("2025-12-17")).toBe("day");
    expect(await at("2025-12-16")).toBe("week");
    expect(await at("2024-03-19")).toBe("week");
    expect(await at("2024-03-18")).toBe("month");
    const m = await getDashboardCosts(
      ctx(tenant),
      view("2024-03-18", "2026-03-18", SP),
      appDb,
      noFetch,
    );
    expect(m.grain).toBe("month");
    expect(m.days.map((d) => d.date)).toEqual(["2025-02-01", "2026-03-01"]);
    expect(m.days[1]?.costUsd).toBeCloseTo(31, 6);
  });

  test("the MCP tool answers the same groups, and refuses a zone it cannot read", async () => {
    const principal: VerifiedToken = {
      userId: 1n,
      tenantId: tenant,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      clientId: "c",
      jti: "j",
    };
    const y = YEAR(SP);
    const args = {
      since: y.since?.toISOString(),
      until: y.until?.toISOString(),
      tz: SP,
    };
    const res = await metricsTimeseries(principal, args, { base: appDb });
    expect("ok" in res && res.ok).toBe(true);
    const body = (res as { data: unknown }).data;
    expect(JSON.parse(JSON.stringify(body))).toEqual(
      JSON.parse(JSON.stringify(await getTimeseries(ctx(tenant), y, appDb))),
    );
    expect((body as { grain: string }).grain).toBe("week");
    const bad = await metricsTimeseries(
      principal,
      { ...args, tz: "Not/AZone" },
      { base: appDb },
    );
    expect("ok" in bad && bad.ok).toBe(false);
  });

  test("a window with no start begins at the tenant's first record", async () => {
    const until = dayStart("2026-03-19", SP);
    const t = await getTimeseries(ctx(tenant), { until, tz: SP }, appDb);
    // From 2025-02-10: over 92 days and under two years.
    expect(t.grain).toBe("week");
    const none = await getTimeseries(ctx(empty), { until, tz: SP }, appDb);
    expect(none.grain).toBe("day");
    expect(none.points).toEqual([]);
  });
});

// A GROUPED READ OVER THE SUMS takes a UTC day's counts from the day rows when the day lies wholly
// inside one local week or month, and from the quarters when the day holds a group's first instant:
// in Sao Paulo a week starts at 03:00 UTC on Monday, and a month at 03:00 UTC on its first day.
describe.skipIf(!dbUp)("grouped reads over the sums (DB)", () => {
  let t = 0n;

  beforeAll(async () => {
    t = (
      await suDb.tenant.create({
        data: { name: "grain-sums", slug: `grain-sums-${process.pid}` },
      })
    ).id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId: t,
      accountId: 61_000 + (process.pid % 10_000),
      baseUrl: "https://grain-sums.cw.example",
      adminToken: "enc",
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId: t,
        name: "Ana",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "m1" },
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: t,
        chatwootInstanceId: inst.id,
        chatwootInboxId: 1,
        name: "WhatsApp",
        agentId: agent.id,
      },
    });
    for (const at of [
      // Week of 2026-03-02: a Wednesday, and Sunday 22:00 in Sao Paulo, already Monday in UTC.
      "2026-03-04T13:00:00Z",
      "2026-03-09T01:00:00Z",
      // Week of 2026-03-09: Monday 02:00 in Sao Paulo, on the same UTC day, and a Wednesday.
      "2026-03-09T05:00:00Z",
      "2026-03-11T13:00:00Z",
      // March: the 31st, and 23:00 on the 31st in Sao Paulo, already April in UTC. April: 01:00.
      "2026-03-31T13:00:00Z",
      "2026-04-01T02:00:00Z",
      "2026-04-01T04:00:00Z",
    ]) {
      const n = seq++;
      const c = await suDb.conversation.create({
        data: {
          tenantId: t,
          chatwootInstanceId: inst.id,
          inboxId: inbox.id,
          chatwootConversationId: n,
          status: "open",
          threadId: `${t}:${inst.id}:${n}`,
          createdAt: new Date(at),
          lastEventAt: new Date(at),
        },
      });
      await suDb.llmUsage.create({
        data: {
          tenantId: t,
          agentId: agent.id,
          inboxId: inbox.id,
          conversationId: c.id,
          source: "inbox",
          model: "m1",
          node: "agent",
          costUsd: 1,
          createdAt: new Date(at),
        },
      });
    }
    await until(
      "the sums to catch up",
      async () => {
        const s = await stepLedgerSums(appDb, t);
        return s.caughtUp && s.summedUntil !== null;
      },
      { everyMs: 0, deadlineMs: 240_000 },
    );
    // NOTE: a step sums one day of a tenant's past, and the fixture is months old.
  }, 300_000);

  afterAll(async () => {
    if (t)
      await suDb.tenant.delete({ where: { id: t } }).catch(() => undefined);
  });

  const bump = (day: string, n: number) =>
    suDb.$executeRawUnsafe(
      `UPDATE conversation_day_sums SET conversations = conversations + ${n}
        WHERE tenant_id = ${t} AND day = '${day}'::timestamp`,
    );
  const weeks = async () =>
    Object.fromEntries(
      (
        await getOutcomeTrend(
          ctx(t),
          view("2026-01-01", "2026-04-30", SP),
          undefined,
          appDb,
        )
      ).days.map((d) => [d.date, d.total]),
    );

  test("a week's conversations are its own, across the UTC day that holds its first instant", async () => {
    expect(await weeks()).toMatchObject({
      "2026-03-02": 2,
      "2026-03-09": 2,
    });
  });

  test("a UTC day inside a week is read from its day row, the day of the week's start from its quarters", async () => {
    const before = await weeks();
    // NOTE: the day rows changed by hand: a read that takes them shows the change, one that reads
    // the quarters does not.
    await bump("2026-03-11", 10);
    await bump("2026-03-09", 100);
    try {
      const after = await weeks();
      expect(after["2026-03-09"]).toBe((before["2026-03-09"] ?? 0) + 10);
      expect(after["2026-03-02"]).toBe(before["2026-03-02"]);
    } finally {
      await bump("2026-03-11", -10);
      await bump("2026-03-09", -100);
    }
  });

  const bumpCost = (day: string, usd: number) =>
    suDb.$executeRawUnsafe(
      `UPDATE ledger_day_sums SET cost_usd = cost_usd + ${usd}
        WHERE tenant_id = ${t} AND day = '${day}'::timestamp`,
    );
  const weeklyCost = async () =>
    Object.fromEntries(
      (
        await getDashboardCosts(
          ctx(t),
          view("2026-01-01", "2026-04-30", SP),
          appDb,
          noFetch,
        )
      ).days.map((d) => [d.date, d.costUsd]),
    );

  test("the job writes a day's ledger sums as its quarters added up", async () => {
    const [row] = await suDb.$queryRawUnsafe<
      { day: number; quarter: number }[]
    >(
      `SELECT (SELECT SUM(cost_usd) FROM ledger_day_sums WHERE tenant_id = ${t})::float8 AS day,
              (SELECT SUM(cost_usd) FROM ledger_quarter_sums WHERE tenant_id = ${t})::float8 AS quarter`,
    );
    expect(row?.day).toBe(7);
    expect(row?.quarter).toBe(7);
  });

  test("a week's cost is its own, across the UTC day that holds its first instant", async () => {
    expect(await weeklyCost()).toMatchObject({
      "2026-03-02": 2,
      "2026-03-09": 2,
    });
  });

  test("a UTC day inside a week takes its cost from its day row, the day of the week's start from its quarters", async () => {
    const before = await weeklyCost();
    // NOTE: the day rows changed by hand, as for the conversations above.
    await bumpCost("2026-03-11", 10);
    await bumpCost("2026-03-09", 100);
    try {
      const after = await weeklyCost();
      expect(after["2026-03-09"]).toBe((before["2026-03-09"] ?? 0) + 10);
      expect(after["2026-03-02"]).toBe(before["2026-03-02"]);
    } finally {
      await bumpCost("2026-03-11", -10);
      await bumpCost("2026-03-09", -100);
    }
  });

  test("a marked quarter keeps its day off the day rows until the job rewrites the day", async () => {
    await suDb.$executeRawUnsafe(
      `UPDATE llm_usage SET cost_usd = 5 WHERE tenant_id = ${t} AND created_at = '2026-03-11T13:00:00'::timestamp`,
    );
    try {
      expect((await weeklyCost())["2026-03-09"]).toBe(6);
      await until(
        "the job to rewrite the marked day",
        async () => (await stepLedgerSums(appDb, t)).caughtUp,
        { everyMs: 0, deadlineMs: 60_000 },
      );
      const [row] = await suDb.$queryRawUnsafe<{ usd: number }[]>(
        `SELECT SUM(cost_usd)::float8 AS usd FROM ledger_day_sums
          WHERE tenant_id = ${t} AND day = '2026-03-11'::timestamp`,
      );
      expect(row?.usd).toBe(5);
      expect((await weeklyCost())["2026-03-09"]).toBe(6);
    } finally {
      await suDb.$executeRawUnsafe(
        `UPDATE llm_usage SET cost_usd = 1 WHERE tenant_id = ${t} AND created_at = '2026-03-11T13:00:00'::timestamp`,
      );
      await until(
        "the job to rewrite the day back",
        async () => (await stepLedgerSums(appDb, t)).caughtUp,
        { everyMs: 0, deadlineMs: 60_000 },
      );
    }
  });

  test("a month's cost is its own, across the UTC day that holds its first instant", async () => {
    const c = await getDashboardCosts(
      ctx(t),
      view("2024-03-01", "2026-04-30", SP),
      appDb,
      noFetch,
    );
    expect(c.grain).toBe("month");
    expect(
      Object.fromEntries(c.days.map((d) => [d.date, d.costUsd])),
    ).toMatchObject({ "2026-03-01": 6, "2026-04-01": 1 });
  });

  test("a month's conversations are its own, across the UTC day that holds its first instant", async () => {
    const tr = await getOutcomeTrend(
      ctx(t),
      view("2024-03-01", "2026-04-30", SP),
      undefined,
      appDb,
    );
    expect(tr.grain).toBe("month");
    expect(
      Object.fromEntries(tr.days.map((d) => [d.date, d.total])),
    ).toMatchObject({ "2026-03-01": 6, "2026-04-01": 1 });
  });
});
