import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { requestContext } from "@/api/lib/i18n";
import config from "@/config";
import { MetricsTooSlowError } from "@/lib/errors";
import * as tenancy from "@/lib/tenancy";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
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
import { fromKeptDays } from "@/modules/analytics/rollup/answer";
import {
  addDays,
  dayCount,
  dayStart,
  daysBetween,
  localDay,
} from "@/modules/analytics/rollup/days";
import {
  alignedDays,
  BLOCK_SECTIONS,
  type Block,
  filterKey,
  rollupVersion,
  WindowLoad,
} from "@/modules/analytics/rollup/engine";
import { costsLink, figuresOf } from "@/modules/analytics/rollup/figures";
import { learnPgLerp, pgLerp } from "@/modules/analytics/rollup/lerp";
import { COMPUTE, SECTIONS } from "@/modules/analytics/rollup/sections";
import { SETTLE_BATCH, settleDirty } from "@/modules/analytics/rollup/store";
import {
  heartbeat,
  type StreamEvent,
  streamFigures,
} from "@/modules/analytics/rollup/stream";
import { getKpis } from "@/modules/analytics/service";
import { getOutcomeTrend } from "@/modules/analytics/trends";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog } from "../utils/flowlog";
import { until } from "../utils/poll";

// THE KEPT DAYS ANSWER WHAT THE LIVE READERS ANSWER. A seeded month and a half of conversations,
// ledger rows, flow-log lines and suggestions, with conversations billed and logged across several
// days, and every block compared, window by window and filter by filter, against the live reader of
// the same block. The windows cross part boundaries, start in the middle of conversations and run in
// zones whose midnights are not UTC's.

// Every case computes and merges real days against the database: on a loaded machine one takes
// longer than the runner's five seconds without anything being wrong.
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

const noFetch = (() => {
  throw new Error("no network in this test");
}) as unknown as typeof fetch;

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const today = new Date(
  Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate(),
  ),
);
const START = new Date(today.getTime() - 46 * DAY);

let tenantId = 0n;
let a1 = 0n;
let a2 = 0n;
let i1 = 0n;
let i2 = 0n;
let i3 = 0n;
let retention = 0;

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function seed() {
  const r = rng(1383);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const t = await suDb.tenant.create({
    data: { name: "kept", slug: `kept-${process.pid}` },
  });
  tenantId = t.id;
  const inst = await seedChatwootInstance(suDb, {
    tenantId,
    accountId: 70_000 + (process.pid % 10_000),
    baseUrl: "https://kept.cw.example",
    adminToken: "enc",
  });
  const agent = (name: string) =>
    suDb.agent.create({
      data: {
        tenantId,
        name,
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "m1" },
      },
    });
  a1 = (await agent("Ana")).id;
  a2 = (await agent("Beto")).id;
  const inbox = (n: number, name: string, agentId: bigint | null) =>
    suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        chatwootInboxId: n,
        name,
        agentId,
      },
    });
  i1 = (await inbox(1, "WhatsApp", a1)).id;
  i2 = (await inbox(2, "E-mail", a2)).id;
  i3 = (await inbox(3, "Site", null)).id;
  const ledger: Prisma.LlmUsageCreateManyInput[] = [];
  const logs: Prisma.ExecutionLogCreateManyInput[] = [];
  const suggestions: {
    thread: string;
    at: Date;
    status: string;
    agent: bigint | null;
  }[] = [];
  // Names that are also the names of an object's own machinery are keys like any other.
  const labelsPool = [
    "vendas",
    "Suporte",
    "ação",
    "b_c",
    "B",
    "pix",
    "__proto__",
    "constructor",
  ];
  const models = [
    "gpt-6-luna",
    "gpt-5.6-luna",
    "claude-haiku-5-5",
    "constructor",
    "__proto__",
  ];
  const nodes = [
    null,
    null,
    "agent",
    "vision",
    "observer",
    "suggestion_review",
  ];
  const causes = [
    { stage: "tool", detail: { tool: "handoff_to_human", handedOff: true } },
    { stage: "tool", detail: { tool: "handoff_to_human" } },
    {
      stage: "handoff",
      detail: {
        outcome: "opened_after_skip",
        reason: "needs_human",
        assigned: "agent",
      },
    },
    {
      stage: "handoff",
      detail: {
        outcome: "opened_after_skip",
        reason: "not_for_us",
        assigned: "routing",
      },
    },
    {
      stage: "handoff",
      detail: { outcome: "opened_after_skip", assigned: "failed" },
    },
    {
      stage: "handoff",
      detail: { outcome: "guardrail_handoff", assigned: "team" },
    },
    { stage: "handoff", detail: { outcome: "taken_over" } },
    {
      stage: "tool",
      detail: { tool: "skip_reply", skipReason: "needs_human" },
    },
    { stage: "tool", detail: { tool: "skip_reply", skipReason: "not_for_us" } },
    { stage: "tool", detail: { tool: "skip_reply" } },
  ] as const;
  for (let n = 0; n < 420; n++) {
    const at = new Date(START.getTime() + Math.floor(r() * 46 * DAY));
    const inboxId = pick([i1, i2, i3, i1]);
    const cid = 10_000 + n;
    const reply = r() < 0.4;
    const created = new Date(at.getTime() - Math.floor(r() * 3_600_000));
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        inboxId,
        chatwootConversationId: cid,
        status: pick(["open", "resolved", "resolved", "pending"]),
        resolvedBy: pick([
          null,
          "agent",
          "agent",
          "legacy_unknown",
          "followup_abandonment",
          "human",
        ]),
        assigneeType: pick([null, null, "AgentBot", "User"]),
        threadId: `${tenantId}:${inst.id}:${cid}`,
        labels:
          r() < 0.6
            ? [pick(labelsPool), ...(r() < 0.3 ? [pick(labelsPool)] : [])]
            : [],
        createdAt: at,
        lastInboundAt: new Date(at.getTime() + Math.floor(r() * 8 * DAY)),
        chatwootCreatedAt: reply ? created : null,
        chatwootFirstReplyAt: reply
          ? new Date(created.getTime() + Math.floor(r() * 7_200_000) + r())
          : null,
      },
    });
    // Billed and logged over up to six days after its creation, so conversations straddle parts.
    const span = Math.floor(r() * 6);
    const calls = Math.floor(r() * 7);
    const agentId = pick([a1, a2, a1, null]);
    for (let k = 0; k < calls; k++) {
      ledger.push({
        tenantId,
        agentId: r() < 0.85 ? agentId : pick([a1, a2]),
        inboxId: r() < 0.9 ? inboxId : null,
        conversationId: conv.id,
        source: r() < 0.9 ? "inbox" : "playground",
        model: pick(models),
        node: pick(nodes),
        promptTokens: Math.floor(r() * 3000),
        completionTokens: Math.floor(r() * 400),
        cachedReadTokens: Math.floor(r() * 1000),
        costUsd: r() < 0.9 ? (r() * 0.05).toFixed(10) : null,
        durationMs: r() < 0.95 ? 200 + Math.floor(r() * r() * 30_000) : null,
        turnId: `t${n}-${k}`,
        createdAt: new Date(
          at.getTime() + Math.floor(r() * span * DAY) + k * 1000,
        ),
      });
    }
    const lines = Math.floor(r() * 5);
    for (let k = 0; k < lines; k++) {
      const c = pick(causes);
      logs.push({
        tenantId,
        turnId: `t${n}-${Math.floor(r() * calls + 1)}`,
        conversationId: conv.id,
        agentId,
        inboxId: r() < 0.7 ? inboxId : null,
        stage: c.stage,
        level: "info",
        status: r() < 0.9 ? "ok" : "skipped",
        source: "inbox",
        detail: c.detail as Prisma.InputJsonObject,
        createdAt: new Date(
          at.getTime() + Math.floor(r() * span * DAY) + 500 + k,
        ),
      });
    }
    if (r() < 0.3) {
      const steps = 1 + Math.floor(r() * 3);
      for (let k = 0; k < steps; k++)
        logs.push({
          tenantId,
          turnId: `f${n}-${k}`,
          conversationId: conv.id,
          agentId,
          inboxId,
          stage: "generate",
          level: "info",
          status: "ok",
          source: "inbox",
          detail: {
            trigger: "followup",
            outcome: pick(["messaged", "templated", "failed"]),
          },
          createdAt: new Date(
            at.getTime() + (k + 1) * Math.floor(r() * 2 * DAY),
          ),
        });
    }
    if (r() < 0.35)
      logs.push({
        tenantId,
        turnId: `p${n}`,
        conversationId: r() < 0.9 ? conv.id : null,
        agentId,
        inboxId,
        stage: pick(["tool", "generate", "deliver"]),
        level: pick(["warn", "error"]),
        status: "error",
        source: "inbox",
        detail:
          r() < 0.7
            ? { tool: pick(["kanban_move_card", "search_knowledge"]) }
            : {},
        createdAt: new Date(at.getTime() + Math.floor(r() * span * DAY)),
      });
    if (r() < 0.15)
      suggestions.push({
        thread:
          r() < 0.8 ? conv.threadId : `${tenantId}:playground:${a1}:x${n}`,
        at: new Date(at.getTime() + Math.floor(r() * DAY)),
        status: pick([
          "PENDING",
          "APPROVED",
          "REJECTED",
          "DISCARDED",
          "EDITED",
          "SCREENING",
        ]),
        agent: pick([a1, a2, null]),
      });
  }
  // Ledger rows that are no conversation's (a playground turn, a vision read with no thread).
  for (let k = 0; k < 60; k++)
    ledger.push({
      tenantId,
      agentId: pick([a1, a2]),
      source: pick(["playground", "inbox"]),
      model: pick(models),
      node: pick(nodes),
      promptTokens: 500,
      completionTokens: 50,
      costUsd: r() < 0.7 ? "0.0100000000" : null,
      durationMs: 300 + k * 17,
      createdAt: new Date(START.getTime() + Math.floor(r() * 46 * DAY)),
    });
  // Client channel traffic, half from anonymous visitors: ledger rows and flow lines carry the
  // audience themselves, a suggestion through its thread's owner. A generator of its own, so the
  // rows above stay what they were.
  const rc = rng(2222);
  const people = [
    { externalId: "anon:kept-visitor", anonymous: true },
    { externalId: "kept-user", anonymous: false },
  ];
  for (const p of people) {
    const eu = await suDb.externalUser.create({
      data: { tenantId, channel: "client", externalId: p.externalId },
    });
    for (let k = 0; k < 4; k++) {
      const thread = `${tenantId}:client:${a1}:${p.anonymous ? "a" : "i"}${k}`;
      await suDb.detachedThread.create({
        data: {
          threadId: thread,
          tenantId,
          agentId: a1,
          kind: "client",
          externalUserId: eu.id,
        },
      });
      const at = new Date(START.getTime() + Math.floor(rc() * 46 * DAY));
      suggestions.push({
        thread,
        at,
        status: rc() < 0.5 ? "PENDING" : "APPROVED",
        agent: a1,
      });
      for (let j = 0; j < 5; j++) {
        const when = new Date(at.getTime() + j * 60_000);
        ledger.push({
          tenantId,
          agentId: a1,
          source: "client",
          anonymous: p.anonymous,
          model: "gpt-6-luna",
          promptTokens: 400,
          completionTokens: 40,
          costUsd: "0.0050000000",
          durationMs: 500 + j,
          turnId: `c${p.anonymous ? "a" : "i"}${k}-${j}`,
          createdAt: when,
        });
        logs.push({
          tenantId,
          turnId: `c${p.anonymous ? "a" : "i"}${k}-${j}`,
          agentId: a1,
          stage: j === 4 ? "tool" : "generate",
          level: j === 4 ? "warn" : "info",
          status: j === 4 ? "error" : "ok",
          source: "client",
          anonymous: p.anonymous,
          detail: j === 4 ? { tool: "search_knowledge" } : {},
          createdAt: when,
        });
      }
    }
  }
  await suDb.llmUsage.createMany({ data: ledger });
  await suDb.executionLog.createMany({ data: logs });
  if (suggestions.length > 0) {
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "kb" },
    });
    for (const [k, s] of suggestions.entries())
      await suDb.$executeRawUnsafe(
        `INSERT INTO approval_queue_items (tenant_id, knowledge_base_id, thread_id, proposed_content, status, agent_id, normalized_hash, created_at, updated_at)
         VALUES ($1, $2, $3, 'x', $4::"ApprovalStatus", $5, $6, $7, $7)`,
        tenantId,
        kb.id,
        s.thread,
        s.status,
        s.agent,
        `h${k}`,
        s.at,
      );
  }
  // The seed is history: its writes queued every day as changed, and a day changed in the last
  // minutes is computed but not kept. An hour back, they read as the old changes they stand for.
  await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
}

