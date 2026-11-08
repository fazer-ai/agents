import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
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
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE LEARNED PART SIZE. A part that did not fit the budget teaches the next cold load of the same
// tenant and family its size, so no attempt known not to fit spends a budget before being halved.

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

function ctx(t = tenantId): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

async function seedTenant(slug: string, days: number): Promise<bigint> {
  const t = await suDb.tenant.create({
    data: { name: slug, slug: `${slug}-${process.pid}` },
  });
  const inst = await seedChatwootInstance(suDb, {
    tenantId: t.id,
    accountId: 80_000 + (process.pid % 10_000) + 0,
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

async function open(
  f: DashboardFilter,
  blocks: Block[] = ["kpis", "costs", "handoffs"],
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const e of streamFigures(ctx(), f, blocks, undefined, appDb))
    events.push(e);
  return events;
}

async function settleAll(t = tenantId) {
  const settle = (db: ScopedDb) => settleDirty(db, `dashboard-settle|${t}`);
  while ((await runScopedOn(appDb, ctx(t), settle)) > 0);
}

async function reset() {
  await settleAll();
  await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
  resetPartSizes();
}

describe.skipIf(!dbUp)("the learned part size", () => {
  beforeAll(async () => {
    tenantId = await seedTenant("parts", 70);
  });

  beforeEach(reset);
  const hold = partSizeHold.ms;
  afterEach(() => {
    partSizeHold.ms = hold;
    resetPartSizes();
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.$executeRaw`DELETE FROM dashboard_days WHERE tenant_id = ${tenantId}`;
    await suDb.$executeRaw`DELETE FROM dashboard_dirty WHERE tenant_id = ${tenantId}`;
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
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
