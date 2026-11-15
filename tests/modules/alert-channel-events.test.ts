import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { modelTelemetry } from "@/graph/model-telemetry";
import type { TenantContext } from "@/lib/tenancy";
import {
  createAlertChannel,
  listAlertChannels,
  updateAlertChannel,
} from "@/modules/flowlog/channels";
import { emitDeadLetter } from "@/modules/flowlog/dead-letter";
import { ALERT_EVENTS } from "@/modules/flowlog/events";
import { emitFallbackAnswered } from "@/modules/flowlog/fallback-lines";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import type { FlowContext, FlowEvent } from "@/modules/flowlog/service";
import { writeFlowEvent } from "@/modules/flowlog/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { alertStageList } from "@/modules/mcp/read";
import {
  alertChannelCreate,
  alertChannelUpdate,
} from "@/modules/mcp/write-webhooks";
import { VisionError, type VisionProvider } from "@/modules/vision/providers";
import { VISION_TOTAL_BUDGET_MS } from "@/modules/vision/retry";
import { extractWithRetry } from "@/modules/vision/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";

// A channel leaves events out inside its stages and level: it can mute the tool limit and keep every
// other `generate` warning, or keep nothing but fallbacks and dead letters. The lines are driven
// through the emitters production calls (the model telemetry's tool-limit hook, the fallback line,
// the dead letter), and each assertion reads the delivery ledger, which is what the alert worker sends
// from. The flow log keeps every line whatever a channel leaves out.

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

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}
function principal(tenantId: bigint): VerifiedToken {
  return {
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
}

describe.skipIf(!dbUp)("alert channel left-out events", () => {
  let tenant = 0n;
  let seq = 0;

  beforeAll(async () => {
    tenant = (
      await suDb.tenant.create({
        data: { name: "Events", slug: `events-${process.pid}` },
      })
    ).id;
    await suDb.vaultEntry.create({
      data: {
        tenantId: tenant,
        name: "events-url",
        kind: "generic",
        secret: encryptJson(outboundUrl("/api/webhooks/9/eventsTOKEN")),
      },
    });
  });

  afterAll(async () => {
    if (tenant) {
      await clearFlowLog(suDb, { tenantId: tenant });
      for (const tbl of [
        "audit_logs",
        "alert_deliveries",
        "alert_channels",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tenant}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // Every test starts with no channel and no pending delivery, so a ledger count is this test's.
  async function reset() {
    await suDb.$executeRawUnsafe(
      `DELETE FROM alert_deliveries WHERE tenant_id = ${tenant}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM alert_channels WHERE tenant_id = ${tenant}`,
    );
  }

  async function channel(over: {
    excludeEvents?: string[];
    stages?: string[];
  }) {
    seq += 1;
    return await createAlertChannel(
      ctx(tenant),
      {
        name: `events-${seq}`,
        type: "discord",
        url: outboundUrl(`/api/webhooks/events/${seq}`),
        minLevel: "warn",
        ...over,
      },
      appDb,
    );
  }

  function flow(turnId: string): FlowContext {
    return { tenantId: tenant, turnId, source: "inbox", base: appDb };
  }

  async function ledger(channelId: string) {
    await settleFlowEvents();
    return await suDb.alertDelivery.findMany({
      where: { tenantId: tenant, channelId: BigInt(channelId) },
      orderBy: { id: "asc" },
      select: { stage: true, count: true, summary: true, causeKey: true },
    });
  }

  const toolLimit = (turnId: string) =>
    modelTelemetry(flow(turnId), "openai").onToolLimit?.({
      maxToolCalls: 10,
      toolCalls: 17,
    });
  const fallback = (turnId: string) =>
    emitFallbackAnswered(flow(turnId), "generate", "openai", {
      provider: "anthropic",
      model: "claude",
      reason: "HTTP 503",
      failure: "HTTP 503",
    });
  const deadLetter = () =>
    emitDeadLetter({
      tenantId: tenant,
      unit: "job",
      level: "error",
      error: "job exhausted its retries",
      detail: { kind: "FOLLOWUP" },
      base: appDb,
    });

  test("leaving the tool limit out keeps the rest of `generate`, and the line stays in the log", async () => {
    await reset();
    const muted = await channel({ excludeEvents: ["tool_limit"] });
    // The same destination without the filter, so "the tool limit alerts nowhere" is not what passes.
    const control = await channel({});
    expect(muted.excludeEvents).toEqual(["tool_limit"]);

    toolLimit("events-tool");
    expect(await ledger(muted.id)).toEqual([]);
    expect((await ledger(control.id)).map((d) => d.summary)).toEqual([
      "[generate] ok: toolLimitHit",
    ]);
    const logged = await flowLogRows(suDb, {
      orderBy: { id: "asc" },
      where: { tenantId: tenant, turnId: "events-tool" },
      select: { level: true, stage: true },
    });
    expect(logged.map((r) => ({ level: r.level, stage: r.stage }))).toEqual([
      { level: "warn", stage: "generate" },
    ]);

    fallback("events-fallback");
    expect((await ledger(muted.id)).map((d) => d.summary)).toEqual([
      "[generate via anthropic] ok: fallbackReason=HTTP 503",
    ]);
  });

  test("a left-out line neither counts on nor shapes a delivery another line opened on the channel", async () => {
    await reset();
    const muted = await channel({ excludeEvents: ["tool_limit"] });
    const control = await channel({});
    // NOTE: One line at a time: concurrent dispatches may each insert a row instead of bumping (the
    // coalescing's own rare race), and the order is what makes the fallback's body the first.
    fallback("events-burst-1");
    await settleFlowEvents();
    toolLimit("events-burst-2");
    await settleFlowEvents();
    toolLimit("events-burst-3");
    expect(await ledger(muted.id)).toEqual([
      expect.objectContaining({
        count: 1,
        summary: "[generate via anthropic] ok: fallbackReason=HTTP 503",
      }),
    ]);
    // Coalescing itself is untouched: the channel without a filter folds all three into one.
    expect((await ledger(control.id)).map((d) => d.count)).toEqual([3]);
  });

  test("a channel of fallbacks and dead letters: every other event left out, and a line of no event still arrives", async () => {
    await reset();
    const narrow = await channel({
      stages: ["generate", "dead_letter"],
      excludeEvents: ALERT_EVENTS.filter((e) => e !== "model_fallback"),
    });
    toolLimit("events-only-tool");
    await writeFlowEvent(flow("events-only-provider"), {
      stage: "generate",
      level: "error",
      status: "error",
      provider: "openai",
      detail: { failure: "HTTP 500" },
      errorMessage: "model exploded",
    });
    expect(await ledger(narrow.id)).toEqual([]);
    fallback("events-only-fallback");
    deadLetter();
    expect((await ledger(narrow.id)).map((d) => d.stage).sort()).toEqual([
      "dead_letter",
      "generate",
    ]);
    // An error nobody named is never left out by the list: only the stages decide it.
    await reset();
    const narrow2 = await channel({
      excludeEvents: [...ALERT_EVENTS],
    });
    await writeFlowEvent(flow("events-unnamed"), {
      stage: "generate",
      level: "error",
      status: "error",
      errorMessage: "graph crashed",
    });
    expect((await ledger(narrow2.id)).map((d) => d.summary)).toEqual([
      "[generate] graph crashed",
    ]);
  });

  test("cause and rate alerts follow the list by their own event", async () => {
    await reset();
    const noProvider = await channel({ excludeEvents: ["provider_failure"] });
    // A dead letter is no event: leaving provider failures out does not touch its cause alert.
    deadLetter();
    expect((await ledger(noProvider.id)).map((d) => d.causeKey)).toEqual([
      "dead_letter:job:FOLLOWUP",
    ]);
    await reset();
    const noProvider2 = await channel({ excludeEvents: ["provider_failure"] });
    const all2 = await channel({});
    const failure: FlowEvent = {
      stage: "vision",
      level: "info",
      status: "error",
      provider: "openai",
      detail: { failure: "HTTP 503", willRetry: true },
      errorMessage: "vision openai failed with 503",
    };
    for (let i = 0; i < 5; i++)
      await writeFlowEvent(flow(`events-rate-${i}`), failure);
    expect(await ledger(noProvider2.id)).toEqual([]);
    expect((await ledger(all2.id)).map((d) => d.causeKey)).toEqual([
      "rate:vision:openai",
    ]);
  });

  test("a vision read that gave up after a retry it announced is a provider failure", async () => {
    await reset();
    const noProvider = await channel({ excludeEvents: ["provider_failure"] });
    const all = await channel({});
    let clock = 0;
    const provider = {
      defaultModel: "m",
      extract: async () => {
        throw new VisionError("gemini", 503);
      },
    } as VisionProvider;
    // NOTE: The wait oversleeps the budget, so the retry the first line announced never runs and the
    // outcome is the line `extractWithRetry` writes after the loop.
    await expect(
      extractWithRetry({
        provider,
        providerName: "gemini",
        model: "m",
        req: {
          bytes: new ArrayBuffer(4),
          mimeType: "image/png",
          kind: "image",
          prompt: "Descreva.",
          model: "m",
          apiKey: "k",
          baseURL: null,
          fetchImpl: fetch,
        },
        flow: flow("events-vision-gave-up"),
        now: () => clock,
        sleep: async () => {
          clock += VISION_TOTAL_BUDGET_MS - 1_000;
        },
      }),
    ).rejects.toThrow("vision gemini failed with 503");
    expect(await ledger(noProvider.id)).toEqual([]);
    expect((await ledger(all.id)).map((d) => [d.stage, d.summary])).toEqual([
      [
        "vision",
        "[vision via gemini] vision gemini failed with 503 (image left unread)",
      ],
    ]);
  });

  test("an event outside the vocabulary is refused on create and on update, and nothing is stored", async () => {
    await reset();
    await expect(
      createAlertChannel(
        ctx(tenant),
        {
          name: "bad-events",
          type: "discord",
          url: outboundUrl("/api/webhooks/events/bad"),
          excludeEvents: ["toolLimitHit"],
        },
        appDb,
      ),
    ).rejects.toThrow("unknown alert event: toolLimitHit");
    expect(
      await suDb.alertChannel.count({
        where: { tenantId: tenant, name: { startsWith: "bad-" } },
      }),
    ).toBe(0);
    const ch = await channel({});
    await expect(
      updateAlertChannel(
        ctx(tenant),
        BigInt(ch.id),
        { excludeEvents: ["generate"] },
        appDb,
      ),
    ).rejects.toThrow("unknown alert event: generate");
    const deduped = await updateAlertChannel(
      ctx(tenant),
      BigInt(ch.id),
      { excludeEvents: ["tool_limit", "tool_limit"] },
      appDb,
    );
    expect(deduped.excludeEvents).toEqual(["tool_limit"]);
  });

  test("editing another field keeps the list, and the audit row records a change to it", async () => {
    await reset();
    const ch = await channel({ excludeEvents: ["tool_limit"] });
    const renamed = await updateAlertChannel(
      ctx(tenant),
      BigInt(ch.id),
      { name: "renamed" },
      appDb,
    );
    expect(renamed.excludeEvents).toEqual(["tool_limit"]);
    const toggled = await updateAlertChannel(
      ctx(tenant),
      BigInt(ch.id),
      { enabled: false },
      appDb,
    );
    expect(toggled.excludeEvents).toEqual(["tool_limit"]);
    await updateAlertChannel(
      ctx(tenant),
      BigInt(ch.id),
      { excludeEvents: ["tool_limit", "no_reply"] },
      appDb,
    );
    const audit = await suDb.auditLog.findFirst({
      where: {
        tenantId: tenant,
        action: "alert_channel.update",
        target: `alert_channel:${ch.id}`,
      },
      orderBy: { id: "desc" },
      select: { before: true, after: true },
    });
    expect(audit?.before).toMatchObject({ excludeEvents: ["tool_limit"] });
    expect(audit?.after).toMatchObject({
      excludeEvents: ["tool_limit", "no_reply"],
    });
  });

  test("a stored event the vocabulary has since dropped does not break the next save, and cannot be added anew", async () => {
    await reset();
    const ch = await channel({ excludeEvents: ["tool_limit"] });
    await suDb.alertChannel.update({
      where: { id: BigInt(ch.id) },
      data: { excludeEvents: ["tool_limit", "retired_event"] },
    });
    const saved = await updateAlertChannel(
      ctx(tenant),
      BigInt(ch.id),
      { name: "kept", excludeEvents: ["tool_limit", "retired_event"] },
      appDb,
    );
    expect(saved.excludeEvents).toEqual(["tool_limit", "retired_event"]);
    const listed = (await listAlertChannels(ctx(tenant), appDb)).find(
      (c) => c.id === ch.id,
    );
    expect(listed?.excludeEvents).toEqual(["tool_limit", "retired_event"]);
    const other = await channel({});
    await expect(
      updateAlertChannel(
        ctx(tenant),
        BigInt(other.id),
        { excludeEvents: ["retired_event"] },
        appDb,
      ),
    ).rejects.toThrow("unknown alert event: retired_event");
  });

  test("MCP: the vocabulary is listed, the dry run refuses what the apply refuses, and the apply stores the list", async () => {
    await reset();
    const p = principal(tenant);
    const vocab = await alertStageList(p);
    expect(vocab.ok).toBe(true);
    if (vocab.ok) {
      expect((vocab.data as { events: string[] }).events).toEqual([
        ...ALERT_EVENTS,
      ]);
    }
    const badDry = await alertChannelCreate(
      p,
      {
        name: "mcp-bad",
        type: "discord",
        url_ref: "events-url",
        exclude_events: ["nope"],
      },
      { base: appDb },
    );
    expect(badDry.ok).toBe(false);
    if (!badDry.ok) expect(badDry.error).toContain("unknown alert event: nope");

    const made = await alertChannelCreate(
      p,
      {
        name: "mcp-events",
        type: "discord",
        url_ref: "events-url",
        exclude_events: ["tool_limit"],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(made.ok).toBe(true);
    const row = await suDb.alertChannel.findFirst({
      where: { tenantId: tenant, name: "mcp-events" },
      select: { id: true, excludeEvents: true },
    });
    expect(row?.excludeEvents).toEqual(["tool_limit"]);

    const badPreview = await alertChannelUpdate(
      p,
      { channel_id: String(row?.id), exclude_events: ["nope"] },
      { base: appDb },
    );
    expect(badPreview.ok).toBe(false);
    const applied = await alertChannelUpdate(
      p,
      {
        channel_id: String(row?.id),
        exclude_events: ["no_reply"],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    const after = await suDb.alertChannel.findFirst({
      where: { id: row?.id },
      select: { excludeEvents: true },
    });
    expect(after).toEqual({ excludeEvents: ["no_reply"] });
  });
});
