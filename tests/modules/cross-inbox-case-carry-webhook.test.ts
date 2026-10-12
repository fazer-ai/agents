import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { caseCarryDedupeKey } from "@/modules/cross-inbox-case/carry-job";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// A contact's file on a conversation that names its case arms the late carry from the webhook, with
// no turn and no tool call. Only the contact's own files of a carried type do, and only while the
// files block is on.

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

const CHATWOOT_INBOX_ID = 7701;
const CASE_INBOX = 9;
const AGENT_BOT_ID = 77;
const CASE = 202;
const KEY = "case_conversation_id";

let tenantId: bigint;
let instanceId: bigint;
let inboxDbId: bigint;
let agentId: bigint;

const threadOf = (convId: number) => `${tenantId}:${instanceId}:${convId}`;

const CARRY_ON = {
  crossInboxCase: {
    targetInboxId: CASE_INBOX,
    carryAttachments: { mode: "conversation", fileTypes: ["image", "file"] },
  },
};

async function deliver(
  convId: number,
  over: {
    messageId?: number;
    attrs?: Record<string, unknown>;
    files?: Array<{ id: number; file_type: string }>;
    messageType?: string;
    private?: boolean;
    event?: string;
    sender?: { type: string; id: number };
  } = {},
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const n = normalizeChatwootEvent({
    event: over.event ?? "message_created",
    id: over.messageId ?? 900_000 + convId,
    created_at: now,
    content: "",
    message_type: over.messageType ?? "incoming",
    private: over.private ?? false,
    sender: over.sender ?? { type: "contact", id: 5 },
    attachments: (over.files ?? [{ id: 7002, file_type: "image" }]).map(
      (f) => ({
        ...f,
        data_url: `https://chat.carryhook.example/rails/active_storage/f-${f.id}.jpg`,
        file_size: 8,
      }),
    ),
    conversation: {
      id: convId,
      inbox_id: CHATWOOT_INBOX_ID,
      status: "open",
      contact_inbox: { id: 80_000 + convId },
      custom_attributes: over.attrs ?? { [KEY]: CASE },
      meta: {
        assignee_type: null,
        assignee: null,
        sender: { id: 5, name: "Cliente" },
      },
      channel: "Channel::Api",
      last_activity_at: now,
    },
  });
  if (!n) throw new Error("unreachable: the fixture event is valid");
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `case-carry-hook-${convId}-${Date.now()}-${Math.random()}`,
      event: over.event ?? "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: AGENT_BOT_ID,
    normalized: n,
    base: appDb,
    deps: {
      makeClient: (async () =>
        ({
          sendMessage: async () => ({}),
          sendPrivateNote: async () => ({}),
          toggleTyping: async () => ({}),
          getMessages: async () => ({ payload: [] }),
        }) as unknown as ChatwootClient) as never,
      makeModel: () => {
        throw new Error("no turn is the subject here");
      },
    },
  }).catch(() => {
    // The receiver may stop at any of its own gates after the arm, which is what this measures.
  });
}

const rowOf = (convId: number) =>
  suDb.schedulerJob.findFirst({
    where: {
      tenantId,
      kind: "CASE_CARRY",
      dedupeKey: caseCarryDedupeKey(threadOf(convId)),
    },
  });

async function seedConv(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      status: "open",
      threadId: threadOf(convId),
      lastEventAt: new Date(Date.now() - 60_000),
    },
  });
}

describe.skipIf(!dbUp)("the webhook arms the late carry", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CarryHook", slug: `carry-hook-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 7,
      baseUrl: "https://chat.carryhook.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Gi",
        systemPrompt: "x",
        enabled: true,
        mode: "production",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: CARRY_ON,
      },
      select: { id: true },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: AGENT_BOT_ID,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `carry-hook-${process.pid}`,
        name: "Gi",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "WhatsApp",
        agentId,
      },
      select: { id: true },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "conversations",
        "contacts",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
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

  test("the contact's image on a conversation that names its case arms the carry for that case", async () => {
    await seedConv(97_001);
    await deliver(97_001, { messageId: 9002 });
    const row = await rowOf(97_001);
    expect(row?.status).toBe("PENDING");
    expect(row?.payload).toMatchObject({
      originConversationId: 97_001,
      caseId: CASE,
      armedAtMessageId: 9002,
    });
  });

  test("nothing is armed without a case, without a carried file, or for a file nobody but the contact may send", async () => {
    await seedConv(97_002);
    await deliver(97_002, { attrs: {} });
    await seedConv(97_003);
    await deliver(97_003, { files: [] });
    await seedConv(97_004);
    await deliver(97_004, { files: [{ id: 7004, file_type: "audio" }] });
    await seedConv(97_005);
    await deliver(97_005, {
      messageType: "outgoing",
      sender: { type: "user", id: 77 },
    });
    await seedConv(97_006);
    await deliver(97_006, {
      messageType: "outgoing",
      private: true,
      sender: { type: "user", id: 77 },
    });
    for (const c of [97_002, 97_003, 97_004, 97_005, 97_006]) {
      expect(await rowOf(c)).toBeNull();
    }
  });

  test("an audio that arrives on message_updated arms the carry too", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          crossInboxCase: {
            targetInboxId: CASE_INBOX,
            carryAttachments: { mode: "conversation", fileTypes: ["audio"] },
          },
        },
      },
    });
    try {
      await seedConv(97_008);
      await deliver(97_008, {
        event: "message_updated",
        messageId: 9008,
        files: [{ id: 7008, file_type: "audio" }],
      });
      expect((await rowOf(97_008))?.payload).toMatchObject({
        caseId: CASE,
        armedAtMessageId: 9008,
      });
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: CARRY_ON },
      });
    }
  });

  test("with the files block off nothing is armed", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          crossInboxCase: {
            targetInboxId: CASE_INBOX,
            carryAttachments: { mode: "off" },
          },
        },
      },
    });
    try {
      await seedConv(97_007);
      await deliver(97_007);
      expect(await rowOf(97_007)).toBeNull();
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: CARRY_ON },
      });
    }
  });
});
