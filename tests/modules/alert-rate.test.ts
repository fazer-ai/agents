import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { alertLinks } from "@/modules/flowlog/alert-send";
import { dispatchRateAlert, rateSubjectOf } from "@/modules/flowlog/alerts";
import {
  type FlowContext,
  type FlowEvent,
  writeFlowEvent,
} from "@/modules/flowlog/service";
import { outboundUrl } from "../utils/outbound";

// A PROVIDER DEGRADED, NOT A FAILURE. A retried attempt is `info` and pages nobody alone, which is
// right for one and wrong for twenty: a provider failing every few minutes slows every turn it
// touches. Counted from the flow log, one alert at the threshold per stage and provider per window.

describe("rateSubjectOf", () => {
  const ev = (over: Partial<FlowEvent>): FlowEvent => ({
    stage: "vision",
    level: "info",
    status: "error",
    provider: "openai",
    detail: { failure: "HTTP 503", willRetry: true },
    ...over,
  });

  test("a transient failure on a model stage counts, at any level", () => {
    for (const failure of ["timeout", "HTTP 503", "HTTP 502", "HTTP 429"]) {
      expect(rateSubjectOf(ev({ detail: { failure } }))).toEqual({
        stage: "vision",
        provider: "openai",
      });
    }
    expect(rateSubjectOf(ev({ level: "warn" }))).not.toBeNull();
  });

  test("a request failure, an unknown one, a tool and a success do not", () => {
    for (const failure of ["HTTP 400", "HTTP 401", "provider error"]) {
      expect(rateSubjectOf(ev({ detail: { failure } }))).toBeNull();
    }
    expect(rateSubjectOf(ev({ stage: "tool" }))).toBeNull();
    expect(rateSubjectOf(ev({ status: "ok" }))).toBeNull();
    expect(rateSubjectOf(ev({ detail: {} }))).toBeNull();
  });

  test("a rate alert links to the list even before a second failure is counted on it", () => {
    const [link] = alertLinks({
      type: "discord",
      stage: "vision",
      level: "warn",
      summary: "x",
      count: 1,
      tenantId: 1n,
      turnId: "t",
      conversationId: 9n,
      causeKey: "rate:vision:openai",
    });
    expect(link?.url).toContain("/logs?stage=vision");
    expect(link?.url).not.toContain("turnId=");
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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const tenants: bigint[] = [];
let seq = 0;

async function freshTenant(): Promise<bigint> {
  const t = await suDb.tenant.create({
    data: { name: "Rate1092", slug: `rate-1092-${process.pid}-${seq++}` },
  });
  tenants.push(t.id);
  return t.id;
}

async function channel(
  tenantId: bigint,
  over: {
    minLevel?: string;
    stages?: string[];
    excludeAgentIds?: bigint[];
  } = {},
): Promise<bigint> {
  const ch = await suDb.alertChannel.create({
    data: {
      tenantId,
      name: `ch-${seq++}`,
      type: "discord",
      url: encryptJson(outboundUrl(`/api/webhooks/rate-${seq}`)),
      minLevel: over.minLevel ?? "error",
      stages: over.stages ?? [],
      excludeAgentIds: over.excludeAgentIds ?? [],
    },
  });
  return ch.id;
}

const flow = (tenantId: bigint, over: Partial<FlowContext> = {}) => ({
  tenantId,
  turnId: crypto.randomUUID(),
  source: "inbox" as const,
  base: appDb,
  ...over,
});

const failure = (
  over: {
    provider?: string;
    failure?: string;
    stage?: FlowEvent["stage"];
  } = {},
): FlowEvent => ({
  stage: over.stage ?? "vision",
  level: "info",
  status: "error",
  provider: over.provider ?? "openai",
  detail: { failure: over.failure ?? "HTTP 503", willRetry: true },
  errorMessage: "vision openai failed with 503",
});

async function fail(tenantId: bigint, n: number, over = {}) {
  for (let i = 0; i < n; i++)
    await writeFlowEvent(flow(tenantId), failure(over));
}

// Lines already in the log, written minutes ago, as the count reads them.
async function pastFailures(
  tenantId: bigint,
  minutesAgo: number[],
  over: { provider?: string; failure?: string } = {},
) {
  for (const m of minutesAgo) {
    await suDb.executionLog.create({
      data: {
        tenantId,
        turnId: crypto.randomUUID(),
        stage: "vision",
        level: "info",
        status: "error",
        provider: over.provider ?? "openai",
        source: "inbox",
        detail: { failure: over.failure ?? "HTTP 503", willRetry: true },
        createdAt: new Date(Date.now() - m * 60_000),
      },
    });
  }
}

async function rateRows(channelId: bigint) {
  return suDb.alertDelivery.findMany({
    where: { channelId, causeKey: { startsWith: "rate:" } },
    orderBy: { id: "asc" },
    select: { causeKey: true, level: true, summary: true, count: true },
  });
}

describe.skipIf(!dbUp)("rate alerts", () => {
  afterAll(async () => {
    for (const id of tenants) {
      for (const tbl of [
        "alert_deliveries",
        "alert_channels",
        "execution_logs",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${id}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${id}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("five recovered failures in the window are one rate alert, even on an error-only channel", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId, { minLevel: "error" });
    await fail(tenantId, 5);
    const rows = await rateRows(ch);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.causeKey).toBe("rate:vision:openai");
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.summary).toBe(
      "[vision via openai] provider degraded: 5 transient failures in 15 min",
    );
    // Nothing else reached the error-only channel: the failures themselves are `info`.
    expect(await suDb.alertDelivery.count({ where: { channelId: ch } })).toBe(
      1,
    );
  });

  test("four are none", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await fail(tenantId, 4);
    expect(await rateRows(ch)).toEqual([]);
  });

  test("the count is the window's: failures older than it do not add up", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await pastFailures(tenantId, [61, 46, 31, 16]);
    await fail(tenantId, 1);
    expect(await rateRows(ch)).toEqual([]);

    const recent = await freshTenant();
    const ch2 = await channel(recent);
    await pastFailures(recent, [14, 14], { failure: "timeout" });
    await pastFailures(recent, [14, 14], { failure: "HTTP 502" });
    await fail(recent, 1);
    expect((await rateRows(ch2)).map((r) => r.summary)).toEqual([
      "[vision via openai] provider degraded: 5 transient failures in 15 min",
    ]);
  });

  test("each provider has its own rate, and a provider's failures do not add to another's", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await fail(tenantId, 5, { provider: "openai" });
    await fail(tenantId, 5, { provider: "gemini" });
    expect((await rateRows(ch)).map((r) => r.causeKey)).toEqual([
      "rate:vision:openai",
      "rate:vision:gemini",
    ]);

    const split = await freshTenant();
    const ch2 = await channel(split);
    await fail(split, 3, { provider: "openai" });
    await fail(split, 2, { provider: "gemini" });
    expect(await rateRows(ch2)).toEqual([]);
  });

  test("more failures in the same window are counted on the alert, not sent again", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await fail(tenantId, 7);
    const rows = await rateRows(ch);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
  });

  test("a provider still degraded after the window alerts again", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await fail(tenantId, 5);
    const sixteenAgo = new Date(Date.now() - 16 * 60_000);
    await suDb.alertDelivery.updateMany({
      where: { channelId: ch },
      data: { status: "DELIVERED", createdAt: sixteenAgo },
    });
    await suDb.executionLog.updateMany({
      where: { tenantId },
      data: { createdAt: sixteenAgo },
    });
    await fail(tenantId, 5);
    expect(await rateRows(ch)).toHaveLength(2);
  });

  test("request failures, unknown failures and a tool's 502 never make a rate", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId, { minLevel: "warn" });
    await fail(tenantId, 5, { failure: "HTTP 400" });
    await fail(tenantId, 5, { failure: "provider error" });
    await fail(tenantId, 5, { stage: "tool" });
    expect(await rateRows(ch)).toEqual([]);
  });

  // The playground's failures are an operator testing, not the provider serving customers.
  test("failures in the playground do not add to the rate", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    for (let i = 0; i < 5; i++) {
      await writeFlowEvent(flow(tenantId, { source: "playground" }), failure());
    }
    await fail(tenantId, 1);
    expect(await rateRows(ch)).toEqual([]);
  });

  test("tenants do not add up", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const chA = await channel(a);
    const chB = await channel(b);
    await fail(a, 3);
    await fail(b, 2);
    expect(await rateRows(chA)).toEqual([]);
    expect(await rateRows(chB)).toEqual([]);
  });

  test("the stage allowlist and the excluded agents still filter it", async () => {
    const tenantId = await freshTenant();
    const agent = await suDb.agent.create({
      data: { tenantId, name: "A", systemPrompt: "x" },
    });
    const ttsOnly = await channel(tenantId, { stages: ["tts"] });
    const excludes = await channel(tenantId, { excludeAgentIds: [agent.id] });
    const all = await channel(tenantId);
    for (let i = 0; i < 5; i++) {
      await writeFlowEvent(flow(tenantId, { agentId: agent.id }), failure());
    }
    expect(await rateRows(ttsOnly)).toEqual([]);
    expect(await rateRows(excludes)).toEqual([]);
    expect(await rateRows(all)).toHaveLength(1);
  });

  test("concurrent failures across the threshold are one alert per channel", async () => {
    const tenantId = await freshTenant();
    const one = await channel(tenantId);
    const two = await channel(tenantId, { minLevel: "warn" });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        writeFlowEvent(flow(tenantId), failure()),
      ),
    );
    expect(await rateRows(one)).toHaveLength(1);
    expect(await rateRows(two)).toHaveLength(1);
  });

  test("the threshold and the window are the deployment's", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    const opts = { threshold: 3, windowMs: 60_000 };
    // One outside a one-minute window, two inside: two count, and two is under three.
    await pastFailures(tenantId, [1.5, 0, 0]);
    await dispatchRateAlert(flow(tenantId), failure(), appDb, opts);
    expect(await rateRows(ch)).toEqual([]);
    await pastFailures(tenantId, [0]);
    await dispatchRateAlert(flow(tenantId), failure(), appDb, opts);
    expect((await rateRows(ch)).map((r) => r.summary)).toEqual([
      "[vision via openai] provider degraded: 3 transient failures in 1 min",
    ]);
  });
});
