import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { type AgentNudge, runAgentNudge } from "@/graph/nudge";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  confirmProactiveReservation,
  PROACTIVE_LIMIT_WINDOW_MS,
  reserveProactiveSend,
  sendWithinProactiveLimit,
} from "@/modules/proactive-limit/service";
import { turnLimitVerdict } from "@/modules/turn-limit/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// The per-conversation proactive limit, through the real `runAgentNudge` with a recording Chatwoot
// double: a nudge past the limit sends nothing, logs why, and leaves the conversation with the agent.

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
let whatsappInboxDbId = 0n;
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

const proactiveRows = (conversationId: bigint) =>
  suDb.agentTurnDelivery.count({ where: { conversationId, proactive: true } });

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

const limitLines = (conversationId: bigint) =>
  flowLogRows(suDb, {
    where: { tenantId, stage: "proactive_limit", conversationId },
    orderBy: { id: "asc" },
    select: { level: true, status: true, detail: true, errorMessage: true },
  });

describe.skipIf(!dbUp)("proactive limit", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PL", slug: `pl-${process.pid}` },
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
        webhookRouteTokenHash: `pl-route-${process.pid}`,
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
    const whatsapp = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 8,
        name: "WhatsApp",
        agentId: agent.id,
        channelType: "Channel::Whatsapp",
        provider: "whatsapp_cloud",
      },
    });
    whatsappInboxDbId = whatsapp.id;
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

  test("past the limit the event is not sent, the first refusal is an error naming the integration, and the conversation stays with the agent", async () => {
    await setLimit(2);
    const conv = await seedConv(5101);
    for (const _ of [1, 2]) {
      const { r, run } = nudge(5101);
      expect(await run).toBe("messaged");
      expect(r.messages).toHaveLength(1);
    }
    expect(await proactiveRows(conv)).toBe(2);

    const third = nudge(5101);
    expect(await third.run).toBe("silent");
    expect(third.r.messages).toEqual([]);
    expect(third.r.notes).toEqual([]);
    expect(third.r.statuses).toEqual([]);
    expect(await proactiveRows(conv)).toBe(2);

    const fourth = nudge(5101);
    expect(await fourth.run).toBe("silent");
    expect(fourth.r.messages).toEqual([]);

    const lines = await limitLines(conv);
    expect(lines.map((l) => l.level)).toEqual(["error", "info"]);
    expect(lines[0]?.detail).toMatchObject({
      outcome: "not_sent",
      limit: 2,
      count: 2,
      trigger: "GENERIC",
      integrationInstanceId: String(integrationId),
    });
    expect(lines[0]?.errorMessage).toContain('integration "Integracao-A"');
    expect(lines[0]?.errorMessage).toContain("limit 2");

    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv },
      select: { status: true, assigneeType: true },
    });
    expect(row).toEqual({ status: "pending", assigneeType: null });
  });

  test("a refusal a day after the last alert is an error again", async () => {
    await setLimit(1);
    const conv = await seedConv(5102);
    await seedDeliveries(conv, true, 60_000);
    await suDb.conversation.update({
      where: { id: conv },
      data: {
        proactiveLimitAlertedAt: new Date(
          Date.now() - PROACTIVE_LIMIT_WINDOW_MS - 60_000,
        ),
      },
    });
    expect(await nudge(5102).run).toBe("silent");
    expect((await limitLines(conv)).map((l) => l.level)).toEqual(["error"]);
  });

  test("reactive replies do not count, and proactive sends older than 24 hours leave the window", async () => {
    await setLimit(2);
    const conv = await seedConv(5103);
    await seedDeliveries(conv, false, 1_000, 2_000, 3_000, 4_000, 5_000);
    await seedDeliveries(
      conv,
      true,
      PROACTIVE_LIMIT_WINDOW_MS + 10 * 60_000,
      PROACTIVE_LIMIT_WINDOW_MS + 20 * 60_000,
      PROACTIVE_LIMIT_WINDOW_MS - 10 * 60_000,
    );
    const ok = nudge(5103);
    expect(await ok.run).toBe("messaged");
    expect(ok.r.messages).toHaveLength(1);
    expect(await nudge(5103).run).toBe("silent");
  });

  test("a stored 0 never refuses", async () => {
    await setLimit(0);
    const conv = await seedConv(5104);
    await seedDeliveries(conv, true, 1_000, 2_000, 3_000);
    const { r, run } = nudge(5104);
    expect(await run).toBe("messaged");
    expect(r.messages).toHaveLength(1);
    expect(await limitLines(conv)).toEqual([]);
  });

  test("an agent that never stored the limit stops at the default of 10", async () => {
    await setLimit(undefined);
    const conv = await seedConv(5105);
    await seedDeliveries(
      conv,
      true,
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) => m * 60_000),
    );
    expect(await nudge(5105).run).toBe("messaged");
    expect(await proactiveRows(conv)).toBe(10);
    expect(await nudge(5105).run).toBe("silent");
  });

  test("a nudge that says nothing gives its reservation back", async () => {
    await setLimit(1);
    const conv = await seedConv(5106);
    const quiet = nudge(5106, { reply: "" });
    expect(await quiet.run).toBe("silent");
    expect(quiet.r.messages).toEqual([]);
    expect(await proactiveRows(conv)).toBe(0);
    const { r, run } = nudge(5106);
    expect(await run).toBe("messaged");
    expect(r.messages).toHaveLength(1);
  });

  test("on a conversation a person holds, a note-only run under the limit leaves its note and counts nothing", async () => {
    await setLimit(5);
    const conv = await seedConv(5107, "User");
    const { r, run } = nudge(5107, {
      nudge: { source: "ASAAS", status: "paid", value: 100, currency: "BRL" },
    });
    expect(await run).toBe("noted");
    expect(r.notes).toHaveLength(1);
    expect(await proactiveRows(conv)).toBe(0);
  });

  test("over the limit, a note-only run does not start, but an operator event still reaches the person as a note", async () => {
    await setLimit(1);
    const conv = await seedConv(5116, "User");
    await seedDeliveries(conv, true, 60_000);
    const authored = nudge(5116, {
      nudge: { source: "ASAAS", status: "paid", value: 100, currency: "BRL" },
    });
    expect(await authored.run).toBe("silent");
    expect(authored.r.notes).toEqual([]);
    expect(authored.r.messages).toEqual([]);
    const event = nudge(5116);
    expect(await event.run).toBe("noted");
    expect(event.r.notes).toHaveLength(1);
    expect(event.r.messages).toEqual([]);
    expect(await proactiveRows(conv)).toBe(1);
  });

  test("a refused follow-up step still lands its labels, and does not resolve", async () => {
    await setLimit(1);
    const conv = await seedConv(5108);
    await seedDeliveries(conv, true, 60_000);
    const { r, run } = nudge(5108, {
      nudge: { source: "followup", step: 3 },
      postActions: { assignLabels: ["sem-resposta"], resolve: true },
    });
    expect(await run).toBe("silent");
    expect(r.messages).toEqual([]);
    expect(r.labelSets).toEqual([["sem-resposta"]]);
    expect(r.statuses).toEqual([]);
    const [line] = await limitLines(conv);
    expect(line?.errorMessage).toContain("The follow-up message was not sent");
    expect(line?.detail).toMatchObject({ trigger: "followup", step: 3 });
  });

  test("events arriving together never send past the limit", async () => {
    await setLimit(3);
    const conv = await seedConv(5109);
    const runs = [1, 2, 3, 4, 5, 6].map(() => nudge(5109));
    const outcomes = await Promise.all(runs.map((n) => n.run));
    const sent = runs.flatMap((n) => n.r.messages);
    expect(sent).toHaveLength(3);
    expect(outcomes.filter((o) => o === "messaged")).toHaveLength(3);
    expect(await proactiveRows(conv)).toBe(3);
  });

  test("a reservation the nudge has not sent yet is not a delivery the turn limit counts", async () => {
    await setLimit(5);
    const conv = await seedConv(5110);
    const verdict = await reserveProactiveSend({
      tenantId,
      conversationDbId: conv,
      limit: 5,
      base: appDb,
    });
    if (verdict.over) throw new Error("expected a reservation");
    const reactive = () =>
      turnLimitVerdict({
        tenantId,
        conversationDbId: conv,
        limit: 1,
        base: appDb,
      });
    expect((await reactive()).over).toBe(false);
    await confirmProactiveReservation({
      tenantId,
      reservationId: verdict.reservationId as bigint,
      base: appDb,
    });
    expect((await reactive()).over).toBe(true);
  });

  test("a fixed send under the limit becomes a delivery, and one that throws gives its row back", async () => {
    const conv = await seedConv(5199);
    const fixed = (send: () => Promise<void>) =>
      sendWithinProactiveLimit({
        tenantId,
        instanceId,
        chatwootConversationId: 5199,
        agentId,
        limit: 5,
        source: "channel-redirect-link",
        base: appDb,
        send,
      });
    await expect(
      fixed(async () => {
        throw new Error("chatwoot down");
      }),
    ).rejects.toThrow("chatwoot down");
    expect(await proactiveRows(conv)).toBe(0);
    expect(await fixed(async () => {})).toBe("sent");
    const rows = await suDb.agentTurnDelivery.findMany({
      where: { conversationId: conv },
      select: { pending: true },
    });
    expect(rows).toEqual([{ pending: false }]);
  });

  test("a fixed send no longer wanted after the count sends nothing, under the limit or past it", async () => {
    const under = await seedConv(5198);
    const over = await seedConv(5197);
    await seedDeliveries(over, true, 60_000);
    let sends = 0;
    const fixed = (chatwootConversationId: number) =>
      sendWithinProactiveLimit({
        tenantId,
        instanceId,
        chatwootConversationId,
        agentId,
        limit: 1,
        source: "channel-redirect-closing",
        base: appDb,
        stillWanted: async () => false,
        send: async () => {
          sends++;
        },
      });
    expect(await fixed(5198)).toBe("stood-down");
    expect(await fixed(5197)).toBe("stood-down");
    expect(sends).toBe(0);
    expect(await proactiveRows(under)).toBe(0);
    expect(await proactiveRows(over)).toBe(1);
    expect(await limitLines(over)).toEqual([]);
    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: over },
      select: { proactiveLimitAlertedAt: true },
    });
    expect(row.proactiveLimitAlertedAt).toBeNull();
  });

  test("outside the window with no template, under the limit the note is left and nothing counts", async () => {
    await setLimit(5);
    const conv = await seedConv(5111, null, {
      id: whatsappInboxDbId,
      lastInboundAt: new Date(Date.now() - 2 * PROACTIVE_LIMIT_WINDOW_MS),
    });
    const { r, run } = nudge(5111, { nudge: { source: "followup", step: 2 } });
    expect(await run).toBe("noted-window");
    expect(r.messages).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(await proactiveRows(conv)).toBe(0);
  });

  test("outside the window with no template, over the limit the run ends as the window note would, with nothing written", async () => {
    await setLimit(1);
    const conv = await seedConv(5114, null, {
      id: whatsappInboxDbId,
      lastInboundAt: new Date(Date.now() - 2 * PROACTIVE_LIMIT_WINDOW_MS),
    });
    await seedDeliveries(conv, true, 60_000);
    const { r, run } = nudge(5114, { nudge: { source: "followup", step: 2 } });
    expect(await run).toBe("noted-window");
    expect(r.messages).toEqual([]);
    expect(r.notes).toEqual([]);
    expect((await limitLines(conv)).map((l) => l.level)).toEqual(["error"]);
  });

  test("an operator event whose conversation a person takes during the count is left as their note", async () => {
    await setLimit(1);
    const conv = await seedConv(5115);
    await seedDeliveries(conv, true, 60_000);
    const base = appDb.$extends({
      query: {
        agentTurnDelivery: {
          async count({ args, query }) {
            await suDb.conversation.update({
              where: { id: conv },
              data: { status: "open", assigneeType: "User", assigneeId: 5 },
            });
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const { r, run } = nudge(5115, { base });
    expect(await run).toBe("noted");
    expect(r.messages).toEqual([]);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]?.[1]).toContain("Pedido 42 saiu para entrega.");
  });

  test("a person who takes the conversation during the count does not get the refused step's labels", async () => {
    await setLimit(1);
    const conv = await seedConv(5112);
    await seedDeliveries(conv, true, 60_000);
    let counted = false;
    const base = appDb.$extends({
      query: {
        agentTurnDelivery: {
          async count({ args, query }) {
            counted = true;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const { r, run } = nudge(5112, {
      nudge: { source: "followup", step: 2 },
      postActions: { assignLabels: ["sem-resposta"] },
      requireLiveBotOwnership: true,
      base,
      getConversation: async (c) =>
        counted
          ? { id: c, status: "open", meta: { assignee: { id: 5 } } }
          : { id: c, status: "pending", meta: {} },
    });
    expect(await run).toBe("silent");
    expect(r.messages).toEqual([]);
    expect(r.labelSets).toEqual([]);
  });

  test("an occasion retired during the count takes no alert and writes no line", async () => {
    await setLimit(1);
    const conv = await seedConv(5113);
    await seedDeliveries(conv, true, 60_000);
    let wanted = true;
    const base = appDb.$extends({
      query: {
        agentTurnDelivery: {
          async count({ args, query }) {
            wanted = false;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const { r, run } = nudge(5113, { base, stillWanted: async () => wanted });
    expect(await run).toBe("stale");
    expect(r.messages).toEqual([]);
    expect(await limitLines(conv)).toEqual([]);
    const row = await suDb.conversation.findUniqueOrThrow({
      where: { id: conv },
      select: { proactiveLimitAlertedAt: true },
    });
    expect(row.proactiveLimitAlertedAt).toBeNull();
  });
});
