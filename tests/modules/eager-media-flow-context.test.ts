import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// The eager-media stages (`stt`, `vision`) are the ONLY inbox-source flow lines that used to be
// written with no conversation, agent or inbox: `runEagerMedia`'s context carried a threadId and
// nothing else. `flowlog/read.ts` filters on conversationId (and has no threadId filter), so the
// console's own route into a turn's trail — /logs?conversationId=<id> — could never show the voice
// note that failed on that conversation.
//
// Asked where it is CONSUMED, not where it is defined: the fixture drives the real receiver
// (processChatwootDelivery), so the call site has to hand `runEagerMedia` the ids for the row to
// carry them. Building the context by hand would pass with the call site still passing nothing.
//
// Deterministic and offline by construction: the agent's STT is enabled with NO credentialRef, so
// the service takes its `no_credential` skip — which emits the stage line — before it loads a
// Chatwoot client or reaches a provider. And the delivery is a `message_updated` carrying late
// audio, which runs eager media WITHOUT arming a turn, so no model is ever asked for.
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

const CHATWOOT_INBOX_ID = 4411;
const CONV_ID = 9711;
// The second call site's fixture: a test-mode agent on its own inbox, so the two paths never share
// a conversation and a row written by the wrong one cannot be mistaken for the right one.
const TEST_INBOX_ID = 4412;
const TEST_CONV_ID = 9712;
const AGENT_BOT_ID = 77;

let tenantId: bigint;
let instanceId: bigint;
let agentId: bigint;
let inboxDbId: bigint;
let conversationDbId: bigint;
let testAgentId: bigint;
let testInboxDbId: bigint;
let testConversationDbId: bigint;

describe.skipIf(!dbUp)("the eager-media flow context", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Eager", slug: `eager-media-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 4,
      baseUrl: "https://chat.eager.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        enabled: true,
        mode: "production",
        // No credentialRef: the STT service skips on it, and the skip is what emits the line.
        settings: { stt: { enabled: true, provider: "openai" } },
      },
      select: { id: true },
    });
    agentId = agent.id;
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
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inboxDbId,
        chatwootConversationId: CONV_ID,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
        lastEventAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });
    conversationDbId = conv.id;

    // `runEagerMedia` has a SECOND call site, on the answer path: a test-mode agent whose episode is
    // already activated passes the gate and only then gets its media analysed. It hands over the same
    // three ids from a different expression (`rt?.agentId ?? null`), so it is a separate rule and
    // needs its own measurement — with the ids of the first fixture it would pass on the wrong row.
    // Debounce is on so the delivery arms a job instead of running a turn: the ids are the subject
    // here, not the answer.
    const testAgent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente (teste)",
        systemPrompt: "x",
        enabled: true,
        mode: "test",
        settings: {
          stt: { enabled: true, provider: "openai" },
          debounce: { enabled: true },
        },
      },
      select: { id: true },
    });
    testAgentId = testAgent.id;
    const testInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: TEST_INBOX_ID,
        name: "WhatsApp (teste)",
        agentId: testAgentId,
      },
      select: { id: true },
    });
    testInboxDbId = testInbox.id;
    const testConv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: testInboxDbId,
        chatwootConversationId: TEST_CONV_ID,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${TEST_CONV_ID}`,
        lastEventAt: new Date(Date.now() - 60_000),
        // Already activated with /teste: what puts the delivery on the answer path.
        testActivatedAt: new Date(Date.now() - 30_000),
      },
      select: { id: true },
    });
    testConversationDbId = testConv.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "scheduler_jobs",
        "chatwoot_webhook_deliveries",
        "conversations",
        "inboxes",
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

  test("names the conversation, agent and inbox the stt line belongs to", async () => {
    const n = normalizeChatwootEvent({
      event: "message_updated",
      id: 5001,
      content: "",
      message_type: "incoming",
      private: false,
      attachments: [
        {
          id: 88,
          file_type: "audio",
          data_url: "https://chat.eager.example/audio/88.ogg",
        },
      ],
      conversation: {
        id: CONV_ID,
        inbox_id: CHATWOOT_INBOX_ID,
        status: "pending",
        contact_inbox: { id: 60_000 + CONV_ID },
        meta: {
          assignee_type: null,
          assignee: null,
          sender: { id: 21, name: "Cliente" },
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
        deliveryId: `eager-media-${process.pid}`,
        event: "message_updated",
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
        // A client that refuses the one call this path must never reach: with no credential the
        // service skips before it would download the audio.
        makeClient: (async () =>
          ({
            downloadAttachment: async () => {
              throw new Error(
                "the audio must not be downloaded: no credential",
              );
            },
            sendMessage: async () => ({}),
            sendPrivateNote: async () => ({}),
          }) as unknown as ChatwootClient) as never,
        makeModel: () => {
          throw new Error("a late-media update must not run a turn");
        },
      },
    });

    // The emit is fire-and-forget, so the row lands after the call returns (same reason the other
    // flow-log suites poll).
    const threadId = `${tenantId}:${instanceId}:${CONV_ID}`;
    let row:
      | {
          conversationId: bigint | null;
          agentId: bigint | null;
          inboxId: bigint | null;
        }
      | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      row =
        (await suDb.executionLog.findFirst({
          where: { tenantId, threadId, stage: "stt" },
          select: { conversationId: true, agentId: true, inboxId: true },
        })) ?? undefined;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    if (!row) throw new Error("no stt line was written");
    expect(row.conversationId).toBe(conversationDbId);
    expect(row.agentId).toBe(agentId);
    expect(row.inboxId).toBe(inboxDbId);
  });

  test("names them on the answer path too, where a test-mode episode gets its media", async () => {
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 5002,
      content: "",
      message_type: "incoming",
      private: false,
      attachments: [
        {
          id: 89,
          file_type: "audio",
          data_url: "https://chat.eager.example/audio/89.ogg",
        },
      ],
      conversation: {
        id: TEST_CONV_ID,
        inbox_id: TEST_INBOX_ID,
        status: "pending",
        contact_inbox: { id: 60_000 + TEST_CONV_ID },
        meta: {
          assignee_type: null,
          assignee: null,
          sender: { id: 22, name: "Cliente (teste)" },
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
        deliveryId: `eager-media-test-mode-${process.pid}`,
        event: "message_created",
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
            downloadAttachment: async () => {
              throw new Error(
                "the audio must not be downloaded: no credential",
              );
            },
            sendMessage: async () => ({}),
            sendPrivateNote: async () => ({}),
          }) as unknown as ChatwootClient) as never,
        makeModel: () => {
          throw new Error("a debounced burst must not run a turn inline");
        },
      },
    });

    const threadId = `${tenantId}:${instanceId}:${TEST_CONV_ID}`;
    let row:
      | {
          conversationId: bigint | null;
          agentId: bigint | null;
          inboxId: bigint | null;
        }
      | undefined;
    for (let i = 0; i < 200 && !row; i++) {
      row =
        (await suDb.executionLog.findFirst({
          where: { tenantId, threadId, stage: "stt" },
          select: { conversationId: true, agentId: true, inboxId: true },
        })) ?? undefined;
      if (!row) await new Promise((r) => setTimeout(r, 20));
    }
    if (!row) throw new Error("no stt line was written on the answer path");
    expect(row.conversationId).toBe(testConversationDbId);
    expect(row.agentId).toBe(testAgentId);
    expect(row.inboxId).toBe(testInboxDbId);
  });
});
