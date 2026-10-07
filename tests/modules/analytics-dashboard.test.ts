import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  getFollowUpActivity,
  getHandoffReasons,
  getKnowledgeActivity,
  getLabelOutcomes,
} from "@/modules/analytics/activity";
import { getBreakdown } from "@/modules/analytics/breakdown";
import { getDashboardCosts } from "@/modules/analytics/costs";
import type { DashboardFilter } from "@/modules/analytics/filter";
import { getHealth } from "@/modules/analytics/health";
import { getInstanceMetrics, getKpis } from "@/modules/analytics/service";
import { getOutcomeTrend } from "@/modules/analytics/trends";
import { recordResolutionOrigin } from "@/modules/conversations/record-resolution";
import { listConversations } from "@/modules/conversations/service";
import { listExecutionLogs } from "@/modules/flowlog/read";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE DASHBOARD READS ONE SET OF ROWS PER VIEW. A fixed fixture over two days, two
// agents on two inboxes, and the assertions are the numbers the fixture was built to produce: the
// funnel and its trend agree, the dimension table sums to the ledger, the drill-down lists exactly
// the conversations a figure counted, and nothing of another tenant reaches any of it.

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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const noFetch = (() => {
  throw new Error("no network in this test");
}) as unknown as typeof fetch;

// Day 1 and day 2 of the window, at noon UTC; the window is the whole week around them.
const D1 = new Date("2026-09-02T12:00:00Z");
const D2 = new Date("2026-09-03T12:00:00Z");
const BEFORE = new Date("2026-08-20T12:00:00Z");
const WEEK: DashboardFilter = {
  since: new Date("2026-09-01T00:00:00Z"),
  until: new Date("2026-09-08T00:00:00Z"),
  tz: "UTC",
};

interface Fx {
  tenantId: bigint;
  instanceId: bigint;
  a1: bigint;
  a2: bigint;
  i1: bigint;
  i2: bigint;
  // Conversation ids by name, for the drill-down assertions.
  conv: Record<string, bigint>;
}

let fx: Fx;
let other: Fx;
let convSeq = 1000;

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function seedTenant(slug: string): Promise<Fx> {
  const t = await suDb.tenant.create({
    data: { name: slug, slug: `${slug}-${process.pid}` },
  });
  const inst = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    // One Chatwoot account per tenant: the pair is unique across the fleet.
    accountId: 50_000 + (convSeq++ % 10_000) + (process.pid % 1000) * 10,
    baseUrl: `https://${slug}.cw.example`,
    adminToken: "enc",
  });
  const agent = (name: string) =>
    suDb.agent.create({
      data: {
        tenantId: t.id,
        name,
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "m1" },
      },
    });
  const a1 = await agent("Ana");
  const a2 = await agent("Beto");
  const inbox = (n: number, name: string, agentId: bigint) =>
    suDb.inbox.create({
      data: {
        tenantId: t.id,
        chatwootInstanceId: inst.id,
        chatwootInboxId: n,
        name,
        agentId,
      },
    });
  const i1 = await inbox(1, "WhatsApp", a1.id);
  const i2 = await inbox(2, "E-mail", a2.id);
  return {
    tenantId: t.id,
    instanceId: inst.id,
    a1: a1.id,
    a2: a2.id,
    i1: i1.id,
    i2: i2.id,
    conv: {},
  };
}

// One conversation, created at `at`. `agent` set means the agent took a turn on it (an agent-turn
// ledger row); the outcome is reached the way production reaches it.
async function seedConv(
  f: Fx,
  name: string,
  p: {
    at: Date;
    inbox: bigint;
    agent?: bigint;
    outcome?: "resolved" | "handoff" | "open";
    labels?: string[];
    cost?: number;
    model?: string;
  },
): Promise<bigint> {
  const n = convSeq++;
  const conv = await suDb.conversation.create({
    data: {
      tenantId: f.tenantId,
      chatwootInstanceId: f.instanceId,
      inboxId: p.inbox,
      chatwootConversationId: n,
      status: "open",
      threadId: `${f.tenantId}:${f.instanceId}:${n}`,
      lastEventAt: p.at,
      createdAt: p.at,
      labels: p.labels ?? [],
    },
  });
  if (p.agent !== undefined) {
    await suDb.llmUsage.create({
      data: {
        tenantId: f.tenantId,
        agentId: p.agent,
        inboxId: p.inbox,
        conversationId: conv.id,
        source: "inbox",
        model: p.model ?? "m1",
        node: "agent",
        promptTokens: 100,
        completionTokens: 10,
        costUsd: p.cost ?? 1,
        createdAt: p.at,
      },
    });
  }
  if (p.outcome === "resolved") {
    await recordResolutionOrigin({
      tenantId: f.tenantId,
      conversation: { id: conv.id },
      origin: "agent",
      observed: { status: "open", statusAt: null },
      base: appDb,
    });
    await suDb.conversation.update({
      where: { id: conv.id },
      data: { status: "resolved" },
    });
  }
  if (p.outcome === "handoff") {
    await suDb.conversation.update({
      where: { id: conv.id },
      data: { assigneeType: "User", assigneeId: 7 },
    });
  }
  f.conv[name] = conv.id;
  return conv.id;
}

async function log(
  f: Fx,
  p: {
    at: Date;
    conv?: bigint;
    agent?: bigint;
    stage: string;
    level?: string;
    status?: string;
    detail: Prisma.InputJsonObject;
  },
) {
  await suDb.executionLog.create({
    data: {
      tenantId: f.tenantId,
      turnId: crypto.randomUUID(),
      conversationId: p.conv ?? null,
      agentId: p.agent ?? null,
      stage: p.stage,
      level: p.level ?? "info",
      status: p.status ?? "ok",
      source: "inbox",
      detail: p.detail,
      createdAt: p.at,
    },
  });
}

