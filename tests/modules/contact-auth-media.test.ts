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
import {
  clearMediaAnnotations,
  mediaAnnotationFor,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { mediaRefusalKey } from "@/modules/contact-auth/media-refusal";
import {
  clearContactAuthState,
  mediaRefusedHereThrough,
} from "@/modules/contact-auth/state";
import { seedChatwootInstance } from "../utils/chatwoot";

// With the contact authorization gate on, no media of an incoming message reaches the STT or vision
// provider unless the gate let that message through. Counted at the injected provider fetches.

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
const authAnswers: Array<boolean | (() => Promise<boolean>)> = [];

// Runs once inside the next STT call, to change the world while the provider is busy.
let duringStt: (() => Promise<void>) | null = null;
const sttFetch = (async () => {
  providers.stt += 1;
  const side = duringStt;
  duringStt = null;
  if (side) await side();
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
  const next = authAnswers.shift();
  if (next === undefined) throw new Error("auth: no answer queued");
  const allow = typeof next === "function" ? await next() : next;
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
  // An image an earlier pass already described, alone or beside one nobody read yet.
  describedImage?: "alone" | "beside-new" | "both";
  // The default audio and image, plus a second image.
  extraImage?: boolean;
  // Receives the normalized event, to read what the delivery left on it.
  seen?: NormalizedChatwootEvent[];
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
      : p.describedImage
        ? [
            {
              id: messageId * 10 + 2,
              file_type: "image",
              data_url: `${CW_BASE}/rails/active_storage/blobs/i${messageId}.png`,
              meta: { image_description: "Print do pedido 21607129." },
            },
            ...(p.describedImage === "beside-new"
              ? [
                  {
                    id: messageId * 10 + 3,
                    file_type: "image",
                    data_url: `${CW_BASE}/rails/active_storage/blobs/j${messageId}.png`,
                  },
                ]
              : p.describedImage === "both"
                ? [
                    {
                      id: messageId * 10 + 3,
                      file_type: "image",
                      data_url: `${CW_BASE}/rails/active_storage/blobs/j${messageId}.png`,
                      meta: { image_description: "Comprovante de pagamento." },
                    },
                  ]
                : []),
          ]
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
            ...(p.extraImage
              ? [
                  {
                    id: messageId * 10 + 4,
                    file_type: "image",
                    data_url: `${CW_BASE}/rails/active_storage/blobs/k${messageId}.png`,
                  },
                ]
              : []),
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
  p.seen?.push(n);
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
    clearMediaAnnotations();
    clearContactAuthState();
    providers.stt = 0;
    providers.vision = 0;
    providers.auth = 0;
    authAnswers.length = 0;
    duringStt = null;
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

  test("a replayed delivery of a refused message stays unread even when the gate now says yes", async () => {
    await seedConversation(8819, INBOX_GATED);
    authAnswers.push(false);
    const refused = await deliver({
      convId: 8819,
      chatwootInboxId: INBOX_GATED,
    });
    expect(providers.stt).toBe(0);
    authAnswers.push(true);
    await deliver({
      convId: 8819,
      chatwootInboxId: INBOX_GATED,
      messageId: refused,
    });
    expect(providers.auth).toBe(2);
    expect(providers.stt).toBe(0);
    expect(providers.vision).toBe(0);
  });

  test("an image an earlier pass already described is reused without asking the gate", async () => {
    await seedConversation(8820, INBOX_GATED);
    authAnswers.push(false);
    await deliver({
      convId: 8820,
      chatwootInboxId: INBOX_GATED,
      humanHeld: true,
      describedImage: "alone",
    });
    expect(providers.auth).toBe(0);
    expect(providers.vision).toBe(0);
  });

  test("on a refusal, memory keeps what an earlier pass read and counts the rest as unread", async () => {
    await seedConversation(8821, INBOX_GATED);
    authAnswers.push(false);
    const id = await deliver({
      convId: 8821,
      chatwootInboxId: INBOX_GATED,
      describedImage: "beside-new",
    });
    expect(providers.vision).toBe(0);
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
    expect(text).toContain("Print do pedido 21607129.");
    expect(text).toContain('quantidade="1"');
    // What a later re-fetch of the thread reads.
    expect(
      mediaAnnotationFor(tenantId, instanceId, id)?.attachmentsUnread,
    ).toBe(1);
  });

  test("a refusal that lands while the endpoint is answering wins over that yes", async () => {
    await seedConversation(8822, INBOX_GATED);
    const id = 72_000;
    authAnswers.push(async () => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: 8822 },
        data: { mediaRefusedThroughMessageId: id + 1 },
      });
      return true;
    });
    await deliver({
      convId: 8822,
      chatwootInboxId: INBOX_GATED,
      humanHeld: true,
      messageId: id,
    });
    expect(providers.auth).toBe(1);
    expect(providers.stt).toBe(0);
    expect(providers.vision).toBe(0);
  });

  test("a refusal the conversation could not store is still honoured by this process", async () => {
    await seedConversation(8823, INBOX_GATED);
    await suDb.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION cam_refusal_fails() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'injected'; END $$ LANGUAGE plpgsql`);
    await suDb.$executeRawUnsafe(`CREATE TRIGGER cam_refusal_fails BEFORE UPDATE OF media_refused_through_message_id
      ON conversations FOR EACH ROW WHEN (NEW.chatwoot_conversation_id = 8823) EXECUTE FUNCTION cam_refusal_fails()`);
    try {
      authAnswers.push(false, true);
      const id = await deliver({ convId: 8823, chatwootInboxId: INBOX_GATED });
      await deliver({
        convId: 8823,
        chatwootInboxId: INBOX_GATED,
        event: "message_updated",
        messageId: id,
      });
      expect(providers.stt).toBe(0);
      expect(providers.vision).toBe(0);
    } finally {
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS cam_refusal_fails ON conversations",
      );
      await suDb.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS cam_refusal_fails()",
      );
    }
  });

  test("a refusal recorded before the gate was switched off keeps that message unread", async () => {
    await seedConversation(8824, INBOX_OPEN);
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: 8824 },
      data: { mediaRefusedThroughMessageId: 73_000 },
    });
    await deliver({
      convId: 8824,
      chatwootInboxId: INBOX_OPEN,
      event: "message_updated",
      humanHeld: true,
      messageId: 73_000,
    });
    expect(providers.auth).toBe(0);
    expect(providers.stt).toBe(0);
    expect(providers.vision).toBe(0);
  });

  test("a refusal that lands while the voice note is transcribed stops the image of the same message", async () => {
    await seedConversation(8825, INBOX_GATED);
    const id = 74_000;
    authAnswers.push(true);
    duringStt = async () => {
      await suDb.conversation.updateMany({
        where: { tenantId, chatwootConversationId: 8825 },
        data: { mediaRefusedThroughMessageId: id + 1 },
      });
    };
    await deliver({
      convId: 8825,
      chatwootInboxId: INBOX_GATED,
      humanHeld: true,
      messageId: id,
    });
    expect(providers.stt).toBe(1);
    expect(providers.vision).toBe(0);
  });

  test("a refusal is honoured from before its write lands, and after it", async () => {
    await seedConversation(8826, INBOX_GATED);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 8826 },
      select: { id: true },
    });
    const key = mediaRefusalKey(tenantId, conv.id);
    await suDb.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION cam_refusal_slow() RETURNS trigger AS $$
      BEGIN PERFORM pg_sleep(0.6); RETURN NEW; END $$ LANGUAGE plpgsql`);
    await suDb.$executeRawUnsafe(`CREATE TRIGGER cam_refusal_slow BEFORE UPDATE OF media_refused_through_message_id
      ON conversations FOR EACH ROW WHEN (NEW.chatwoot_conversation_id = 8826) EXECUTE FUNCTION cam_refusal_slow()`);
    try {
      authAnswers.push(false);
      const id = 75_000;
      const pending = deliver({
        convId: 8826,
        chatwootInboxId: INBOX_GATED,
        messageId: id,
      });
      let seen: number | null = null;
      for (let i = 0; i < 40 && seen === null; i++) {
        await Bun.sleep(10);
        seen = mediaRefusedHereThrough(key);
      }
      expect(seen).toBe(id);
      await pending;
      expect(mediaRefusedHereThrough(key)).toBe(id);
    } finally {
      await suDb.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS cam_refusal_slow ON conversations",
      );
      await suDb.$executeRawUnsafe(
        "DROP FUNCTION IF EXISTS cam_refusal_slow()",
      );
    }
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

  // Chatwoot delivers a voice note as a `message_created` and two `message_updated` almost at once, and
  // each delivery runs the media pass. One message is read once, whichever delivery gets there first.
  describe("one message, several deliveries", () => {
    beforeEach(() => {
      clearMediaAnnotations();
      providers.stt = 0;
      providers.vision = 0;
      providers.auth = 0;
      authAnswers.length = 0;
      clearContactAuthState();
    });

    // The provider takes a while, as the real one does, so the deliveries overlap while it runs.
    async function burst(
      convId: number,
      inbox: number,
      messageId: number,
      humanHeld = false,
    ) {
      const seen: NormalizedChatwootEvent[] = [];
      duringStt = () => Bun.sleep(80);
      await Promise.all(
        (
          ["message_created", "message_updated", "message_updated"] as const
        ).map((event) =>
          deliver({
            convId,
            chatwootInboxId: inbox,
            event,
            messageId,
            humanHeld,
            seen,
          }),
        ),
      );
      return seen;
    }

    test("three concurrent deliveries of one voice note and image read each file once", async () => {
      await seedConversation(8930, INBOX_OPEN);
      const seen = await burst(8930, INBOX_OPEN, 89_300);
      expect(providers.stt).toBe(1);
      expect(providers.vision).toBe(1);
      for (const n of seen) expect(n.message?.transcribedText).toBe(TRANSCRIPT);
    });

    test("the same on a conversation a person holds", async () => {
      await seedConversation(8931, INBOX_OPEN);
      const seen = await burst(8931, INBOX_OPEN, 89_310, true);
      expect(providers.stt).toBe(1);
      expect(providers.vision).toBe(1);
      for (const n of seen) expect(n.message?.transcribedText).toBe(TRANSCRIPT);
    });

    test("the same behind the contact authorization gate, on a yes", async () => {
      await seedConversation(8932, INBOX_GATED);
      authAnswers.push(true, true, true, true, true, true);
      await burst(8932, INBOX_GATED, 89_320);
      expect(providers.stt).toBe(1);
      expect(providers.vision).toBe(1);
    });

    test("descriptions a later delivery carries on every attachment win over the store", async () => {
      await seedConversation(8934, INBOX_OPEN);
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 89_340 },
        { imageDescription: "Print do pedido 21607129." },
      );
      const seen: NormalizedChatwootEvent[] = [];
      await deliver({
        convId: 8934,
        chatwootInboxId: INBOX_OPEN,
        messageId: 89_340,
        humanHeld: true,
        describedImage: "both",
        seen,
      });
      expect(providers.vision).toBe(0);
      expect(seen[0]?.message?.imageDescription).toContain(
        "Comprovante de pagamento.",
      );
    });

    test("a partial read in the store is asked again for the file it missed", async () => {
      await seedConversation(8935, INBOX_OPEN);
      stashMediaAnnotation(
        { tenantId, instanceId, messageId: 89_350 },
        { imageDescription: "Print do pedido 21607129.", attachmentsUnread: 1 },
      );
      await deliver({
        convId: 8935,
        chatwootInboxId: INBOX_OPEN,
        messageId: 89_350,
        humanHeld: true,
        describedImage: "beside-new",
      });
      expect(providers.vision).toBe(1);
    });

    test("an update that brings a file the first delivery did not have reads only that file", async () => {
      await seedConversation(8936, INBOX_OPEN);
      await deliver({
        convId: 8936,
        chatwootInboxId: INBOX_OPEN,
        messageId: 89_360,
      });
      const seen: NormalizedChatwootEvent[] = [];
      await deliver({
        convId: 8936,
        chatwootInboxId: INBOX_OPEN,
        event: "message_updated",
        messageId: 89_360,
        humanHeld: true,
        extraImage: true,
        seen,
      });
      expect(providers.vision).toBe(2);
      expect(seen[0]?.message?.imageDescription).toContain("k89360.png");
      expect(seen[0]?.message?.attachmentsUnread ?? 0).toBe(0);
    });

    test("an update that arrives after the read reuses it, even without the write-back on the event", async () => {
      await seedConversation(8933, INBOX_OPEN);
      await deliver({
        convId: 8933,
        chatwootInboxId: INBOX_OPEN,
        messageId: 89_330,
      });
      const seen: NormalizedChatwootEvent[] = [];
      await deliver({
        convId: 8933,
        chatwootInboxId: INBOX_OPEN,
        event: "message_updated",
        messageId: 89_330,
        humanHeld: true,
        seen,
      });
      expect(providers.stt).toBe(1);
      expect(providers.vision).toBe(1);
      expect(seen[0]?.message?.transcribedText).toBe(TRANSCRIPT);
    });
  });
});
