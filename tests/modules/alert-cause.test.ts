import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { alertLinks } from "@/modules/flowlog/alert-send";
import { causeKeyOf } from "@/modules/flowlog/alerts";
import {
  type FlowContext,
  type FlowEvent,
  withFlowStage,
  writeFlowEvent,
} from "@/modules/flowlog/service";
import { TtsError } from "@/modules/tts/providers";
import { flowLogRows } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";

// ONE CAUSE, ONE ALERT. A provider refusing the account fails every call the same way until someone
// fixes it, so its alert is delivered once per channel per window and the repeats are counted on it;
// and it reaches an error-only channel, because a dead key is the one thing that channel needs to hear.
// Everything else keeps the (channel, stage, level) coalescing it had.

describe("causeKeyOf", () => {
  const ev = (over: Partial<FlowEvent>): FlowEvent => ({
    stage: "tts",
    status: "error",
    provider: "elevenlabs",
    ...over,
  });

  test("an account failure on a provider stage is keyed by stage, provider and failure", () => {
    for (const failure of ["HTTP 401", "HTTP 403", "HTTP 429"]) {
      expect(causeKeyOf(ev({ detail: { failure } }))).toBe(
        `tts:elevenlabs:${failure}`,
      );
    }
  });

  test("a transient or unknown failure is not a cause", () => {
    for (const failure of [
      "HTTP 503",
      "timeout",
      "provider error",
      "HTTP 400",
    ]) {
      expect(causeKeyOf(ev({ detail: { failure } }))).toBeNull();
    }
    expect(causeKeyOf(ev({ detail: {} }))).toBeNull();
    // A line that did not fail is not a cause, whatever its detail says.
    expect(
      causeKeyOf(ev({ status: "ok", detail: { failure: "HTTP 401" } })),
    ).toBeNull();
  });

  test("the spend ceiling is a cause only when it refuses turns", () => {
    expect(
      causeKeyOf({ stage: "spend_ceiling", detail: { state: "over" } }),
    ).toBe("spend_ceiling:over");
    expect(
      causeKeyOf({ stage: "spend_ceiling", detail: { state: "warning" } }),
    ).toBeNull();
  });

  test("a channel error is keyed by its code, and a dead letter by unit and kind", () => {
    expect(
      causeKeyOf({ stage: "channel_error", detail: { code: "131053" } }),
    ).toBe("channel_error:131053");
    expect(causeKeyOf({ stage: "channel_error", detail: { code: null } })).toBe(
      "channel_error:unknown",
    );
    expect(
      causeKeyOf({
        stage: "dead_letter",
        detail: { unit: "job", kind: "FOLLOWUP" },
      }),
    ).toBe("dead_letter:job:FOLLOWUP");
    expect(
      causeKeyOf({
        stage: "dead_letter",
        detail: { unit: "inbound_delivery" },
      }),
    ).toBe("dead_letter:inbound_delivery");
  });

  test("text a server wrote never becomes part of a key", () => {
    expect(
      causeKeyOf(
        ev({ provider: "a b@c.com", detail: { failure: "HTTP 401" } }),
      ),
    ).toBe("tts:-:HTTP 401");
    expect(
      causeKeyOf({
        stage: "channel_error",
        detail: { code: "the customer's message" },
      }),
    ).toBe("channel_error:unknown");
  });

  // A cause gathers lines of every level (a retried run is `info`), so its burst link does not narrow
  // the list by the row's level.
  test("a cause burst links to its stage without a level", () => {
    const base = {
      type: "discord",
      stage: "tts",
      level: "warn",
      summary: "x",
      count: 3,
      tenantId: 1n,
      turnId: "t",
      conversationId: null,
    };
    const [cause] = alertLinks({
      ...base,
      causeKey: "tts:elevenlabs:HTTP 401",
    });
    expect(cause?.url).toContain("stage=tts");
    expect(cause?.url).not.toContain("level=");
    const [plain] = alertLinks({ ...base, causeKey: null });
    expect(plain?.url).toContain("level=warn");
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

// A tenant per test, so one test's channels never see another's lines.
async function freshTenant(): Promise<bigint> {
  const t = await suDb.tenant.create({
    data: {
      name: "Cause1091",
      slug: `cause-1091-${process.pid}-${seq++}`,
    },
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
      url: encryptJson(outboundUrl(`/api/webhooks/cause-${seq}`)),
      minLevel: over.minLevel ?? "error",
      stages: over.stages ?? [],
      excludeAgentIds: over.excludeAgentIds ?? [],
    },
  });
  return ch.id;
}

function flow(tenantId: bigint, over: Partial<FlowContext> = {}): FlowContext {
  return {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    base: appDb,
    ...over,
  };
}

const tts401 = (failure = "HTTP 401"): FlowEvent => ({
  stage: "tts",
  level: "warn",
  status: "error",
  provider: "elevenlabs",
  detail: { failure },
  errorMessage: "TTS elevenlabs failed with 401 (quota_exceeded)",
});

async function deliveries(channelId: bigint) {
  return suDb.alertDelivery.findMany({
    where: { channelId },
    orderBy: { id: "asc" },
    select: { id: true, count: true, causeKey: true, level: true },
  });
}

// What the worker does to a row once it is sent; the cause dedupe must hold past it.
async function markDelivered(channelId: bigint) {
  await suDb.alertDelivery.updateMany({
    where: { channelId },
    data: { status: "DELIVERED", deliveredAt: new Date() },
  });
}

describe.skipIf(!dbUp)("cause alerts through the ledger", () => {
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
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a failed stage records its failure class, never the server's text", async () => {
    const tenantId = await freshTenant();
    const ctx = flow(tenantId);
    await expect(
      withFlowStage(ctx, "tts", { provider: "elevenlabs" }, async () => {
        throw new TtsError("elevenlabs", 401, "quota_exceeded");
      }),
    ).rejects.toThrow();
    const rows = await flowLogRows(suDb, {
      where: { tenantId, turnId: ctx.turnId },
      select: { detail: true },
    });
    expect(rows).toHaveLength(1);
    expect(
      (rows[0]?.detail as Record<string, unknown> | undefined)?.failure,
    ).toBe("HTTP 401");
  });

  test("six failures of one cause, spread past the coalesce window, are one delivery of six", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    for (let i = 0; i < 6; i++) {
      await writeFlowEvent(flow(tenantId), tts401());
      // The worker sent the first one before the next failure came.
      await markDelivered(ch);
    }
    const rows = await deliveries(ch);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(6);
    expect(rows[0]?.causeKey).toBe("tts:elevenlabs:HTTP 401");
  });

  test("the same cause after the window opens a second delivery", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId);
    await writeFlowEvent(flow(tenantId), tts401());
    await markDelivered(ch);
    await suDb.alertDelivery.updateMany({
      where: { channelId: ch },
      data: { createdAt: new Date(Date.now() - (3 * 60 + 1) * 60_000) },
    });
    await writeFlowEvent(flow(tenantId), tts401());
    const rows = await deliveries(ch);
    expect(rows.map((r) => r.count)).toEqual([1, 1]);
  });

  test("a cause reaches an error-only channel; a transient failure does not", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId, { minLevel: "error" });
    await writeFlowEvent(flow(tenantId), tts401("HTTP 503"));
    expect(await deliveries(ch)).toEqual([]);
    await writeFlowEvent(flow(tenantId), tts401());
    const rows = await deliveries(ch);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.causeKey).toBe("tts:elevenlabs:HTTP 401");
  });

  test("two causes are two deliveries, and the failure class is part of the cause", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId, { minLevel: "warn" });
    await writeFlowEvent(flow(tenantId), tts401());
    await writeFlowEvent(flow(tenantId), {
      ...tts401(),
      stage: "vision",
      provider: "gemini",
    });
    await writeFlowEvent(flow(tenantId), tts401("HTTP 429"));
    await writeFlowEvent(flow(tenantId), tts401("HTTP 429"));
    const rows = await deliveries(ch);
    expect(rows.map((r) => [r.causeKey, r.count])).toEqual([
      ["tts:elevenlabs:HTTP 401", 1],
      ["vision:gemini:HTTP 401", 1],
      ["tts:elevenlabs:HTTP 429", 2],
    ]);
  });

  test("the stage allowlist and the excluded agents still filter a cause", async () => {
    const tenantId = await freshTenant();
    const agent = await suDb.agent.create({
      data: { tenantId, name: "A", systemPrompt: "x" },
    });
    const visionOnly = await channel(tenantId, { stages: ["vision"] });
    const excludes = await channel(tenantId, { excludeAgentIds: [agent.id] });
    const control = await channel(tenantId);
    await writeFlowEvent(flow(tenantId, { agentId: agent.id }), tts401());
    expect(await deliveries(visionOnly)).toEqual([]);
    expect(await deliveries(excludes)).toEqual([]);
    expect(await deliveries(control)).toHaveLength(1);
    await suDb.agent.deleteMany({ where: { tenantId } });
  });

  test("a line that is not a cause keeps the 30-second coalescing, and never joins a cause row", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId, { minLevel: "warn" });
    await writeFlowEvent(flow(tenantId), tts401());
    await writeFlowEvent(flow(tenantId), tts401("HTTP 503"));
    await writeFlowEvent(flow(tenantId), tts401("HTTP 503"));
    let rows = await deliveries(ch);
    expect(rows.map((r) => [r.causeKey, r.count])).toEqual([
      ["tts:elevenlabs:HTTP 401", 1],
      [null, 2],
    ]);
    await markDelivered(ch);
    await writeFlowEvent(flow(tenantId), tts401("HTTP 503"));
    rows = await deliveries(ch);
    expect(rows.map((r) => [r.causeKey, r.count])).toEqual([
      ["tts:elevenlabs:HTTP 401", 1],
      [null, 2],
      [null, 1],
    ]);
  });

  test("a retried run against a dead key is an info line, and still a cause alert at warn", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId, { minLevel: "error" });
    await writeFlowEvent(flow(tenantId), {
      stage: "generate",
      level: "info",
      status: "error",
      provider: "openai",
      detail: { failure: "HTTP 401", willRetry: true },
      errorMessage: "HTTP 401",
    });
    const rows = await deliveries(ch);
    expect(rows.map((r) => [r.causeKey, r.level])).toEqual([
      ["generate:openai:HTTP 401", "warn"],
    ]);
  });

  test("the spend ceiling, channel errors and dead letters dedupe by their own cause", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId, { minLevel: "error" });
    for (let i = 0; i < 3; i++) {
      await writeFlowEvent(flow(tenantId), {
        stage: "spend_ceiling",
        level: "error",
        status: "skipped",
        detail: { state: "over" },
      });
      await markDelivered(ch);
    }
    // The warning before the ceiling is not a cause, and stays under an error-only channel.
    await writeFlowEvent(flow(tenantId), {
      stage: "spend_ceiling",
      level: "warn",
      status: "ok",
      detail: { state: "warning" },
    });
    for (const code of ["131053", "131053", "131047"]) {
      await writeFlowEvent(flow(tenantId), {
        stage: "channel_error",
        level: "warn",
        status: "error",
        detail: { code, class: "media", action: "none" },
      });
    }
    for (const kind of ["FOLLOWUP", "FOLLOWUP", "HEARTBEAT"]) {
      await writeFlowEvent(flow(tenantId), {
        stage: "dead_letter",
        level: "error",
        status: "error",
        detail: { unit: "job", kind },
        errorMessage: "gave up",
      });
    }
    const rows = await deliveries(ch);
    expect(rows.map((r) => [r.causeKey, r.count])).toEqual([
      ["spend_ceiling:over", 3],
      ["channel_error:131053", 2],
      ["channel_error:131047", 1],
      ["dead_letter:job:FOLLOWUP", 2],
      ["dead_letter:job:HEARTBEAT", 1],
    ]);
  });

  test("concurrent failures of one cause are still one delivery", async () => {
    for (let round = 0; round < 5; round++) {
      const tenantId = await freshTenant();
      const ch = await channel(tenantId);
      await Promise.all(
        Array.from({ length: 4 }, () =>
          writeFlowEvent(flow(tenantId), tts401()),
        ),
      );
      const rows = await deliveries(ch);
      expect(rows.map((r) => r.count)).toEqual([4]);
    }
  });

  test("a cause in the playground pages nobody", async () => {
    const tenantId = await freshTenant();
    const ch = await channel(tenantId, { minLevel: "warn" });
    await writeFlowEvent(flow(tenantId, { source: "playground" }), tts401());
    expect(await deliveries(ch)).toEqual([]);
  });
});
