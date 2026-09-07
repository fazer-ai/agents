import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// Some transports emit `message_created` with no attachment and hang the voice note on a
// `message_updated` a moment later. The receiver ANALYSED that update — `hasPendingInboundMediaUpdate`
// sends it to the eager pass — but never ingested it, because continuous ingestion asked
// `isNewIncomingMessage`, which a `message_updated` is not. The creation had nothing renderable and
// appended nothing, so the transcription the provider was paid for reached no memory at all
// (issue #478).
//
// Offline by construction: the transcription rides on the ATTACHMENT, which `runEagerMedia` reuses
// verbatim ("never re-transcribe"), so no provider is reached and no model is asked for.
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

const CHATWOOT_INBOX_ID = 4711;
const CONV_ID = 9741;
const AGENT_BOT_ID = 78;
const TRANSCRIPTION = "quero remarcar meu ingresso para sábado";
// An inbox NO responder answers, watched by a monitoring agent: the shape where the append is not a
// supplement to a turn's memory, it is the only memory there will ever be.
const WATCHED_INBOX_ID = 4712;
const WATCHED_CONV_ID = 9742;
const OBSERVER_BOT_ID = 79;

let tenantId: bigint;
let instanceId: bigint;
let agentId: bigint;
let inboxDbId: bigint;
let watchedInboxDbId: bigint;

