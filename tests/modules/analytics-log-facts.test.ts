import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import {
  getFollowUpActivity,
  getHandoffReasons,
} from "@/modules/analytics/activity";
import type { DashboardFilter } from "@/modules/analytics/filter";
import {
  backfillLogFactsSlice,
  ensureLogFactsBackfill,
  logFactsBackfillHandler,
  registerLogFactsBackfillHandler,
} from "@/modules/analytics/log-facts";
import { flowlogSweepHandler } from "@/modules/flowlog/retention";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog } from "@/tests/utils/flowlog";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// THE LOG FACTS ARE THE LOG, READ ANOTHER WAY (docs/dashboard.md, "Log facts"). The handoff, silence
// and follow-up figures are read from `dashboard_log_facts` once a tenant's backfill finished, and
// from `execution_logs` before that; both readers live in the same functions, switched by the
// tenant's `dashboard_log_facts_state` row. So every case here reads the same figures twice, the
// facts way and the log way, over one randomized fixture and every filter, and asks for the same
// answer; and then changes the log under the facts (a line written late, deleted, rewritten, swept)
// and asks again.

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
// The window is three days back from a fixed hour, and lines go up to two days before it, so the
// earlier transfers that decide a person sit outside the window too.
const END = new Date(Date.now() - 2 * 60 * 60 * 1000);
const START = new Date(END.getTime() - 3 * DAY);
const FIRST = new Date(START.getTime() - 2 * DAY);

interface Fx {
  tenantId: bigint;
  instanceId: bigint;
  agents: bigint[];
  inboxes: bigint[];
  convs: { id: bigint; inbox: bigint }[];
}

let fx: Fx;
let other: Fx;
let convSeq = 70_000 + (process.pid % 1000) * 50;
let phantomJobId = 0n;

function ctx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// A deterministic generator, so a failing case names a fixture that comes back.
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

async function seedTenant(slug: string): Promise<Fx> {
  const t = await suDb.tenant.create({
    data: { name: slug, slug: `${slug}-${process.pid}` },
  });
  const inst = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    accountId: 60_000 + (convSeq++ % 10_000) + (process.pid % 1000) * 10,
    baseUrl: `https://${slug}.cw.example`,
    adminToken: "enc",
  });
  const agents: bigint[] = [];
  for (const name of ["Ana", "Beto"]) {
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
  }
  const inboxes: bigint[] = [];
  for (const [n, name] of [
    [1, "WhatsApp"],
    [2, "E-mail"],
  ] as const) {
    inboxes.push(
      (
        await suDb.inbox.create({
          data: {
            tenantId: t.id,
            chatwootInstanceId: inst.id,
            chatwootInboxId: n,
            name,
            agentId: agents[n - 1] as bigint,
          },
        })
      ).id,
    );
  }
  return { tenantId: t.id, instanceId: inst.id, agents, inboxes, convs: [] };
}

async function seedConv(f: Fx, inbox: bigint, at: Date): Promise<bigint> {
  const n = convSeq++;
  const c = await suDb.conversation.create({
    data: {
      tenantId: f.tenantId,
      chatwootInstanceId: f.instanceId,
      inboxId: inbox,
      chatwootConversationId: n,
      status: "open",
      threadId: `${f.tenantId}:${f.instanceId}:${n}`,
      lastEventAt: at,
      createdAt: at,
    },
  });
  f.convs.push({ id: c.id, inbox });
  return c.id;
}

interface Line {
  at: Date;
  conv: bigint | null;
  stage: string;
  status?: string;
  detail: Prisma.InputJsonObject;
  turnId?: string;
  agent?: bigint | null;
  inbox?: bigint | null;
  source?: string;
  anonymous?: boolean;
}

async function writeLine(f: Fx, l: Line): Promise<bigint> {
  const row = await suDb.executionLog.create({
    data: {
      tenantId: f.tenantId,
      turnId: l.turnId ?? crypto.randomUUID(),
      conversationId: l.conv,
      agentId: l.agent ?? null,
      inboxId: l.inbox ?? null,
      stage: l.stage,
      level: "info",
      status: l.status ?? "ok",
      source: l.source ?? "inbox",
      anonymous: l.anonymous ?? false,
      detail: l.detail,
      createdAt: l.at,
    },
    select: { id: true },
  });
  return row.id;
}

