import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { USAGE_NODE_IS_AGENT_TURN } from "@/graph/usage";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { getLabelOutcomes } from "@/modules/analytics/activity";
import { getBreakdown } from "@/modules/analytics/breakdown";
import {
  countConversationDays,
  countConversations,
  settleConversationMarks,
  withRunsMark,
} from "@/modules/analytics/conversation-sums";
import { getDashboardCosts } from "@/modules/analytics/costs";
import { drillDownPageIds } from "@/modules/analytics/drilldown";
import type { DashboardFilter } from "@/modules/analytics/filter";
import { stepLedgerSums } from "@/modules/analytics/ledger-sums";
import { getKpis, getTimeseries } from "@/modules/analytics/service";
import { getOutcomeTrend } from "@/modules/analytics/trends";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "@/tests/utils/chatwoot";
import { until } from "@/tests/utils/poll";
import { TEST_TIMEOUT_MS } from "@/tests/utils/timeouts";

// THE CONVERSATION COUNTS (docs/dashboard.md, "Conversation sums"): the funnel, the KPIs, the agent
// and inbox splits, the label outcomes, the drill-down and the cost block's divisors read the same
// from the counts as from the conversations, and a late change to a counted conversation (its row,
// or an agent's turn on it) reaches the figures at once. The oracle is each reader's own read of the
// rows, which it takes when the tenant has no sums state.

// Named here as well as in the preload: bun applies the preload's time to the first file of a process
// only, and these tests outlast bun's 5 s default on a loaded machine (scripts/bun-test.sh).
jest.setTimeout(TEST_TIMEOUT_MS);

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
const FIRST = NOW - 6 * DAY;
const LAST = NOW - 2 * HOUR;

interface Fx {
  tenantId: bigint;
  instanceId: bigint;
  agents: bigint[];
  inboxes: bigint[];
  convs: bigint[];
}
let fx: Fx;
let seq = 95_000 + (process.pid % 1000) * 60;

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
    accountId: 80_000 + (seq++ % 10_000) + (process.pid % 1000) * 10,
    baseUrl: `https://${slug}.cw.example`,
    adminToken: "enc",
  });
  const agents: bigint[] = [];
  for (const name of ["Ana", "Beto", "Caio"])
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
  for (const n of [1, 2, 3])
    inboxes.push(
      (
        await suDb.inbox.create({
          data: {
            tenantId: t.id,
            chatwootInstanceId: inst.id,
            chatwootInboxId: n,
            name: `in${n}`,
            // The third inbox has no agent bound: only a run makes its conversations an agent's.
            agentId: n < 3 ? (agents[n - 1] as bigint) : null,
          },
        })
      ).id,
    );
  return { tenantId: t.id, instanceId: inst.id, agents, inboxes, convs: [] };
}

// Conversations of every outcome, label set and first response the figures read, with agent turns
// from the inbox's agent, another agent, a legacy row with no agent, and calls that are not turns.
async function seedConversations(f: Fx, seed: number, count: number) {
  const r = rng(seed);
  const usage: Prisma.LlmUsageCreateManyInput[] = [];
  // A conversation a minute either side of every UTC midnight, where the day sums meet the quarters.
  const edges: number[] = [];
  for (let d = Math.ceil(FIRST / DAY) * DAY; d < NOW - 10 * 60_000; d += DAY)
    edges.push(d - 60_000, d + 60_000);
  for (let i = 0; i < count; i++) {
    const n = seq++;
    const at = new Date(edges[i] ?? FIRST + Math.floor(r() * (LAST - FIRST)));
    const resolved = r() < 0.5;
    const reply = r();
    const c = await suDb.conversation.create({
      data: {
        tenantId: f.tenantId,
        chatwootInstanceId: f.instanceId,
        inboxId: r() < 0.05 ? null : pick(r, f.inboxes),
        chatwootConversationId: n,
        status: resolved ? "resolved" : pick(r, ["open", "pending"]),
        assigneeType: r() < 0.2 ? "User" : r() < 0.5 ? "AgentBot" : null,
        resolvedBy: resolved
          ? pick(r, ["agent", "agent", "human", "legacy_unknown"])
          : null,
        labels:
          r() < 0.2
            ? []
            : [
                pick(r, ["vendas", "suporte", "x"]),
                ...(r() < 0.3 ? ["vip"] : []),
              ],
        sweepOnly: r() < 0.03,
        threadId: `${f.tenantId}:${f.instanceId}:${n}`,
        createdAt: at,
        chatwootCreatedAt: reply < 0.8 ? at : null,
        chatwootFirstReplyAt:
          reply < 0.7
            ? new Date(at.getTime() + Math.floor(r() * 3_600_000))
            : null,
      },
    });
    f.convs.push(c.id);
    const turns = Math.floor(r() * 4);
    for (let k = 0; k < turns; k++)
      usage.push({
        tenantId: f.tenantId,
        conversationId: c.id,
        agentId: r() < 0.08 ? null : pick(r, f.agents),
        source: r() < 0.9 ? "inbox" : "playground",
        node: pick(r, [null, "agent", "agent", "vision", "observer"]),
        model: "m1",
        costUsd: 0.01,
        createdAt: new Date(
          Math.max(
            at.getTime(),
            Math.min(LAST, at.getTime() + Math.floor(r() * 2 * DAY)),
          ),
        ),
      });
  }
  await suDb.llmUsage.createMany({ data: usage });
}

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

