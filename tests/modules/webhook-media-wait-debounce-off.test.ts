import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import {
  clearMediaAnnotations,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import {
  debounceDedupeKey,
  resolveArmConfig,
} from "@/modules/debounce/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog } from "../utils/flowlog";

// An agent with debounce OFF answers each message as it arrives, in a direct turn. A voice note whose
// file is still being written to storage cannot be read in that turn, and only the debounce flush can
// come back for it, so the receiver arms the flush for that message (and for every message that
// arrives while that flush is live) instead of the direct turn. Driven through the real receiver;
// the eager transcription is a stand-in that leaves what the STT service leaves on a 404.
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

const CHATWOOT_INBOX_ID = 4712;
const AGENT_BOT_ID = 81;
const WORDS = "quero remarcar a consulta";

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let nextId = 1;

class CountingModel extends BaseChatModel {
  calls = 0;
  constructor() {
    super({});
  }
  _llmType() {
    return "counting";
  }
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    this.calls++;
    return {
      generations: [{ text: "ok", message: new AIMessage("ok") }],
    };
  }
}

const client = (async () =>
  ({
    getMessages: async () => ({ payload: [] }),
    sendMessage: async () => ({}),
    sendPrivateNote: async () => ({}),
    toggleTyping: async () => ({}),
    updateAttachmentMeta: async () => ({}),
  }) as unknown as ChatwootClient) as never;

// What `transcribeInboundAudio` does: on a 404 past the window it marks the note and throws; with
// the file served it returns the words.
function transcriber(state: "uploading" | "stored") {
  return async (p: {
    tenantId: bigint;
    instanceId: bigint;
    messageId: number;
  }) => {
    if (state === "stored") return WORDS;
    stashMediaAnnotation(
      {
        tenantId: p.tenantId,
        instanceId: p.instanceId,
        messageId: p.messageId,
      },
      { transcriptionUnavailable: true },
    );
    throw new ChatwootApiError(404, "GET attachment");
  };
}

async function seedConversation(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(Date.now() - 60_000),
    },
  });
}

async function deliver(
  convId: number,
  opts: { audio: boolean; storage?: "uploading" | "stored" },
) {
  const messageId = 7000 + nextId++;
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: messageId,
    content: opts.audio ? "" : "e tem horário amanhã?",
    message_type: "incoming",
    private: false,
    attachments: opts.audio
      ? [
          {
            id: 90_000 + messageId,
            file_type: "audio",
            data_url: `https://chat.wait.example/rails/active_storage/blobs/${messageId}.ogg`,
          },
        ]
      : [],
    conversation: {
      id: convId,
      inbox_id: CHATWOOT_INBOX_ID,
      status: "pending",
      contact_inbox: { id: 80_000 + convId },
      meta: {
        assignee_type: null,
        assignee: null,
        sender: { id: 41, name: "Cliente" },
      },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
  if (!n) throw new Error("unreachable: the fixture is a valid event");
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `media-wait-${process.pid}-${messageId}`,
      event: "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  const model = new CountingModel();
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: AGENT_BOT_ID,
    normalized: n,
    base: appDb,
    deps: {
      makeClient: client,
      makeModel: () => model,
      transcribe: transcriber(opts.storage ?? "stored") as never,
    },
  });
  return { model };
}

async function flushRows(convId: number) {
  return suDb.schedulerJob.count({
    where: {
      tenantId,
      kind: "DEBOUNCE",
      dedupeKey: debounceDedupeKey(`${tenantId}:${instanceId}:${convId}`),
      status: { in: ["PENDING", "CLAIMED"] },
    },
  });
}

describe.skipIf(!dbUp)("debounce off: a file still on its way", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "MW", slug: `media-wait-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 8,
      baseUrl: "https://chat.wait.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "k", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        enabled: true,
        mode: "production",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${key.id}`,
        },
        settings: {
          stt: {
            enabled: true,
            provider: "openai",
            credentialRef: `vault:${key.id}`,
          },
          debounce: { enabled: false },
        },
      },
      select: { id: true },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: AGENT_BOT_ID,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `media-wait-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "API",
        agentId: agent.id,
      },
      select: { id: true },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    clearMediaAnnotations();
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const table of [
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "audit_logs",
        "llm_usage",
        "conversations",
        "contacts",
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

  test("a voice note still uploading arms the flush instead of the direct turn", async () => {
    await seedConversation(9801);
    const { model } = await deliver(9801, {
      audio: true,
      storage: "uploading",
    });

    expect(await flushRows(9801)).toBe(1);
    expect(model.calls).toBe(0);
  });

  test("a message that arrives while that flush is live joins it", async () => {
    await seedConversation(9802);
    await deliver(9802, { audio: true, storage: "uploading" });
    const { model } = await deliver(9802, { audio: false });

    expect(await flushRows(9802)).toBe(1);
    expect(model.calls).toBe(0);
  });

  test("a voice note read at arrival takes the direct turn as before", async () => {
    await seedConversation(9803);
    const { model } = await deliver(9803, { audio: true, storage: "stored" });

    expect(await flushRows(9803)).toBe(0);
    expect(model.calls).toBeGreaterThan(0);
  });

  // An agent with debounce on arms with its own window: the media wait never stands in for it.
  test("debounce on arms with the agent's own window", async () => {
    const before = await suDb.agent.findFirstOrThrow({
      where: { tenantId },
      select: { settings: true },
    });
    await suDb.agent.updateMany({
      where: { tenantId },
      data: {
        settings: { debounce: { enabled: true, windowSeconds: 30 } },
      },
    });
    try {
      const cfg = await resolveArmConfig({
        tenantId,
        instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        threadId: `${tenantId}:${instanceId}:9805`,
        mediaArriving: true,
        base: appDb,
      });
      expect(cfg?.windowSeconds).toBe(30);
    } finally {
      await suDb.agent.updateMany({
        where: { tenantId },
        data: { settings: before.settings ?? {} },
      });
    }
  });

  // With the debounce worker off nothing drains a DEBOUNCE row, so the file waits in the direct turn
  // instead of in a flush that never runs and that every later message would join.
  test("with the debounce worker off, a voice note still uploading takes the direct turn", async () => {
    await seedConversation(9806);
    const saved = config.debounceWorker.enabled;
    config.debounceWorker.enabled = false;
    try {
      const { model } = await deliver(9806, {
        audio: true,
        storage: "uploading",
      });
      expect(await flushRows(9806)).toBe(0);
      expect(model.calls).toBeGreaterThan(0);
    } finally {
      config.debounceWorker.enabled = saved;
    }
  });

  test("a text message with no flush live takes the direct turn as before", async () => {
    await seedConversation(9804);
    const { model } = await deliver(9804, { audio: false });

    expect(await flushRows(9804)).toBe(0);
    expect(model.calls).toBeGreaterThan(0);
  });
});
