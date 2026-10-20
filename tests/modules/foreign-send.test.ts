import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { CHATWOOT_SEND_ID_KEY } from "@/modules/chatwoot/constants";
import {
  foreignBotMessageOf,
  normalizeChatwootEvent,
} from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { causeKeyOf } from "@/modules/flowlog/alerts";
import { FOREIGN_SEND_MESSAGE } from "@/modules/flowlog/foreign-send";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { outboundUrl } from "../utils/outbound";

// A message posted with the managed Agent Bot's token by something other than the engine: every
// engine create carries a send id, so one without it is reported, once per agent per alert window,
// and the agent's handling of it does not change.

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

const INBOX_ID = 6871;
const CONV_ID = 68_701;
const BOT_ID = 17;
const TEXT = "Qual o seu e-mail para enviarmos o contrato?";

function message(
  messageId: number,
  opts: {
    event?: string;
    sender?: { type: string; id: number } | null;
    sendId?: string;
    private?: boolean;
    messageType?: string;
  } = {},
) {
  const n = normalizeChatwootEvent({
    event: opts.event ?? "message_created",
    id: messageId,
    content: TEXT,
    message_type: opts.messageType ?? "outgoing",
    private: opts.private ?? false,
    sender:
      opts.sender === undefined
        ? { type: "agent_bot", id: BOT_ID }
        : opts.sender,
    content_attributes: opts.sendId
      ? { [CHATWOOT_SEND_ID_KEY]: opts.sendId }
      : {},
    conversation: {
      id: CONV_ID,
      inbox_id: INBOX_ID,
      status: "pending",
      meta: { sender: { id: 41, name: "Cliente" } },
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
  if (!n) throw new Error("unreachable: the fixture is a valid event");
  return n;
}

describe("foreignBotMessageOf", () => {
  test("the route's own bot, outgoing, without a send id, is foreign", () => {
    expect(foreignBotMessageOf(message(1), BOT_ID)).toEqual({
      conversationId: CONV_ID,
      messageId: 1,
    });
  });

  test("a message the engine named is ours, whatever the name", () => {
    for (const sendId of ["engine:abc", "reply:k:1", "channel-resend:9"]) {
      expect(foreignBotMessageOf(message(2, { sendId }), BOT_ID)).toBeNull();
    }
  });

  test("another bot, a person, a contact and a sender-less row are not this check's", () => {
    for (const sender of [
      { type: "agent_bot", id: BOT_ID + 1 },
      { type: "user", id: BOT_ID },
      null,
    ]) {
      expect(foreignBotMessageOf(message(3, { sender }), BOT_ID)).toBeNull();
    }
    expect(
      foreignBotMessageOf(message(3, { messageType: "incoming" }), BOT_ID),
    ).toBeNull();
  });

  test("a private note, an update and an unattributed route are not reported", () => {
    expect(
      foreignBotMessageOf(message(4, { private: true }), BOT_ID),
    ).toBeNull();
    expect(
      foreignBotMessageOf(message(4, { event: "message_updated" }), BOT_ID),
    ).toBeNull();
    expect(foreignBotMessageOf(message(4), null)).toBeNull();
    // A bot without a readable id on an unattributed route: null against null is no match.
    const anonymous = message(4, {
      sender: { type: "agent_bot", id: null as unknown as number },
    });
    expect(anonymous.message?.sender?.id).toBeNull();
    expect(foreignBotMessageOf(anonymous, null)).toBeNull();
  });
});

// Keyed by the agent: the same bot id on two Chatwoot servers is two agents, and two alerts.
test("the alert cause is the agent, so one agent's run is one alert", () => {
  const ev = (agent: unknown) => ({
    stage: "foreign_send" as const,
    level: "warn" as const,
    detail: { agent, routeBot: BOT_ID, messageId: 1 },
  });
  expect(causeKeyOf(ev("42"))).toBe("foreign_send:42");
  expect(causeKeyOf(ev("43"))).not.toBe(causeKeyOf(ev("42")));
  expect(causeKeyOf(ev("17; drop"))).toBe("foreign_send");
  expect(causeKeyOf(ev(42))).toBe("foreign_send");
});

let tenantId: bigint;
let instanceId: bigint;
let agentId: bigint;
let channelId: bigint;

async function deliver(n: ReturnType<typeof message>) {
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `fs-${process.pid}-${crypto.randomUUID()}`,
      event: n.event,
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: row.id,
    agentBotId: BOT_ID,
    normalized: n,
    base: appDb,
    deps: {
      sleep: async () => {},
      makeClient: (async () => {
        throw new Error("a message on the bot token sends nothing");
      }) as never,
      makeModel: () => {
        throw new Error("no model may run on a bot outgoing message");
      },
    },
  });
}

// Every event in this file is on one conversation, so the conversation scopes the read.
const lines = async () => {
  const conv = await suDb.conversation.findFirst({
    where: { tenantId, chatwootConversationId: CONV_ID },
    select: { id: true },
  });
  if (!conv) return [];
  return flowLogRows(suDb, {
    where: { conversationId: conv.id, stage: "foreign_send" },
    orderBy: { id: "asc" },
  });
};

describe.skipIf(!dbUp)("a message posted on the agent's bot token", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "Token do bot", slug: `foreign-send-${process.pid}` },
      })
    ).id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 6,
        baseUrl: "https://chat.token.example",
        adminToken: encryptJson("ADMIN"),
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Liz",
          systemPrompt: "x",
          enabled: true,
          mode: "production",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
          settings: {},
        },
        select: { id: true },
      })
    ).id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: BOT_ID,
        accessToken: encryptJson("BOT-TOKEN"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `fs-route-${process.pid}`,
        name: "Liz",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
        name: "WhatsApp",
        agentId,
      },
    });
    channelId = (
      await suDb.alertChannel.create({
        data: {
          tenantId,
          name: "alertas",
          type: "discord",
          url: encryptJson(outboundUrl("/api/webhooks/foreign-send")),
          minLevel: "warn",
          stages: [],
          excludeAgentIds: [],
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!tenantId) return;
    await clearFlowLog(suDb, { tenantId });
    await suDb.alertDelivery.deleteMany({ where: { channelId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
  });

  test("an engine send writes nothing, and a foreign one a warn naming the agent and no text", async () => {
    await deliver(message(7001, { sendId: "engine:x" }));
    await deliver(message(7002, { sender: { type: "agent_bot", id: 99 } }));
    await deliver(message(7003, { private: true }));
    expect(await lines()).toHaveLength(0);

    await deliver(message(7004));
    const rows = await lines();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.level).toBe("warn");
    expect(row?.agentId).toBe(agentId);
    expect(row?.conversationId).not.toBeNull();
    expect(row?.detail).toEqual({
      agent: String(agentId),
      routeBot: BOT_ID,
      messageId: 7004,
    });
    expect(row?.errorMessage).toBe(FOREIGN_SEND_MESSAGE);
    expect(
      JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? String(v) : v)),
    ).not.toContain("e-mail");
  });

  test("a run of them is one alert on the channel, counted", async () => {
    await deliver(message(7005));
    await deliver(message(7006));
    expect(await lines()).toHaveLength(3);
    const alerts = await suDb.alertDelivery.findMany({
      where: { channelId },
      select: { causeKey: true, count: true, level: true },
    });
    expect(alerts).toEqual([
      { causeKey: `foreign_send:${agentId}`, count: 3, level: "warn" },
    ]);
  });
});