async function blocks(tenantId: bigint, f: DashboardFilter) {
  const c = ctx(tenantId);
  const kpis = await getKpis(c, f, db);
  const trend = await getOutcomeTrend(c, f, undefined, db);
  const byAgent = await getOutcomeTrend(c, f, "agent", db);
  const byInbox = await getOutcomeTrend(c, f, "inbox", db);
  const labels = await getLabelOutcomes(c, f, db);
  const costs = await getDashboardCosts(c, f, db, noFetch);
  const breakdown = await getBreakdown(c, f, "agent", db);
  const drill = await runScopedOn(db, c, (d) =>
    drillDownPageIds(d, { view: f, outcome: "involved" }, { take: 10_000 }),
  );
  return JSON.parse(
    JSON.stringify(
      {
        kpis,
        trend,
        byAgent,
        byInbox,
        labels,
        divisors: {
          conversations: costs.conversations,
          resolved: costs.resolvedConversations,
          days: costs.days.map((d) => [
            d.date,
            d.conversations,
            d.resolvedConversations,
          ]),
        },
        breakdown: breakdown.map((r) => [
          r.key,
          r.conversations,
          r.resolvedConversations,
        ]),
        drill: drill.map(String).sort(),
      },
      (_, v) => (typeof v === "bigint" ? String(v) : v),
    ),
  );
}

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
    "five local days",
    () => ({
      since: new Date(Math.floor((NOW - 5 * DAY) / DAY) * DAY + 3 * HOUR),
      until: new Date(Math.floor(NOW / DAY) * DAY + 3 * HOUR),
      tz: "America/Sao_Paulo",
    }),
  ],
  [
    "a window cut off the quarter hour, running to now",
    () => ({ since: new Date(FIRST + 9 * 60_000), tz: "Asia/Kathmandu" }),
  ],
  ["all time", () => ({ tz: "UTC" })],
  ["one agent", () => ({ since: new Date(FIRST), agentId: fx.agents[1] })],
  [
    "the inbox with no agent bound",
    () => ({ since: new Date(FIRST), inboxId: fx.inboxes[2] }),
  ],
];

beforeAll(async () => {
  if (!dbUp) return;
  fx = await seedTenant("csums");
  await seedConversations(fx, 21, 220);
  await sumUp(fx.tenantId);
}, 120_000);

