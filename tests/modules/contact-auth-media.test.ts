import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #890: with the contact authorization gate on, nothing of an incoming message reaches the STT
// or vision provider unless the gate let THAT message through. The media pass used to run at arrival,
// before the gate, and again on a refused message handed to memory, so a customer who had not
// consented still had their voice note transcribed and their photo described. Counted at the
// providers themselves (the injected fetches), on every entry the receiver has: a new message on a
// bot-held conversation, a conversation a person holds (where no gate runs), and a late attachment.

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

const AUTH_URL = "https://203.0.113.9:9443/check";
const CW_BASE = "https://203.0.113.23:9";
const PHONE = "+5511966665555";
const INBOX_GATED = 881;
const INBOX_ONCE = 882;
const INBOX_OPEN = 883;
const INBOX_DEBOUNCE = 884;
const INBOX_CLOSED = 885;
const INBOX_TEST = 886;
const INBOX_NO_MEDIA = 887;
const TRANSCRIPT = "SENTINELA-STT";
const DESCRIPTION = "SENTINELA-VISAO";

let tenantId = 0n;
let instanceId = 0n;
const inboxDb = new Map<number, bigint>();

const providers = { stt: 0, vision: 0, auth: 0 };
const authAnswers: boolean[] = [];

const sttFetch = (async () => {
  providers.stt += 1;
  return new Response(JSON.stringify({ text: TRANSCRIPT }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as unknown as typeof fetch;
const visionFetch = (async () => {
  providers.vision += 1;
  return new Response(
    JSON.stringify({ choices: [{ message: { content: DESCRIPTION } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as unknown as typeof fetch;
const authFetch = (async () => {
  providers.auth += 1;
  const allow = authAnswers.shift();
  if (allow === undefined) throw new Error("auth: no answer queued");
  return new Response(JSON.stringify({ authorized: allow }), { status: 200 });
}) as unknown as typeof fetch;

function stubClient() {
  const client = {
    downloadAttachment: async (url: string) => ({
      bytes: new ArrayBuffer(64),
      contentType: url.endsWith(".ogg") ? "audio/ogg" : "image/png",
    }),
    updateAttachmentMeta: async () => ({}),
    sendMessage: async () => ({}),
    sendPrivateNote: async () => ({}),
    toggleStatus: async () => ({}),
    assignTeam: async () => ({}),
    toggleTyping: async () => ({}),
    getMessages: async () => ({ payload: [] }),
  } as unknown as ChatwootClient;
  return async () => client;
}

async function seedConversation(convId: number, chatwootInboxId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDb.get(chatwootInboxId) as bigint,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
    },
  });
}

let seq = 0;
async function deliver(p: {
  convId: number;
  chatwootInboxId: number;
  event?: "message_created" | "message_updated";
  messageId?: number;
  humanHeld?: boolean;
  textOnly?: boolean;
  owesMemoryOnly?: boolean;
}) {
  seq += 1;
  const messageId = p.messageId ?? 9000 + seq;
  const n = normalizeChatwootEvent({
    event: p.event ?? "message_created",
    id: messageId,
    content: p.textOnly ? "oi, tudo bem?" : "",
    message_type: "incoming",
    private: false,
    attachments: p.textOnly
      ? []
      : [
          {
            id: messageId * 10 + 1,
            file_type: "audio",
            data_url: `${CW_BASE}/rails/active_storage/blobs/a${messageId}.ogg`,
          },
          {
            id: messageId * 10 + 2,
            file_type: "image",
            data_url: `${CW_BASE}/rails/active_storage/blobs/i${messageId}.png`,
          },
        ],
    conversation: {
      id: p.convId,
      inbox_id: p.chatwootInboxId,
      status: p.humanHeld ? "open" : "pending",
      contact_inbox: { id: 92_000 + p.convId },
      meta: {
        assignee_type: p.humanHeld ? "User" : null,
        assignee: p.humanHeld ? { id: 5, type: "user" } : null,
        sender: { id: 500 + p.convId, name: "Cliente", phone_number: PHONE },
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
      deliveryId: `cam-${process.pid}-${p.convId}-${seq}`,
      event: p.event ?? "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: 31,
    normalized: n,
    base: appDb,
    ...(p.owesMemoryOnly ? { owesMemoryOnly: true } : {}),
    deps: {
      makeClient: stubClient() as never,
      makeModel: () =>
        new FakeListChatModel({ responses: ["Recebido."] }) as never,
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
      contactAuthFetch: authFetch,
      sttFetch,
      visionFetch,
    },
  });
  return messageId;
}

describe.skipIf(!dbUp)("contact authorization gate and the media pass", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAMEDIA", slug: `camedia-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 43,
      baseUrl: CW_BASE,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const authKey = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "auth-key",
        kind: "bearer_token",
        secret: encryptJson("AUTH-SECRET"),
      },
      select: { id: true },
    });
    const media = {
      stt: {
        enabled: true,
        provider: "openai",
        credentialRef: `vault:${key.id}`,
      },
      vision: {
        enabled: true,
        provider: "openai",
        credentialRef: `vault:${key.id}`,
      },
    };
    const gate = {
      enabled: true,
      url: AUTH_URL,
      credentialRef: `vault:${authKey.id}`,
      noticeCooldownSeconds: 300,
      denyMessage: "Autoriza o uso de IA? Responda sim.",
      handoffEnabled: false,
    };
    // Closed all of today: the availability gate consumes the message BEFORE the contact gate is
    // asked, so the pass that waited for a verdict has none and asks for itself.
    const hoje = new Date().toISOString().slice(0, 10);
    const closed = await suDb.businessHours.create({
      data: {
        tenantId,
        name: "Fechado hoje",
        timezone: "UTC",
        windows: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day,
          start: "09:00",
          end: "18:00",
        })),
        exceptions: [{ date: hoje, label: "Feriado", ranges: [] }],
      },
      select: { id: true },
    });
    const agents: Array<
      [number, number, Record<string, string | number | boolean> | null]
    > = [
      [INBOX_GATED, 31, gate],
      [INBOX_ONCE, 32, { ...gate, mode: "once", grantTtlSeconds: 3600 }],
      [INBOX_OPEN, 33, null],
      [INBOX_DEBOUNCE, 34, gate],
      [INBOX_CLOSED, 35, gate],
      [INBOX_TEST, 36, gate],
      [INBOX_NO_MEDIA, 37, gate],
    ];
    for (const [inboxId, botId, contactAuth] of agents) {
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: `media-${inboxId}`,
          systemPrompt: "Você é prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${key.id}`,
          },
          ...(inboxId === INBOX_CLOSED ? { businessHoursId: closed.id } : {}),
          ...(inboxId === INBOX_TEST ? { mode: "test" } : {}),
          settings: {
            debounce: { enabled: inboxId === INBOX_DEBOUNCE },
            split: { enabled: false },
            ...(inboxId === INBOX_NO_MEDIA
              ? { stt: { enabled: false }, vision: { enabled: false } }
              : media),
            ...(contactAuth ? { contactAuth } : {}),
          },
        },
        select: { id: true },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: botId,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("SECRET"),
          webhookRouteTokenHash: `camedia-${process.pid}-${botId}`,
          name: "bot",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: inboxId,
          name: `media-${inboxId}`,
          agentId: agent.id,
        },
        select: { id: true },
      });
      inboxDb.set(inboxId, inbox.id);
    }
  });

  beforeEach(() => {
    clearContactAuthState();
    providers.stt = 0;
    providers.vision = 0;
    providers.auth = 0;
    authAnswers.length = 0;
  });

  afterAll(async () => {
    if (!dbUp || !tenantId) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a refused contact's audio and image reach no provider", async () => {
    await seedConversation(8801, INBOX_GATED);
    authAnswers.push(false);
    await deliver({ convId: 8801, chatwootInboxId: INBOX_GATED });
    expect(providers.auth).toBe(1);
    expect(providers.stt).toBe(0);
    expect(providers.vision).toBe(0);
  });

  test("an allowed contact's media is read once, and the endpoint is asked once", async () => {
    await seedConversation(8802, INBOX_GATED);
    authAnswers.push(true);
    await deliver({ convId: 8802, chatwootInboxId: INBOX_GATED });
    expect(providers.auth).toBe(1);
    expect(providers.stt).toBe(1);
    expect(providers.vision).toBe(1);
  });

  test("on a conversation a person holds no turn runs, and the media is read only if the gate allows it", async () => {
    await seedConversation(8803, INBOX_GATED);
    authAnswers.push(false);
    await deliver({
      convId: 8803,
      chatwootInboxId: INBOX_GATED,
      humanHeld: true,
    });
    expect(providers.auth).toBe(1);
    expect(providers.stt).toBe(0);
    expect(providers.vision).toBe(0);

    await seedConversation(8804, INBOX_GATED);
    authAnswers.push(true);
    await deliver({
      convId: 8804,
      chatwootInboxId: INBOX_GATED,
      humanHeld: true,
    });
    expect(providers.auth).toBe(2);
    expect(providers.stt).toBe(1);
    expect(providers.vision).toBe(1);
  });

  test("a late attachment of a refused contact is not read", async () => {
    await seedConversation(8805, INBOX_GATED);
    authAnswers.push(false, false);
    const id = await deliver({ convId: 8805, chatwootInboxId: INBOX_GATED });
    await deliver({
      convId: 8805,
      chatwootInboxId: INBOX_GATED,
      event: "message_updated",
      messageId: id,
    });
    expect(providers.stt).toBe(0);
    expect(providers.vision).toBe(0);
  });

  test("under mode once, a stored grant lets the media through without asking again", async () => {
    await seedConversation(8806, INBOX_ONCE);
    authAnswers.push(true);
    await deliver({ convId: 8806, chatwootInboxId: INBOX_ONCE });
    await deliver({ convId: 8806, chatwootInboxId: INBOX_ONCE });
    expect(providers.auth).toBe(1);
    expect(providers.stt).toBe(2);
    expect(providers.vision).toBe(2);
  });

  test("with debounce on, a refused contact's media is not read either", async () => {
    await seedConversation(8808, INBOX_DEBOUNCE);
    authAnswers.push(false);
    await deliver({ convId: 8808, chatwootInboxId: INBOX_DEBOUNCE });
    expect(providers.auth).toBe(1);
    expect(providers.stt).toBe(0);
    expect(providers.vision).toBe(0);
  });

  test("memory keeps the refused message without its content", async () => {
    await seedConversation(8809, INBOX_GATED);
    authAnswers.push(false);
    const id = await deliver({ convId: 8809, chatwootInboxId: INBOX_GATED });
    const row = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        payload: { path: ["messageId"], equals: id },
      },
      select: { payloadSecret: true },
    });
    if (!row?.payloadSecret)
      throw new Error("the refused message was not remembered");
    const text = decryptJson<string>(row.payloadSecret);
    expect(text).not.toContain(TRANSCRIPT);
    expect(text).not.toContain(DESCRIPTION);
  });

  test("out of hours no verdict is asked by the turn, so memory reads the media only on the gate's own yes", async () => {
    await seedConversation(8810, INBOX_CLOSED);
    authAnswers.push(false);
    await deliver({ convId: 8810, chatwootInboxId: INBOX_CLOSED });
    expect(providers.auth).toBe(1);
    expect(providers.stt).toBe(0);
    expect(providers.vision).toBe(0);

    await seedConversation(8811, INBOX_CLOSED);
    authAnswers.push(true);
    await deliver({ convId: 8811, chatwootInboxId: INBOX_CLOSED });
    expect(providers.auth).toBe(2);
    expect(providers.stt).toBe(1);
    expect(providers.vision).toBe(1);
  });

  test("a message with nothing to read costs the endpoint nothing", async () => {
    await seedConversation(8812, INBOX_GATED);
    await deliver({
      convId: 8812,
      chatwootInboxId: INBOX_GATED,
      humanHeld: true,
      textOnly: true,
    });
    expect(providers.auth).toBe(0);
  });

  test("a memory-only replay asks the gate before reading, since no turn asked it", async () => {
    await seedConversation(8813, INBOX_TEST);
    authAnswers.push(false);
    await deliver({
      convId: 8813,
      chatwootInboxId: INBOX_TEST,
      owesMemoryOnly: true,
    });
    expect(providers.auth).toBe(1);
    expect(providers.stt).toBe(0);
    expect(providers.vision).toBe(0);
  });

  // Review round 1 of #892: the refusal lived only in the first delivery, so an update of the refused
  // audio arriving after the customer consented asked the gate again and got the new yes.
  test("a refused message stays unread after a later consent, without asking the endpoint again", async () => {
    await seedConversation(8814, INBOX_ONCE);
    authAnswers.push(false);
    const refused = await deliver({
      convId: 8814,
      chatwootInboxId: INBOX_ONCE,
    });
    expect(providers.stt).toBe(0);
    // The customer says yes: the next message is read, and the grant is stored.
    authAnswers.push(true);
    await deliver({ convId: 8814, chatwootInboxId: INBOX_ONCE });
    expect(providers.stt).toBe(1);
    expect(providers.auth).toBe(2);
    // A late update of the refused audio: not read, and not asked about.
    await deliver({
      convId: 8814,
      chatwootInboxId: INBOX_ONCE,
      event: "message_updated",
      messageId: refused,
    });
    expect(providers.stt).toBe(1);
    expect(providers.auth).toBe(2);
  });

  test("a refusal the media pass got for itself is remembered the same way", async () => {
    await seedConversation(8816, INBOX_GATED);
    authAnswers.push(false);
    const refused = await deliver({
      convId: 8816,
      chatwootInboxId: INBOX_GATED,
      humanHeld: true,
    });
    expect(providers.auth).toBe(1);
    // Queued in case the pass asks again; it must not.
    authAnswers.push(true);
    await deliver({
      convId: 8816,
      chatwootInboxId: INBOX_GATED,
      event: "message_updated",
      messageId: refused,
      humanHeld: true,
    });
    expect(providers.auth).toBe(1);
    expect(providers.stt).toBe(0);
  });

  test("the remembered refusal only moves up, so a refusal delivered out of order does not lower it", async () => {
    await seedConversation(8817, INBOX_GATED);
    authAnswers.push(false, false);
    await deliver({
      convId: 8817,
      chatwootInboxId: INBOX_GATED,
      messageId: 70_900,
    });
    await deliver({
      convId: 8817,
      chatwootInboxId: INBOX_GATED,
      messageId: 70_100,
    });
    expect(providers.auth).toBe(2);
    authAnswers.push(true);
    await deliver({
      convId: 8817,
      chatwootInboxId: INBOX_GATED,
      event: "message_updated",
      messageId: 70_500,
    });
    expect(providers.auth).toBe(2);
    expect(providers.stt).toBe(0);
  });

  // Measured by the holdout verifier of #892: Chatwoot follows every voice note with a
  // `message_updated`, read as late media, and the pass asked the endpoint again for a message the
  // gate had just allowed.
  test("the update that follows an allowed voice note does not ask the endpoint again", async () => {
    await seedConversation(8818, INBOX_GATED);
    authAnswers.push(true);
    const id = await deliver({ convId: 8818, chatwootInboxId: INBOX_GATED });
    expect(providers.auth).toBe(1);
    await deliver({
      convId: 8818,
      chatwootInboxId: INBOX_GATED,
      event: "message_updated",
      messageId: id,
    });
    expect(providers.auth).toBe(1);
  });

  test("with STT and vision off, the gate is not asked about media nobody would read", async () => {
    await seedConversation(8815, INBOX_NO_MEDIA);
    await deliver({
      convId: 8815,
      chatwootInboxId: INBOX_NO_MEDIA,
      humanHeld: true,
    });
    expect(providers.auth).toBe(0);
  });

  test("without the gate, the media is read as before, even on a conversation a person holds", async () => {
    await seedConversation(8807, INBOX_OPEN);
    await deliver({
      convId: 8807,
      chatwootInboxId: INBOX_OPEN,
      humanHeld: true,
    });
    expect(providers.auth).toBe(0);
    expect(providers.stt).toBe(1);
    expect(providers.vision).toBe(1);
  });
});