// A conversation a HUMAN owns: the bot does not handle it (`!act`), which is the branch continuous
// ingestion exists for — nothing else will ever fold this message in.
function lateAudio(
  messageId: number,
  opts: {
    transcribed: boolean;
    conversationId?: number;
    chatwootInboxId?: number;
  },
) {
  return normalizeChatwootEvent({
    event: "message_updated",
    id: messageId,
    content: "",
    message_type: "incoming",
    private: false,
    attachments: [
      {
        id: 90 + messageId,
        file_type: "audio",
        data_url: "https://chat.late.example/audio.ogg",
        ...(opts.transcribed ? { transcribed_text: TRANSCRIPTION } : {}),
      },
    ],
    conversation: {
      id: opts.conversationId ?? CONV_ID,
      inbox_id: opts.chatwootInboxId ?? CHATWOOT_INBOX_ID,
      status: "open",
      contact_inbox: { id: 70_000 + (opts.conversationId ?? CONV_ID) },
      meta: {
        assignee_type: "user",
        assignee: { id: 5, name: "Atendente humana" },
        sender: { id: 21, name: "Cliente" },
      },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
}

async function deliver(
  n: NonNullable<ReturnType<typeof lateAudio>>,
  agentBotId = AGENT_BOT_ID,
) {
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `late-media-${process.pid}-${crypto.randomUUID()}`,
      event: "message_updated",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId,
    normalized: n,
    base: appDb,
    deps: {
      makeClient: (async () =>
        ({
          downloadAttachment: async () => {
            throw new Error(
              "the audio must not be downloaded: it is already transcribed",
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
}

const ingestJobs = () =>
  suDb.schedulerJob.findMany({
    where: { tenantId, kind: "INGEST_MESSAGE" },
    select: { payload: true },
  });

describe.skipIf(!dbUp)("late media reaches memory", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Late", slug: `late-media-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 4,
      baseUrl: "https://chat.late.example",
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
        settings: {},
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
    const watcher = await suDb.agent.create({
      data: {
        tenantId,
        name: "Observadora",
        systemPrompt: "x",
        enabled: true,
        mode: "monitoring",
        settings: {},
      },
      select: { id: true },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: watcher.id,
        chatwootAgentBotId: OBSERVER_BOT_ID,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `late-media-obs-${process.pid}`,
        name: "Observadora",
      },
    });
    const watched = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: WATCHED_INBOX_ID,
        name: "Humanos",
      },
      select: { id: true },
    });
    watchedInboxDbId = watched.id;
    await suDb.inboxObserver.create({
      data: { tenantId, inboxId: watchedInboxDbId, agentId: watcher.id },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: watchedInboxDbId,
        chatwootConversationId: WATCHED_CONV_ID,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${WATCHED_CONV_ID}`,
        lastEventAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inboxDbId,
        chatwootConversationId: CONV_ID,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
        lastEventAt: new Date(Date.now() - 60_000),
      },
      select: { id: true },
    });
  });

  afterAll(async () => {
    if (!dbUp) return;
    if (tenantId) {
      for (const table of [
        "chatwoot_webhook_deliveries",
        "conversations",
        "inbox_observers",
        "chatwoot_agent_bots",
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

  test("a transcription that arrives on the update is folded into the thread", async () => {
    const n = lateAudio(6001, { transcribed: true });
    if (!n) throw new Error("unreachable: the fixture is a valid event");

    await deliver(n);

    const jobs = await ingestJobs();
    const mine = jobs.filter(
      (j) => (j.payload as Record<string, unknown>).messageId === 6001,
    );
    expect(mine).toHaveLength(1);
    const payload = mine[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.role).toBe("customer");
  });

  // The message reaches memory as the WORDS, not as the "not audible" marker the renderer writes for
  // an audio it cannot read — which is the whole point of waiting for the transcription.
  test("the thread gets the transcription, not the unreadable-audio marker", async () => {
    const n = lateAudio(6003, { transcribed: true });
    if (!n) throw new Error("unreachable: the fixture is a valid event");

    await deliver(n);

    const job = (await ingestJobs()).find(
      (j) => (j.payload as Record<string, unknown>).messageId === 6003,
    );
    if (!job) throw new Error("no ingest was armed");
    const row = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        payload: { path: ["messageId"], equals: 6003 },
      },
      select: { payloadSecret: true },
    });
    if (!row?.payloadSecret) throw new Error("the arm carried no text");
    expect(decryptJson<string>(row.payloadSecret)).toContain(TRANSCRIPTION);
  });

  // A SECOND delivery of the same message does not append twice: `armIngest` keys the job by
  // (thread, message) and re-arms the same work, which is what makes widening the runtime gate safe
  // for an event the fork re-fires.
  test("a re-delivered write-back arms the same work, not a second append", async () => {
    const first = lateAudio(6004, { transcribed: true });
    const again = lateAudio(6004, { transcribed: true });
    if (!first || !again)
      throw new Error("unreachable: the fixtures are valid");

    await deliver(first);
    await deliver(again);

    const mine = (await ingestJobs()).filter(
      (j) => (j.payload as Record<string, unknown>).messageId === 6004,
    );
    expect(mine).toHaveLength(1);
  });

  // THE CASE THE FEATURE EXISTS FOR: an inbox no responder answers, watched by a monitoring agent.
  // There is no turn here and there never will be, so the append is not a supplement to somebody
  // else's memory — it is the only memory of what the customer said.
  test("a watcher's conversation folds the transcription in too", async () => {
    const n = lateAudio(6005, {
      transcribed: true,
      conversationId: WATCHED_CONV_ID,
      chatwootInboxId: WATCHED_INBOX_ID,
    });
    if (!n) throw new Error("unreachable: the fixture is a valid event");

    await deliver(n, OBSERVER_BOT_ID);

    const mine = (await ingestJobs()).filter(
      (j) => (j.payload as Record<string, unknown>).messageId === 6005,
    );
    expect(mine).toHaveLength(1);
    const payload = mine[0]?.payload as Record<string, unknown> | undefined;
    expect(payload?.role).toBe("customer");
  });

  // The gate is what the analysis PRODUCED, not the event's shape: an update carrying an audio
  // nobody could transcribe has nothing this side did not already have, and folding it in would
  // write "not audible" over a thread that may already hold the words.
  test("an update whose media was not analysed is not folded in", async () => {
    const n = lateAudio(6002, { transcribed: false });
    if (!n) throw new Error("unreachable: the fixture is a valid event");

    await deliver(n);

    const jobs = await ingestJobs();
    const mine = jobs.filter(
      (j) => (j.payload as Record<string, unknown>).messageId === 6002,
    );
    expect(mine).toHaveLength(0);
  });
});