async function writeTurn(
  f: Fx,
  conv: bigint,
  at: Date,
  p: { node?: string | null; source?: string; turnId?: string } = {},
) {
  await suDb.llmUsage.create({
    data: {
      tenantId: f.tenantId,
      conversationId: conv,
      source: p.source ?? "inbox",
      model: "m1",
      node: p.node === undefined ? "agent" : p.node,
      turnId: p.turnId ?? crypto.randomUUID(),
      costUsd: 0.01,
      createdAt: at,
    },
  });
}

const pick = <T>(r: () => number, xs: readonly T[]): T =>
  xs[Math.floor(r() * xs.length)] as T;

// Every kind of line a figure reads, and the near misses it must not: refused calls, calls around a
// tool (`phase`), transfers that did not hand over, follow-up steps that reached nobody, lines with no
// conversation; spread over agents, inboxes (a line with none is its conversation's), sources and
// audiences; with agent turns between them, some of them the transfer's own turn.
async function seedRandom(f: Fx, seed: number, convCount: number) {
  const r = rng(seed);
  const span = END.getTime() - FIRST.getTime();
  for (let c = 0; c < convCount; c++) {
    const inbox = pick(r, f.inboxes);
    const convAt = new Date(FIRST.getTime() + Math.floor(r() * span * 0.5));
    const conv = await seedConv(f, inbox, convAt);
    const lastInbound = new Date(convAt.getTime() + Math.floor(r() * span));
    await suDb.conversation.update({
      where: { id: conv },
      data: {
        lastInboundAt: r() < 0.7 ? lastInbound : null,
        ...(r() < 0.3
          ? {
              status: "resolved",
              resolvedBy: pick(r, ["followup_abandonment", "agent"]),
            }
          : {}),
      },
    });
    const events = 4 + Math.floor(r() * 14);
    let lastTurn: string | null = null;
    for (let e = 0; e < events; e++) {
      const at = new Date(
        convAt.getTime() + Math.floor(r() * (END.getTime() - convAt.getTime())),
      );
      const shared = {
        at,
        conv: r() < 0.05 ? null : conv,
        agent: pick(r, [...f.agents, null]),
        inbox: r() < 0.35 ? null : pick(r, [inbox, inbox, ...f.inboxes]),
        source: pick(r, ["inbox", "inbox", "inbox", "client", "playground"]),
        anonymous: r() < 0.3,
      };
      const turnId: string = crypto.randomUUID();
      const roll = r();
      if (roll < 0.25) {
        const turn = r() < 0.5 && lastTurn ? lastTurn : turnId;
        await writeTurn(f, conv, at, {
          node: pick(r, ["agent", null, "vision", "observer", "decision"]),
          source: pick(r, ["inbox", "inbox", "playground"]),
          turnId: turn,
        });
      } else if (roll < 0.4) {
        lastTurn = turnId;
        const detail: Record<string, string | boolean> = {
          tool: "handoff_to_human",
        };
        if (r() < 0.2) detail.phase = "precondition";
        const h = r();
        if (h < 0.3) detail.handedOff = false;
        else if (h < 0.7) detail.handedOff = true;
        await writeLine(f, {
          ...shared,
          stage: "tool",
          status: r() < 0.85 ? "ok" : "error",
          detail,
          turnId,
        });
      } else if (roll < 0.7) {
        const detail: Record<string, string> = {
          outcome: pick(r, [
            "taken_over",
            "taken_over",
            "taken_over",
            "opened_after_skip",
            "guardrail_handoff",
            "resolved",
            "ownership_lost",
          ]),
        };
        if (r() < 0.6)
          detail.reason = pick(r, ["needs_human", "not_for_us", "unanswered"]);
        if (r() < 0.6)
          detail.assigned = pick(r, [
            "agent",
            "team",
            "routing",
            "failed",
            "withdrawn",
            "other",
          ]);
        lastTurn = turnId;
        await writeLine(f, { ...shared, stage: "handoff", detail, turnId });
      } else if (roll < 0.85) {
        const detail: Record<string, string> = { tool: "skip_reply" };
        if (r() < 0.7)
          detail.skipReason = pick(r, ["needs_human", "not_for_us", "done"]);
        if (r() < 0.15) detail.phase = "precondition";
        await writeLine(f, {
          ...shared,
          stage: "tool",
          status: r() < 0.9 ? "ok" : "error",
          detail,
        });
      } else if (roll < 0.95) {
        await writeLine(f, {
          ...shared,
          stage: "generate",
          detail: {
            trigger: pick(r, ["followup", "followup", "inbound"]),
            outcome: pick(r, ["messaged", "templated", "skipped", "failed"]),
          },
        });
      } else {
        await writeLine(f, {
          ...shared,
          stage: pick(r, ["tool", "embed", "tts"]),
          detail: { tool: pick(r, ["search", "label"]) },
        });
      }
    }
  }
}

