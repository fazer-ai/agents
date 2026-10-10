import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { type AgentNudge, runAgentNudge } from "@/graph/nudge";
import { runScopedOn } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { proactiveBreakerGet } from "@/modules/mcp/read";
import {
  proactiveBreakerResume,
  proactiveBreakerSet,
} from "@/modules/mcp/write-settings";
import {
  computeAutoPeak,
  getProactiveBreakerStatus,
  resumeProactiveBreaker,
} from "@/modules/proactive-breaker/service";
import {
  confirmProactiveReservation,
  reserveProactiveSend,
  sendWithinProactiveLimit,
} from "@/modules/proactive-limit/service";
import { updateProactiveBreakerSettings } from "@/modules/tenant-settings/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { until } from "../utils/poll";

// The account-wide proactive breaker, through the real `runAgentNudge` and the real reservation: the
// send that finds the account at its limit trips it, and nothing proactive goes out until a resume.

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

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentId = 0n;
let integrationId = 0n;

function recorder() {
  const messages: Array<[number, string]> = [];
  const notes: Array<[number, string]> = [];
  const statuses: Array<[number, string]> = [];
  const labelSets: string[][] = [];
  let labels: string[] = [];
  const client = {
    sendMessage: async (c: number, t: string) => {
      messages.push([c, t]);
      return { id: 70_000 + messages.length };
    },
    sendPrivateNote: async (c: number, t: string) => {
      notes.push([c, t]);
      return { id: 80_000 + notes.length };
    },
    getConversationLabels: async () => labels,
    setConversationLabels: async (_c: number, next: string[]) => {
      labels = next;
      labelSets.push(next);
      return {};
    },
    toggleStatus: async (c: number, status: string) => {
      statuses.push([c, status]);
      return {};
    },
    sendTemplate: async () => ({}),
    toggleTyping: async () => ({}),
    assignTeam: async () => ({}),
    assignToAgent: async () => ({}),
  } as unknown as ChatwootClient;
  return { client, messages, notes, statuses, labelSets };
}

async function setLimit(limit: number | undefined) {
  await suDb.agent.update({
    where: { id: agentId },
    data: {
      settings:
        limit === undefined ? {} : { limits: { maxProactivePerDay: limit } },
    },
  });
}

async function seedConv(
  convId: number,
  assigneeType: string | null = null,
  inbox: { id: bigint; lastInboundAt: Date } | null = null,
): Promise<bigint> {
  const row = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inbox?.id ?? inboxDbId,
      chatwootConversationId: convId,
      status: assigneeType === "User" ? "open" : "pending",
      assigneeType,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
      lastInboundAt: inbox?.lastInboundAt ?? new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

async function seedDeliveries(
  conversationId: bigint,
  proactive: boolean,
  ...ageMs: number[]
) {
  for (const age of ageMs)
    await suDb.agentTurnDelivery.create({
      data: {
        tenantId,
        conversationId,
        proactive,
        deliveredAt: new Date(Date.now() - age),
      },
    });
}

const event = (): AgentNudge => ({
  source: "GENERIC",
  kind: "agent_nudge",
  framing: "operator_event",
  text: "Pedido 42 saiu para entrega.",
  integrationInstanceId: String(integrationId),
});

function nudge(
  convId: number,
  opts: {
    reply?: string;
    nudge?: AgentNudge;
    postActions?: { assignLabels?: string[]; resolve?: boolean };
    base?: PrismaClient;
    stillWanted?: () => Promise<boolean>;
    requireLiveBotOwnership?: boolean;
    getConversation?: (c: number) => Promise<unknown>;
  } = {},
) {
  const r = recorder();
  if (opts.getConversation)
    (r.client as unknown as Record<string, unknown>).getConversation =
      opts.getConversation;
  return {
    r,
    run: runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      nudge: opts.nudge ?? event(),
      postActions: opts.postActions,
      stillWanted: opts.stillWanted,
      requireLiveBotOwnership: opts.requireLiveBotOwnership,
      base: opts.base ?? appDb,
      deps: {
        makeModel: () =>
          new FakeListChatModel({
            responses: [opts.reply ?? "Seu pedido saiu para entrega."],
          }),
        makeClient: async () => r.client,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    }),
  };
}

