import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  processChatwootDelivery,
  turnHadTheWords,
} from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// The one question the late-media gate asks of a turn: did its input carry the customer's WORDS, or
// only the placeholder a voice note is until STT writes back.
describe("turnHadTheWords", () => {
  test("a message with no audio is the message itself", () => {
    expect(turnHadTheWords({ hasAudio: false, transcribedText: null })).toBe(
      true,
    );
  });

  test("audio already transcribed carries its words", () => {
    expect(turnHadTheWords({ hasAudio: true, transcribedText: "alô" })).toBe(
      true,
    );
  });

  // THE CASE THE COLUMN EXISTS NOT TO BREAK: a turn that ran on the placeholder must not claim the
  // message, or the write-back's own ingest is suppressed and the words reach nobody.
  test("audio still waiting on STT does not", () => {
    expect(turnHadTheWords({ hasAudio: true, transcribedText: null })).toBe(
      false,
    );
    expect(
      turnHadTheWords({ hasAudio: true, transcribedText: undefined }),
    ).toBe(false);
    // An empty transcription is not words either.
    expect(turnHadTheWords({ hasAudio: true, transcribedText: "" })).toBe(
      false,
    );
  });
});

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

const INBOX_ID = 83;
const OUR_BOT = 23;
let tenantId = 0n;
let instanceId = 0n;
let deliverySeq = 0;
const realFetch = globalThis.fetch;

// The direct path (debounce off) asks the same question with the attachment FILE TYPES: an audio whose
// url has not landed yet is still audio, so the turn that ran on its placeholder does not claim it.
describe.skipIf(!dbUp)("the direct turn claims only the words it had", () => {
  beforeAll(async () => {
    globalThis.fetch = (async () =>
      Response.json({ payload: [] })) as unknown as typeof globalThis.fetch;
    const t = await suDb.tenant.create({
      data: { name: "WORDS", slug: `words-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 33,
      baseUrl: "https://chat.words.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você atende.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "production",
        settings: { debounce: { enabled: false } },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: OUR_BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `words-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_ID,
        name: "SAC",
        agentId: agent.id,
      },
    });
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
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
      "chatwoot_deployments",
    ]) {
      await suDb
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${tenantId}`)
        .catch(() => {});
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  async function directTurn(
    convId: number,
    message: Record<string, unknown>,
  ): Promise<boolean | null> {
    deliverySeq += 1;
    const messageId = 83_000 + convId;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      message_type: "incoming",
      sender: { id: 88, name: "Cliente", type: null },
      conversation: {
        id: convId,
        inbox_id: INBOX_ID,
        status: "pending",
        contact_inbox: { id: 83_000 + convId },
        meta: { assignee: null, sender: { id: 88, name: "Cliente" } },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000) + deliverySeq,
      },
      ...message,
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `words-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
        conversationId: convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });
    let outcome: string | null = null;
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: OUR_BOT,
      normalized: n,
      base: appDb,
      onDirectTurn: (r) => {
        outcome = r.kind === "outcome" ? r.outcome : `error:${String(r.error)}`;
      },
      deps: {
        makeClient: (async () =>
          ({
            sendMessage: async () => ({}),
            sendPrivateNote: async () => ({}),
            toggleTyping: async () => ({}),
          }) as unknown as ChatwootClient) as never,
        makeModel: () => new FakeListChatModel({ responses: ["Entendi."] }),
      },
    });
    // Controle positivo da montagem: o turno direto rodou de fato.
    expect(outcome as string | null).not.toBeNull();
    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { turnCovered: true },
    });
    return row.turnCovered;
  }

  test("a text message is claimed by the turn that answered it", async () => {
    expect(await directTurn(1, { content: "qual o horário?" })).toBe(true);
  });

  test("a voice note whose url has not landed is not claimed", async () => {
    expect(
      await directTurn(2, {
        content: null,
        attachments: [{ id: 7, file_type: "audio" }],
      }),
    ).not.toBe(true);
  });
});
