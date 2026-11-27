import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import {
  clearMediaAnnotations,
  conversationMediaArriving,
  mediaArrivingHold,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  processChatwootDelivery,
  runEagerMedia,
} from "@/modules/chatwoot/webhook";
import {
  armDebounce,
  debounceDedupeKey,
  resolveArmConfig,
  stampDeferral,
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

// Called when the model is invoked: what a test reads while the turn is still running.
let duringTurn: (() => void) | null = null;

class CountingModel extends BaseChatModel {
  calls = 0;
  seen: string[] = [];
  constructor() {
    super({});
  }
  _llmType() {
    return "counting";
  }
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.calls++;
    duringTurn?.();
    for (const m of messages)
      if (m.type === "human" && typeof m.content === "string")
        this.seen.push(m.content);
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
function transcriber(state: "uploading" | "stored" | "recovered") {
  return async (p: {
    tenantId: bigint;
    instanceId: bigint;
    messageId: number;
    onMediaMissing?: () => void;
  }) => {
    if (state === "stored") return WORDS;
    p.onMediaMissing?.();
    if (state === "recovered") return WORDS;
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
  opts: { audio: boolean; storage?: "uploading" | "stored" | "recovered" },
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

  // The download answered 404 once and then read the file: the delivery's own mark is not a reason
  // to queue a reply that is ready.
  test("a voice note read after one 404 takes the direct turn", async () => {
    await seedConversation(9827);
    let heldDuringTurn: boolean | null = null;
    duringTurn = () => {
      heldDuringTurn = conversationMediaArriving(tenantId, instanceId, 9827);
    };
    const { model } = await deliver(9827, {
      audio: true,
      storage: "recovered",
    }).finally(() => {
      duringTurn = null;
    });
    // A text right after that reply is not queued behind a file that was read.
    const next = await deliver(9827, { audio: false });

    expect(await flushRows(9827)).toBe(0);
    expect(model.calls).toBeGreaterThan(0);
    expect(next.model.calls).toBeGreaterThan(0);
    // The delivery let go when it chose the direct turn, not when the turn ended.
    expect(heldDuringTurn as boolean | null).toBe(false);
  });

  // The claimed row is re-armed as a new burst, and still says when the row was first armed.
  test("a re-arm of a claimed row keeps when the row was first armed", async () => {
    const threadId = `${tenantId}:${instanceId}:9828`;
    const first = Date.now() - 30_000;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "CLAIMED",
        runAt: new Date(Date.now() - 1_000),
        payload: { threadId, agentBotId: AGENT_BOT_ID, burstStartedAt: first },
      },
    });
    const arm = () =>
      armDebounce({
        tenantId,
        threadId,
        agentBotId: AGENT_BOT_ID,
        cfg: {
          enabled: true,
          windowSeconds: 5,
          maxMessagesPerBurst: 20,
          maxWindowSeconds: 60,
        },
        base: appDb,
      });
    const read = async () =>
      (
        await suDb.schedulerJob.findFirstOrThrow({
          where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
          select: { payload: true },
        })
      ).payload as { liveSince: number; burstStartedAt: number };

    await arm();
    const once = await read();
    await arm();
    const twice = await read();

    expect(once.liveSince).toBe(first);
    expect(once.burstStartedAt).toBeGreaterThan(first);
    expect(twice.liveSince).toBe(first);
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
      // The arm still says a file is on its way: debounce can be turned off before the flush.
      expect(cfg?.lateMedia).toBe(true);
      expect(cfg?.mediaOnly).toBeUndefined();
      const plain = await resolveArmConfig({
        tenantId,
        instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        threadId: `${tenantId}:${instanceId}:9805`,
        mediaArriving: false,
        base: appDb,
      });
      expect(plain?.lateMedia).toBeUndefined();
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
      // The direct turn renders the note as late too, never as inaudible.
      expect(model.seen.join("\n")).toContain(
        "a transcrição não ficou pronta a tempo",
      );
      expect(model.seen.join("\n")).not.toContain("não audível");
      // The delivery armed nothing, and let go of the conversation all the same.
      expect(conversationMediaArriving(tenantId, instanceId, 9806)).toBe(false);
    } finally {
      config.debounceWorker.enabled = saved;
    }
  });

  // A burst waiting for a file keeps its next retry when a message arrives with a long window.
  test("a message that joins a media wait does not push its retry out", async () => {
    const threadId = `${tenantId}:${instanceId}:9807`;
    const retryAt = new Date(Date.now() + 5_000);
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "PENDING",
        runAt: retryAt,
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now() - 10_000,
          mediaWaitSince: Date.now() - 5_000,
        },
      },
    });

    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: {
        enabled: true,
        windowSeconds: 90,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 600,
      },
      base: appDb,
    });

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { runAt: true },
    });
    expect(row.runAt.getTime()).toBeLessThanOrEqual(retryAt.getTime());
  });

  // A text re-armed the row while the first flush was retrying: the flush's own reschedule can no
  // longer reach it, so the stamp brings that row's run forward to the retry.
  test("the first media wait brings a row re-armed during the flush forward to its retry", async () => {
    const threadId = `${tenantId}:${instanceId}:9808`;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "PENDING",
        runAt: new Date(Date.now() + 90_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now(),
        },
      },
    });
    const since = Date.now() - 1_000;
    const retryAt = new Date(Date.now() + 5_000);

    await stampDeferral({
      tenantId,
      threadId,
      since,
      field: "mediaWaitSince",
      retryAt,
      base: appDb,
    });

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { runAt: true, payload: true },
    });
    expect(row.runAt.getTime()).toBe(retryAt.getTime());
    expect(row.payload).toHaveProperty("mediaWaitSince", since);
  });

  test("the flush a debounce-off agent arms for a late file is marked as armed for media only", async () => {
    await seedConversation(9811);
    await deliver(9811, { audio: true, storage: "uploading" });

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: {
        tenantId,
        dedupeKey: debounceDedupeKey(`${tenantId}:${instanceId}:9811`),
      },
      select: { payload: true },
    });
    expect(row.payload).toHaveProperty("mediaOnly", true);
  });

  // Queued while debounce was on, with no file on its way: not a wait this text joins.
  test("a text does not join an ordinary burst queued before debounce was turned off", async () => {
    await seedConversation(9812);
    const threadId = `${tenantId}:${instanceId}:9812`;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "PENDING",
        runAt: new Date(Date.now() + 90_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now(),
        },
      },
    });

    const { model } = await deliver(9812, { audio: false });

    expect(model.calls).toBeGreaterThan(0);
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { payload: true },
    });
    expect(row.payload).not.toHaveProperty("mediaOnly");
  });

  test("a text joins a burst that debounce armed and that is now waiting for a file", async () => {
    await seedConversation(9813);
    const threadId = `${tenantId}:${instanceId}:9813`;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "PENDING",
        runAt: new Date(Date.now() + 5_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now(),
          mediaWaitSince: Date.now(),
        },
      },
    });

    const { model } = await deliver(9813, { audio: false });

    expect(model.calls).toBe(0);
    expect(await flushRows(9813)).toBe(1);
  });

  // The voice note's own delivery is still asking storage for the file and has armed nothing yet.
  test("a text that arrives while a voice note of the conversation is still being asked for joins its wait", async () => {
    await seedConversation(9814);
    const earlier = mediaArrivingHold({
      tenantId,
      instanceId,
      conversationId: 9814,
    });
    earlier.mark();

    const { model } = await deliver(9814, { audio: false }).finally(
      earlier.release,
    );

    expect(model.calls).toBe(0);
    expect(await flushRows(9814)).toBe(1);
  });

  // The row's time is when the run in flight came due, already in the past: kept, the worker would
  // run the next retry on its next tick.
  test("a message that joins while a media retry runs does not bring the next retry to now", async () => {
    const threadId = `${tenantId}:${instanceId}:9815`;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "CLAIMED",
        runAt: new Date(Date.now() - 8_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now() - 20_000,
          mediaWaitSince: Date.now() - 10_000,
        },
      },
    });
    const before = Date.now();

    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: {
        enabled: true,
        windowSeconds: 90,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 600,
      },
      base: appDb,
    });

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { runAt: true, payload: true },
    });
    expect(row.runAt.getTime()).toBeGreaterThan(before);
    expect(row.payload).toHaveProperty("mediaWaitSince");
  });

  test("a flush whose claim was retired stamps nothing on the row a newer burst armed", async () => {
    const threadId = `${tenantId}:${instanceId}:9816`;
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "PENDING",
        runAt: new Date(Date.now() + 90_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now(),
        },
      },
      select: { id: true, claimSeq: true },
    });
    const stamp = (claimSeq: number) =>
      stampDeferral({
        tenantId,
        threadId,
        since: Date.now() - 1_000,
        field: "mediaWaitSince",
        retryAt: new Date(Date.now() + 5_000),
        job: { id: row.id, claimSeq },
        base: appDb,
      });
    const read = () =>
      suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
        select: { runAt: true, payload: true },
      });

    await stamp(row.claimSeq - 1);
    const untouched = await read();
    await stamp(row.claimSeq);
    const stamped = await read();

    expect(untouched.payload).not.toHaveProperty("mediaWaitSince");
    expect(untouched.runAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(stamped.payload).toHaveProperty("mediaWaitSince");
  });

  test("a media wait stays one when a message arms it with the agent's own debounce", async () => {
    const threadId = `${tenantId}:${instanceId}:9817`;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "PENDING",
        runAt: new Date(Date.now() + 5_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now(),
          mediaOnly: true,
        },
      },
    });

    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: {
        enabled: true,
        windowSeconds: 15,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 60,
      },
      base: appDb,
    });

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { payload: true },
    });
    expect(row.payload).toHaveProperty("mediaOnly", true);
  });

  // Debounce was on when the burst was armed and it is already waiting for a file: a text that joins
  // through the debounce-off path does not lift its cap.
  test("an ordinary burst waiting for a file stays ordinary when a media-only arm joins it", async () => {
    const threadId = `${tenantId}:${instanceId}:9818`;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "PENDING",
        runAt: new Date(Date.now() + 5_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now(),
          mediaWaitSince: Date.now(),
        },
      },
    });

    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: {
        enabled: true,
        windowSeconds: 5,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 60,
        mediaOnly: true,
        lateMedia: true,
      },
      base: appDb,
    });

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { payload: true },
    });
    expect(row.payload).not.toHaveProperty("mediaOnly");
    expect(row.payload).toHaveProperty("mediaWaitSince");
  });

  // The flush stamped its deferral and has not rescheduled yet: the row is still CLAIMED, and the
  // message's window must not replace the retry the flush asked for.
  test("a message that joins between the deferral stamp and the reschedule keeps the retry", async () => {
    const threadId = `${tenantId}:${instanceId}:9819`;
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "CLAIMED",
        runAt: new Date(Date.now() - 1_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now() - 5_000,
        },
      },
      select: { id: true, claimSeq: true },
    });
    const retryAt = new Date(Date.now() + 5_000);
    await stampDeferral({
      tenantId,
      threadId,
      since: Date.now() - 1_000,
      field: "mediaWaitSince",
      retryAt,
      job: row,
      base: appDb,
    });
    const before = Date.now();

    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: {
        enabled: true,
        windowSeconds: 90,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 600,
      },
      base: appDb,
    });

    const after = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { runAt: true },
    });
    expect(after.runAt.getTime()).toBe(retryAt.getTime());
    expect(after.runAt.getTime()).toBeGreaterThan(before);
  });

  test("once the voice note's delivery has armed its flush, the conversation mark lapses", async () => {
    await seedConversation(9820);
    await deliver(9820, { audio: true, storage: "uploading" });

    expect(await flushRows(9820)).toBe(1);
    expect(conversationMediaArriving(tenantId, instanceId, 9820)).toBe(false);
  });

  // The claimed flush is the same burst, deferring for its file: the joining arm keeps its mode too.
  test("an ordinary burst deferring for a file stays ordinary when a media-only arm joins mid-flush", async () => {
    const threadId = `${tenantId}:${instanceId}:9821`;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "CLAIMED",
        runAt: new Date(Date.now() - 1_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now() - 10_000,
          mediaWaitSince: Date.now() - 5_000,
        },
      },
    });

    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: {
        enabled: true,
        windowSeconds: 5,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 60,
        mediaOnly: true,
        lateMedia: true,
      },
      base: appDb,
    });

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { payload: true },
    });
    expect(row.payload).not.toHaveProperty("mediaOnly");
  });

  // Asked with nothing on its way in the conversation any more: the job alone answers.
  test("a media-only job not yet deferred is one a later text joins", async () => {
    const threadId = `${tenantId}:${instanceId}:9822`;
    const job = (payload: Record<string, unknown>) =>
      suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey: debounceDedupeKey(threadId),
          status: "PENDING",
          runAt: new Date(Date.now() + 5_000),
          payload: {
            threadId,
            agentBotId: AGENT_BOT_ID,
            burstStartedAt: Date.now(),
            ...payload,
          },
        },
        select: { id: true },
      });
    const resolve = () =>
      resolveArmConfig({
        tenantId,
        instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        threadId,
        mediaArriving: false,
        base: appDb,
      });

    const ordinary = await job({});
    const withOrdinary = await resolve();
    await suDb.schedulerJob.delete({ where: { id: ordinary.id } });
    await job({ mediaOnly: true });
    const withMediaOnly = await resolve();

    expect(withOrdinary).toBeNull();
    expect(withMediaOnly).toMatchObject({ mediaOnly: true, windowSeconds: 5 });
  });

  // Debounce was turned off with an ordinary burst queued, and a late voice note joined it: the row
  // keeps its cap, and still says a file is on its way so the next text joins it.
  test("an ordinary pending burst joined by a late file is one a later text joins", async () => {
    const threadId = `${tenantId}:${instanceId}:9823`;
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "PENDING",
        runAt: new Date(Date.now() + 5_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now(),
        },
      },
    });
    const resolve = () =>
      resolveArmConfig({
        tenantId,
        instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        threadId,
        mediaArriving: false,
        base: appDb,
      });
    const before = await resolve();
    // What the late file's own delivery arms with.
    const late = await resolveArmConfig({
      tenantId,
      instanceId,
      chatwootInboxId: CHATWOOT_INBOX_ID,
      threadId,
      mediaArriving: true,
      base: appDb,
    });
    if (!late) throw new Error("unreachable: a late file always arms");

    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: late,
      base: appDb,
    });

    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { payload: true },
    });
    expect(before).toBeNull();
    expect(row.payload).not.toHaveProperty("mediaOnly");
    expect(await resolve()).not.toBeNull();

    // The text that joined re-arms the row with its own config, and the one after it still joins.
    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: {
        enabled: true,
        windowSeconds: 5,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 60,
      },
      base: appDb,
    });
    expect(await resolve()).not.toBeNull();
  });

  // The last round before the ceiling is milliseconds ahead and can be due by the time a message
  // re-arms the claimed row.
  test("a retry already due when a message joins is run at once, not after the window", async () => {
    const threadId = `${tenantId}:${instanceId}:9824`;
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "CLAIMED",
        runAt: new Date(Date.now() - 1_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now() - 5_000,
        },
      },
      select: { id: true, claimSeq: true },
    });
    const retryAt = new Date(Date.now() + 1);
    await stampDeferral({
      tenantId,
      threadId,
      since: Date.now() - 59_000,
      field: "mediaWaitSince",
      retryAt,
      job: row,
      base: appDb,
    });
    await Bun.sleep(10);

    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: {
        enabled: true,
        windowSeconds: 90,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 600,
      },
      base: appDb,
    });

    const after = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { runAt: true },
    });
    expect(after.runAt.getTime()).toBe(retryAt.getTime());
  });

  test("a retry noted by an earlier claim of the row is not this run's retry", async () => {
    const threadId = `${tenantId}:${instanceId}:9825`;
    const row = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
        status: "CLAIMED",
        runAt: new Date(Date.now() - 1_000),
        payload: {
          threadId,
          agentBotId: AGENT_BOT_ID,
          burstStartedAt: Date.now() - 5_000,
          mediaWaitSince: Date.now() - 5_000,
          retryAt: Date.now() - 4_000,
        },
      },
      select: { id: true, claimSeq: true },
    });
    await suDb.$executeRawUnsafe(
      `UPDATE scheduler_jobs SET payload = payload || '{"retryClaim": ${row.claimSeq - 1}}'::jsonb WHERE id = ${row.id}`,
    );
    const before = Date.now();

    await armDebounce({
      tenantId,
      threadId,
      agentBotId: AGENT_BOT_ID,
      cfg: {
        enabled: true,
        windowSeconds: 90,
        maxMessagesPerBurst: 20,
        maxWindowSeconds: 600,
      },
      base: appDb,
    });

    const after = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, dedupeKey: debounceDedupeKey(threadId) },
      select: { runAt: true },
    });
    expect(after.runAt.getTime()).toBeGreaterThan(before + 60_000);
  });

  // The delivery runs the pass twice: the second reads the file and the provider hears no speech.
  test("a second pass that reads the voice note takes the late flag back off the event", async () => {
    await seedConversation(9826);
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 79_826,
      content: "",
      message_type: "incoming",
      private: false,
      attachments: [
        {
          id: 99_826,
          file_type: "audio",
          data_url:
            "https://chat.wait.example/rails/active_storage/blobs/79826.ogg",
        },
      ],
      conversation: {
        id: 9826,
        inbox_id: CHATWOOT_INBOX_ID,
        status: "pending",
        contact_inbox: { id: 89_826 },
        meta: { assignee_type: null, assignee: null, sender: { id: 41 } },
        channel: "Channel::Api",
      },
    });
    if (!n?.message)
      throw new Error("unreachable: the fixture is a valid event");
    const pass = (transcribe: unknown) =>
      runEagerMedia(tenantId, instanceId, n, appDb, {
        conversationId: null,
        agentId: null,
        inboxId: inboxDbId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        deliveryRowId: null,
        admission: "allowed",
        deps: { makeClient: client, transcribe: transcribe as never },
      });

    await pass(transcriber("uploading"));
    const afterFirst = n.message.transcriptionUnavailable;
    await pass(
      async (p: {
        tenantId: bigint;
        instanceId: bigint;
        messageId: number;
      }) => {
        stashMediaAnnotation(p, { transcriptionUnavailable: false });
        return null;
      },
    );

    expect(afterFirst).toBe(true);
    expect(n.message.transcriptionUnavailable).toBe(false);
  });

  test("a text message with no flush live takes the direct turn as before", async () => {
    await seedConversation(9804);
    const { model } = await deliver(9804, { audio: false });

    expect(await flushRows(9804)).toBe(0);
    expect(model.calls).toBeGreaterThan(0);
  });
});