// A list the live reader leaves in database order on ties, put in one order for both sides.
function canon(v: unknown): unknown {
  if (Array.isArray(v)) {
    const items = v.map(canon);
    return items.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
  }
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, canon(x)]));
  return v;
}

async function live(block: Block, f: DashboardFilter): Promise<unknown> {
  const c = ctx();
  switch (block) {
    case "kpis":
      return getKpis(c, f, appDb);
    case "outcomes":
      return {
        trend: await getOutcomeTrend(c, f, undefined, appDb),
        agent: (await getOutcomeTrend(c, f, "agent", appDb)).series,
        inbox: (await getOutcomeTrend(c, f, "inbox", appDb)).series,
      };
    case "costs":
      return getDashboardCosts(c, f, appDb, noFetch);
    case "breakdown":
      return {
        agent: await getBreakdown(c, f, "agent", appDb),
        inbox: await getBreakdown(c, f, "inbox", appDb),
        model: await getBreakdown(c, f, "model", appDb),
        node: await getBreakdown(c, f, "node", appDb),
      };
    case "handoffs":
      return getHandoffReasons(c, f, appDb);
    case "labels":
      return getLabelOutcomes(c, f, appDb);
    case "health":
      return getHealth(c, f, appDb);
    case "followUps":
      return getFollowUpActivity(c, f, appDb);
    case "knowledge":
      return getKnowledgeActivity(c, f, appDb);
  }
}

async function kept(block: Block, f: DashboardFilter): Promise<unknown> {
  const w = alignedDays(f);
  if (!w) throw new Error("window not aligned");
  const load = await new WindowLoad(
    ctx(),
    f,
    BLOCK_SECTIONS[block],
    w,
    appDb,
  ).complete();
  const fig = await figuresOf(ctx(), load, [block], null, appDb);
  switch (block) {
    case "outcomes":
      return {
        trend: fig.trend,
        agent: fig.series?.agent,
        inbox: fig.series?.inbox,
      };
    case "costs":
      return fig.costs;
    default:
      return fig[block];
  }
}

const BLOCKS: Block[] = [
  "kpis",
  "outcomes",
  "costs",
  "breakdown",
  "handoffs",
  "labels",
  "health",
  "followUps",
  "knowledge",
];

function windowOf(
  tz: string,
  fromDaysAgo: number,
  toDaysAgo: number,
  extra: Partial<DashboardFilter> = {},
): DashboardFilter {
  const t = localDay(Date.now(), tz);
  return {
    since: dayStart(addDays(t, -fromDaysAgo), tz),
    until: dayStart(addDays(t, -toDaysAgo + 1), tz),
    tz,
    ...extra,
  };
}

async function clearKept() {
  await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
}

// Back to the state the seed leaves: no change waiting in the queue, every queued change an hour
// old, and no day kept. A test that leaves a change unsettled, a change from the last minutes or a
// kept day then cannot make the next one skip a day, count a batch short or find its window in.
async function fromHistory() {
  const settle = (db: tenancy.ScopedDb) =>
    settleDirty(db, `dashboard-settle|${tenantId}`);
  while ((await runScopedOn(appDb, ctx(), settle)) > 0);
  await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
  await clearKept();
}

