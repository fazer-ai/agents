import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  createAlertChannel,
  listAlertChannels,
  updateAlertChannel,
} from "@/modules/flowlog/channels";
import type { FlowContext } from "@/modules/flowlog/service";
import { writeFlowEvent } from "@/modules/flowlog/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  alertChannelCreate,
  alertChannelUpdate,
} from "@/modules/mcp/write-webhooks";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";

// Issue #843: an evaluation battery runs test agents on the same instance as production, and their
// deliberate warnings flooded the operator's alert channel. A channel can now leave named agents out.
// Two things are asserted together because the issue asked for both: the excluded agent's line does
// NOT reach this channel, and it IS still in the flow log, which the battery reads to score.

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

describe.skipIf(!dbUp)("alert channel excluded agents (issue #843)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let battery = 0n;
  let production = 0n;
  let foreign = 0n;

  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "ExA", slug: `ex-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "ExB", slug: `ex-b-${process.pid}` },
      })
    ).id;
    battery = (
      await suDb.agent.create({
        data: { tenantId: tenantA, name: "battery", systemPrompt: "x" },
      })
    ).id;
    production = (
      await suDb.agent.create({
        data: { tenantId: tenantA, name: "production", systemPrompt: "x" },
      })
    ).id;
    foreign = (
      await suDb.agent.create({
        data: { tenantId: tenantB, name: "foreign", systemPrompt: "x" },
      })
    ).id;
    await suDb.vaultEntry.create({
      data: {
        tenantId: tenantA,
        name: "ex-url",
        kind: "generic",
        secret: encryptJson(outboundUrl("/api/webhooks/9/exTOKEN")),
      },
    });
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await clearFlowLog(suDb, { tenantId: tid });
      for (const tbl of [
        "audit_logs",
        "alert_deliveries",
        "alert_channels",
        "vault_entries",
        "agents",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  function flow(agentId: bigint | null, turnId: string): FlowContext {
    return {
      tenantId: tenantA,
      turnId,
      source: "inbox",
      agentId,
      base: appDb,
    };
  }

  const deliveries = (channelId: string) =>
    suDb.alertDelivery.count({
      where: { tenantId: tenantA, channelId: BigInt(channelId) },
    });

  test("the excluded agent's warning reaches the log and not this channel; the others still alert", async () => {
    const ops = await createAlertChannel(
      ctx(tenantA),
      {
        name: "ops",
        type: "discord",
        url: outboundUrl("/api/webhooks/1/ops"),
        minLevel: "warn",
        excludeAgentIds: [String(battery)],
      },
      appDb,
    );
    // A second channel with no exclusions, so "the battery's line alerts nowhere" is not what passes.
    const lab = await createAlertChannel(
      ctx(tenantA),
      {
        name: "lab",
        type: "discord",
        url: outboundUrl("/api/webhooks/1/lab"),
        minLevel: "warn",
      },
      appDb,
    );
    expect(ops.excludeAgentIds).toEqual([String(battery)]);

    const ev = {
      stage: "generate" as const,
      level: "warn" as const,
      status: "ok" as const,
      detail: { silenceUnexplained: true },
    };
    await writeFlowEvent(flow(battery, "ex-battery"), ev);
    expect(await deliveries(ops.id)).toBe(0);
    expect(await deliveries(lab.id)).toBe(1);
    const logged = await flowLogRows(suDb, {
      where: { tenantId: tenantA, turnId: "ex-battery" },
      select: { agentId: true, level: true },
    });
    expect(logged.map((r) => ({ agentId: r.agentId, level: r.level }))).toEqual(
      [{ agentId: battery, level: "warn" }],
    );

    // The production agent on the same channel still pages, and so does a line with no agent at all.
    await writeFlowEvent(flow(production, "ex-prod"), {
      ...ev,
      errorMessage: "prod",
    });
    await writeFlowEvent(flow(null, "ex-none"), {
      stage: "dead_letter",
      level: "error",
      errorMessage: "tenant-wide",
    });
    expect(await deliveries(ops.id)).toBe(2);
  });

  test("an id that names no agent of this tenant is refused, on create and on update", async () => {
    for (const bad of [String(foreign), "999999999", "abc", "0"]) {
      await expect(
        createAlertChannel(
          ctx(tenantA),
          {
            name: `bad-${bad}`,
            type: "discord",
            url: outboundUrl("/api/webhooks/2/x"),
            excludeAgentIds: [bad],
          },
          appDb,
        ),
      ).rejects.toThrow("unknown agent");
    }
    expect(
      await suDb.alertChannel.count({
        where: { tenantId: tenantA, name: { startsWith: "bad-" } },
      }),
    ).toBe(0);
    const ch = await createAlertChannel(
      ctx(tenantA),
      { name: "upd", type: "discord", url: outboundUrl("/api/webhooks/2/u") },
      appDb,
    );
    await expect(
      updateAlertChannel(
        ctx(tenantA),
        BigInt(ch.id),
        { excludeAgentIds: [String(foreign)] },
        appDb,
      ),
    ).rejects.toThrow("unknown agent");
    const updated = await updateAlertChannel(
      ctx(tenantA),
      BigInt(ch.id),
      { excludeAgentIds: [String(production), String(production)] },
      appDb,
    );
    expect(updated.excludeAgentIds).toEqual([String(production)]);
    const audit = await suDb.auditLog.findFirst({
      where: {
        tenantId: tenantA,
        action: "alert_channel.update",
        target: `alert_channel:${ch.id}`,
      },
      select: { before: true, after: true },
    });
    expect(audit?.before).toMatchObject({ excludeAgentIds: [] });
    expect(audit?.after).toMatchObject({
      excludeAgentIds: [String(production)],
    });
  });

  test("an excluded agent that was deleted does not break the next save of the channel", async () => {
    const doomed = (
      await suDb.agent.create({
        data: { tenantId: tenantA, name: "doomed", systemPrompt: "x" },
      })
    ).id;
    const ch = await createAlertChannel(
      ctx(tenantA),
      {
        name: "stale",
        type: "discord",
        url: outboundUrl("/api/webhooks/3/s"),
        excludeAgentIds: [String(doomed)],
      },
      appDb,
    );
    await suDb.agent.delete({ where: { id: doomed } });
    // The console sends the whole list back on every save.
    const saved = await updateAlertChannel(
      ctx(tenantA),
      BigInt(ch.id),
      { name: "stale-renamed", excludeAgentIds: [String(doomed)] },
      appDb,
    );
    expect(saved.name).toBe("stale-renamed");
    expect(saved.excludeAgentIds).toEqual([String(doomed)]);
    const listed = (await listAlertChannels(ctx(tenantA), appDb)).find(
      (c) => c.id === ch.id,
    );
    expect(listed?.excludeAgentIds).toEqual([String(doomed)]);
    // Re-adding it after removal is an ADD, and an add has to name a live agent.
    await updateAlertChannel(
      ctx(tenantA),
      BigInt(ch.id),
      { excludeAgentIds: [] },
      appDb,
    );
    await expect(
      updateAlertChannel(
        ctx(tenantA),
        BigInt(ch.id),
        { excludeAgentIds: [String(doomed)] },
        appDb,
      ),
    ).rejects.toThrow("unknown agent");
  });

  test("MCP: the dry run refuses what the apply refuses, and the apply stores the list", async () => {
    const p = principal(tenantA);
    const dry = await alertChannelCreate(
      p,
      {
        name: "mcp-dry",
        type: "discord",
        url_ref: "ex-url",
        exclude_agent_ids: [String(foreign)],
      },
      { base: appDb },
    );
    expect(dry.ok).toBe(false);
    if (!dry.ok) expect(dry.error).toContain("unknown agent");

    const made = await alertChannelCreate(
      p,
      {
        name: "mcp",
        type: "discord",
        url_ref: "ex-url",
        exclude_agent_ids: [String(battery)],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(made.ok).toBe(true);
    const row = await suDb.alertChannel.findFirst({
      where: { tenantId: tenantA, name: "mcp" },
      select: { id: true, excludeAgentIds: true },
    });
    expect(row?.excludeAgentIds).toEqual([battery]);

    const preview = await alertChannelUpdate(
      p,
      {
        channel_id: String(row?.id),
        exclude_agent_ids: [String(battery), String(production)],
      },
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(JSON.stringify(preview.data)).toContain(String(production));
    }
    const badPreview = await alertChannelUpdate(
      p,
      { channel_id: String(row?.id), exclude_agent_ids: [String(foreign)] },
      { base: appDb },
    );
    expect(badPreview.ok).toBe(false);
    const applied = await alertChannelUpdate(
      p,
      {
        channel_id: String(row?.id),
        exclude_agent_ids: [],
        dry_run: false,
      },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    const after = await suDb.alertChannel.findFirst({
      where: { id: row?.id },
      select: { excludeAgentIds: true },
    });
    expect(after?.excludeAgentIds).toEqual([]);
  });
});