afterAll(async () => {
  if (dbUp && fx)
    await suDb.tenant
      .delete({ where: { id: fx.tenantId } })
      .catch(() => undefined);
  await su?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!dbUp)("the conversation counts", () => {
  test("the job keeps the runs of every conversation an agent took a turn on", async () => {
    const [diff] = await suDb.$queryRaw<
      { missing: number; extra: number }[]
    >(Prisma.sql`
      WITH truth AS (
        SELECT DISTINCT conversation_id, COALESCE(agent_id, 0) AS agent_id FROM llm_usage
         WHERE tenant_id = ${fx.tenantId} AND conversation_id IS NOT NULL AND source = 'inbox'
           AND ledger_is_agent_turn(node)
      ), kept AS (
        SELECT conversation_id, agent_id FROM conversation_agent_runs WHERE tenant_id = ${fx.tenantId}
      )
      SELECT (SELECT COUNT(*) FROM (SELECT * FROM truth EXCEPT SELECT * FROM kept) a)::int AS missing,
             (SELECT COUNT(*) FROM (SELECT * FROM kept EXCEPT SELECT * FROM truth) b)::int AS extra`);
    expect(diff).toEqual({ missing: 0, extra: 0 });
  });

  for (const [name, view] of VIEWS)
    test(`every conversation block reads the same from the counts as from the conversations: ${name}`, async () => {
      expect(await blocks(fx.tenantId, view())).toEqual(
        await rawBlocks(fx.tenantId, view()),
      );
    });

  for (const [name, view] of VIEWS)
    test(`the cost divisors are the funnel's conversations: ${name}`, async () => {
      const c = ctx(fx.tenantId);
      const kpis = await getKpis(c, view(), db);
      const costs = await getDashboardCosts(c, view(), db, noFetch);
      expect(costs.conversations).toBe(kpis.involved);
      expect(costs.resolvedConversations).toBe(kpis.resolvedByBot);
      const trend = await getOutcomeTrend(c, view(), undefined, db);
      expect(trend.days.reduce((n, d) => n + d.involved, 0)).toBe(
        kpis.involved,
      );
      const involvedOn = new Map(trend.days.map((d) => [d.date, d.involved]));
      for (const d of costs.days)
        expect(d.conversations).toBe(involvedOn.get(d.date) ?? 0);
    });

  for (const [name, view] of VIEWS)
    test(`a mark hours behind reads the conversations from their rows: ${name}`, async () => {
      await suDb.$executeRaw(Prisma.sql`
        UPDATE ledger_sums_state SET summed_until = summed_until - interval '3 hours'
         WHERE tenant_id = ${fx.tenantId}`);
      try {
        const v = await runScopedOn(db, ctx(fx.tenantId), (d) =>
          withRunsMark(d, view()),
        );
        expect(v.runsMark).toBeUndefined();
        expect(await blocks(fx.tenantId, view())).toEqual(
          await rawBlocks(fx.tenantId, view()),
        );
      } finally {
        await suDb.$executeRaw(Prisma.sql`
          UPDATE ledger_sums_state SET summed_until = summed_until + interval '3 hours'
           WHERE tenant_id = ${fx.tenantId}`);
      }
    });

  test("a late change to a counted conversation is in the figures at once and after the next run", async () => {
    const view = { since: new Date(FIRST), tz: "UTC" };
    // Each statement changes one column the figures read, on conversations of its own, and moves a
    // figure: the outcome, the labels, the inbox, the first response sample, the conversation itself.
    const slice = (from: number, to: number) => fx.convs.slice(from, to);
    const changes = [
      Prisma.sql`UPDATE conversations SET status = 'resolved'
        WHERE id = ANY(${slice(0, 20)}::bigint[]) AND status <> 'resolved' AND assignee_type IS DISTINCT FROM 'User'`,
      Prisma.sql`UPDATE conversations SET status = 'open'
        WHERE id = ANY(${slice(0, 20)}::bigint[]) AND status = 'resolved' AND assignee_type IS DISTINCT FROM 'User'`,
      Prisma.sql`UPDATE conversations SET assignee_type = 'User'
        WHERE id = ANY(${slice(20, 30)}::bigint[]) AND assignee_type IS DISTINCT FROM 'User'`,
      Prisma.sql`UPDATE conversations SET resolved_by = CASE WHEN resolved_by = 'agent' THEN 'human' ELSE 'agent' END
        WHERE id = ANY(${slice(30, 60)}::bigint[]) AND status = 'resolved' AND assignee_type IS DISTINCT FROM 'User'`,
      Prisma.sql`UPDATE conversations SET labels = ARRAY['novo'] WHERE id = ANY(${slice(60, 68)}::bigint[])`,
      Prisma.sql`UPDATE conversations SET inbox_id = ${fx.inboxes[2]}
        WHERE id = ANY(${slice(68, 80)}::bigint[]) AND inbox_id IS DISTINCT FROM ${fx.inboxes[2]}`,
      Prisma.sql`UPDATE conversations SET chatwoot_first_reply_at = chatwoot_created_at + interval '7 minutes'
        WHERE id = ANY(${slice(80, 120)}::bigint[]) AND chatwoot_created_at IS NOT NULL AND chatwoot_first_reply_at IS NULL`,
      Prisma.sql`DELETE FROM conversations WHERE id = ANY(${slice(120, 123)}::bigint[])`,
    ];
    for (const [i, change] of changes.entries())
      expect([i, await suDb.$executeRaw(change)]).not.toEqual([i, 0]);
    expect(
      await suDb.conversationSumMark.count({
        where: { tenantId: fx.tenantId },
      }),
    ).toBeGreaterThan(0);
    const now = await blocks(fx.tenantId, view);
    expect(now).toEqual(await rawBlocks(fx.tenantId, view));
    await sumUp(fx.tenantId);
    expect(
      await suDb.conversationSumMark.count({
        where: { tenantId: fx.tenantId },
      }),
    ).toBe(0);
    expect(await blocks(fx.tenantId, view)).toEqual(now);
  });

  test("a first reply mirrored late reaches the first response figures, alone", async () => {
    const view = { since: new Date(FIRST), tz: "UTC" };
    const before = await getKpis(ctx(fx.tenantId), view, db);
    expect(
      await suDb.$executeRaw(Prisma.sql`
        UPDATE conversations SET chatwoot_first_reply_at = chatwoot_created_at + interval '3 minutes'
         WHERE id = ANY(${fx.convs}::bigint[]) AND chatwoot_created_at IS NOT NULL
           AND chatwoot_first_reply_at IS NULL AND created_at < ${new Date(NOW - DAY)}`),
    ).toBeGreaterThan(0);
    const now = await getKpis(ctx(fx.tenantId), view, db);
    expect(now.firstResponseSampled).toBeGreaterThan(
      before.firstResponseSampled,
    );
    expect(now).toEqual(await rawBlocks(fx.tenantId, view).then((b) => b.kpis));
    await sumUp(fx.tenantId);
    expect(await getKpis(ctx(fx.tenantId), view, db)).toEqual(now);
  });

  test("a rewrite the figures do not read leaves no mark", async () => {
    await sumUp(fx.tenantId);
    await suDb.$executeRaw(Prisma.sql`
      UPDATE conversations SET chatwoot_status_at = 1, last_event_at = now()
       WHERE id = ANY(${fx.convs.slice(40, 60)}::bigint[])`);
    expect(
      await suDb.conversationSumMark.count({
        where: { tenantId: fx.tenantId },
      }),
    ).toBe(0);
  });

  test("an agent's first turn on a counted conversation, and the removal of a conversation's only turns, are in the figures at once", async () => {
    const view = { since: new Date(FIRST), agentId: fx.agents[2], tz: "UTC" };
    const quiet = await suDb.$queryRaw<{ id: bigint }[]>(Prisma.sql`
      SELECT c.id FROM conversations c
       WHERE c.tenant_id = ${fx.tenantId}
         AND NOT EXISTS (SELECT 1 FROM llm_usage u WHERE u.conversation_id = c.id AND u.agent_id = ${fx.agents[2]})
       LIMIT 5`);
    // Written now, by the agent: the turn itself is above the mark, the conversation below it.
    await suDb.llmUsage.createMany({
      data: quiet.map((q) => ({
        tenantId: fx.tenantId,
        conversationId: q.id,
        agentId: fx.agents[2],
        source: "inbox",
        node: "agent",
        model: "m1",
      })),
    });
    const ran = await suDb.$queryRaw<{ id: bigint }[]>(Prisma.sql`
      SELECT conversation_id AS id FROM llm_usage
       WHERE tenant_id = ${fx.tenantId} AND agent_id = ${fx.agents[0]} AND source = 'inbox'
         AND created_at < now() - interval '1 day'
       LIMIT 4`);
    await suDb.$executeRaw(Prisma.sql`
      DELETE FROM llm_usage WHERE tenant_id = ${fx.tenantId} AND conversation_id = ANY(${ran.map((r) => r.id)}::bigint[])`);
    for (const v of [view, { since: new Date(FIRST), tz: "UTC" }]) {
      const now = await blocks(fx.tenantId, v);
      expect(now).toEqual(await rawBlocks(fx.tenantId, v));
    }
    await sumUp(fx.tenantId);
    for (const v of [view, { since: new Date(FIRST), tz: "UTC" }])
      expect(await blocks(fx.tenantId, v)).toEqual(
        await rawBlocks(fx.tenantId, v),
      );
  });

  test("a counted conversation removed and written back counts as it did", async () => {
    const view = { since: new Date(FIRST), tz: "UTC" };
    await sumUp(fx.tenantId);
    const before = await blocks(fx.tenantId, view);
    const [kept] = await suDb.$queryRaw<{ id: bigint }[]>(Prisma.sql`
      SELECT r.conversation_id AS id FROM conversation_agent_runs r
        JOIN conversations c ON c.id = r.conversation_id
       WHERE r.tenant_id = ${fx.tenantId} AND r.agent_id <> 0 AND c.created_at < now() - interval '1 day'
       LIMIT 1`);
    const id = (kept as { id: bigint }).id;
    const [gone] = await suDb.$queryRaw<{ row: unknown }[]>(Prisma.sql`
      WITH d AS (DELETE FROM conversations WHERE id = ${id} RETURNING *)
      SELECT row_to_json(d) AS row FROM d`);
    await sumUp(fx.tenantId);
    // Its turns stay in the ledger, so written back it is the conversation the agent ran on again.
    await suDb.$executeRaw(Prisma.sql`
      INSERT INTO conversations SELECT * FROM json_populate_record(NULL::conversations, ${JSON.stringify((gone as { row: unknown }).row)}::json)`);
    expect(await blocks(fx.tenantId, view)).toEqual(before);
    await sumUp(fx.tenantId);
    expect(await blocks(fx.tenantId, view)).toEqual(before);
  });

  test("a conversation that just arrived counts its turns at once, a turn stamped before the mark too", async () => {
    const t = await seedTenant("fresh");
    try {
      await sumUp(t.tenantId);
      const view = { since: new Date(FIRST), tz: "UTC" };
      // Both conversations are above the mark, their own rows not yet marked: one turn written now,
      // and one stamped a day back, which lands in a summed quarter of the ledger.
      for (const at of [undefined, new Date(NOW - DAY)]) {
        const c = await suDb.conversation.create({
          data: {
            tenantId: t.tenantId,
            chatwootInstanceId: t.instanceId,
            inboxId: t.inboxes[0],
            chatwootConversationId: seq++,
            status: "open",
            threadId: `${t.tenantId}:${t.instanceId}:${seq}`,
          },
        });
        await suDb.llmUsage.create({
          data: {
            tenantId: t.tenantId,
            conversationId: c.id,
            agentId: t.agents[0],
            source: "inbox",
            node: "agent",
            model: "m1",
            createdAt: at,
          },
        });
      }
      const kpis = await getKpis(ctx(t.tenantId), view, db);
      expect([kpis.totalConversations, kpis.involved]).toEqual([2, 2]);
      // The same with the mark hours behind, read from the rows.
      await suDb.$executeRaw(Prisma.sql`
        UPDATE ledger_sums_state SET summed_until = summed_until - interval '3 hours'
         WHERE tenant_id = ${t.tenantId}`);
      const behind = await getKpis(ctx(t.tenantId), view, db);
      expect([behind.totalConversations, behind.involved]).toEqual([2, 2]);
    } finally {
      await suDb.tenant
        .delete({ where: { id: t.tenantId } })
        .catch(() => undefined);
    }
  });

  test("the agent breakdown's unattributed row counts the conversations a legacy turn ran on", async () => {
    const t = await seedTenant("legacy");
    try {
      const at = new Date(NOW - DAY);
      for (const agentId of [null, t.agents[0]]) {
        const c = await suDb.conversation.create({
          data: {
            tenantId: t.tenantId,
            chatwootInstanceId: t.instanceId,
            inboxId: t.inboxes[2],
            chatwootConversationId: seq++,
            status: "resolved",
            resolvedBy: "agent",
            threadId: `${t.tenantId}:${t.instanceId}:${seq}`,
            createdAt: at,
          },
        });
        await suDb.llmUsage.create({
          data: {
            tenantId: t.tenantId,
            conversationId: c.id,
            agentId,
            source: "inbox",
            node: "agent",
            model: "m1",
            costUsd: 1,
            createdAt: new Date(at.getTime() + HOUR),
          },
        });
      }
      const view = { since: new Date(FIRST), tz: "UTC" };
      const row = async () =>
        (await getBreakdown(ctx(t.tenantId), view, "agent", db)).find(
          (r) => r.key === null,
        );
      // Before its first run the tenant reads from the rows.
      const rawRow = await row();
      await sumUp(t.tenantId);
      for (const r of [rawRow, await row()])
        expect([r?.conversations, r?.resolvedConversations]).toEqual([1, 1]);
    } finally {
      await suDb.tenant
        .delete({ where: { id: t.tenantId } })
        .catch(() => undefined);
    }
  });

  test("a turn stamped back on a conversation too young for its own mark counts it, while its ledger quarter waits", async () => {
    const t = await seedTenant("backdated");
    try {
      const c = await suDb.conversation.create({
        data: {
          tenantId: t.tenantId,
          chatwootInstanceId: t.instanceId,
          inboxId: t.inboxes[0],
          chatwootConversationId: seq++,
          status: "open",
          threadId: `${t.tenantId}:${t.instanceId}:${seq}`,
          createdAt: new Date(NOW - 2 * DAY),
        },
      });
      await sumUp(t.tenantId);
      await suDb.llmUsage.create({
        data: {
          tenantId: t.tenantId,
          conversationId: c.id,
          agentId: t.agents[0],
          source: "inbox",
          node: "agent",
          model: "m1",
          createdAt: new Date(NOW - DAY),
        },
      });
      // The shape of a conversation younger than the grace: the ledger quarter is marked, the
      // conversation is not, and the mark passes it before the ledger quarter is summed again.
      await suDb.$executeRaw(Prisma.sql`
        DELETE FROM conversation_sum_marks WHERE tenant_id = ${t.tenantId}`);
      const [state] = await suDb.$queryRaw<{ until: Date }[]>(Prisma.sql`
        SELECT summed_until AS until FROM ledger_sums_state WHERE tenant_id = ${t.tenantId}`);
      const q = Math.floor((NOW - 2 * DAY) / (15 * 60_000)) * 15 * 60_000;
      const until = (state as { until: Date }).until;
      const day = Math.floor(q / DAY) * DAY;
      await runScopedOn(db, ctx(t.tenantId), async (d) => {
        await countConversations(
          d,
          new Date(q),
          new Date(q + 15 * 60_000),
          until,
        );
        await countConversationDays(
          d,
          new Date(day),
          new Date(day + DAY),
          until,
        );
      });
      await sumUp(t.tenantId);
      const view = { since: new Date(FIRST), tz: "UTC" };
      expect((await getKpis(ctx(t.tenantId), view, db)).involved).toBe(1);
    } finally {
      await suDb.tenant
        .delete({ where: { id: t.tenantId } })
        .catch(() => undefined);
    }
  });

  test("a day the job finishes summing in a step that starts inside it is written whole", async () => {
    const t = fx.tenantId;
    const dayTables = [
      "ledger_latency_days",
      "conversation_day_sums",
      "conversation_label_day_sums",
      "conversation_first_response_days",
    ];
    const snapshot = async () => {
      const out: Record<string, string[]> = {};
      for (const table of dayTables) {
        const rows = await suDb.$queryRaw<{ r: string }[]>(
          Prisma.sql`SELECT (to_jsonb(x) - 'id')::text AS r FROM ${Prisma.raw(table)} x WHERE tenant_id = ${t}`,
        );
        out[table] = rows.map((x) => x.r).sort();
      }
      return out;
    };
    const before = await snapshot();
    expect(before.conversation_day_sums?.length).toBeGreaterThan(0);
    // The state of a job whose last step ended at ten in the morning of D, D's day rows not yet written.
    const d = new Date(Math.floor((NOW - 3 * DAY) / DAY) * DAY);
    const cut = new Date(d.getTime() + 10 * HOUR);
    for (const table of dayTables)
      await suDb.$executeRaw(
        Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE tenant_id = ${t} AND day >= ${d}`,
      );
    for (const table of [
      "ledger_quarter_sums",
      "conversation_quarter_sums",
      "conversation_label_quarter_sums",
    ])
      await suDb.$executeRaw(
        Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE tenant_id = ${t} AND quarter >= ${cut}`,
      );
    await suDb.$executeRaw(
      Prisma.sql`UPDATE ledger_sums_state SET summed_until = ${cut} WHERE tenant_id = ${t}`,
    );
    await sumUp(t);
    expect(await snapshot()).toEqual(before);
    const view = VIEWS[0]?.[1]() as DashboardFilter;
    expect(await blocks(t, view)).toEqual(await rawBlocks(t, view));
  });

  test("first replies within a second keep their spread, summed or read from the rows", async () => {
    const t = await seedTenant("csub");
    try {
      const at = new Date(Math.floor((NOW - 3 * DAY) / DAY) * DAY + 5 * HOUR);
      for (const ms of [100, 900])
        await suDb.conversation.create({
          data: {
            tenantId: t.tenantId,
            chatwootInstanceId: t.instanceId,
            inboxId: t.inboxes[0],
            chatwootConversationId: seq++,
            status: "open",
            threadId: `${t.tenantId}:${t.instanceId}:${seq}`,
            createdAt: at,
            chatwootCreatedAt: at,
            chatwootFirstReplyAt: new Date(at.getTime() + ms),
          },
        });
      await sumUp(t.tenantId);
      const view = { since: new Date(FIRST), tz: "UTC" };
      const summed = await getKpis(ctx(t.tenantId), view, db);
      expect(summed.firstResponseSampled).toBe(2);
      expect(summed.firstResponseSeconds).toBeCloseTo(0.5, 9);
      expect(summed).toEqual((await rawBlocks(t.tenantId, view)).kpis);
    } finally {
      await suDb.tenant
        .delete({ where: { id: t.tenantId } })
        .catch(() => undefined);
    }
  });

  test("a late turn whose ledger quarter is summed after its conversation's still counts it as run", async () => {
    const view = { since: new Date(FIRST), agentId: fx.agents[1], tz: "UTC" };
    const quiet = await suDb.$queryRaw<{ id: bigint }[]>(Prisma.sql`
      SELECT c.id FROM conversations c
       WHERE c.tenant_id = ${fx.tenantId} AND c.created_at < ${new Date(NOW - 2 * DAY)}
         AND NOT EXISTS (SELECT 1 FROM llm_usage u WHERE u.conversation_id = c.id AND u.agent_id = ${fx.agents[1]})
       LIMIT 3`);
    expect(quiet.length).toBe(3);
    // Written a day back, below the mark, by the agent of the view.
    await suDb.llmUsage.createMany({
      data: quiet.map((q) => ({
        tenantId: fx.tenantId,
        conversationId: q.id,
        agentId: fx.agents[1],
        source: "inbox",
        node: "agent",
        model: "m1",
        createdAt: new Date(NOW - DAY),
      })),
    });
    // The ledger's own marks wait for a later step, as when they fall past a step's batch.
    const held = await suDb.$queryRaw<
      { tenant_id: bigint; quarter: Date }[]
    >(Prisma.sql`
      DELETE FROM ledger_sum_marks WHERE tenant_id = ${fx.tenantId} RETURNING tenant_id, quarter`);
    try {
      await stepLedgerSums(db, fx.tenantId);
      const conversationFigures = async (raw: boolean) => {
        const b = raw
          ? await rawBlocks(fx.tenantId, view)
          : await blocks(fx.tenantId, view);
        return { kpis: b.kpis, trend: b.trend, labels: b.labels };
      };
      expect(await conversationFigures(false)).toEqual(
        await conversationFigures(true),
      );
    } finally {
      for (const m of held)
        await suDb.$executeRaw(Prisma.sql`
          INSERT INTO ledger_sum_marks (tenant_id, quarter) VALUES (${m.tenant_id}, ${m.quarter})`);
      await sumUp(fx.tenantId);
    }
  });

  test("conversations older than the tenant's first ledger row are counted", async () => {
    const t = await seedTenant("cold");
    try {
      const old = new Date(Math.floor((NOW - 4 * DAY) / DAY) * DAY + 6 * HOUR);
      const c = await suDb.conversation.create({
        data: {
          tenantId: t.tenantId,
          chatwootInstanceId: t.instanceId,
          inboxId: t.inboxes[0],
          chatwootConversationId: seq++,
          status: "open",
          threadId: `${t.tenantId}:${t.instanceId}:${seq}`,
          createdAt: old,
        },
      });
      await suDb.llmUsage.create({
        data: {
          tenantId: t.tenantId,
          conversationId: c.id,
          agentId: t.agents[0],
          source: "inbox",
          node: "agent",
          model: "m1",
          createdAt: new Date(NOW - DAY),
        },
      });
      // Rows from before the migration carry no marks.
      await suDb.$executeRaw(Prisma.sql`
        DELETE FROM conversation_sum_marks WHERE tenant_id = ${t.tenantId}`);
      await suDb.$executeRaw(Prisma.sql`
        DELETE FROM ledger_sum_marks WHERE tenant_id = ${t.tenantId}`);
      await sumUp(t.tenantId);
      const view = { since: new Date(FIRST), tz: "UTC" };
      const kpis = await getKpis(ctx(t.tenantId), view, db);
      expect(kpis.totalConversations).toBe(1);
      expect(kpis.involved).toBe(1);
    } finally {
      await suDb.tenant
        .delete({ where: { id: t.tenantId } })
        .catch(() => undefined);
    }
  });

  test("every agent turn marks its counted conversation, an agent already kept included", async () => {
    const [kept] = await suDb.$queryRaw<
      { conversation_id: bigint; agent_id: bigint }[]
    >(Prisma.sql`
      SELECT conversation_id, agent_id FROM conversation_agent_runs
       WHERE tenant_id = ${fx.tenantId} AND agent_id <> 0 LIMIT 1`);
    expect(kept).toBeDefined();
    const k = kept as { conversation_id: bigint; agent_id: bigint };
    const marksOf = () =>
      suDb.conversationSumMark.count({
        where: { tenantId: fx.tenantId, conversationId: k.conversation_id },
      });
    const turn = () =>
      suDb.llmUsage.create({
        data: {
          tenantId: fx.tenantId,
          conversationId: k.conversation_id,
          agentId: k.agent_id,
          source: "inbox",
          node: "agent",
          model: "m1",
        },
      });
    // A kept run proves nothing to a turn: a rebuild may be dropping it in a transaction the turn
    // cannot see yet.
    await turn();
    expect(await marksOf()).toBe(1);
    await turn();
    expect(await marksOf()).toBe(2);
    await sumUp(fx.tenantId);
  });

  test("a turn written while the agent's last turn is removed keeps the conversation involved", async () => {
    const t = await seedTenant("race");
    // A transaction held open until released, once its write is in.
    const held = (
      write: (tx: Prisma.TransactionClient) => Promise<unknown>,
    ) => {
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
          await write(tx);
          wrote();
          await released;
        },
        { timeout: 60_000, maxWait: 5_000 },
      );
      return written.then(() => ({ release, done }));
    };
    try {
      const c = await suDb.conversation.create({
        data: {
          tenantId: t.tenantId,
          chatwootInstanceId: t.instanceId,
          inboxId: t.inboxes[0],
          chatwootConversationId: seq++,
          status: "open",
          threadId: `${t.tenantId}:${t.instanceId}:${seq}`,
          createdAt: new Date(NOW - DAY),
        },
      });
      const turn = {
        tenantId: t.tenantId,
        conversationId: c.id,
        agentId: t.agents[0],
        source: "inbox",
        node: "agent",
        model: "m1",
      } as const;
      const old = await suDb.llmUsage.create({
        data: { ...turn, createdAt: new Date(NOW - DAY + HOUR) },
      });
      await sumUp(t.tenantId);
      // A removes the agent's only turn, B writes a new one, each unseen by the other. A commits, and
      // the rebuild runs before B commits.
      const a = await held((tx) =>
        tx.llmUsage.delete({ where: { id: old.id } }),
      );
      const b = await held((tx) => tx.llmUsage.create({ data: turn }));
      a.release();
      await a.done;
      const [state] = await suDb.$queryRaw<{ until: Date }[]>(Prisma.sql`
        SELECT summed_until AS until FROM ledger_sums_state WHERE tenant_id = ${t.tenantId}`);
      await runScopedOn(db, ctx(t.tenantId), (d) =>
        settleConversationMarks(d, (state as { until: Date }).until),
      );
      b.release();
      await b.done;
      await sumUp(t.tenantId);
      const kpis = await getKpis(
        ctx(t.tenantId),
        { since: new Date(FIRST), tz: "UTC" },
        db,
      );
      expect(kpis.involved).toBe(1);
    } finally {
      await suDb.tenant
        .delete({ where: { id: t.tenantId } })
        .catch(() => undefined);
    }
  });

  test("the timeseries of traffic other than real conversations has no conversations", async () => {
    const { points: real } = await getTimeseries(
      ctx(fx.tenantId),
      { since: new Date(FIRST) },
      db,
    );
    expect(real.some((p) => p.conversations > 0)).toBe(true);
    for (const f of [
      { since: new Date(FIRST), source: "playground" as const },
      { since: new Date(FIRST), audience: "anonymous" as const },
    ]) {
      const { points: series } = await getTimeseries(ctx(fx.tenantId), f, db);
      expect(series.filter((p) => p.conversations !== 0)).toEqual([]);
    }
  });

  test("the timeseries of one agent in one inbox has no day without calls or conversations", async () => {
    for (const inboxId of fx.inboxes) {
      const f = { since: new Date(FIRST), agentId: fx.agents[0], inboxId };
      const { points: series } = await getTimeseries(ctx(fx.tenantId), f, db);
      expect(
        series.filter((p) => p.calls === 0 && p.conversations === 0),
      ).toEqual([]);
    }
  });

  test("the inbox breakdown counts the conversations with no inbox in its no-inbox row", async () => {
    const view = { since: new Date(FIRST), tz: "UTC" };
    const rows = await getBreakdown(ctx(fx.tenantId), view, "inbox", db);
    const none = rows.find((r) => r.key === null);
    const [expected] = await suDb.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM conversations c
       WHERE c.tenant_id = ${fx.tenantId} AND c.inbox_id IS NULL AND NOT c.sweep_only
         AND c.created_at >= ${view.since}
         AND EXISTS (SELECT 1 FROM llm_usage u WHERE u.conversation_id = c.id AND u.source = 'inbox'
                       AND ledger_is_agent_turn(u.node))`);
    expect(expected?.n).toBeGreaterThan(0);
    expect(none?.conversations).toBe(expected?.n);
  });

  test("every foreign key of the sums tables leads an index, so a cascade finds its rows", async () => {
    const rows = await suDb.$queryRaw<{ fk: string }[]>(Prisma.sql`
      SELECT con.conname AS fk FROM pg_constraint con
       WHERE con.contype = 'f'
         AND con.conrelid::regclass::text IN ('conversation_agent_runs', 'conversation_quarter_sums',
           'conversation_label_quarter_sums', 'conversation_day_sums', 'conversation_label_day_sums',
           'conversation_first_response_days', 'conversation_sum_marks', 'ledger_quarter_sums',
           'ledger_latency_days', 'ledger_sum_marks', 'ledger_sums_state')
         AND NOT EXISTS (
           SELECT 1 FROM pg_index i
            WHERE i.indrelid = con.conrelid
              AND (i.indkey::int2[])[0:cardinality(con.conkey) - 1] = con.conkey)`);
    expect(rows).toEqual([]);
  });

  test("the database's idea of an agent turn is the app's", async () => {
    const nodes = [...Object.keys(USAGE_NODE_IS_AGENT_TURN), null];
    const rows = await suDb.$queryRaw<{ node: string | null; turn: boolean }[]>(
      Prisma.sql`SELECT n AS node, ledger_is_agent_turn(n) AS turn FROM unnest(${nodes}::text[]) AS n`,
    );
    expect(
      Object.fromEntries(rows.map((r) => [String(r.node), r.turn])),
    ).toEqual(
      Object.fromEntries(
        nodes.map((n) => [
          String(n),
          n === null
            ? true
            : USAGE_NODE_IS_AGENT_TURN[
                n as keyof typeof USAGE_NODE_IS_AGENT_TURN
              ],
        ]),
      ),
    );
  });
});