const ctx = () => ({ tenantId, userId: null, role: "TENANT_ADMIN" as const });

// The breaker's lines are the account's, not one turn's, and every test clears the tenant's log first.
const breakerLines = () =>
  // flowlog-scope: tenant-wide
  flowLogRows(suDb, {
    where: { tenantId, stage: "proactive_breaker" },
    orderBy: { id: "asc" },
    select: { level: true, detail: true, errorMessage: true },
  });

async function setBreaker(mode: "auto" | "fixed" | "off", limit?: number) {
  await updateProactiveBreakerSettings(
    ctx(),
    { mode, ...(limit !== undefined ? { limit } : {}) },
    appDb,
  );
}

async function resetBreaker() {
  await suDb.agentTurnDelivery.deleteMany({ where: { tenantId } });
  await suDb.proactiveBreaker.deleteMany({ where: { tenantId } });
  await clearFlowLog(suDb, { tenantId });
}

async function seedGenerate(outcome: string, at: Date, n: number) {
  for (let i = 0; i < n; i++)
    await suDb.executionLog.create({
      data: {
        tenantId,
        turnId: crypto.randomUUID(),
        stage: "generate",
        status: "ok",
        level: "info",
        source: "inbox",
        detail: { trigger: "GENERIC", outcome },
        createdAt: new Date(at.getTime() + i * 1000),
      },
    });
}