// Reads the tenant's figures both ways: the log way by marking its backfill unfinished for the read.
async function bothWays(f: Fx, filter: DashboardFilter) {
  const facts = {
    handoffs: await getHandoffReasons(ctx(f.tenantId), filter, appDb),
    followUps: await getFollowUpActivity(ctx(f.tenantId), filter, appDb),
  };
  await suDb.$executeRaw`INSERT INTO dashboard_log_facts_state (tenant_id) VALUES (${f.tenantId})`;
  try {
    const log = {
      handoffs: await getHandoffReasons(ctx(f.tenantId), filter, appDb),
      followUps: await getFollowUpActivity(ctx(f.tenantId), filter, appDb),
    };
    return { facts, log };
  } finally {
    await suDb.$executeRaw`DELETE FROM dashboard_log_facts_state WHERE tenant_id = ${f.tenantId}`;
  }
}

function filters(f: Fx): DashboardFilter[] {
  const out: DashboardFilter[] = [];
  const windows: [Date | undefined, Date | undefined][] = [
    [START, END],
    [new Date(START.getTime() + DAY), new Date(START.getTime() + 2 * DAY)],
    [undefined, undefined],
  ];
  for (const [since, until] of windows) {
    for (const tz of ["UTC", "America/Sao_Paulo"]) {
      out.push({ since, until, tz });
    }
    out.push({ since, until, tz: "UTC", agentId: f.agents[0] });
    out.push({ since, until, tz: "UTC", inboxId: f.inboxes[1] });
    out.push({ since, until, tz: "UTC", source: "client" });
    out.push({
      since,
      until,
      tz: "UTC",
      source: "client",
      audience: "anonymous",
    });
    out.push({
      since,
      until,
      tz: "UTC",
      agentId: f.agents[1],
      inboxId: f.inboxes[0],
      source: "inbox",
    });
  }
  return out;
}

async function personCount(f: Fx, filter: DashboardFilter) {
  const h = await getHandoffReasons(ctx(f.tenantId), filter, appDb);
  return {
    person: h.totals.find((t) => t.cause === "person")?.conversations ?? 0,
    agent: h.totals.find((t) => t.cause === "agent")?.conversations ?? 0,
  };
}

const ALL: DashboardFilter = { tz: "UTC" };