describe.skipIf(!dbUp)("the kept days of the dashboard", () => {
  beforeAll(async () => {
    retention = config.flowlog.retentionDays;
    config.flowlog.retentionDays = 3650;
    await seed();
  });

  beforeEach(fromHistory);

  afterAll(async () => {
    config.flowlog.retentionDays = retention;
    if (!dbUp) return;
    await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
    await suDb.$executeRaw`DELETE FROM dashboard_dirty WHERE tenant_id = ${tenantId}`;
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  const cases: [string, () => DashboardFilter][] = [
    ["45 days, UTC", () => windowOf("UTC", 44, 0)],
    ["the middle ten days, UTC", () => windowOf("UTC", 25, 16)],
    ["35 days in São Paulo", () => windowOf("America/Sao_Paulo", 34, 0)],
    [
      "20 days in Kathmandu, inbox source",
      () => windowOf("Asia/Kathmandu", 30, 11, { source: "inbox" }),
    ],
    ["40 days, one agent", () => windowOf("UTC", 39, 0, { agentId: a1 })],
    [
      "40 days, one inbox, playground",
      () =>
        windowOf("America/Sao_Paulo", 39, 2, {
          inboxId: i1,
          source: "playground",
        }),
    ],
    [
      "40 days, the unbound inbox",
      () => windowOf("UTC", 39, 0, { inboxId: i3 }),
    ],
    [
      "45 days, client channel",
      () => windowOf("UTC", 44, 0, { source: "client" }),
    ],
    [
      "45 days, anonymous visitors",
      () =>
        windowOf("America/Sao_Paulo", 44, 0, {
          source: "client",
          audience: "anonymous",
        }),
    ],
    [
      "45 days, identified users",
      () =>
        windowOf("UTC", 44, 0, { source: "client", audience: "identified" }),
    ],
    [
      "the whole history",
      () => ({
        until: dayStart(addDays(localDay(Date.now(), "UTC"), 1), "UTC"),
        tz: "UTC",
      }),
    ],
  ];

  for (const [name, make] of cases) {
    test(`every block equals the live reader: ${name}`, async () => {
      const f = make();
      for (const block of BLOCKS) {
        const expected = canon(await live(block, f));
        // Cold: every part computed now. Warm: every day read back from what the first pass kept.
        expect(canon(await kept(block, f))).toEqual(expected);
        expect(canon(await kept(block, f))).toEqual(expected);
      }
    }, 120_000);
  }

  test("a second opening computes today and yesterday while it reads the kept days, and is whole at once", async () => {
    await clearKept();
    const f = windowOf("UTC", 39, 0);
    await kept("costs", f);
    const [stored] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(DISTINCT day)::int AS n FROM dashboard_days
       WHERE tenant_id = ${tenantId} AND section = 'ledger.costs'`;
    expect(stored?.n).toBe(38);
    const w = alignedDays(f);
    if (!w) throw new Error("not aligned");
    const load = new WindowLoad(ctx(), f, BLOCK_SECTIONS.costs, w, appDb);
    await load.prepare();
    expect(load.progress().pending).toEqual([]);
    expect(load.progress().ready).toBe(40);
    expect(load.done()).toBe(true);
  });

  test("the parts go most recent first, at most 30 days each", async () => {
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    const w = alignedDays(f);
    if (!w) throw new Error("not aligned");
    const load = new WindowLoad(ctx(), f, ["ledger.costs"], w, appDb);
    await load.prepare();
    const seen: [string, string][] = [];
    const before = load.progress();
    expect(before.pending.length).toBe(1);
    while (!load.done()) {
      const p = load.progress();
      await load.step();
      if (p.pending[0]) seen.push(p.pending[0]);
    }
    expect(load.progress().ready).toBe(45);
    const t = localDay(Date.now(), "UTC");
    expect(seen[0]).toEqual([addDays(t, -44), addDays(t, -2)]);
  });

  test("a change to a conversation of a kept day drops that day, through any writer", async () => {
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("kpis", f);
    const [conv] = await suDb.$queryRaw<{ id: bigint; day: string }[]>`
      SELECT id, to_char(created_at::date, 'YYYY-MM-DD') AS day FROM conversations
       WHERE tenant_id = ${tenantId}
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at LIMIT 1`;
    if (!conv) throw new Error("no conversation");
    const before = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_days
       WHERE tenant_id = ${tenantId} AND section = 'conv.funnel' AND day = ${conv.day}::date`;
    expect(before[0]?.n).toBe(1);
    await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(tenantId)}, true)`;
      await tx.$executeRaw`UPDATE conversations SET assignee_type = 'User', status = 'open' WHERE id = ${conv.id}`;
    });
    expect(canon(await kept("kpis", f))).toEqual(canon(await live("kpis", f)));
    const [processed] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_dirty
       WHERE tenant_id = ${tenantId} AND conversation_id = ${conv.id} AND processed_at IS NOT NULL`;
    expect(processed?.n).toBeGreaterThan(0);
  });

  test("a late ledger row and a repricing drop the days they reach", async () => {
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("costs", f);
    await kept("breakdown", f);
    const [row] = await suDb.$queryRaw<
      { id: bigint; conversation_id: bigint }[]
    >`
      SELECT id, conversation_id FROM llm_usage
       WHERE tenant_id = ${tenantId} AND conversation_id IS NOT NULL AND cost_usd IS NOT NULL
         AND created_at < now() - interval '5 days'
       ORDER BY created_at LIMIT 1`;
    if (!row) throw new Error("no row");
    await suDb.$executeRaw`UPDATE llm_usage SET cost_usd = cost_usd * 3 WHERE id = ${row.id}`;
    await suDb.llmUsage.create({
      data: {
        tenantId,
        agentId: a2,
        conversationId: row.conversation_id,
        source: "inbox",
        model: "late-model",
        promptTokens: 10,
        completionTokens: 1,
        costUsd: "1.2500000000",
        durationMs: 999,
        createdAt: new Date(Date.now() - 20 * DAY),
      },
    });
    for (const block of ["costs", "breakdown", "health", "kpis"] as Block[])
      expect(canon(await kept(block, f))).toEqual(canon(await live(block, f)));
  });

  test("a flow-log day the retention sweep emptied keeps its figures, and one never kept has no data", async () => {
    // Every earlier change old enough for its day to be kept by the first opening below.
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    const before = await kept("handoffs", f);
    // Retention now cuts the window in half: the kept days stay, and nothing recomputes them.
    config.flowlog.retentionDays = 20;
    try {
      expect(canon(await kept("handoffs", f))).toEqual(canon(before));
      await clearKept();
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      const load = await new WindowLoad(
        ctx(),
        f,
        ["log.handoffs"],
        w,
        appDb,
      ).complete();
      const p = load.progress();
      expect(p.families.log.noData).toBeGreaterThan(20);
      expect(p.families.log.ready + p.families.log.noData).toBe(45);
    } finally {
      config.flowlog.retentionDays = 3650;
    }
  }, 120_000);

  test("the stream sends what is kept, then each part most recent first, and ends on the live figures", async () => {
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("kpis", windowOf("UTC", 9, 0));
    const events: StreamEvent[] = [];
    for await (const e of streamFigures(
      ctx(),
      f,
      ["kpis", "handoffs"],
      undefined,
      appDb,
    ))
      events.push(e);
    const first = events[0];
    const last = events[events.length - 1];
    if (first?.kind !== "snapshot" || last?.kind !== "snapshot")
      throw new Error("no snapshots");
    expect(first.done).toBe(false);
    // The last ten days: kept by the earlier request, and today and yesterday computed beside them.
    expect(first.progress.families.conv.ready).toBe(10);
    expect(last.done).toBe(true);
    expect(last.progress.ready).toBe(45);
    const t = localDay(Date.now(), "UTC");
    const computing = events.flatMap((e) =>
      e.kind === "computing" && e.progress.computing
        ? [e.progress.computing]
        : [],
    );
    const d = (n: number) => addDays(t, -n);
    // Every missing run in parts of 30 days, by last day (today and yesterday came with the first).
    expect(computing).toEqual([
      [d(31), d(2)],
      [d(39), d(10)],
      [d(44), d(32)],
      [d(44), d(40)],
    ]);
    const ready = events.flatMap((e) =>
      e.kind === "snapshot" ? [e.progress.ready] : [],
    );
    expect(ready).toEqual([...ready].sort((a, b) => a - b));
    expect(canon(last.figures.kpis)).toEqual(canon(await live("kpis", f)));
    expect(canon(last.figures.handoffs)).toEqual(
      canon(await live("handoffs", f)),
    );
  });

  test("a window that is not whole days streams the live figures at once", async () => {
    const f = {
      ...windowOf("UTC", 9, 0),
      since: new Date(Date.now() - 3 * DAY),
    };
    const events: StreamEvent[] = [];
    for await (const e of streamFigures(ctx(), f, ["kpis"], undefined, appDb))
      events.push(e);
    expect(events.length).toBe(1);
    const [only] = events;
    if (only?.kind !== "snapshot") throw new Error("no snapshot");
    expect(only.done).toBe(true);
    expect(only.figures.kpis).toEqual(await getKpis(ctx(), f, appDb));
  });

  test("the day the retention cutoff falls in is read as the live reader reads it, and never kept", async () => {
    await clearKept();
    config.flowlog.retentionDays = 20;
    try {
      // The cutoff is 20 days back at this instant, inside that UTC day unless the test runs at midnight.
      const f = windowOf("UTC", 20, 0);
      for (const block of ["handoffs", "followUps", "health"] as Block[])
        expect(canon(await kept(block, f))).toEqual(
          canon(await live(block, f)),
        );
      const boundary = addDays(localDay(Date.now(), "UTC"), -20);
      const [row] = await suDb.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM dashboard_days
         WHERE tenant_id = ${tenantId} AND section LIKE 'log.%' AND day = ${boundary}::date`;
      expect(row?.n).toBe(0);
    } finally {
      config.flowlog.retentionDays = 3650;
    }
  });

  test("a change settled before its part began is kept with the part, and a reload computes only the day it reached", async () => {
    await fromHistory();
    const f = windowOf("UTC", 44, 0);
    const [conv] = await suDb.$queryRaw<{ id: bigint; day: string }[]>`
      SELECT id, to_char(created_at::date, 'YYYY-MM-DD') AS day FROM conversations
       WHERE tenant_id = ${tenantId}
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at DESC LIMIT 1`;
    if (!conv) throw new Error("no conversation");
    const stamps = async () =>
      new Map(
        (
          await suDb.$queryRaw<{ day: string; at: string }[]>`
            SELECT to_char(day, 'YYYY-MM-DD') AS day, computed_at::text AS at FROM dashboard_days
             WHERE tenant_id = ${tenantId} AND section = 'conv.labels' AND tz = 'UTC'`
        ).map((r) => [r.day, r.at]),
      );
    // A tenant whose old conversations change every few minutes: the change is queued just before
    // the load, which settles it before any part reads, so every part's snapshot already sees it.
    await suDb.$executeRaw`UPDATE conversations SET labels = ARRAY['tardia'] WHERE id = ${conv.id}`;
    expect(canon(await kept("labels", f))).toEqual(
      canon(await live("labels", f)),
    );
    const first = await stamps();
    expect(first.has(conv.day)).toBe(true);
    // Every past day from the tenant's first record on (a day before it is empty without a row).
    const past = daysBetween(
      [...first.keys()].sort()[0] ?? addDays(localDay(Date.now(), "UTC"), -44),
      addDays(localDay(Date.now(), "UTC"), -2),
    );
    expect(past.filter((d) => !first.has(d))).toEqual([]);
    // The next change, minutes later, reaches the same day: the reload computes that day alone.
    await suDb.$executeRaw`UPDATE conversations SET labels = ARRAY['tardia', 'outra'] WHERE id = ${conv.id}`;
    expect(canon(await kept("labels", f))).toEqual(
      canon(await live("labels", f)),
    );
    const second = await stamps();
    const recomputed = past.filter((d) => second.get(d) !== first.get(d));
    expect(recomputed).toEqual([conv.day]);
    // And a reload with no change in between computes no past day at all.
    await kept("labels", f);
    expect(await stamps()).toEqual(second);
  });

  test("a change still queued when the part checks is not kept, however long its writer ran", async () => {
    await fromHistory();
    const f = windowOf("UTC", 44, 0);
    const [conv] = await suDb.$queryRaw<{ id: bigint; day: string }[]>`
      SELECT id, to_char(created_at::date, 'YYYY-MM-DD') AS day FROM conversations
       WHERE tenant_id = ${tenantId}
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at DESC LIMIT 1 OFFSET 1`;
    if (!conv) throw new Error("no conversation");
    const compute = COMPUTE.conv;
    let raced = false;
    COMPUTE.conv = async (...args) => {
      await compute(...args);
      const range = args[4];
      if (raced || range.first > conv.day || range.last < conv.day) return;
      raced = true;
      // After the part read: a transaction that began ten minutes ago commits its change, which
      // nobody settles before the part keeps its days.
      await suDb.$executeRaw`UPDATE conversations SET labels = ARRAY['fila'] WHERE id = ${conv.id}`;
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '10 minutes' WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
    };
    try {
      await kept("labels", f);
    } finally {
      COMPUTE.conv = compute;
    }
    expect(raced).toBe(true);
    const stored = await suDb.$queryRaw<{ day: string }[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day FROM dashboard_days
       WHERE tenant_id = ${tenantId} AND section = 'conv.labels' AND tz = 'UTC'`;
    const days = stored.map((r) => r.day);
    expect(days).not.toContain(conv.day);
    expect(days.length).toBeGreaterThan(30);
    expect(canon(await kept("labels", f))).toEqual(
      canon(await live("labels", f)),
    );
  });

  test("an inbox bound to another agent while the part runs keeps no conversation day of it", async () => {
    await fromHistory();
    const f = windowOf("UTC", 44, 0);
    const compute = COMPUTE.conv;
    let raced = false;
    COMPUTE.conv = async (...args) => {
      await compute(...args);
      // A part of the window's past days, the kind that is kept (not today and yesterday, nor the
      // fixed range the version hash records).
      const range = args[4];
      if (
        raced ||
        range.first < addDays(localDay(Date.now(), "UTC"), -44) ||
        range.last >= addDays(localDay(Date.now(), "UTC"), -1)
      )
        return;
      raced = true;
      // What the binding trigger queues: every conversation day moves, and nobody settles it yet.
      await suDb.$executeRaw`INSERT INTO dashboard_dirty (tenant_id, section) VALUES (${tenantId}, 'conv-all')`;
    };
    try {
      await kept("labels", f);
    } finally {
      COMPUTE.conv = compute;
    }
    expect(raced).toBe(true);
    const [stored] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_days
       WHERE tenant_id = ${tenantId} AND section LIKE 'conv.%'`;
    expect(stored?.n).toBe(0);
  });

  test("a change from a writer that began long before the part, settled while the part ran, is not kept stale", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    const [conv] = await suDb.$queryRaw<{ id: bigint; day: string }[]>`
      SELECT id, to_char(created_at::date, 'YYYY-MM-DD') AS day FROM conversations
       WHERE tenant_id = ${tenantId}
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at DESC LIMIT 1 OFFSET 2`;
    if (!conv) throw new Error("no conversation");
    const compute = COMPUTE.conv;
    let raced = false;
    COMPUTE.conv = async (...args) => {
      await compute(...args);
      const range = args[4];
      if (raced || range.first > conv.day || range.last < conv.day) return;
      raced = true;
      // After the part read: a maintenance transaction that began ten minutes ago commits its change,
      // and another request settles it before the part publishes.
      await suDb.$executeRaw`UPDATE conversations SET labels = ARRAY['manutencao'] WHERE id = ${conv.id}`;
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '10 minutes' WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
      await runScopedOn(appDb, ctx(), (db) =>
        settleDirty(db, `dashboard-settle|${tenantId}`),
      );
    };
    try {
      await kept("labels", f);
    } finally {
      COMPUTE.conv = compute;
    }
    expect(raced).toBe(true);
    const stored = await suDb.$queryRaw<{ day: string }[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day FROM dashboard_days
       WHERE tenant_id = ${tenantId} AND section = 'conv.labels' AND tz = 'UTC'`;
    expect(stored.map((r) => r.day)).not.toContain(conv.day);
    expect(canon(await kept("labels", f))).toEqual(
      canon(await live("labels", f)),
    );
  });

  test("a percentile repeats the server's own interpolation to the last digit", async () => {
    const r = rng(7);
    const cases: { p: number; v: number[] }[] = [];
    for (let k = 0; k < 300; k++) {
      const n = 2 + Math.floor(r() * 400);
      cases.push({
        p: [0.5, 0.9, 0.75, 0.1][k % 4] as number,
        v: Array.from({ length: n }, () => Math.round(r() * 1e9) / 1e3).sort(
          (a, b) => a - b,
        ),
      });
    }
    const rows = await appDb.$queryRaw<{ i: number; q: number }[]>`
      SELECT c.i, percentile_cont(c.p) WITHIN GROUP (ORDER BY u.x) AS q
        FROM jsonb_to_recordset(${JSON.stringify(cases.map((c, i) => ({ i, p: c.p, v: c.v })))}::jsonb)
               AS c(i int, p float8, v float8[])
        CROSS JOIN LATERAL unnest(c.v) AS u(x)
       GROUP BY c.i, c.p`;
    await runScopedOn(appDb, ctx(), (db) => learnPgLerp(db));
    const wrong = rows.filter(({ i, q }) => {
      const c = cases[i];
      if (!c) return true;
      const pos = c.p * (c.v.length - 1);
      const lo = c.v[Math.floor(pos)] as number;
      const hi = c.v[Math.ceil(pos)] as number;
      const mine =
        Math.floor(pos) === Math.ceil(pos)
          ? lo
          : pgLerp(c.p, c.v.length, lo, hi);
      return mine !== Number(q);
    });
    expect(wrong.length).toBe(0);
  });

  test("a kept flow-log day past retention ignores a later change to its conversation", async () => {
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("handoffs", f);
    const [line] = await suDb.$queryRaw<{ cid: bigint; day: string }[]>`
      SELECT l.conversation_id AS cid, to_char(l.created_at::date, 'YYYY-MM-DD') AS day
        FROM execution_logs l
       WHERE l.tenant_id = ${tenantId} AND l.stage = 'handoff' AND l.conversation_id IS NOT NULL
         AND l.created_at BETWEEN now() - interval '40 days' AND now() - interval '30 days'
       ORDER BY l.created_at LIMIT 1`;
    if (!line) throw new Error("no old flow-log line");
    const count = () => suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_days
       WHERE tenant_id = ${tenantId} AND section = 'log.handoffs' AND day = ${line.day}::date`;
    expect((await count())[0]?.n).toBe(1);
    config.flowlog.retentionDays = 20;
    try {
      await suDb.$executeRaw`UPDATE conversations SET status = 'resolved', resolved_by = 'human' WHERE id = ${line.cid}`;
      await kept("handoffs", f);
      expect((await count())[0]?.n).toBe(1);
    } finally {
      config.flowlog.retentionDays = 3650;
    }
  });

  test("a merge reads kept cells through the transaction it holds, on a pool of one", async () => {
    const one = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl as string, max: 1 }),
    });
    const timeout = config.metrics.timeoutMs;
    config.metrics.timeoutMs = 3_000;
    try {
      const f = windowOf("UTC", 30, 0);
      await kept("kpis", f);
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      // Warm: the percentile cells are not in memory and are read back while the merge holds the
      // only connection.
      const load = await new WindowLoad(
        ctx(),
        f,
        BLOCK_SECTIONS.kpis,
        w,
        one,
      ).complete();
      const fig = await figuresOf(ctx(), load, ["kpis"], null, one);
      expect(canon(fig.kpis)).toEqual(canon(await live("kpis", f)));
    } finally {
      config.metrics.timeoutMs = timeout;
      await one.$disconnect();
    }
  });

  test("a fresh billed call on an older conversation drops the day the conversation started", async () => {
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("kpis", f);
    const [conv] = await suDb.$queryRaw<{ id: bigint; day: string }[]>`
      SELECT c.id, to_char(c.created_at::date, 'YYYY-MM-DD') AS day FROM conversations c
       WHERE c.tenant_id = ${tenantId}
         AND c.created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
         AND NOT EXISTS (SELECT 1 FROM llm_usage u WHERE u.conversation_id = c.id)
       ORDER BY c.created_at LIMIT 1`;
    if (!conv) throw new Error("no conversation without a turn");
    const before = canon(await live("kpis", f));
    // Today: the agent's first turn on it, a proactive nudge, say.
    await suDb.llmUsage.create({
      data: {
        tenantId,
        agentId: a1,
        conversationId: conv.id,
        source: "inbox",
        model: "gpt-6-luna",
        promptTokens: 1,
        completionTokens: 1,
      },
    });
    const after = canon(await live("kpis", f));
    expect(after).not.toEqual(before);
    expect(canon(await kept("kpis", f))).toEqual(after);
  });

  test("a queue longer than one batch is settled whole before a day is read", async () => {
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("labels", f);
    const [conv] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM conversations WHERE tenant_id = ${tenantId}
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at LIMIT 1`;
    if (!conv) throw new Error("no conversation");
    // A batch's worth of changes to nothing, queued first, then the one that matters.
    await suDb.$executeRaw`
      INSERT INTO dashboard_dirty (tenant_id, section, at, created_at)
      SELECT ${tenantId}, 'know', TIMESTAMP '2000-01-01', (now() AT TIME ZONE 'UTC') - interval '1 hour'
        FROM generate_series(1, ${SETTLE_BATCH})`;
    await suDb.$executeRaw`UPDATE conversations SET labels = ARRAY['por-ultimo'] WHERE id = ${conv.id}`;
    expect(canon(await kept("labels", f))).toEqual(
      canon(await live("labels", f)),
    );
  });

  test("a backlog that fails partway keeps the batches it settled", async () => {
    await suDb.$executeRaw`
      INSERT INTO dashboard_days (tenant_id, version, filter_key, tz, section, day, data)
      VALUES (${tenantId}, 'x', 'x', 'UTC', 'know.boom', DATE '1999-06-01', '{}')`;
    await suDb.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION kept_days_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.section = 'know.boom' THEN RAISE EXCEPTION 'boom'; END IF;
        RETURN OLD;
      END $$`);
    await suDb.$executeRawUnsafe(
      `CREATE TRIGGER kept_days_test_boom BEFORE DELETE ON dashboard_days FOR EACH ROW EXECUTE FUNCTION kept_days_test_boom()`,
    );
    try {
      // A batch's worth that settles, then one whose kept day cannot be dropped.
      await suDb.$executeRaw`
        INSERT INTO dashboard_dirty (tenant_id, section, at, created_at)
        SELECT ${tenantId}, 'know', TIMESTAMP '2000-01-02', (now() AT TIME ZONE 'UTC') - interval '1 hour'
          FROM generate_series(1, ${SETTLE_BATCH})`;
      await suDb.$executeRaw`
        INSERT INTO dashboard_dirty (tenant_id, section, at, created_at)
        VALUES (${tenantId}, 'know', TIMESTAMP '1999-06-01 12:00', (now() AT TIME ZONE 'UTC') - interval '1 hour')`;
      await expect(kept("knowledge", windowOf("UTC", 44, 0))).rejects.toThrow(
        "boom",
      );
      const [row] = await suDb.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM dashboard_dirty
         WHERE tenant_id = ${tenantId} AND at = TIMESTAMP '2000-01-02' AND processed_at IS NOT NULL`;
      expect(row?.n).toBe(SETTLE_BATCH);
    } finally {
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER kept_days_test_boom ON dashboard_days",
      );
      await suDb.$executeRawUnsafe("DROP FUNCTION kept_days_test_boom()");
      await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId} AND section = 'know.boom'`;
      await suDb.$executeRaw`DELETE FROM dashboard_dirty WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
    }
  });

  test("a request waits for a change another request is settling before it reads a kept day", async () => {
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("labels", f);
    const [conv] = await suDb.$queryRaw<{ id: bigint; day: string }[]>`
      SELECT id, to_char(created_at::date, 'YYYY-MM-DD') AS day FROM conversations
       WHERE tenant_id = ${tenantId}
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at DESC LIMIT 1`;
    if (!conv) throw new Error("no conversation");
    await suDb.$executeRaw`UPDATE conversations SET labels = ARRAY['enquanto-isso'] WHERE id = ${conv.id}`;
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
    let reading: Promise<unknown> | undefined;
    // Another request in the middle of settling that change: its row taken, the day not yet dropped
    // for anyone else.
    await suDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM dashboard_dirty
           WHERE tenant_id = ${tenantId} AND processed_at IS NULL FOR UPDATE`;
        await tx.$executeRaw`
          DELETE FROM dashboard_days WHERE tenant_id = ${tenantId} AND section LIKE 'conv.%' AND day = ${conv.day}::date`;
        reading = kept("labels", f);
        await until(
          "the reader waiting for the row being settled",
          async () => {
            const [w] = await suDb.$queryRaw<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM dashboard_dirty%'`;
            return (w?.n ?? 0) > 0;
          },
        );
        await tx.$executeRaw`
          UPDATE dashboard_dirty SET processed_at = now() AT TIME ZONE 'UTC'
           WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
      },
      { timeout: 20_000 },
    );
    expect(canon(await reading)).toEqual(canon(await live("labels", f)));
  });

  test("a percentile whose kept day is computed again under it reads the new day whole", async () => {
    // Every earlier change old enough for its day to be kept, so the load below reads it from the store.
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("kpis", f);
    const w = alignedDays(f);
    if (!w) throw new Error("not aligned");
    // Histograms read, cells not yet.
    const load = await new WindowLoad(
      ctx(),
      f,
      BLOCK_SECTIONS.kpis,
      w,
      appDb,
    ).complete();
    const [day] = await suDb.$queryRaw<{ day: string }[]>`
      SELECT to_char(created_at::date, 'YYYY-MM-DD') AS day FROM conversations
       WHERE tenant_id = ${tenantId} AND chatwoot_first_reply_at IS NOT NULL
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`;
    if (!day) throw new Error("no day with first replies");
    const saved = await suDb.$queryRaw<{ id: bigint; at: Date }[]>`
      SELECT id, chatwoot_first_reply_at AS at FROM conversations
       WHERE tenant_id = ${tenantId} AND created_at::date = ${day.day}::date
         AND chatwoot_first_reply_at IS NOT NULL`;
    try {
      await suDb.$executeRaw`
        UPDATE conversations SET chatwoot_first_reply_at = NULL
         WHERE tenant_id = ${tenantId} AND id = ANY(${saved.map((r) => r.id)}::bigint[])`;
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
      // Another request drops the day and keeps it again, with the new cells.
      await kept("kpis", f);
      const fig = await figuresOf(ctx(), load, ["kpis"], null, appDb);
      expect(canon(fig.kpis)).toEqual(canon(await live("kpis", f)));
    } finally {
      for (const r of saved)
        await suDb.$executeRaw`UPDATE conversations SET chatwoot_first_reply_at = ${r.at} WHERE id = ${r.id}`;
    }
  });

  test("deleting a conversation drops the knowledge days of its thread's suggestions", async () => {
    await clearKept();
    const [conv] = await suDb.$queryRaw<{ id: bigint; inbox: bigint }[]>`
      SELECT c.id, c.inbox_id AS inbox FROM conversations c
       WHERE c.tenant_id = ${tenantId} AND c.inbox_id IS NOT NULL
         AND c.created_at BETWEEN now() - interval '40 days' AND now() - interval '3 days'
         AND EXISTS (SELECT 1 FROM approval_queue_items q
                      WHERE q.thread_id = c.thread_id AND q.created_at < now() - interval '3 days')
       ORDER BY c.created_at LIMIT 1`;
    if (!conv) throw new Error("no conversation with suggestions");
    const f = windowOf("UTC", 44, 0, { inboxId: conv.inbox });
    const before = canon(await kept("knowledge", f));
    await suDb.$executeRaw`DELETE FROM conversations WHERE id = ${conv.id}`;
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
    const after = canon(await live("knowledge", f));
    expect(after).not.toEqual(before);
    expect(canon(await kept("knowledge", f))).toEqual(after);
  });

  test("a request that is waiting for another's part stops when its viewer leaves", async () => {
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    const w = alignedDays(f);
    if (!w) throw new Error("not aligned");
    const load = new WindowLoad(ctx(), f, BLOCK_SECTIONS.labels, w, appDb);
    await load.prepare();
    const lockKey = `dashboard|${tenantId}|${await rollupVersion()}|${filterKey(f)}|UTC|conv`;
    const abort = new AbortController();
    await suDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
        const stepping = load.step(abort.signal);
        abort.abort();
        await stepping;
      },
      { timeout: 20_000 },
    );
    const [row] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_days WHERE tenant_id = ${tenantId}`;
    expect(row?.n).toBe(0);
  });

  test("a batch waits for a part that is keeping its days, and then drops the ones it reaches", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("labels", f);
    const [conv] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM conversations WHERE tenant_id = ${tenantId}
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at DESC LIMIT 1`;
    if (!conv) throw new Error("no conversation");
    let reading: Promise<unknown> | undefined;
    await suDb.$transaction(
      async (tx) => {
        // A part that checked for changes before this one was written, still to commit.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`dashboard-settle|${tenantId}`}, 0))::text`;
        await suDb.$executeRaw`UPDATE conversations SET labels = ARRAY['depois-da-checagem'] WHERE id = ${conv.id}`;
        await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
        reading = kept("labels", f);
        await until("the batch waiting for the part", async () => {
          const [w] = await suDb.$queryRaw<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
          return (w?.n ?? 0) > 0;
        });
      },
      { timeout: 20_000 },
    );
    expect(canon(await reading)).toEqual(canon(await live("labels", f)));
  });

  test("days kept by separate requests for different blocks are read without computing them again", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 30, 0);
    // A REST call for the KPIs, then one for the labels: two computations of the same days, the
    // histograms' the older.
    await kept("kpis", f);
    await kept("labels", f);
    const w = alignedDays(f);
    if (!w) throw new Error("not aligned");
    const load = await new WindowLoad(
      ctx(),
      f,
      [...BLOCK_SECTIONS.kpis, ...BLOCK_SECTIONS.labels],
      w,
      appDb,
    ).complete();
    const conv = COMPUTE.conv;
    let computed = 0;
    COMPUTE.conv = (...args) => {
      computed++;
      return conv(...args);
    };
    try {
      const fig = await figuresOf(ctx(), load, ["kpis", "labels"], null, appDb);
      expect(canon(fig.kpis)).toEqual(canon(await live("kpis", f)));
      expect(computed).toBe(0);
    } finally {
      COMPUTE.conv = conv;
    }
  });

  test("moving a conversation to another thread drops the knowledge days of the new thread's suggestions", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const [conv] = await suDb.$queryRaw<
      { id: bigint; inbox: bigint; thread: string }[]
    >`
      SELECT c.id, c.inbox_id AS inbox, c.thread_id AS thread FROM conversations c
       WHERE c.tenant_id = ${tenantId} AND c.inbox_id IS NOT NULL
         AND c.created_at BETWEEN now() - interval '40 days' AND now() - interval '3 days'
         AND NOT EXISTS (SELECT 1 FROM approval_queue_items q WHERE q.thread_id = c.thread_id)
       ORDER BY c.created_at LIMIT 1`;
    const [other] = await suDb.$queryRaw<{ thread: string }[]>`
      SELECT q.thread_id AS thread FROM approval_queue_items q
       WHERE q.tenant_id = ${tenantId}
         AND q.created_at BETWEEN now() - interval '40 days' AND now() - interval '3 days'
         AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.thread_id = q.thread_id)
       ORDER BY q.created_at DESC LIMIT 1`;
    if (!conv || !other)
      throw new Error("no conversation or thread to move it to");
    const f = windowOf("UTC", 44, 0, { inboxId: conv.inbox });
    const before = canon(await kept("knowledge", f));
    try {
      await suDb.$executeRaw`UPDATE conversations SET thread_id = ${other.thread} WHERE id = ${conv.id}`;
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
      const after = canon(await live("knowledge", f));
      expect(after).not.toEqual(before);
      expect(canon(await kept("knowledge", f))).toEqual(after);
    } finally {
      await suDb.$executeRaw`UPDATE conversations SET thread_id = ${conv.thread} WHERE id = ${conv.id}`;
    }
  });

  // The anonymous visitor's thread with a suggestion older than a few days, and the identified user.
  async function anonymousThread() {
    const [row] = await suDb.$queryRaw<
      { thread: string; owner: bigint; agent: bigint }[]
    >`
      SELECT dt.thread_id AS thread, dt.external_user_id AS owner, dt.agent_id AS agent
        FROM detached_threads dt JOIN external_users eu ON eu.id = dt.external_user_id
       WHERE dt.tenant_id = ${tenantId} AND eu.external_id LIKE 'anon:%'
         AND EXISTS (SELECT 1 FROM approval_queue_items q
                      WHERE q.thread_id = dt.thread_id AND q.created_at < now() - interval '3 days')
       ORDER BY dt.thread_id LIMIT 1`;
    const [user] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM external_users
       WHERE tenant_id = ${tenantId} AND external_id NOT LIKE 'anon:%' LIMIT 1`;
    if (!row || !user) throw new Error("no anonymous thread with suggestions");
    return { ...row, user: user.id };
  }

  test("an anonymous thread handed over at sign-in drops the knowledge days of its suggestions", async () => {
    await fromHistory();
    const t = await anonymousThread();
    const f = windowOf("UTC", 44, 0, {
      source: "client",
      audience: "anonymous",
    });
    const before = canon(await kept("knowledge", f));
    try {
      await suDb.$executeRaw`UPDATE detached_threads SET external_user_id = ${t.user} WHERE thread_id = ${t.thread}`;
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
      const after = canon(await live("knowledge", f));
      expect(after).not.toEqual(before);
      expect(canon(await kept("knowledge", f))).toEqual(after);
    } finally {
      await suDb.$executeRaw`UPDATE detached_threads SET external_user_id = ${t.owner} WHERE thread_id = ${t.thread}`;
    }
  });

  test("an anonymous thread that expired drops the knowledge days of its suggestions", async () => {
    await fromHistory();
    const t = await anonymousThread();
    const f = windowOf("UTC", 44, 0, {
      source: "client",
      audience: "anonymous",
    });
    const before = canon(await kept("knowledge", f));
    try {
      await suDb.$executeRaw`DELETE FROM detached_threads WHERE thread_id = ${t.thread}`;
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
      const after = canon(await live("knowledge", f));
      expect(after).not.toEqual(before);
      expect(canon(await kept("knowledge", f))).toEqual(after);
    } finally {
      await suDb.detachedThread.create({
        data: {
          threadId: t.thread,
          tenantId,
          agentId: t.agent,
          kind: "client",
          externalUserId: t.owner,
        },
      });
    }
  });

  test("the stream keeps saying it is working while a snapshot waits", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    const f = windowOf("UTC", 30, 0);
    // The last twenty days kept: the stream has a part left to compute after its first snapshot.
    await kept("labels", windowOf("UTC", 20, 0));
    // The merge's ordering query waits once armed, as a snapshot waiting on a busy pool would.
    let armed = false;
    let entered = false;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const onTx = (tx: object) =>
      new Proxy(tx, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          if (p !== "$queryRaw" || typeof v !== "function") return v;
          return async (sql: Prisma.Sql, ...rest: unknown[]) => {
            if (armed && sql.sql.includes("AS t(k) ORDER BY k")) {
              entered = true;
              await gate;
            }
            return v.call(t, sql, ...rest);
          };
        },
      });
    // runScopedOn extends the client before it opens the transaction: both are wrapped.
    const wrap = <C extends object>(client: C): C =>
      new Proxy(client, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver);
          if (typeof v !== "function") return v;
          if (prop === "$extends")
            return (...a: unknown[]) => wrap(v.apply(target, a));
          if (prop === "$transaction")
            return (fn: (tx: object) => Promise<unknown>, opts?: unknown) =>
              v.call(target, (tx: object) => fn(onTx(tx)), opts);
          return v;
        },
      });
    const slow = wrap(appDb);
    const ticks: (() => void)[] = [];
    const wait = heartbeat.wait;
    heartbeat.wait = () => new Promise<void>((r) => ticks.push(r));
    try {
      const gen = streamFigures(ctx(), f, ["labels"], undefined, slow);
      const first = await gen.next();
      expect(first.value?.kind).toBe("snapshot");
      armed = true;
      const computing = await gen.next();
      expect(computing.value?.kind).toBe("computing");
      const next = gen.next();
      await until("the snapshot waiting", () => entered);
      for (const t of ticks.splice(0)) t();
      const beat = await next;
      expect(beat.value?.kind).toBe("computing");
      if (beat.value?.kind === "computing")
        expect(beat.value.progress.computing).toBeNull();
      release();
      for (;;) {
        const e = await gen.next();
        if (e.done) break;
        for (const t of ticks.splice(0)) t();
      }
    } finally {
      release();
      heartbeat.wait = wait;
    }
  });

  test("the stream says it is alive while the queue is still settling", async () => {
    const f = windowOf("UTC", 30, 0);
    const ticks: (() => void)[] = [];
    const wait = heartbeat.wait;
    heartbeat.wait = () => new Promise<void>((r) => ticks.push(r));
    try {
      let gen: AsyncGenerator<StreamEvent> | undefined;
      let first: Promise<IteratorResult<StreamEvent>> | undefined;
      await suDb.$transaction(
        async (tx) => {
          // A part keeping its days: the settling batch waits for it.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`dashboard-settle|${tenantId}`}, 0))::text`;
          gen = streamFigures(ctx(), f, ["labels"], undefined, appDb);
          first = gen.next();
          await until("the batch waiting", async () => {
            const [w] = await suDb.$queryRaw<{ n: number }[]>`
              SELECT COUNT(*)::int AS n FROM pg_stat_activity
               WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`;
            return (w?.n ?? 0) > 0;
          });
          await until("a heartbeat armed", () => ticks.length > 0);
          for (const t of ticks.splice(0)) t();
          expect((await first)?.value?.kind).toBe("waiting");
        },
        { timeout: 20_000 },
      );
      for (;;) {
        const e = await gen?.next();
        if (!e || e.done) break;
        for (const t of ticks.splice(0)) t();
      }
    } finally {
      heartbeat.wait = wait;
    }
  });

  test("the day before yesterday stays live while it ended less than 24 hours ago", async () => {
    // 00:10 on 2026-10-05 in Sydney, the night after the clocks went forward: the 3rd ended 23 hours
    // and 10 minutes ago, too recent for the triggers to queue a change to it.
    setSystemTime(new Date("2026-10-04T13:10:00Z"));
    try {
      const tz = "Australia/Sydney";
      const f = {
        since: dayStart("2026-09-25", tz),
        until: dayStart("2026-10-06", tz),
        tz,
      };
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      const load = new WindowLoad(ctx(), f, BLOCK_SECTIONS.labels, w, appDb);
      await load.prepare();
      // Computed with today and yesterday, before any part is kept.
      expect(load.get("conv.labels", "2026-10-03")).toBeDefined();
      expect(load.get("conv.labels", "2026-10-02")).toBeUndefined();
    } finally {
      setSystemTime();
    }
  });

  test("while a window fills, conversations are counted over the run of days in, never over scattered ones", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    // Days kept by an earlier view, in the middle of what the next one asks for, with three days
    // missing between them and yesterday.
    await kept("costs", windowOf("UTC", 10, 5));
    const events: StreamEvent[] = [];
    for await (const e of streamFigures(
      ctx(),
      windowOf("UTC", 44, 0),
      ["costs"],
      undefined,
      appDb,
    ))
      if (e.kind === "snapshot") events.push(e);
    const [first, second] = events;
    if (first?.kind !== "snapshot" || second?.kind !== "snapshot")
      throw new Error("no snapshots");
    // Kept days with three days missing after them: which day a conversation was first seen in
    // cannot be told yet.
    expect(first.figures.costs).toBeUndefined();
    // Those three in: the last eleven days, read as their own window.
    expect(canon(second.figures.costs)).toEqual(
      canon(await live("costs", windowOf("UTC", 10, 0))),
    );
  });

  test("a part whose keeping failed is computed and kept again, not taken as in", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    // Keeping more than one day at once runs out of time; one day at a time fits.
    await suDb.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION kept_days_test_slow() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (SELECT COUNT(DISTINCT day) FROM inserted WHERE tenant_id = ${tenantId}) > 1 THEN
          RAISE EXCEPTION 'too slow' USING ERRCODE = '57014';
        END IF;
        RETURN NULL;
      END $$`);
    await suDb.$executeRawUnsafe(
      "CREATE TRIGGER kept_days_test_slow AFTER INSERT ON dashboard_days REFERENCING NEW TABLE AS inserted FOR EACH STATEMENT EXECUTE FUNCTION kept_days_test_slow()",
    );
    try {
      const f = windowOf("UTC", 9, 0);
      expect(canon(await kept("knowledge", f))).toEqual(
        canon(await live("knowledge", f)),
      );
    } finally {
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER kept_days_test_slow ON dashboard_days",
      );
      await suDb.$executeRawUnsafe("DROP FUNCTION kept_days_test_slow()");
    }
    const [row] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(DISTINCT day)::int AS n FROM dashboard_days
       WHERE tenant_id = ${tenantId} AND section = 'know.knowledge'`;
    // Every day but today and yesterday, which are never kept.
    expect(row?.n).toBe(8);
  });

  test("a whole-history window starts at the oldest kept day, even when its records were swept", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f: DashboardFilter = {
      until: dayStart(addDays(localDay(Date.now(), "UTC"), 1), "UTC"),
      tz: "UTC",
    };
    // A flow-log day kept before the sweep took its lines, older than anything left in the tables.
    const old = addDays(localDay(START.getTime(), "UTC"), -5);
    await suDb.$executeRaw`
      INSERT INTO dashboard_days (tenant_id, version, filter_key, tz, section, day, data)
      VALUES (${tenantId}, ${await rollupVersion()}, ${filterKey(f)}, 'UTC', 'log.followups', ${old}::date,
              ${JSON.stringify({ s: 7, p: {} })}::jsonb)`;
    const w = alignedDays(f);
    if (!w) throw new Error("not aligned");
    const load = new WindowLoad(ctx(), f, BLOCK_SECTIONS.followUps, w, appDb);
    await load.prepare();
    expect(load.days[0]).toBe(old);
    expect(load.get("log.followups", old)).toEqual({ s: 7, p: {} });
  });

  test("flow-log days before the first record and past retention are no data, not empty", async () => {
    await clearKept();
    config.flowlog.retentionDays = 20;
    try {
      const first = addDays(localDay(START.getTime(), "UTC"), -10);
      const f: DashboardFilter = {
        since: dayStart(first, "UTC"),
        until: dayStart(addDays(localDay(Date.now(), "UTC"), 1), "UTC"),
        tz: "UTC",
      };
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      const load = new WindowLoad(ctx(), f, BLOCK_SECTIONS.followUps, w, appDb);
      await load.prepare();
      expect(load.get("log.followups", first)).toBeUndefined();
      expect(load.progress().families.log.noData).toBeGreaterThanOrEqual(10);
    } finally {
      config.flowlog.retentionDays = 3650;
    }
  });

  test("a window that starts centuries before the first record lists only the days from it", async () => {
    const f: DashboardFilter = {
      since: new Date("1600-01-01T00:00:00Z"),
      until: dayStart(addDays(localDay(Date.now(), "UTC"), 1), "UTC"),
      tz: "UTC",
    };
    const w = alignedDays(f);
    if (!w) throw new Error("not aligned");
    const load = new WindowLoad(ctx(), f, BLOCK_SECTIONS.kpis, w, appDb);
    await load.prepare();
    expect(load.days.length).toBeLessThan(60);
    const p = load.progress();
    // Every day of the window counted, the ones before the first record as in.
    expect(p.total).toBeGreaterThan(155_000);
    expect(p.families.conv.total - p.families.conv.ready).toBeLessThan(60);
    while (await load.step());
    const fig = await figuresOf(ctx(), load, ["kpis"], null, appDb);
    expect(canon(fig.kpis)).toEqual(canon(await live("kpis", f)));
  });

  test("a family stopped on a day past the budget leaves the others to finish", async () => {
    await clearKept();
    const f = windowOf("UTC", 20, 0);
    const ledger = COMPUTE.ledger;
    COMPUTE.ledger = async () => {
      throw new MetricsTooSlowError(15_000);
    };
    try {
      const events: StreamEvent[] = [];
      for await (const e of streamFigures(
        ctx(),
        f,
        ["kpis", "costs"],
        undefined,
        appDb,
      ))
        if (e.kind === "snapshot") events.push(e);
      const last = events[events.length - 1];
      if (last?.kind !== "snapshot") throw new Error("no snapshot");
      expect(last.done).toBe(true);
      expect(last.progress.families.ledger.refused?.status).toBe(503);
      expect(last.progress.families.ledger.gaps.length).toBeGreaterThan(0);
      expect(last.progress.families.conv.gaps).toEqual([]);
      expect(canon(last.figures.kpis)).toEqual(canon(await live("kpis", f)));
      // A caller that answers once is refused for the block that stopped.
      await expect(kept("costs", f)).rejects.toBeInstanceOf(
        MetricsTooSlowError,
      );
    } finally {
      COMPUTE.ledger = ledger;
    }
  });

  test("a fresh billed call deleted or moved off an older conversation drops the day it started", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    const pick = async (skip: bigint[]) => {
      const [c] = await suDb.$queryRaw<{ id: bigint }[]>`
        SELECT c.id FROM conversations c
         WHERE c.tenant_id = ${tenantId}
           AND c.created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
           AND NOT EXISTS (SELECT 1 FROM llm_usage u WHERE u.conversation_id = c.id)
           AND NOT (c.id = ANY(${skip}::bigint[]))
         ORDER BY c.created_at LIMIT 1`;
      if (!c) throw new Error("no conversation without a turn");
      return c.id;
    };
    const one = await pick([]);
    const two = await pick([one]);
    const turn = (conversationId: bigint) =>
      suDb.llmUsage.create({
        data: {
          tenantId,
          agentId: a1,
          conversationId,
          source: "inbox",
          model: "gpt-6-luna",
          promptTokens: 1,
          completionTokens: 1,
        },
      });
    const a = await turn(one);
    const b = await turn(two);
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    expect(canon(await kept("kpis", f))).toEqual(canon(await live("kpis", f)));
    // The first one taken back, the second moved to a playground thread.
    await suDb.llmUsage.delete({ where: { id: a.id } });
    await suDb.llmUsage.update({
      where: { id: b.id },
      data: { source: "playground" },
    });
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    expect(canon(await kept("kpis", f))).toEqual(canon(await live("kpis", f)));
  });

  test("a queue whose batch does not fit the budget is cut until it does, and drains", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    // Marking a batch processed takes a tenth of a millisecond a row: a whole batch of 20,000 is two
    // seconds, past a one-second budget, as a repricing's queue was past fifteen.
    await suDb.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION kept_days_test_slow_mark() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_sleep((SELECT COUNT(*) FROM marked WHERE tenant_id = ${tenantId}) * 0.0001);
        RETURN NULL;
      END $$`);
    await suDb.$executeRawUnsafe(
      "CREATE TRIGGER kept_days_test_slow_mark AFTER UPDATE ON dashboard_dirty REFERENCING NEW TABLE AS marked FOR EACH STATEMENT EXECUTE FUNCTION kept_days_test_slow_mark()",
    );
    const timeout = config.metrics.timeoutMs;
    config.metrics.timeoutMs = 1_000;
    try {
      await suDb.$executeRaw`
        INSERT INTO dashboard_dirty (tenant_id, section, at, created_at)
        SELECT ${tenantId}, 'know', TIMESTAMP '2000-01-03', (now() AT TIME ZONE 'UTC') - interval '1 hour'
          FROM generate_series(1, 25000)`;
      const f = windowOf("UTC", 9, 0);
      // Prepared as the stream prepares it, with no deadline of its own: a caller that answers once
      // is refused at its one budget instead, keeping the batches it settled.
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      await new WindowLoad(
        ctx(),
        f,
        BLOCK_SECTIONS.knowledge,
        w,
        appDb,
      ).prepare();
      config.metrics.timeoutMs = timeout;
      expect(canon(await kept("knowledge", f))).toEqual(
        canon(await live("knowledge", f)),
      );
      const [row] = await suDb.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM dashboard_dirty
         WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
      expect(row?.n).toBe(0);
    } finally {
      config.metrics.timeoutMs = timeout;
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER kept_days_test_slow_mark ON dashboard_dirty",
      );
      await suDb.$executeRawUnsafe("DROP FUNCTION kept_days_test_slow_mark()");
      await suDb.$executeRaw`DELETE FROM dashboard_dirty WHERE tenant_id = ${tenantId} AND processed_at IS NULL`;
    }
  }, 120_000);

  test("a repriced line queues its own day only, and the kept costs follow it", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("costs", f);
    const [line] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM llm_usage WHERE tenant_id = ${tenantId} AND conversation_id IS NOT NULL
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at LIMIT 1`;
    if (!line) throw new Error("no ledger line");
    await suDb.$executeRaw`UPDATE llm_usage SET cost_usd = 12.5 WHERE id = ${line.id}`;
    const queued = await suDb.$queryRaw<{ conversation_id: bigint | null }[]>`
      SELECT conversation_id FROM dashboard_dirty
       WHERE tenant_id = ${tenantId} AND processed_at IS NULL AND section = 'ledger'`;
    expect(queued.map((q) => q.conversation_id)).toEqual([null]);
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    expect(canon(await kept("costs", f))).toEqual(
      canon(await live("costs", f)),
    );
  });

  test("a change drops its day in every zone a view keeps it in", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const views = [
      windowOf("UTC", 44, 0),
      windowOf("Asia/Kathmandu", 44, 0),
      windowOf("America/Sao_Paulo", 44, 0, { source: "inbox" }),
    ];
    for (const f of views) await kept("labels", f);
    const [conv] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM conversations WHERE tenant_id = ${tenantId}
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at LIMIT 1 OFFSET 7`;
    if (!conv) throw new Error("no conversation");
    await suDb.$executeRaw`UPDATE conversations SET labels = ARRAY['em-toda-zona'] WHERE id = ${conv.id}`;
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    for (const f of views)
      expect(canon(await kept("labels", f))).toEqual(
        canon(await live("labels", f)),
      );
  }, 120_000);

  test("an agent turn taken back drops the handoff days it decided", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    const before = canon(await kept("handoffs", f));
    // A person who took over after the agent's turns: without those turns the takeover is no
    // person's handoff any more.
    const convs = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT DISTINCT l.conversation_id AS id FROM execution_logs l
       WHERE l.tenant_id = ${tenantId} AND l.stage = 'handoff' AND l.detail->>'outcome' = 'taken_over'
         AND l.created_at < now() - interval '3 days'
         AND EXISTS (SELECT 1 FROM llm_usage u WHERE u.conversation_id = l.conversation_id)`;
    if (convs.length === 0) throw new Error("no takeover after an agent turn");
    await suDb.$executeRaw`DELETE FROM llm_usage WHERE conversation_id = ANY(${convs.map((c) => c.id)}::bigint[])`;
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    const after = canon(await live("handoffs", f));
    expect(after).not.toEqual(before);
    expect(canon(await kept("handoffs", f))).toEqual(after);
  });

  test("a ledger line moved to another inbox queues its conversation, not only its day", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0, { inboxId: i1 });
    await kept("costs", f);
    const [line] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT u.id FROM llm_usage u WHERE u.tenant_id = ${tenantId} AND u.inbox_id = ${i1}
         AND u.conversation_id IS NOT NULL
         AND u.created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY u.created_at LIMIT 1`;
    if (!line) throw new Error("no ledger line in the inbox");
    await suDb.$executeRaw`UPDATE llm_usage SET inbox_id = ${i2} WHERE id = ${line.id}`;
    const queued = await suDb.$queryRaw<{ conversation_id: bigint | null }[]>`
      SELECT conversation_id FROM dashboard_dirty
       WHERE tenant_id = ${tenantId} AND processed_at IS NULL AND section = 'ledger'`;
    expect(queued.every((q) => q.conversation_id !== null)).toBe(true);
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    expect(canon(await kept("costs", f))).toEqual(
      canon(await live("costs", f)),
    );
  });

  test("a viewer who leaves while the queue settles stops the load before it reads or computes", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    // The version hash runs the sections once, on a recorder: before the count starts.
    await rollupVersion();
    const conv = COMPUTE.conv;
    let computed = 0;
    COMPUTE.conv = (...args) => {
      computed++;
      return conv(...args);
    };
    const abort = new AbortController();
    abort.abort();
    try {
      const events: StreamEvent[] = [];
      for await (const e of streamFigures(
        ctx(),
        windowOf("UTC", 20, 0),
        ["kpis"],
        abort.signal,
        appDb,
      ))
        events.push(e);
      expect(events.filter((e) => e.kind === "snapshot")).toEqual([]);
      expect(computed).toBe(0);
    } finally {
      COMPUTE.conv = conv;
    }
  });

  test("a conversation backdated from a day never kept into a kept one is counted there", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("kpis", f);
    // Its own conversation, from two hours ago: the seed's newest one depends on the hour it ran.
    const [inst] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM chatwoot_instances WHERE tenant_id = ${tenantId} LIMIT 1`;
    if (!inst) throw new Error("no instance");
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        inboxId: i1,
        chatwootConversationId: 99_002,
        threadId: `backdated-${process.pid}`,
        status: "resolved",
        createdAt: new Date(Date.now() - 2 * 3_600_000),
      },
    });
    try {
      await suDb.$executeRaw`UPDATE conversations SET created_at = created_at - interval '10 days' WHERE id = ${conv.id}`;
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
      expect(canon(await kept("kpis", f))).toEqual(
        canon(await live("kpis", f)),
      );
    } finally {
      await suDb.conversation.delete({ where: { id: conv.id } });
    }
  }, 120_000);

  test("a ledger line given another turn queues its conversation", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    const [line] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM llm_usage WHERE tenant_id = ${tenantId} AND conversation_id IS NOT NULL
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at LIMIT 1 OFFSET 3`;
    if (!line) throw new Error("no ledger line");
    await suDb.$executeRaw`UPDATE llm_usage SET turn_id = 'outra-volta' WHERE id = ${line.id}`;
    const queued = await suDb.$queryRaw<{ conversation_id: bigint | null }[]>`
      SELECT conversation_id FROM dashboard_dirty
       WHERE tenant_id = ${tenantId} AND processed_at IS NULL AND section = 'ledger'`;
    expect(queued.length).toBeGreaterThan(0);
    expect(queued.every((q) => q.conversation_id !== null)).toBe(true);
  });

  test("the retention cutoff's day is computed for the flow log and read as kept for the rest", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    config.flowlog.retentionDays = 20;
    try {
      const f = windowOf("UTC", 30, 0);
      await kept("kpis", f);
      await kept("handoffs", f);
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      const load = new WindowLoad(
        ctx(),
        f,
        [...BLOCK_SECTIONS.kpis, ...BLOCK_SECTIONS.handoffs],
        w,
        appDb,
      );
      await load.prepare();
      expect(load.done()).toBe(true);
    } finally {
      config.flowlog.retentionDays = 3650;
    }
  });

  test("a day whose midnight a clock change skips starts when the clock jumps, as Postgres reads it", async () => {
    for (const [day, tz] of [
      ["2026-09-06", "America/Santiago"],
      ["2026-04-05", "America/Santiago"],
      ["2026-03-29", "Europe/London"],
      ["2026-10-12", "Asia/Kathmandu"],
    ] as const) {
      const [row] = await suDb.$queryRaw<{ at: Date }[]>`
        SELECT (${day}::timestamp AT TIME ZONE ${tz}) AS at`;
      expect(`${day} ${tz} ${dayStart(day, tz).toISOString()}`).toBe(
        `${day} ${tz} ${row?.at.toISOString()}`,
      );
    }
  });

  test("a flow-log day past retention kept for one block is in for that block when opened with the others", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    const alone = await kept("handoffs", f);
    config.flowlog.retentionDays = 20;
    try {
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      const load = await new WindowLoad(
        ctx(),
        f,
        [...BLOCK_SECTIONS.handoffs, ...BLOCK_SECTIONS.followUps],
        w,
        appDb,
      ).complete();
      const p = load.progress();
      // The handoffs were kept before the sweep, the follow-ups never were.
      expect(p.sections?.["log.handoffs"]?.noData).toBe(0);
      expect(p.sections?.["log.handoffs"]?.gaps).toEqual([]);
      expect(p.sections?.["log.followups"]?.noData).toBeGreaterThan(20);
      // The days no request can fill are named apart from those still loading, for a chart to mark.
      expect(p.sections?.["log.handoffs"]?.none).toEqual([]);
      const none = p.sections?.["log.followups"]?.none ?? [];
      expect(none.reduce((n, [a, b]) => n + dayCount(a, b), 0)).toBe(
        p.sections?.["log.followups"]?.noData ?? -1,
      );
      // The axis starts on the window's first day from the first snapshot on.
      expect(p.first).toBe(localDay(f.since?.getTime() ?? 0, "UTC"));
      const fig = await figuresOf(ctx(), load, ["handoffs"], null, appDb);
      expect(canon(fig.handoffs)).toEqual(canon(alone));
    } finally {
      config.flowlog.retentionDays = 3650;
    }
  }, 120_000);

  test("a flow-log block whose own days are all in reads them all while a sibling section still fills", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    const alone = await kept("handoffs", f);
    const w = alignedDays(f);
    if (!w) throw new Error("not aligned");
    // Prepared only: today and yesterday are computed, the follow-ups' older days are still missing.
    const load = new WindowLoad(
      ctx(),
      f,
      [...BLOCK_SECTIONS.handoffs, ...BLOCK_SECTIONS.followUps],
      w,
      appDb,
    );
    await load.prepare();
    const p = load.progress();
    expect(p.sections?.["log.handoffs"]?.gaps).toEqual([]);
    expect(p.sections?.["log.followups"]?.gaps.length).toBeGreaterThan(0);
    const fig = await figuresOf(ctx(), load, ["handoffs"], null, appDb);
    expect(canon(fig.handoffs)).toEqual(canon(alone));
  }, 120_000);

  test("a first reply found to be the platform's leaves the kept first response as the live one", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    await kept("kpis", f);
    const [conv] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM conversations WHERE tenant_id = ${tenantId}
         AND chatwoot_first_reply_at IS NOT NULL
         AND chatwoot_first_reply_at >= chatwoot_created_at
         AND created_at BETWEEN now() - interval '30 days' AND now() - interval '3 days'
       ORDER BY created_at LIMIT 1`;
    if (!conv) throw new Error("no answered conversation");
    try {
      await suDb.$executeRaw`UPDATE conversations SET chatwoot_platform_reply_at = chatwoot_first_reply_at WHERE id = ${conv.id}`;
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
      expect(canon(await kept("kpis", f))).toEqual(
        canon(await live("kpis", f)),
      );
    } finally {
      await suDb.$executeRaw`UPDATE conversations SET chatwoot_platform_reply_at = NULL WHERE id = ${conv.id}`;
    }
  });

  test("a transfer swept from the flow log drops the kept days its conversation's later handoffs fall in", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const [inst] = await suDb.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM chatwoot_instances WHERE tenant_id = ${tenantId} LIMIT 1`;
    if (!inst) throw new Error("no instance");
    const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: inst.id,
        inboxId: i1,
        chatwootConversationId: 99_001,
        threadId: `swept-${process.pid}`,
        status: "open",
        createdAt: ago(25),
      },
    });
    const line = (at: Date, turnId: string) => ({
      tenantId,
      turnId,
      conversationId: conv.id,
      inboxId: i1,
      stage: "handoff",
      level: "info",
      status: "ok",
      source: "inbox",
      detail: { outcome: "taken_over" },
      createdAt: at,
    });
    // The second takeover follows the first, so it is not a person's handoff until the first goes.
    const first = await suDb.executionLog.create({
      data: line(ago(25), "swept-1"),
    });
    await suDb.executionLog.create({ data: line(ago(10), "swept-2") });
    try {
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
      const f = windowOf("UTC", 14, 0);
      await kept("handoffs", f);
      config.flowlog.retentionDays = 20;
      await suDb.executionLog.delete({ where: { id: first.id } });
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
      expect(canon(await kept("handoffs", f))).toEqual(
        canon(await live("handoffs", f)),
      );
    } finally {
      config.flowlog.retentionDays = 3650;
      await clearFlowLog(suDb, { conversationId: conv.id });
      await suDb.conversation.delete({ where: { id: conv.id } });
    }
  }, 120_000);

  test("a call timed across a clock moving back has its latency read as the live reader reads it", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const lines = await Promise.all(
      [-250, -1, -30_000].map((durationMs, k) =>
        suDb.llmUsage.create({
          data: {
            tenantId,
            agentId: a1,
            inboxId: i1,
            source: "inbox",
            model: "gpt-6-luna",
            node: "agent",
            promptTokens: 10,
            completionTokens: 1,
            durationMs,
            turnId: `clock-back-${k}`,
            createdAt: new Date(Date.now() - (5 + k) * 86_400_000),
          },
        }),
      ),
    );
    try {
      await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
      const f = windowOf("UTC", 14, 0);
      const expected = canon(await live("health", f));
      expect(canon(await kept("health", f))).toEqual(expected);
      expect(canon(await kept("health", f))).toEqual(expected);
    } finally {
      await suDb.llmUsage.deleteMany({
        where: { id: { in: lines.map((l) => l.id) } },
      });
    }
  }, 120_000);

  test("the Langfuse link is read on a budget of its own, not on what the request spent on its days", async () => {
    let opened = 0;
    // The budget each transaction opened with, and whether its work finished. The metrics budget is
    // moved away from the general one so the two cannot be told apart by accident.
    const budgets: Array<{ timeout?: number; done?: boolean }> = [];
    const watched = <C extends object>(client: C): C =>
      new Proxy(client, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key !== "$transaction" || typeof value !== "function")
            return value;
          return async (fn: unknown, opts?: { timeout?: number }) => {
            const seen: { timeout?: number; done?: boolean } = {
              timeout: opts?.timeout,
            };
            budgets.push(seen);
            const out = await value.call(target, fn, opts);
            seen.done = true;
            return out;
          };
        },
      });
    const counting = new Proxy(appDb, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== "$extends") return value;
        opened++;
        return (...args: unknown[]) =>
          watched(value.apply(target, args) as object);
      },
    });
    const metricsTimeout = config.metrics.timeoutMs;
    config.metrics.timeoutMs = config.dbTx.timeoutMs + 60_000;
    const before = Date.now();
    try {
      await requestContext.run(
        { locale: "en", startedAt: Date.now() - config.metrics.timeoutMs - 1 },
        () => costsLink(ctx(), counting),
      );
      expect(opened).toBeGreaterThan(0);
      // A fresh metrics budget: counted from the call, not from the request that already spent its own.
      const elapsed = Date.now() - before;
      expect(budgets.length).toBeGreaterThan(0);
      for (const b of budgets) {
        expect(b.timeout).toBeLessThanOrEqual(config.metrics.timeoutMs);
        expect(b.timeout).toBeGreaterThanOrEqual(
          config.metrics.timeoutMs - elapsed - 1,
        );
        expect(b.done).toBe(true);
      }
    } finally {
      config.metrics.timeoutMs = metricsTimeout;
    }
  });

  test("a deleted tenant leaves nothing in the queue", async () => {
    const t = await suDb.tenant.create({
      data: { name: "gone", slug: `kept-gone-${process.pid}` },
    });
    const inst = await seedChatwootInstance(suDb, {
      tenantId: t.id,
      accountId: 80_000 + (process.pid % 10_000),
      baseUrl: "https://gone.cw.example",
      adminToken: "enc",
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId: t.id,
        chatwootInstanceId: inst.id,
        chatwootConversationId: 1,
        threadId: `gone-${process.pid}`,
        status: "open",
        createdAt: new Date(Date.now() - 10 * 86_400_000),
      },
    });
    // A change to an older conversation is queued while the tenant lives; its delete queues again.
    await suDb.$executeRaw`UPDATE conversations SET status = 'resolved' WHERE id = ${conv.id}`;
    const [queued] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_dirty WHERE tenant_id = ${t.id}`;
    expect(queued?.n).toBeGreaterThan(0);
    await suDb.tenant.delete({ where: { id: t.id } });
    const [left] = await suDb.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM dashboard_dirty WHERE tenant_id = ${t.id}`;
    expect(left?.n).toBe(0);
  });

  // A caller that answers once (a REST route, an MCP tool) sends nothing until every part is in, so
  // a cold window longer than one budget would outlive the server's idle timeout.
  async function slowConv(seconds: number, onCall?: () => void) {
    // The version hash runs the sections once, on a recorder: before the stub counts.
    await rollupVersion();
    const conv = COMPUTE.conv;
    COMPUTE.conv = async (db, ...rest) => {
      onCall?.();
      await db.$executeRaw`SELECT pg_sleep(${seconds})`;
      return conv(db, ...rest);
    };
    return () => {
      COMPUTE.conv = conv;
    };
  }

  function answerOnce(f: DashboardFilter, signal?: AbortSignal) {
    return fromKeptDays(
      ctx(),
      f,
      "kpis",
      (x) => x.kpis,
      () => getKpis(ctx(), f, appDb),
      appDb,
      signal,
    );
  }

  test("a caller that answers once is refused within one budget on a cold window, and the next call goes on from the parts kept", async () => {
    // Earlier tests' changes are minutes old, and a day changed that recently is computed but not kept.
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    await clearKept();
    const f = windowOf("UTC", 44, 0);
    // Three steps of two seconds each (today and yesterday, then two parts), on a budget of five: the
    // third does not fit in what is left.
    const restore = await slowConv(2);
    const timeout = config.metrics.timeoutMs;
    config.metrics.timeoutMs = 5_000;
    try {
      const started = Date.now();
      const refused = await answerOnce(f).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(MetricsTooSlowError);
      expect((refused as MetricsTooSlowError).statusCode).toBe(503);
      expect((refused as MetricsTooSlowError).field).toBe("since");
      expect(Date.now() - started).toBeLessThan(5_000 + 1_500);
      const [first] = await suDb.$queryRaw<{ n: number }[]>`
        SELECT COUNT(DISTINCT day)::int AS n FROM dashboard_days
         WHERE tenant_id = ${tenantId} AND section LIKE 'conv.%'`;
      expect(first?.n).toBeGreaterThan(0);
      // The part kept is read back, so the rest fits: today and yesterday, then one part.
      expect(canon(await answerOnce(f))).toEqual(canon(await live("kpis", f)));
    } finally {
      config.metrics.timeoutMs = timeout;
      restore();
    }
  }, 120_000);

  test("a caller that answers once and goes away stops the load at the next part", async () => {
    await clearKept();
    const abort = new AbortController();
    let computed = 0;
    const restore = await slowConv(0, () => {
      computed++;
      abort.abort();
    });
    try {
      await expect(
        answerOnce(windowOf("UTC", 44, 0), abort.signal),
      ).rejects.toBeDefined();
      // Today and yesterday ran when it left, and no part after them.
      expect(computed).toBe(1);
    } finally {
      restore();
    }
  });

  test("a caller that answers once has the one budget its request arrived with, for its days and its merge", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    const f = windowOf("UTC", 20, 0);
    await kept("kpis", f);
    // Arrived a whole budget ago (its authentication, its wait for a connection): nothing is left.
    const late = await requestContext
      .run(
        { locale: "en", startedAt: Date.now() - config.metrics.timeoutMs - 1 },
        () => answerOnce(f),
      )
      .catch((e: unknown) => e);
    expect(late).toBeInstanceOf(MetricsTooSlowError);
    // Its days in within the budget, the merge after them is on what is left of it, not on a new one.
    const timeout = config.metrics.timeoutMs;
    config.metrics.timeoutMs = 2_000;
    try {
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      const load = await requestContext.run(
        { locale: "en", startedAt: Date.now() },
        () =>
          new WindowLoad(ctx(), f, BLOCK_SECTIONS.kpis, w, appDb).complete(),
      );
      const passed = Date.now() + config.metrics.timeoutMs;
      await until("the request's budget to run out", () => Date.now() > passed);
      await expect(
        figuresOf(ctx(), load, ["kpis"], null, appDb),
      ).rejects.toBeInstanceOf(MetricsTooSlowError);
    } finally {
      config.metrics.timeoutMs = timeout;
    }
  }, 120_000);

  test("today's computation cut in halves after its viewer left starts no half", async () => {
    await clearKept();
    const abort = new AbortController();
    let computed = 0;
    // The version hash runs the sections once, on a recorder: before the stub counts.
    await rollupVersion();
    const conv = COMPUTE.conv;
    COMPUTE.conv = async () => {
      computed++;
      abort.abort();
      throw new MetricsTooSlowError(15_000);
    };
    try {
      const f = windowOf("UTC", 20, 0);
      const w = alignedDays(f);
      if (!w) throw new Error("not aligned");
      await new WindowLoad(ctx(), f, BLOCK_SECTIONS.kpis, w, appDb)
        .prepare(abort.signal)
        .catch(() => {});
      expect(computed).toBe(1);
    } finally {
      COMPUTE.conv = conv;
    }
  });

  test("the costs of a caller that answers once, Langfuse link included, end by its request's deadline", async () => {
    await suDb.$executeRaw`UPDATE dashboard_dirty SET created_at = created_at - interval '1 hour' WHERE tenant_id = ${tenantId}`;
    const f = windowOf("UTC", 20, 0);
    await kept("costs", f);
    // Arrived three seconds ago: every transaction it opens has to end where its budget does.
    const arrived = Date.now() - 3_000;
    const ends: number[] = [];
    // The real one, held before the spy replaces the binding every import reads.
    const real = tenancy.runScopedOn;
    const spy = spyOn(tenancy, "runScopedOn").mockImplementation(((
      ...args: Parameters<typeof runScopedOn>
    ) => {
      const budget = args[3] as { deadline?: number } | undefined;
      if (budget?.deadline !== undefined) ends.push(budget.deadline);
      return real(...args);
    }) as typeof runScopedOn);
    try {
      await requestContext.run({ locale: "en", startedAt: arrived }, () =>
        fromKeptDays(
          ctx(),
          f,
          "costs",
          (x) => x.costs,
          () => getDashboardCosts(ctx(), f, appDb),
          appDb,
        ),
      );
    } finally {
      spy.mockRestore();
    }
    expect(ends.length).toBeGreaterThan(0);
    expect(Math.max(...ends)).toBeLessThanOrEqual(
      arrived + config.metrics.timeoutMs,
    );
  });

  test("every section the console reads has a block", () => {
    const covered = new Set(Object.values(BLOCK_SECTIONS).flat());
    expect([...SECTIONS].filter((s) => !covered.has(s))).toEqual([]);
  });
});