describe.skipIf(!dbUp)("proactive breaker", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PB", slug: `pb-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const vault = await suDb.vaultEntry.create({
      data: { tenantId, name: "k", secret: encryptJson("sk") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id}`,
        },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `pb-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
        channelType: "Channel::Api",
      },
    });
    inboxDbId = inbox.id;
    const integration = await suDb.integrationInstance.create({
      data: { tenantId, catalogType: "GENERIC", name: "Integracao-A" },
      select: { id: true },
    });
    integrationId = integration.id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const table of [
        "llm_usage",
        "scheduler_jobs",
        "agent_threads",
        "agent_turn_deliveries",
        "proactive_breakers",
        "audit_logs",
        "conversations",
        "integration_instances",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the account's limit stops every agent's proactive sends, the trip is one error line with the console link, and later refusals are info", async () => {
    await resetBreaker();
    await setLimit(0);
    await setBreaker("fixed", 3);
    for (const c of [6001, 6002, 6003]) {
      await seedConv(c);
      const { run } = nudge(c);
      expect(await run).toBe("messaged");
    }
    await seedConv(6004);
    const fourth = nudge(6004);
    expect(await fourth.run).toBe("silent");
    expect(fourth.r.messages).toEqual([]);
    await seedConv(6005);
    const fifth = nudge(6005);
    expect(await fifth.run).toBe("silent");
    expect(fifth.r.messages).toEqual([]);

    const status = await getProactiveBreakerStatus(ctx(), appDb);
    expect(status.tripped?.count).toBe(3);
    expect(status.tripped?.limit).toBe(3);
    const lines = await breakerLines();
    expect(lines.map((l) => l.level)).toEqual(["error", "info"]);
    expect(lines[0]?.errorMessage).toContain("3 proactive messages");
    expect(lines[0]?.errorMessage).toContain("limit 3");
    expect(lines[0]?.errorMessage).toContain("Components > Advanced");
  });

  test("a resume is a fresh allowance, and changing the limit alone does not reopen", async () => {
    await resetBreaker();
    await setLimit(0);
    await setBreaker("fixed", 2);
    const convs = [6101, 6102, 6103, 6104, 6105, 6106];
    for (const c of convs) await seedConv(c);
    expect(await nudge(6101).run).toBe("messaged");
    expect(await nudge(6102).run).toBe("messaged");
    expect(await nudge(6103).run).toBe("silent");

    await setBreaker("fixed", 100);
    expect(await nudge(6104).run).toBe("silent");
    expect(
      (await getProactiveBreakerStatus(ctx(), appDb)).tripped,
    ).not.toBeNull();

    await setBreaker("fixed", 2);
    const resumed = await resumeProactiveBreaker(ctx(), appDb);
    expect(resumed.tripped).toBeNull();
    expect(resumed.count).toBe(0);
    expect(await nudge(6105).run).toBe("messaged");
    expect(await nudge(6106).run).toBe("messaged");
  });

  test("a reservation that waited behind a resume counts after it", async () => {
    await resetBreaker();
    await setBreaker("fixed", 1);
    await suDb.proactiveBreaker.create({
      data: {
        tenantId,
        trippedAt: new Date(),
        tripCount: 1,
        tripLimit: 1,
        autoComputedAt: new Date(),
      },
    });
    const first = await seedConv(6901);
    const second = await seedConv(6902);
    let waiting: Promise<
      Awaited<ReturnType<typeof reserveProactiveSend>>
    > | null = null;
    // NOTE: The resume runs in a transaction that holds the breaker's lock while the reservation
    // waits for it, which is the order the reservation's instant must respect.
    await suDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`proactive-breaker:${tenantId}`})::bigint)`;
      waiting = reserveProactiveSend({
        tenantId,
        conversationDbId: first,
        limit: 0,
        base: appDb,
      });
      await until("the reservation to wait on the breaker's lock", async () => {
        const rows = await tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        return Number(rows[0]?.n ?? 0) > 0;
      });
      await tx.proactiveBreaker.update({
        where: { tenantId },
        data: {
          trippedAt: null,
          tripCount: null,
          tripLimit: null,
          resumedAt: new Date(),
        },
      });
    });
    const v = await (waiting as unknown as Promise<{ over: boolean }>);
    expect(v.over).toBe(false);
    const next = await reserveProactiveSend({
      tenantId,
      conversationDbId: second,
      limit: 0,
      base: appDb,
    });
    expect(next.over).toBe(true);
  });

  test("turning the breaker off while a reservation holds its lock waits instead of deadlocking", async () => {
    await resetBreaker();
    await setBreaker("fixed", 5);
    const conv = await seedConv(6950);
    let off: Promise<unknown> | null = null;
    // NOTE: The reservation's order: the breaker's lock, then a row referencing the tenant. The
    // settings write must wait for the lock before it locks the tenant row, or the two deadlock.
    await suDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`proactive-breaker:${tenantId}`})::bigint)`;
      off = updateProactiveBreakerSettings(ctx(), { mode: "off" }, appDb);
      await until("the settings write to wait", async () => {
        const rows = await tx.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_locks WHERE NOT granted`;
        return Number(rows[0]?.n ?? 0) > 0;
      });
      await tx.agentTurnDelivery.create({
        data: { tenantId, conversationId: conv, proactive: true },
      });
    });
    await (off as unknown as Promise<unknown>);
    expect((await getProactiveBreakerStatus(ctx(), appDb)).mode).toBe("off");
  });

  test("resuming an open breaker changes nothing and writes no audit row", async () => {
    await resetBreaker();
    await setBreaker("fixed", 3);
    const before = await suDb.auditLog.count({
      where: { tenantId, action: "proactive_breaker.resume" },
    });
    await resumeProactiveBreaker(ctx(), appDb);
    const twice = await resumeProactiveBreaker(ctx(), appDb);
    expect(twice.tripped).toBeNull();
    expect(twice.resumedAt).toBeNull();
    expect(
      await suDb.auditLog.count({
        where: { tenantId, action: "proactive_breaker.resume" },
      }),
    ).toBe(before);
  });

  test("turning the breaker off lets proactive sends through, tripped or not", async () => {
    await resetBreaker();
    await setLimit(0);
    await setBreaker("fixed", 1);
    for (const c of [6201, 6202, 6203, 6204]) await seedConv(c);
    expect(await nudge(6201).run).toBe("messaged");
    expect(await nudge(6202).run).toBe("silent");
    await setBreaker("off");
    expect(await nudge(6203).run).toBe("messaged");
    expect(await nudge(6204).run).toBe("messaged");
    const status = await getProactiveBreakerStatus(ctx(), appDb);
    expect(status.limit).toBeNull();
    expect(status.tripped).toBeNull();
  });

  test("proactive sends older than 24 hours leave the window, and reactive ones never count", async () => {
    await resetBreaker();
    await setLimit(0);
    await setBreaker("fixed", 2);
    const old = await seedConv(6301);
    await seedDeliveries(old, true, 25 * 3_600_000, 26 * 3_600_000);
    await seedDeliveries(old, false, 1000, 2000, 3000);
    await seedConv(6302);
    await seedConv(6303);
    expect(await nudge(6302).run).toBe("messaged");
    expect(await nudge(6303).run).toBe("messaged");
    expect((await getProactiveBreakerStatus(ctx(), appDb)).tripped).toBeNull();
  });

  test("sends arriving together never pass the account's limit", async () => {
    await resetBreaker();
    await setBreaker("fixed", 3);
    const convs: bigint[] = [];
    for (let c = 6401; c <= 6408; c++) convs.push(await seedConv(c));
    const verdicts = await Promise.all(
      convs.map((conversationDbId) =>
        reserveProactiveSend({
          tenantId,
          conversationDbId,
          limit: 0,
          base: appDb,
        }),
      ),
    );
    expect(verdicts.filter((v) => !v.over)).toHaveLength(3);
    expect(
      verdicts.filter((v) => v.over && v.reason === "breaker" && v.trippedNow),
    ).toHaveLength(1);
  });

  test("the redirect ladder's fixed sends are held by the breaker even with no per-conversation limit", async () => {
    await resetBreaker();
    await setBreaker("fixed", 1);
    await seedConv(6501);
    await seedConv(6502);
    let sends = 0;
    const fixed = (c: number) =>
      sendWithinProactiveLimit({
        tenantId,
        instanceId,
        chatwootConversationId: c,
        agentId,
        limit: 0,
        source: "channel-redirect-link",
        base: appDb,
        send: async () => {
          sends++;
        },
      });
    expect(await fixed(6501)).toBe("sent");
    expect(await fixed(6502)).toBe("over");
    expect(sends).toBe(1);
    expect((await breakerLines()).map((l) => l.level)).toEqual(["error"]);
  });

  test("the automatic limit is 3x the largest 24h volume of the last 30 days, never below 1,000", async () => {
    await resetBreaker();
    await clearFlowLog(suDb, { tenantId });
    const now = new Date();
    const day = 86_400_000;
    await seedGenerate("messaged", new Date(now.getTime() - 40 * day), 600);
    await seedGenerate("silent", new Date(now.getTime() - 3 * day), 900);
    const peakAt = new Date(now.getTime() - 8 * day);
    await seedGenerate("messaged", peakAt, 300);
    await seedGenerate(
      "templated",
      new Date(peakAt.getTime() + 3_600_000),
      200,
    );
    await seedGenerate("messaged", new Date(now.getTime() - 2 * day), 100);

    const peak = await runScopedOn(appDb, ctx(), (db) =>
      computeAutoPeak(db, tenantId, now),
    );
    expect(peak.peak).toBe(500);
    expect(peak.at?.getTime()).toBe(peakAt.getTime());

    await setBreaker("auto");
    const status = await getProactiveBreakerStatus(ctx(), appDb, now);
    expect(status.limit).toBe(1500);
    expect(status.auto.basis).toBe("peak");
    expect(status.auto.peak).toBe(500);

    await clearFlowLog(suDb, { tenantId });
    await suDb.proactiveBreaker.deleteMany({ where: { tenantId } });
    await seedGenerate("messaged", new Date(now.getTime() - 2 * day), 334);
    const floorish = await getProactiveBreakerStatus(ctx(), appDb, now);
    expect(floorish.limit).toBe(1002);
    await clearFlowLog(suDb, { tenantId });
    await suDb.proactiveBreaker.deleteMany({ where: { tenantId } });
    const empty = await getProactiveBreakerStatus(ctx(), appDb, now);
    expect(empty.limit).toBe(1000);
    expect(empty.auto.basis).toBe("floor");
  });

  test("an invalid limit is refused and the stored one stays", async () => {
    await resetBreaker();
    await setBreaker("fixed", 3);
    for (const bad of [-5, 1.5, 0]) {
      await expect(setBreaker("fixed", bad)).rejects.toThrow(
        "proactive breaker",
      );
    }
    await expect(
      updateProactiveBreakerSettings(
        ctx(),
        { mode: "fixed", limit: null },
        appDb,
      ),
    ).rejects.toThrow("proactive breaker");
    const status = await getProactiveBreakerStatus(ctx(), appDb);
    expect(status.mode).toBe("fixed");
    expect(status.limit).toBe(3);
  });

  test("another account is neither counted nor paused", async () => {
    await resetBreaker();
    await setLimit(0);
    await setBreaker("fixed", 1);
    await seedConv(6601);
    await seedConv(6602);
    expect(await nudge(6601).run).toBe("messaged");
    expect(await nudge(6602).run).toBe("silent");
    const other = await suDb.tenant.create({
      data: { name: "PB2", slug: `pb2-${process.pid}` },
    });
    try {
      const status = await getProactiveBreakerStatus(
        { tenantId: other.id, userId: null, role: "TENANT_ADMIN" },
        appDb,
      );
      expect(status.tripped).toBeNull();
      expect(status.count).toBe(0);
    } finally {
      await suDb.proactiveBreaker.deleteMany({ where: { tenantId: other.id } });
      await suDb.tenant.delete({ where: { id: other.id } });
    }
  });

  test("a pending reservation confirmed after its send is still one delivery", async () => {
    await resetBreaker();
    await setBreaker("fixed", 5);
    const conv = await seedConv(6701);
    const v = await reserveProactiveSend({
      tenantId,
      conversationDbId: conv,
      limit: 0,
      base: appDb,
    });
    if (v.over) throw new Error("expected a reservation");
    await confirmProactiveReservation({
      tenantId,
      reservationId: v.reservationId as bigint,
      base: appDb,
    });
    expect((await getProactiveBreakerStatus(ctx(), appDb)).count).toBe(1);
  });

  test("the MCP reads, previews, sets and resumes the breaker", async () => {
    await resetBreaker();
    await setLimit(0);
    await setBreaker("fixed", 1);
    await seedConv(6801);
    await seedConv(6802);
    expect(await nudge(6801).run).toBe("messaged");
    expect(await nudge(6802).run).toBe("silent");
    const principal = {
      userId: null,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    } as unknown as VerifiedToken;
    const read = await proactiveBreakerGet(principal, { base: appDb });
    expect(JSON.stringify(read)).toContain('"limit":1');
    const preview = await proactiveBreakerSet(
      principal,
      { mode: "fixed", limit: 50 },
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    expect((await getProactiveBreakerStatus(ctx(), appDb)).limit).toBe(1);
    await proactiveBreakerSet(
      principal,
      { mode: "fixed", limit: 50, dry_run: false },
      { base: appDb },
    );
    const set = await getProactiveBreakerStatus(ctx(), appDb);
    expect(set.limit).toBe(50);
    expect(set.tripped).not.toBeNull();
    const refused = await proactiveBreakerSet(
      principal,
      { mode: "fixed", limit: -5 },
      { base: appDb },
    );
    expect(refused.ok).toBe(false);
    await proactiveBreakerResume(
      principal,
      { dry_run: false },
      { base: appDb },
    );
    expect((await getProactiveBreakerStatus(ctx(), appDb)).tripped).toBeNull();
  });
});