describe.skipIf(!dbUp)("the dashboard's log facts", () => {
  beforeAll(async () => {
    phantomJobId = await burnSchedulerJobId(suDb);
    fx = await seedTenant("facts");
    other = await seedTenant("facts-other");
    await seedRandom(fx, 1731, 40);
    await seedRandom(other, 4242, 10);
  }, 60_000);

  afterAll(async () => {
    for (const f of [fx, other]) {
      if (!f) continue;
      await clearFlowLog(suDb, { tenantId: f.tenantId });
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${f.tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the facts and the log give the same figures, under every filter", async () => {
    const facts = await suDb.dashboardLogFact.count({
      where: { tenantId: fx.tenantId },
    });
    // The fixture has to reach every kind, or the equality says little.
    const kinds = await suDb.dashboardLogFact.groupBy({
      by: ["kind"],
      where: { tenantId: fx.tenantId },
      _count: true,
    });
    expect(kinds.map((k) => k.kind).sort()).toEqual([
      "followup",
      "handoff",
      "silence",
    ]);
    expect(facts).toBeGreaterThan(50);
    let persons = 0;
    for (const filter of filters(fx)) {
      const { facts: a, log: b } = await bothWays(fx, filter);
      expect(a).toEqual(b);
      persons += a.handoffs.totals.find((t) => t.cause === "person")
        ?.conversations
        ? 1
        : 0;
    }
    // ... and a person, the one cause decided at read, has to be among them.
    expect(persons).toBeGreaterThan(0);
  });

  test("a line counts the moment it is written, and stops counting when it is deleted", async () => {
    const conv = await seedConv(fx, fx.inboxes[0] as bigint, START);
    const at = new Date(START.getTime() + 3 * 60 * 60 * 1000);
    const before = await getHandoffReasons(ctx(fx.tenantId), ALL, appDb);
    const id = await writeLine(fx, {
      at,
      conv,
      stage: "handoff",
      detail: { outcome: "guardrail_handoff", assigned: "routing" },
    });
    const after = await getHandoffReasons(ctx(fx.tenantId), ALL, appDb);
    const guard = (h: typeof before) =>
      h.totals.find((t) => t.cause === "guardrail")?.conversations ?? 0;
    expect(guard(after)).toBe(guard(before) + 1);
    await clearFlowLog(suDb, { id });
    expect(await suDb.dashboardLogFact.count({ where: { lineId: id } })).toBe(
      0,
    );
    const gone = await getHandoffReasons(ctx(fx.tenantId), ALL, appDb);
    expect(gone).toEqual(before);
  });

  test("a line that is no figure leaves no fact", async () => {
    const conv = await seedConv(fx, fx.inboxes[0] as bigint, START);
    const ids = [
      await writeLine(fx, {
        at: START,
        conv,
        stage: "handoff",
        detail: { outcome: "resolved" },
      }),
      await writeLine(fx, {
        at: START,
        conv,
        stage: "tool",
        status: "error",
        detail: { tool: "skip_reply" },
      }),
      await writeLine(fx, {
        at: START,
        conv,
        stage: "tool",
        detail: { tool: "handoff_to_human", handedOff: false },
      }),
      await writeLine(fx, {
        at: START,
        conv: null,
        stage: "handoff",
        detail: { outcome: "taken_over" },
      }),
      await writeLine(fx, {
        at: START,
        conv,
        stage: "generate",
        detail: { trigger: "followup", outcome: "failed" },
      }),
    ];
    expect(
      await suDb.dashboardLogFact.count({ where: { lineId: { in: ids } } }),
    ).toBe(0);
    await clearFlowLog(suDb, { id: { in: ids } });
  });

  test("a person taking over follows the conversation's other transfers, whenever they are written or removed", async () => {
    const conv = await seedConv(fx, fx.inboxes[0] as bigint, START);
    const t = (h: number) => new Date(START.getTime() + h * 60 * 60 * 1000);
    const window: DashboardFilter = { since: t(0), until: t(10), tz: "UTC" };
    await writeTurn(fx, conv, t(1));
    await writeLine(fx, {
      at: t(3),
      conv,
      stage: "handoff",
      detail: { outcome: "taken_over" },
    });
    const base = await personCount(fx, window);
    // An earlier transfer written later, between the turn and the takeover: the takeover is now a
    // sighting of the person that transfer brought.
    const late = await writeLine(fx, {
      at: t(2),
      conv,
      stage: "handoff",
      detail: { outcome: "opened_after_skip", reason: "needs_human" },
    });
    expect((await personCount(fx, window)).person).toBe(base.person - 1);
    const { facts, log } = await bothWays(fx, window);
    expect(facts).toEqual(log);
    // Removed again (deleted, or swept by retention): the takeover is a person again.
    await clearFlowLog(suDb, { id: late });
    expect((await personCount(fx, window)).person).toBe(base.person);
  });

  test("a transfer committed after the takeover it precedes still decides it", async () => {
    const conv = await seedConv(fx, fx.inboxes[1] as bigint, START);
    const t = (h: number) => new Date(START.getTime() + h * 60 * 60 * 1000);
    const window: DashboardFilter = { since: t(0), until: t(10), tz: "UTC" };
    const base = await personCount(fx, window);
    const a = new Client({ connectionString: suUrl });
    const b = new Client({ connectionString: suUrl });
    await a.connect();
    await b.connect();
    try {
      await a.query("BEGIN");
      await a.query(
        `INSERT INTO execution_logs (tenant_id, turn_id, conversation_id, stage, level, status, source, detail, created_at)
         VALUES ($1, $2, $3, 'tool', 'info', 'ok', 'inbox', '{"tool":"handoff_to_human","handedOff":true}', $4)`,
        [fx.tenantId, crypto.randomUUID(), conv, t(4)],
      );
      await b.query(
        `INSERT INTO execution_logs (tenant_id, turn_id, conversation_id, stage, level, status, source, detail, created_at)
         VALUES ($1, $2, $3, 'handoff', 'info', 'ok', 'inbox', '{"outcome":"taken_over"}', $4)`,
        [fx.tenantId, crypto.randomUUID(), conv, t(5)],
      );
      await a.query("COMMIT");
    } finally {
      await a.end();
      await b.end();
    }
    const now = await personCount(fx, window);
    expect(now.agent).toBe(base.agent + 1);
    expect(now.person).toBe(base.person);
    expect(await personCount(fx, window)).toEqual(now);
  });

  test("a rewritten line is the fact it now is", async () => {
    const conv = await seedConv(fx, fx.inboxes[0] as bigint, START);
    const id = await writeLine(fx, {
      at: START,
      conv,
      stage: "tool",
      detail: { tool: "skip_reply", skipReason: "done" },
    });
    await suDb.executionLog.update({
      where: { id },
      data: { detail: { tool: "skip_reply", skipReason: "not_for_us" } },
    });
    const fact = await suDb.dashboardLogFact.findUnique({
      where: { lineId: id },
    });
    expect(fact?.reason).toBe("not_for_us");
    await suDb.executionLog.update({
      where: { id },
      data: { status: "error" },
    });
    expect(await suDb.dashboardLogFact.count({ where: { lineId: id } })).toBe(
      0,
    );
    await clearFlowLog(suDb, { id });
  });

  test("retention takes a line's fact with it, in its batches", async () => {
    const conv = await seedConv(fx, fx.inboxes[0] as bigint, START);
    const old = new Date(Date.now() - (config.flowlog.retentionDays + 3) * DAY);
    // One line of each stage a fact comes from.
    const ids: bigint[] = [
      await writeLine(fx, {
        at: old,
        conv,
        stage: "tool",
        detail: { tool: "skip_reply", skipReason: "done" },
      }),
      await writeLine(fx, {
        at: old,
        conv,
        stage: "handoff",
        detail: { outcome: "guardrail_handoff" },
      }),
      await writeLine(fx, {
        at: old,
        conv,
        stage: "generate",
        detail: { trigger: "followup", outcome: "messaged" },
      }),
    ];
    expect(
      await suDb.dashboardLogFact.count({ where: { lineId: { in: ids } } }),
    ).toBe(3);
    const before = await suDb.dashboardLogFact.count({
      where: { tenantId: fx.tenantId },
    });
    // The handler itself, not the registry's entry, which another file of the same run may stub.
    const job: ClaimedJob = {
      id: phantomJobId,
      tenantId: fx.tenantId,
      kind: "FLOWLOG_SWEEP",
      payload: {},
      attempts: 0,
      claimSeq: 0,
    };
    await flowlogSweepHandler(job, appDb);
    expect(
      await suDb.dashboardLogFact.count({ where: { lineId: { in: ids } } }),
    ).toBe(0);
    // Only the swept lines' facts went.
    expect(
      await suDb.dashboardLogFact.count({ where: { tenantId: fx.tenantId } }),
    ).toBe(before - 3);
  });

  test("the backfill fills a tenant's earlier lines in batches, and the readers switch when it ends", async () => {
    // A tenant as the migration finds it: lines and no facts, waiting for its backfill.
    const t = await seedTenant("facts-backfill");
    try {
      await seedRandom(t, 99, 12);
      const expected = await suDb.$queryRaw<
        { line_id: bigint; kind: string; cause: string | null }[]
      >`SELECT line_id, kind, cause FROM dashboard_log_facts WHERE tenant_id = ${t.tenantId} ORDER BY line_id`;
      expect(expected.length).toBeGreaterThan(10);
      const live = {
        handoffs: await getHandoffReasons(ctx(t.tenantId), ALL, appDb),
        followUps: await getFollowUpActivity(ctx(t.tenantId), ALL, appDb),
      };
      await suDb.$executeRaw`DELETE FROM dashboard_log_facts WHERE tenant_id = ${t.tenantId}`;
      await suDb.$executeRaw`INSERT INTO dashboard_log_facts_state (tenant_id) VALUES (${t.tenantId})`;
      // Still the log's figures while it runs.
      expect(await getHandoffReasons(ctx(t.tenantId), ALL, appDb)).toEqual(
        live.handoffs,
      );

      registerLogFactsBackfillHandler();
      expect(getJobHandler("DASHBOARD_LOG_FACTS_BACKFILL")).toBeDefined();
      // The handler itself, not the registry's entry, which another file of the same run may stub.
      const handler = logFactsBackfillHandler;
      await ensureLogFactsBackfill(t.tenantId, suDb);
      const armed = await suDb.schedulerJob.count({
        where: {
          tenantId: t.tenantId,
          kind: "DASHBOARD_LOG_FACTS_BACKFILL",
        },
      });
      expect(armed).toBe(1);
      const job: ClaimedJob = {
        id: phantomJobId,
        tenantId: t.tenantId,
        kind: "DASHBOARD_LOG_FACTS_BACKFILL",
        payload: {},
        attempts: 0,
        claimSeq: 0,
      };
      let result = await handler(job, appDb);
      for (let i = 0; i < 20 && result?.outcome === "reschedule"; i++) {
        result = await handler(job, appDb);
      }
      expect(result).toEqual({ outcome: "done" });
      const state = await suDb.dashboardLogFactsState.findUnique({
        where: { tenantId: t.tenantId },
      });
      expect(state?.backfilledAt).not.toBeNull();
      const filled = await suDb.$queryRaw<
        { line_id: bigint; kind: string; cause: string | null }[]
      >`SELECT line_id, kind, cause FROM dashboard_log_facts WHERE tenant_id = ${t.tenantId} ORDER BY line_id`;
      expect(filled).toEqual(expected);
      // Written by more than one transaction: one per hour of lines.
      const [tx] = await suDb.$queryRaw<{ n: bigint }[]>`
        SELECT COUNT(DISTINCT xmin::text) AS n FROM dashboard_log_facts WHERE tenant_id = ${t.tenantId}`;
      expect(Number(tx?.n)).toBeGreaterThan(1);
      // The facts' figures are the log's, and the readers now read the facts.
      expect(await getHandoffReasons(ctx(t.tenantId), ALL, appDb)).toEqual(
        live.handoffs,
      );
      expect(await getFollowUpActivity(ctx(t.tenantId), ALL, appDb)).toEqual(
        live.followUps,
      );
      // ... read from the facts: without them, nothing is left to count.
      await suDb.$executeRaw`UPDATE dashboard_log_facts SET kind = 'gone' WHERE tenant_id = ${t.tenantId}`;
      const empty = await getHandoffReasons(ctx(t.tenantId), ALL, appDb);
      expect(empty.totals).toEqual([]);
      await suDb.$executeRaw`UPDATE dashboard_log_facts f SET kind = e.kind FROM (SELECT unnest(${filled.map((x) => x.line_id)}::bigint[]) AS id, unnest(${filled.map((x) => x.kind)}::text[]) AS kind) e WHERE f.line_id = e.id`;
      // Once done, a run again changes nothing.
      expect(await backfillLogFactsSlice(appDb, t.tenantId)).toBe(true);
      const again = await suDb.dashboardLogFact.count({
        where: { tenantId: t.tenantId },
      });
      expect(again).toBe(expected.length);
    } finally {
      await clearFlowLog(suDb, { tenantId: t.tenantId });
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${t.tenantId}`,
      );
    }
  }, 60_000);

  test("a backfill run over and over, or two at once, writes each fact once", async () => {
    const t = await seedTenant("facts-twice");
    try {
      await seedRandom(t, 7, 6);
      const rows = () =>
        suDb.dashboardLogFact.findMany({
          where: { tenantId: t.tenantId },
          orderBy: { lineId: "asc" },
        });
      const expected = await rows();
      await suDb.$executeRaw`DELETE FROM dashboard_log_facts WHERE tenant_id = ${t.tenantId}`;
      await suDb.$executeRaw`INSERT INTO dashboard_log_facts_state (tenant_id) VALUES (${t.tenantId})`;
      for (let i = 0; i < 200; i++) {
        const [a, b] = await Promise.all([
          backfillLogFactsSlice(appDb, t.tenantId),
          backfillLogFactsSlice(appDb, t.tenantId),
        ]);
        if (a && b) break;
      }
      expect(await rows()).toEqual(expected);
      // A whole second pass over lines whose facts are all in: every put meets its fact, and leaves it.
      await suDb.$executeRaw`UPDATE dashboard_log_facts_state SET cursor_at = NULL, backfilled_at = NULL WHERE tenant_id = ${t.tenantId}`;
      while (!(await backfillLogFactsSlice(appDb, t.tenantId))) {}
      expect(await rows()).toEqual(expected);
    } finally {
      await clearFlowLog(suDb, { tenantId: t.tenantId });
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${t.tenantId}`,
      );
    }
  }, 60_000);

  test("a tenant sees only its own facts", async () => {
    const mine = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(other.tenantId)}, true)`;
      return tx.dashboardLogFact.findMany({ select: { tenantId: true } });
    });
    expect(mine.length).toBeGreaterThan(0);
    expect(new Set(mine.map((m) => String(m.tenantId)))).toEqual(
      new Set([String(other.tenantId)]),
    );
    const { facts, log } = await bothWays(other, ALL);
    expect(facts).toEqual(log);
  });
});