describe.skipIf(!dbUp)("the dashboard's one view", () => {
  beforeAll(async () => {
    fx = await seedTenant("dash");
    // Day 1, agent Ana on WhatsApp: three conversations, two resolved by her, one handed over.
    await seedConv(fx, "d1r1", {
      at: D1,
      inbox: fx.i1,
      agent: fx.a1,
      outcome: "resolved",
      labels: ["cobranca"],
      cost: 1,
    });
    await seedConv(fx, "d1r2", {
      at: D1,
      inbox: fx.i1,
      agent: fx.a1,
      outcome: "resolved",
      labels: ["cobranca", "pix"],
      cost: 2,
      model: "m2",
    });
    await seedConv(fx, "d1h", {
      at: D1,
      inbox: fx.i1,
      agent: fx.a1,
      outcome: "handoff",
      labels: ["cancelamento"],
      cost: 3,
    });
    // Day 1, nobody of ours ran: in the total, not in involvement.
    await seedConv(fx, "d1none", { at: D1, inbox: fx.i1 });
    // Day 2, agent Beto on e-mail: two handed over, one still open.
    await seedConv(fx, "d2h1", {
      at: D2,
      inbox: fx.i2,
      agent: fx.a2,
      outcome: "handoff",
      labels: ["cancelamento"],
      cost: 0.5,
    });
    await seedConv(fx, "d2h2", {
      at: D2,
      inbox: fx.i2,
      agent: fx.a2,
      outcome: "handoff",
      cost: 0.5,
    });
    await seedConv(fx, "d2open", {
      at: D2,
      inbox: fx.i2,
      agent: fx.a2,
      outcome: "open",
      cost: 1,
    });
    // Created before the window, billed inside it: the funnel of the week does not count it, the
    // ledger figures of the week do.
    const old = await seedConv(fx, "old", {
      at: BEFORE,
      inbox: fx.i1,
      agent: fx.a1,
    });
    await suDb.llmUsage.create({
      data: {
        tenantId: fx.tenantId,
        agentId: fx.a1,
        inboxId: fx.i1,
        conversationId: old,
        source: "inbox",
        model: "m1",
        node: "agent",
        promptTokens: 100,
        completionTokens: 10,
        costUsd: 4,
        createdAt: D2,
      },
    });
    // Ledger rows that are no conversation's: an image read and a playground turn on day 2, and a
    // call with no price.
    await suDb.llmUsage.createMany({
      data: [
        {
          tenantId: fx.tenantId,
          agentId: fx.a1,
          inboxId: fx.i1,
          conversationId: fx.conv.d1r1 ?? null,
          source: "inbox",
          model: "m2",
          node: "vision",
          promptTokens: 0,
          completionTokens: 5,
          costUsd: 0.25,
          createdAt: D1,
          durationMs: 100,
        },
        {
          tenantId: fx.tenantId,
          agentId: fx.a1,
          source: "playground",
          model: "m1",
          node: "agent",
          promptTokens: 1000,
          cachedReadTokens: 600,
          completionTokens: 10,
          costUsd: 5,
          createdAt: D2,
        },
        {
          tenantId: fx.tenantId,
          agentId: fx.a2,
          inboxId: fx.i2,
          source: "inbox",
          model: "m3",
          node: "agent",
          promptTokens: 10,
          completionTokens: 1,
          costUsd: null,
          createdAt: D2,
        },
      ],
    });
    // Latency: ten timed calls of m9, 100 ms to 1000 ms.
    await suDb.llmUsage.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        tenantId: fx.tenantId,
        agentId: fx.a2,
        inboxId: fx.i2,
        source: "inbox",
        model: "m9",
        node: "agent",
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        durationMs: (i + 1) * 100,
        createdAt: D2,
      })),
    });
    // Why conversations left the agent.
    await log(fx, {
      at: D1,
      conv: fx.conv.d1h,
      agent: fx.a1,
      stage: "tool",
      detail: { tool: "handoff_to_human", args: {} },
    });
    await log(fx, {
      at: D2,
      conv: fx.conv.d2h1,
      agent: fx.a2,
      stage: "handoff",
      detail: { outcome: "opened_after_skip", reason: "needs_human" },
    });
    await log(fx, {
      at: D2,
      conv: fx.conv.d2h2,
      agent: fx.a2,
      stage: "handoff",
      detail: { outcome: "taken_over", via: "reply" },
    });
    // The same takeover logged twice is one conversation.
    await log(fx, {
      at: D2,
      conv: fx.conv.d2h2,
      agent: fx.a2,
      stage: "handoff",
      detail: { outcome: "taken_over" },
    });
    await log(fx, {
      at: D2,
      conv: fx.conv.d2h1,
      agent: fx.a2,
      stage: "tool",
      detail: { tool: "skip_reply", skipReason: "needs_human" },
    });
    await log(fx, {
      at: D2,
      conv: fx.conv.d2open,
      agent: fx.a2,
      stage: "tool",
      detail: { tool: "skip_reply" },
    });
    // Problems: three failures of one tool, two warnings of another stage.
    for (let i = 0; i < 3; i++)
      await log(fx, {
        at: D2,
        conv: fx.conv.d2open,
        agent: fx.a2,
        stage: "tool",
        level: "warn",
        status: "error",
        detail: { tool: "consultar_pedido", args: {} },
      });
    for (let i = 0; i < 2; i++)
      await log(fx, {
        at: D2,
        conv: fx.conv.d2open,
        agent: fx.a2,
        stage: "delivery",
        level: "warn",
        detail: {},
      });
    // Follow-ups: two steps reached d2open, one reached d1h; d2open's customer wrote back after the
    // first; a third conversation was closed by the last step.
    const closed = await seedConv(fx, "fuClosed", {
      at: D1,
      inbox: fx.i1,
      agent: fx.a1,
    });
    await suDb.conversation.update({
      where: { id: closed },
      data: { status: "resolved", resolvedBy: "followup_abandonment" },
    });
    const step = (conv: bigint | undefined, at: Date, outcome: string) =>
      log(fx, {
        at,
        conv,
        agent: fx.a1,
        stage: "generate",
        detail: { trigger: "followup", outcome, step: 1, origin: "followup" },
      });
    await step(fx.conv.d2open, new Date("2026-09-04T10:00:00Z"), "messaged");
    await step(fx.conv.d2open, new Date("2026-09-05T10:00:00Z"), "templated");
    await step(fx.conv.d1h, new Date("2026-09-04T10:00:00Z"), "messaged");
    await step(closed, new Date("2026-09-04T10:00:00Z"), "messaged");
    // A silenced step reached nobody.
    await step(fx.conv.d1r1, new Date("2026-09-04T10:00:00Z"), "silent");
    await suDb.conversation.update({
      where: { id: fx.conv.d2open },
      data: { lastInboundAt: new Date("2026-09-04T12:00:00Z") },
    });
    // Knowledge suggestions proposed by Ana in the window.
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: fx.tenantId, name: "Docs" },
    });
    let h = 0;
    for (const status of [
      "PENDING",
      "DISCARDED",
      "APPROVED",
      "APPROVED",
      "REJECTED",
    ] as const)
      await suDb.approvalQueueItem.create({
        data: {
          tenantId: fx.tenantId,
          knowledgeBaseId: kb.id,
          agentId: fx.a1,
          proposedContent: "x",
          normalizedHash: `h${h++}`,
          status,
          createdAt: D2,
        },
      });

    // Another tenant with a lot of everything, none of which may show.
    other = await seedTenant("dash-other");
    await seedConv(other, "x", {
      at: D1,
      inbox: other.i1,
      agent: other.a1,
      outcome: "resolved",
      labels: ["cobranca"],
      cost: 999,
    });
  });

  afterAll(async () => {
    for (const f of [fx, other]) {
      if (!f) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${f.tenantId}`,
      );
    }
  });

  test("the funnel counts the conversations created in the window, once each", async () => {
    const k = await getKpis(ctx(fx.tenantId), WEEK, appDb);
    // 7 created on day 1 and 2 plus the follow-up one; the old one is not of this week.
    expect(k.totalConversations).toBe(8);
    expect(k.involved).toBe(7);
    expect(k.resolvedByBot).toBe(2);
    expect(k.handoff).toBe(3);
    expect(k.involvementRate).toBeCloseTo(7 / 8);
    expect(k.resolutionRate).toBeCloseTo(2 / 7);
    expect(k.handoffRate).toBeCloseTo(3 / 8);
  });

  test("an agent filter counts that agent's conversations, an inbox filter that inbox's", async () => {
    const ana = await getKpis(
      ctx(fx.tenantId),
      { ...WEEK, agentId: fx.a1 },
      appDb,
    );
    // Ana's inbox carries d1r1, d1r2, d1h, d1none and the follow-up one; she ran on all but d1none.
    expect(ana.totalConversations).toBe(5);
    expect(ana.involved).toBe(4);
    expect(ana.resolvedByBot).toBe(2);
    const email = await getKpis(
      ctx(fx.tenantId),
      { ...WEEK, inboxId: fx.i2 },
      appDb,
    );
    expect(email.totalConversations).toBe(3);
    expect(email.handoff).toBe(2);
    expect(email.resolvedByBot).toBe(0);
  });

  test("a day's point on the trend is the tile of that day", async () => {
    const trend = await getOutcomeTrend(
      ctx(fx.tenantId),
      WEEK,
      undefined,
      appDb,
    );
    const d1 = trend.days.find((d) => d.date === "2026-09-02");
    const d2 = trend.days.find((d) => d.date === "2026-09-03");
    expect(d1).toMatchObject({
      total: 5,
      involved: 4,
      resolvedByBot: 2,
      handoff: 1,
    });
    expect(d2).toMatchObject({
      total: 3,
      involved: 3,
      resolvedByBot: 0,
      handoff: 2,
    });
    const oneDay = await getKpis(
      ctx(fx.tenantId),
      {
        since: new Date("2026-09-02T00:00:00Z"),
        until: new Date("2026-09-03T00:00:00Z"),
        tz: "UTC",
      },
      appDb,
    );
    expect(oneDay.totalConversations).toBe(d1?.total ?? -1);
    expect(oneDay.resolvedByBot).toBe(d1?.resolvedByBot ?? -1);
    // The days in the operator's zone: 12:00 UTC is still the same day in São Paulo.
    const sp = await getOutcomeTrend(
      ctx(fx.tenantId),
      { ...WEEK, tz: "America/Sao_Paulo" },
      undefined,
      appDb,
    );
    expect(sp.days.map((d) => d.date)).toEqual(["2026-09-02", "2026-09-03"]);
  });

  test("the breakdown by agent repeats the funnel per agent, by name", async () => {
    const trend = await getOutcomeTrend(ctx(fx.tenantId), WEEK, "agent", appDb);
    const ana = trend.series?.find((s) => s.label === "Ana");
    const beto = trend.series?.find((s) => s.label === "Beto");
    expect(ana?.totals).toMatchObject({
      total: 5,
      involved: 4,
      resolvedByBot: 2,
    });
    expect(beto?.totals).toMatchObject({
      total: 3,
      involved: 3,
      resolvedByBot: 0,
      handoff: 2,
    });
    const byInbox = await getOutcomeTrend(
      ctx(fx.tenantId),
      WEEK,
      "inbox",
      appDb,
    );
    expect(byInbox.series?.map((s) => s.label).sort()).toEqual([
      "E-mail",
      "WhatsApp",
    ]);
  });

  test("the dimension table sums the ledger rows of the view", async () => {
    const rows = await getBreakdown(ctx(fx.tenantId), WEEK, "agent", appDb);
    const ana = rows.find((r) => r.label === "Ana");
    const beto = rows.find((r) => r.label === "Beto");
    // Ana: 1 + 2 + 3 + 1 (follow-up conv) + 0.25 (vision) + 4 (old conv billed in window) + 5 (playground).
    expect(ana?.costUsd).toBeCloseTo(16.25);
    expect(ana?.requests).toBe(7);
    // Beto: 0.5 + 0.5 + 1, the unpriced call and the ten m9 calls at 0.
    expect(beto?.costUsd).toBeCloseTo(2);
    expect(beto?.unpricedRequests).toBe(1);
    expect(beto?.conversations).toBe(3);
    expect(beto?.resolutionRate).toBe(0);
    const real = await getBreakdown(
      ctx(fx.tenantId),
      { ...WEEK, source: "inbox" },
      "agent",
      appDb,
    );
    expect(real.find((r) => r.label === "Ana")?.costUsd).toBeCloseTo(11.25);
    const byNode = await getBreakdown(ctx(fx.tenantId), WEEK, "node", appDb);
    expect(byNode.find((r) => r.key === "vision")?.costUsd).toBeCloseTo(0.25);
    const byModel = await getBreakdown(ctx(fx.tenantId), WEEK, "model", appDb);
    const total = byModel.reduce((s, r) => s + r.costUsd, 0);
    expect(total).toBeCloseTo(18.25);
    // The image read sent no prompt tokens: its row has no cache share, not 0%.
    const vision = byNode.find((r) => r.key === "vision");
    expect(vision?.cacheShare).toBeNull();
    const playground = await getBreakdown(
      ctx(fx.tenantId),
      { ...WEEK, source: "playground" },
      "agent",
      appDb,
    );
    expect(playground[0]?.cacheShare).toBeCloseTo(0.6);
    // No conversation, nothing to divide by.
    expect(playground[0]?.costPerConversation).toBeNull();
  });

  test("the cost days split by model and by call type add up to the day", async () => {
    const c = await getDashboardCosts(
      ctx(fx.tenantId),
      { ...WEEK, source: "inbox" },
      appDb,
      noFetch,
    );
    for (const day of c.days) {
      const byModel = c.daysByModel
        .filter((d) => d.date === day.date)
        .reduce((s, d) => s + d.costUsd, 0);
      const byNode = c.daysByNode
        .filter((d) => d.date === day.date)
        .reduce((s, d) => s + d.costUsd, 0);
      expect(byModel).toBeCloseTo(day.costUsd);
      expect(byNode).toBeCloseTo(day.costUsd);
    }
    const d1 = c.days.find((d) => d.date === "2026-09-02");
    // Day 1: 1 + 2 + 3 + 1 + 0.25 over four conversations, two of them resolved by the agent.
    expect(d1?.costUsd).toBeCloseTo(7.25);
    expect(d1?.conversations).toBe(4);
    expect(d1?.resolvedConversations).toBe(2);
    expect(d1?.costPerConversation).toBeCloseTo(7.25 / 4);
    expect(d1?.costPerResolvedConversation).toBeCloseTo(7.25 / 2);
    expect(c.unpriced.calls).toBe(1);
  });

  test("a figure's drill-down lists exactly the conversations it counted", async () => {
    const day1 = {
      createdSince: new Date("2026-09-02T00:00:00Z"),
      createdUntil: new Date("2026-09-03T00:00:00Z"),
    };
    const ids = async (
      outcome: "all" | "involved" | "resolved_by_agent" | "handoff",
      extra: { agentId?: bigint } = {},
    ) =>
      (
        await listConversations(
          ctx(fx.tenantId),
          { ...extra, drillDown: { ...day1, outcome } },
          appDb,
        )
      ).items
        .map((i) => i.id)
        .sort();
    const sorted = (...names: string[]) =>
      names.map((n) => String(fx.conv[n])).sort();
    expect(await ids("resolved_by_agent")).toEqual(sorted("d1r1", "d1r2"));
    expect(await ids("handoff")).toEqual(sorted("d1h"));
    expect(await ids("involved")).toEqual(
      sorted("d1r1", "d1r2", "d1h", "fuClosed"),
    );
    expect(await ids("all")).toEqual(
      sorted("d1r1", "d1r2", "d1h", "d1none", "fuClosed"),
    );
    // Beto ran on nothing of day 1.
    expect(await ids("involved", { agentId: fx.a2 })).toEqual([]);
    // Paged in the list's order, a page at a time, with nothing lost or repeated.
    const first = await listConversations(
      ctx(fx.tenantId),
      { limit: 2, drillDown: { ...day1, outcome: "all" } },
      appDb,
    );
    const second = await listConversations(
      ctx(fx.tenantId),
      {
        limit: 2,
        cursor: BigInt(first.nextCursor ?? "0"),
        drillDown: { ...day1, outcome: "all" },
      },
      appDb,
    );
    const third = await listConversations(
      ctx(fx.tenantId),
      {
        limit: 2,
        cursor: BigInt(second.nextCursor ?? "0"),
        drillDown: { ...day1, outcome: "all" },
      },
      appDb,
    );
    const paged = [...first.items, ...second.items, ...third.items].map(
      (i) => i.id,
    );
    expect(new Set(paged).size).toBe(5);
    expect(paged.sort()).toEqual(await ids("all"));
  });

  test("handoffs are counted by cause, one conversation once per cause", async () => {
    const h = await getHandoffReasons(ctx(fx.tenantId), WEEK, appDb);
    const total = (cause: string) =>
      h.totals.find((t) => t.cause === cause)?.conversations ?? 0;
    expect(total("agent")).toBe(1);
    expect(total("skip_needs_human")).toBe(1);
    expect(total("person")).toBe(1);
    expect(h.days.find((d) => d.cause === "agent")?.date).toBe("2026-09-02");
    const silence = (r: string) =>
      h.silences.find((s) => s.reason === r)?.turns ?? 0;
    expect(silence("needs_human")).toBe(1);
    // A line written before the reason was logged is not guessed.
    expect(silence("unrecorded")).toBe(1);
  });

  test("labels group the view's conversations, and the unlabeled count apart", async () => {
    const l = await getLabelOutcomes(ctx(fx.tenantId), WEEK, appDb);
    const row = (label: string) => l.labels.find((r) => r.label === label);
    expect(row("cobranca")).toMatchObject({
      conversations: 2,
      resolvedByBot: 2,
      resolutionRate: 1,
    });
    expect(row("cancelamento")).toMatchObject({
      conversations: 2,
      handoff: 2,
      resolutionRate: 0,
    });
    expect(row("pix")?.conversations).toBe(1);
    // d1none, d2h2, d2open and the follow-up one.
    expect(l.unlabeled).toBe(4);
  });

  test("follow-ups: steps delivered, the customers who came back, the ones the last step closed", async () => {
    const f = await getFollowUpActivity(ctx(fx.tenantId), WEEK, appDb);
    expect(f).toEqual({
      stepsSent: 4,
      conversations: 3,
      cameBack: 1,
      closedByLastStep: 1,
    });
  });

  test("knowledge suggestions by where they stand", async () => {
    const k = await getKnowledgeActivity(ctx(fx.tenantId), WEEK, appDb);
    expect(k).toEqual({
      proposed: 5,
      waiting: 1,
      discarded: 1,
      approved: 2,
      rejected: 1,
    });
    const beto = await getKnowledgeActivity(
      ctx(fx.tenantId),
      { ...WEEK, agentId: fx.a2 },
      appDb,
    );
    expect(beto.proposed).toBe(0);
  });

  test("health: latency percentiles by model, problems by stage and tool", async () => {
    const h = await getHealth(ctx(fx.tenantId), WEEK, appDb);
    const m9 = h.latency.find((l) => l.model === "m9");
    expect(m9?.calls).toBe(10);
    expect(m9?.p50Ms).toBeCloseTo(550);
    expect(m9?.p90Ms).toBeCloseTo(910);
    const tool = h.problems.find((p) => p.tool === "consultar_pedido");
    expect(tool).toMatchObject({ stage: "tool", level: "warn", lines: 3 });
    expect(h.problems.find((p) => p.stage === "delivery")?.lines).toBe(2);
  });

  test("first response is read as a median and a 90th percentile", async () => {
    const reply = (name: string, seconds: number) =>
      suDb.conversation.update({
        where: { id: fx.conv[name] },
        data: {
          chatwootCreatedAt: D1,
          chatwootFirstReplyAt: new Date(D1.getTime() + seconds * 1000),
        },
      });
    await reply("d1r1", 10);
    await reply("d1r2", 20);
    await reply("d1h", 100);
    const k = await getKpis(ctx(fx.tenantId), WEEK, appDb);
    expect(k.firstResponseSampled).toBe(3);
    expect(k.firstResponseSeconds).toBeCloseTo(20);
    expect(k.firstResponseP90Seconds).toBeCloseTo(84);
  });

  test("nothing of another tenant reaches any block", async () => {
    const c = ctx(fx.tenantId);
    const rows = await getBreakdown(c, WEEK, "agent", appDb);
    expect(rows.some((r) => r.costUsd >= 999)).toBe(false);
    const labels = await getLabelOutcomes(c, WEEK, appDb);
    expect(
      labels.labels.find((l) => l.label === "cobranca")?.conversations,
    ).toBe(2);
    // Filtering by the other tenant's agent is an empty view, not their numbers.
    const theirs = await getKpis(c, { ...WEEK, agentId: other.a1 }, appDb);
    expect(theirs.totalConversations).toBe(0);
    const theirCost = await getDashboardCosts(
      c,
      { ...WEEK, agentId: other.a1 },
      appDb,
      noFetch,
    );
    expect(theirCost.totalCostUsd).toBe(0);
  });
});

// THE EDGES OF THE VIEW. Each conversation here sits on one boundary of a predicate the funnel and
// the drill-down share, in a tenant of its own so the main fixture's numbers stay as they are.
describe.skipIf(!dbUp)("the view's boundaries", () => {
  let ex: Fx;
  const DAY: DashboardFilter = {
    since: new Date("2026-09-02T00:00:00Z"),
    until: new Date("2026-09-03T00:00:00Z"),
    tz: "UTC",
  };
  const row = (
    f: Fx,
    p: {
      conv?: bigint;
      agent: bigint;
      inbox?: bigint;
      source?: "inbox" | "playground";
      node: string;
      at: Date;
      cost?: number;
    },
  ) =>
    suDb.llmUsage.create({
      data: {
        tenantId: f.tenantId,
        agentId: p.agent,
        inboxId: p.inbox ?? null,
        conversationId: p.conv ?? null,
        source: p.source ?? "inbox",
        model: "m1",
        node: p.node,
        promptTokens: 10,
        completionTokens: 1,
        costUsd: p.cost ?? 1,
        createdAt: p.at,
      },
    });

  beforeAll(async () => {
    ex = await seedTenant("dash-edge");
    // Only an image read ran on it: the agent never took a turn.
    const vision = await seedConv(ex, "visionOnly", { at: D1, inbox: ex.i1 });
    await row(ex, {
      conv: vision,
      agent: ex.a1,
      inbox: ex.i1,
      node: "vision",
      at: D1,
    });
    // A row tagged playground on a conversation is not real traffic.
    const pg = await seedConv(ex, "playgroundOnly", { at: D1, inbox: ex.i1 });
    await row(ex, {
      conv: pg,
      agent: ex.a1,
      source: "playground",
      node: "agent",
      at: D1,
    });
    // Ana answered it on Beto's inbox (bound to Beto).
    await seedConv(ex, "anaOnBeto", { at: D1, inbox: ex.i2, agent: ex.a1 });
    // Resolved by the agent with no turn of ours recorded: in the total, not in what she resolved.
    const ghost = await seedConv(ex, "resolvedNoTurn", {
      at: D1,
      inbox: ex.i1,
    });
    await suDb.conversation.update({
      where: { id: ghost },
      data: { status: "resolved", resolvedBy: "agent" },
    });
    // Handed over with no turn of ours: not the agent's handoff.
    await seedConv(ex, "handoffNoTurn", {
      at: D1,
      inbox: ex.i1,
      outcome: "handoff",
    });
    // Created at the window's end instant: the next window's.
    await seedConv(ex, "atUntil", { at: DAY.until as Date, inbox: ex.i1 });
    // 01:00 UTC on Sep 3 is still Sep 2 in São Paulo.
    await seedConv(ex, "lateNight", {
      at: new Date("2026-09-03T01:00:00Z"),
      inbox: ex.i1,
    });
    // Two with no event yet: the list puts them last, and paging must reach them.
    for (const name of ["noEvent1", "noEvent2"]) {
      const id = await seedConv(ex, name, { at: D1, inbox: ex.i1 });
      await suDb.conversation.update({
        where: { id },
        data: { lastEventAt: null },
      });
    }
    // Ana billed on both inboxes.
    await row(ex, {
      agent: ex.a1,
      inbox: ex.i1,
      node: "agent",
      at: D1,
      cost: 3,
    });
    await row(ex, {
      agent: ex.a1,
      inbox: ex.i2,
      node: "agent",
      at: D1,
      cost: 7,
    });
  });

  afterAll(async () => {
    if (ex)
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${ex.tenantId}`,
      );
  });

  const drill = async (
    outcome: "all" | "involved" | "resolved_by_agent" | "handoff",
    extra: { agentId?: bigint; limit?: number; cursor?: bigint } = {},
  ) =>
    listConversations(
      ctx(ex.tenantId),
      {
        ...extra,
        drillDown: {
          createdSince: DAY.since,
          createdUntil: DAY.until,
          outcome,
        },
      },
      appDb,
    );
  const names = (ids: string[]) =>
    Object.entries(ex.conv)
      .filter(([, id]) => ids.includes(String(id)))
      .map(([n]) => n)
      .sort();

  test("involvement is an agent turn of real traffic, nothing else", async () => {
    const k = await getKpis(ctx(ex.tenantId), DAY, appDb);
    expect(k.involved).toBe(1);
    expect(names((await drill("involved")).items.map((i) => i.id))).toEqual([
      "anaOnBeto",
    ]);
  });

  test("only a turn of ours counts as the agent resolving or handing over", async () => {
    const k = await getKpis(ctx(ex.tenantId), DAY, appDb);
    expect(k.resolvedByBot).toBe(0);
    expect(k.handoff).toBe(0);
    expect((await drill("resolved_by_agent")).items).toEqual([]);
    expect((await drill("handoff")).items).toEqual([]);
  });

  test("an agent filter keeps what the agent answered on an inbox bound to another", async () => {
    const ana = await getKpis(
      ctx(ex.tenantId),
      { ...DAY, agentId: ex.a1 },
      appDb,
    );
    expect(ana.involved).toBe(1);
    expect(
      names(
        (await drill("involved", { agentId: ex.a1 })).items.map((i) => i.id),
      ),
    ).toEqual(["anaOnBeto"]);
  });

  test("the window is half-open: a conversation at its end instant is the next one's", async () => {
    const all = names((await drill("all")).items.map((i) => i.id));
    expect(all).not.toContain("atUntil");
    const k = await getKpis(ctx(ex.tenantId), DAY, appDb);
    expect(k.totalConversations).toBe(all.length);
  });

  test("a day is cut in the operator's zone", async () => {
    const sp = await getOutcomeTrend(
      ctx(ex.tenantId),
      {
        since: new Date("2026-09-01T00:00:00Z"),
        until: new Date("2026-09-05T00:00:00Z"),
        tz: "America/Sao_Paulo",
      },
      undefined,
      appDb,
    );
    // lateNight and atUntil (00:00 UTC Sep 3) both fall on Sep 2 in São Paulo.
    expect(sp.days.find((d) => d.date === "2026-09-03")).toBeUndefined();
  });

  test("paging walks past the conversations with no event, one at a time", async () => {
    const seen: string[] = [];
    let cursor: bigint | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await drill("all", { limit: 1, cursor });
      seen.push(...page.items.map((x) => x.id));
      if (!page.nextCursor) break;
      cursor = BigInt(page.nextCursor);
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(names(seen)).toContain("noEvent1");
    expect(names(seen)).toContain("noEvent2");
    expect(seen.length).toBe((await drill("all")).items.length);
  });

  test("an inbox filter counts the suggestions proposed in that inbox's conversations", async () => {
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId: ex.tenantId, name: "Docs" },
    });
    const thread = async (name: string) =>
      (
        await suDb.conversation.findUniqueOrThrow({
          where: { id: ex.conv[name] },
          select: { threadId: true },
        })
      ).threadId;
    let h = 0;
    for (const threadId of [
      await thread("anaOnBeto"),
      await thread("visionOnly"),
      await thread("visionOnly"),
      null,
    ])
      await suDb.approvalQueueItem.create({
        data: {
          tenantId: ex.tenantId,
          knowledgeBaseId: kb.id,
          agentId: ex.a1,
          threadId,
          proposedContent: "x",
          normalizedHash: `e${h++}`,
          createdAt: D1,
        },
      });
    const k = (inboxId?: bigint) =>
      getKnowledgeActivity(ctx(ex.tenantId), { ...DAY, inboxId }, appDb);
    expect((await k()).proposed).toBe(4);
    expect((await k(ex.i2)).proposed).toBe(1);
    expect((await k(ex.i1)).proposed).toBe(2);
    // One proposed in the playground: the source toggle separates it.
    await suDb.approvalQueueItem.create({
      data: {
        tenantId: ex.tenantId,
        knowledgeBaseId: kb.id,
        agentId: ex.a1,
        threadId: `${ex.tenantId}:playground:${ex.a1}:s1`,
        proposedContent: "x",
        normalizedHash: `e${h++}`,
        createdAt: D1,
      },
    });
    const bySource = async (source: "inbox" | "playground") =>
      (await getKnowledgeActivity(ctx(ex.tenantId), { ...DAY, source }, appDb))
        .proposed;
    expect(await bySource("playground")).toBe(1);
    expect(await bySource("inbox")).toBe(4);
  });

  test("a takeover logged with its conversation and no inbox is that conversation's inbox's", async () => {
    // Written from the webhook before any inbox is resolved: the line names the conversation only.
    await suDb.executionLog.create({
      data: {
        tenantId: ex.tenantId,
        turnId: crypto.randomUUID(),
        conversationId: ex.conv.anaOnBeto ?? null,
        stage: "handoff",
        level: "warn",
        source: "inbox",
        detail: { outcome: "taken_over" },
        createdAt: D1,
      },
    });
    const person = async (inboxId: bigint) =>
      (
        await getHandoffReasons(ctx(ex.tenantId), { ...DAY, inboxId }, appDb)
      ).totals.find((t) => t.cause === "person")?.conversations ?? 0;
    expect(await person(ex.i2)).toBe(1);
    expect(await person(ex.i1)).toBe(0);
    const problems = async (inboxId: bigint) =>
      (
        await getHealth(ctx(ex.tenantId), { ...DAY, inboxId }, appDb)
      ).problems.find((p) => p.stage === "handoff")?.lines ?? 0;
    expect(await problems(ex.i2)).toBe(1);
    expect(await problems(ex.i1)).toBe(0);
    // The Logs page the health row links to lists the same line under the same filter.
    const logs = async (inboxId: bigint) =>
      (
        await listExecutionLogs(
          ctx(ex.tenantId),
          {
            inboxId,
            stage: "handoff",
            level: "warn",
            since: DAY.since,
            until: DAY.until,
          },
          appDb,
        )
      ).items.length;
    expect(await logs(ex.i2)).toBe(1);
    expect(await logs(ex.i1)).toBe(0);
  });

  test("a handoff call that transferred nothing is not the agent's handoff", async () => {
    const line = (conv: bigint | undefined, handedOff?: boolean) =>
      suDb.executionLog.create({
        data: {
          tenantId: ex.tenantId,
          turnId: crypto.randomUUID(),
          conversationId: conv ?? null,
          inboxId: ex.i1,
          stage: "tool",
          status: "ok",
          source: "inbox",
          detail: {
            tool: "handoff_to_human",
            ...(handedOff === undefined ? {} : { handedOff }),
          },
          createdAt: D1,
        },
      });
    await line(ex.conv.noEvent1, false);
    await line(ex.conv.noEvent2, true);
    // Written before the mark existed: a clean return still counts, as it always did.
    await line(ex.conv.visionOnly);
    const r = await getHandoffReasons(ctx(ex.tenantId), DAY, appDb);
    expect(r.totals.find((t) => t.cause === "agent")?.conversations).toBe(2);
  });

  test("each series of a breakdown is the funnel of that agent's or inbox's own view", async () => {
    const week: DashboardFilter = {
      since: new Date("2026-09-01T00:00:00Z"),
      until: new Date("2026-09-08T00:00:00Z"),
      tz: "America/Sao_Paulo",
    };
    for (const breakdown of ["agent", "inbox"] as const) {
      const trend = await getOutcomeTrend(
        ctx(ex.tenantId),
        week,
        breakdown,
        appDb,
      );
      expect(trend.series?.length ?? 0).toBeGreaterThan(0);
      for (const s of trend.series ?? []) {
        const own: DashboardFilter =
          breakdown === "agent"
            ? { ...week, agentId: BigInt(s.key) }
            : { ...week, inboxId: BigInt(s.key) };
        const alone = await getOutcomeTrend(
          ctx(ex.tenantId),
          own,
          undefined,
          appDb,
        );
        expect(s.totals).toEqual(alone.totals);
        expect(s.days).toEqual(alone.days);
      }
    }
    // anaOnBeto is in both agents' series: Beto's inbox, Ana's turn.
    const byAgent = await getOutcomeTrend(
      ctx(ex.tenantId),
      week,
      "agent",
      appDb,
    );
    expect(
      byAgent.series?.find((s) => s.label === "Ana")?.totals.involved,
    ).toBe(1);
    expect(
      byAgent.series?.find((s) => s.label === "Beto")?.totals.involved,
    ).toBe(0);
  });

  test("a priced zero is a cost of zero per conversation; no price at all is no figure", async () => {
    const free = await seedConv(ex, "freeModel", {
      at: new Date("2026-09-10T12:00:00Z"),
      inbox: ex.i1,
    });
    await row(ex, {
      conv: free,
      agent: ex.a1,
      inbox: ex.i1,
      node: "agent",
      at: new Date("2026-09-10T12:00:00Z"),
      cost: 0,
    });
    const day10: DashboardFilter = {
      since: new Date("2026-09-10T00:00:00Z"),
      until: new Date("2026-09-11T00:00:00Z"),
      tz: "UTC",
    };
    const c = await getDashboardCosts(ctx(ex.tenantId), day10, appDb, noFetch);
    expect(c.costPerConversation).toBe(0);
    expect(c.days[0]?.costPerConversation).toBe(0);
    const unpriced = await seedConv(ex, "unpricedOnly", {
      at: new Date("2026-09-11T12:00:00Z"),
      inbox: ex.i1,
    });
    await suDb.llmUsage.create({
      data: {
        tenantId: ex.tenantId,
        agentId: ex.a1,
        inboxId: ex.i1,
        conversationId: unpriced,
        source: "inbox",
        model: "m-unknown",
        node: "agent",
        promptTokens: 1,
        completionTokens: 1,
        costUsd: null,
        createdAt: new Date("2026-09-11T12:00:00Z"),
      },
    });
    const u = await getDashboardCosts(
      ctx(ex.tenantId),
      {
        since: new Date("2026-09-11T00:00:00Z"),
        until: new Date("2026-09-12T00:00:00Z"),
        tz: "UTC",
      },
      appDb,
      noFetch,
    );
    expect(u.costPerConversation).toBeNull();
    expect(u.days[0]?.costPerConversation).toBeNull();
    // The breakdown reads the same rule: a model with no price is no cost per conversation.
    const byModel = await getBreakdown(
      ctx(ex.tenantId),
      {
        since: new Date("2026-09-10T00:00:00Z"),
        until: new Date("2026-09-12T00:00:00Z"),
        tz: "UTC",
      },
      "model",
      appDb,
    );
    expect(
      byModel.find((r) => r.key === "m-unknown")?.costPerConversation,
    ).toBeNull();
    expect(byModel.find((r) => r.key === "m1")?.costPerConversation).toBe(0);
  });

  test("a skip_reply the schema refused silenced nothing", async () => {
    await suDb.executionLog.create({
      data: {
        tenantId: ex.tenantId,
        turnId: crypto.randomUUID(),
        conversationId: ex.conv.visionOnly ?? null,
        inboxId: ex.i1,
        stage: "tool",
        level: "warn",
        status: "skipped",
        source: "inbox",
        detail: { tool: "skip_reply" },
        createdAt: D1,
      },
    });
    const r = await getHandoffReasons(ctx(ex.tenantId), DAY, appDb);
    expect(r.silences).toEqual([]);
  });

  test("a person taking over counts once, not at every message the gate sees them holding it", async () => {
    const conv = await seedConv(ex, "heldByPerson", { at: D1, inbox: ex.i1 });
    const takeover = (at: string, via?: string) =>
      suDb.executionLog.create({
        data: {
          tenantId: ex.tenantId,
          turnId: crypto.randomUUID(),
          conversationId: conv,
          inboxId: ex.i1,
          stage: "handoff",
          level: "warn",
          source: "inbox",
          detail: { outcome: "taken_over", ...(via ? { via } : {}) },
          createdAt: new Date(at),
        },
      });
    await takeover("2026-09-02T13:00:00Z", "reply");
    // The next customer message meets the person still holding it.
    await takeover("2026-09-03T13:00:00Z");
    // Handed back: the agent answers again, and a person takes over a second time.
    await row(ex, {
      conv,
      agent: ex.a1,
      inbox: ex.i1,
      node: "agent",
      at: new Date("2026-09-04T10:00:00Z"),
    });
    await takeover("2026-09-04T13:00:00Z");
    const person = async (since: string, until: string) =>
      (
        await getHandoffReasons(
          ctx(ex.tenantId),
          { since: new Date(since), until: new Date(until), tz: "UTC" },
          appDb,
        )
      ).totals.find((t) => t.cause === "person")?.conversations ?? 0;
    expect(await person("2026-09-03T00:00:00Z", "2026-09-04T00:00:00Z")).toBe(
      0,
    );
    expect(await person("2026-09-04T00:00:00Z", "2026-09-05T00:00:00Z")).toBe(
      1,
    );
  });

  test("the first message after the agent handed over is not a person taking over", async () => {
    const conv = await seedConv(ex, "agentHandedOver", {
      at: D1,
      inbox: ex.i1,
    });
    const line = (at: string, stage: string, detail: Record<string, unknown>) =>
      suDb.executionLog.create({
        data: {
          tenantId: ex.tenantId,
          turnId: crypto.randomUUID(),
          conversationId: conv,
          inboxId: ex.i1,
          stage,
          status: "ok",
          source: "inbox",
          detail: detail as Prisma.InputJsonObject,
          createdAt: new Date(at),
        },
      });
    const transferTurn = crypto.randomUUID();
    await suDb.executionLog.create({
      data: {
        tenantId: ex.tenantId,
        turnId: transferTurn,
        conversationId: conv,
        inboxId: ex.i1,
        stage: "tool",
        status: "ok",
        source: "inbox",
        detail: { tool: "handoff_to_human", handedOff: true },
        createdAt: new Date("2026-09-05T10:00:00Z"),
      },
    });
    // The graph goes back to the model after the tool, in the same turn: not the agent resuming.
    await suDb.llmUsage.create({
      data: {
        tenantId: ex.tenantId,
        agentId: ex.a1,
        inboxId: ex.i1,
        conversationId: conv,
        source: "inbox",
        model: "m1",
        node: "agent",
        turnId: transferTurn,
        promptTokens: 1,
        completionTokens: 1,
        costUsd: 0,
        createdAt: new Date("2026-09-05T10:00:01Z"),
      },
    });
    // The customer writes again; the gate meets the person the agent handed the conversation to.
    await line("2026-09-06T10:00:00Z", "handoff", { outcome: "taken_over" });
    const r = await getHandoffReasons(
      ctx(ex.tenantId),
      {
        since: new Date("2026-09-06T00:00:00Z"),
        until: new Date("2026-09-07T00:00:00Z"),
        tz: "UTC",
      },
      appDb,
    );
    expect(r.totals.find((t) => t.cause === "person")).toBeUndefined();
  });

  test("an inbox filter narrows the ledger figures too", async () => {
    const rows = await getBreakdown(
      ctx(ex.tenantId),
      { ...DAY, inboxId: ex.i2, source: "inbox" },
      "agent",
      appDb,
    );
    // Ana on Beto's inbox: the 7 billed there and the turn on anaOnBeto.
    expect(rows.find((r) => r.label === "Ana")?.costUsd).toBeCloseTo(8);
    const m = await getInstanceMetrics(
      ctx(ex.tenantId),
      { ...DAY, inboxId: ex.i2 },
      appDb,
    );
    expect(m.llm.byInbox.map((r) => r.inboxId)).toEqual([String(ex.i2)]);
    expect(m.llm.byInbox[0]?.calls).toBe(m.llm.calls);
  });
});
