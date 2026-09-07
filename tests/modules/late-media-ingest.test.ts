import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  fillLedgerTranscribedMessage,
  processChatwootDelivery,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
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
// An inbox with BOTH: a responder of ours and the same watcher beside it. The shape where the
// observer must NOT remember on its own, because the responder's own delivery of the same message
// already did (issue #478 review, round 1).
const BOTH_INBOX_ID = 4713;
const BOTH_CONV_ID = 9743;
const RESPONDER_BOT_ID = 80;

let tenantId: bigint;
let instanceId: bigint;
let agentId: bigint;
let inboxDbId: bigint;
let watchedInboxDbId: bigint;
let bothInboxDbId: bigint;

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

// A client whose scheduler writes for an ingestion all throw: the transient failure the arm is
// retried against, driven to the end of its retries.
function failingIngest() {
  return appDb.$extends({
    query: {
      schedulerJob: {
        $allOperations({ args, query }) {
          const shape = JSON.stringify(args, (_k, v) =>
            typeof v === "bigint" ? String(v) : v,
          );
          if (shape.includes("INGEST_MESSAGE")) {
            throw new Error("injected: scheduler unavailable");
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

async function newDeliveryRow() {
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `late-media-${process.pid}-${crypto.randomUUID()}`,
      event: "message_updated",
      status: "PENDING",
    },
    select: { id: true },
  });
  return row.id;
}

async function deliver(
  n: NonNullable<ReturnType<typeof lateAudio>>,
  agentBotId = AGENT_BOT_ID,
  base: PrismaClient = appDb,
  // Created by the caller when it needs the id even if the delivery throws.
  deliveryRowId?: bigint,
) {
  const rowId = deliveryRowId ?? (await newDeliveryRow());
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: rowId,
    agentBotId,
    normalized: n,
    base,
    deps: {
      sleep: async () => {},
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
  return rowId;
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
    // The inbox with a responder AND a watcher. The binding is stamped NOW, which is what forces
    // `responderCoversMessage` past its clock shortcuts and onto the ledger: a binding older than the
    // event answers "covered" without looking, and then the test would prove nothing about the
    // sibling lookup this round is here to fix.
    const responder = await suDb.agent.create({
      data: {
        tenantId,
        name: "Respondedora",
        systemPrompt: "x",
        enabled: true,
        mode: "production",
        settings: {},
      },
      select: { id: true },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: responder.id,
        chatwootAgentBotId: RESPONDER_BOT_ID,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `late-media-resp-${process.pid}`,
        name: "Respondedora",
      },
    });
    const both = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: BOTH_INBOX_ID,
        name: "WhatsApp vigiado",
        agentId: responder.id,
        responderBoundAt: new Date(),
      },
      select: { id: true },
    });
    bothInboxDbId = both.id;
    await suDb.inboxObserver.create({
      data: { tenantId, inboxId: bothInboxDbId, agentId: watcher.id },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: bothInboxDbId,
        chatwootConversationId: BOTH_CONV_ID,
        status: "open",
        threadId: `${tenantId}:${instanceId}:${BOTH_CONV_ID}`,
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

  // THE OTHER HALF OF WIDENING THE GATE (issue #478 review, round 1). On an inbox with a responder
  // of ours, Chatwoot fans the same message to both routes, and the responder's own delivery of it
  // is what folds it into the shared memory. The observer's copy must stand down — and standing
  // down means finding the responder's sibling row, which it can only do if this update NAMES the
  // message. Called with `message: null`, the check answered "not covered" without looking and the
  // thread gained a duplicate the ingest dedup window cannot see: it is written by the ingest job
  // alone, so a message a TURN handled was never in it.
  test("beside a responder that already has the message, the watcher stands down", async () => {
    const n = lateAudio(6006, {
      transcribed: true,
      conversationId: BOTH_CONV_ID,
      chatwootInboxId: BOTH_INBOX_ID,
    });
    if (!n) throw new Error("unreachable: the fixture is a valid event");
    // The responder's own delivery of the same message, as the receiver records it. Unclaimed, which
    // is a row whose work is still ahead of it — the sibling shape `responderCoversMessage` counts.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `late-media-sibling-${process.pid}-${crypto.randomUUID()}`,
        event: "message_created",
        status: "PENDING",
        conversationId: BOTH_CONV_ID,
        inboundMessageId: 6006,
        routeAgentBotId: RESPONDER_BOT_ID,
      },
    });

    await deliver(n, OBSERVER_BOT_ID);

    const mine = (await ingestJobs()).filter(
      (j) => (j.payload as Record<string, unknown>).messageId === 6006,
    );
    expect(mine).toHaveLength(0);
  });

  // The control for the case above, and it is what proves the stand-down was a LOOKUP rather than
  // the whole path being off on this inbox: same inbox, same route, no sibling row — so no
  // responder delivery ever carried this message, and the watcher is the only memory it has.
  test("with no sibling delivery, the watcher beside a responder still remembers", async () => {
    const n = lateAudio(6007, {
      transcribed: true,
      conversationId: BOTH_CONV_ID,
      chatwootInboxId: BOTH_INBOX_ID,
    });
    if (!n) throw new Error("unreachable: the fixture is a valid event");

    await deliver(n, OBSERVER_BOT_ID);

    const mine = (await ingestJobs()).filter(
      (j) => (j.payload as Record<string, unknown>).messageId === 6007,
    );
    expect(mine).toHaveLength(1);
  });

  // AND WHAT AN ENQUEUE THAT DOES NOT LAND MEANS (issue #478 review, round 2). `observerHolds` is
  // inbound-only — an update is not a creation — so on its own it settles this delivery PROCESSED
  // whatever the arm answered, and a scheduler blip then discards the transcription for good: the
  // row is terminal, and the row was the only thing that knew. The words come around once.
  //
  // Two assertions and they are the pair: the delivery must FAIL (the row stays PROCESSING, which is
  // what the sweep reads and replays) and nothing may be marked handled behind it.
  test("an arm that cannot be queued leaves the delivery for the sweep", async () => {
    const n = lateAudio(6010, { transcribed: true });
    if (!n) throw new Error("unreachable: the fixture is a valid event");
    const before = (await ingestJobs()).length;

    // The row is created by the test, not by `deliver`, because the delivery is meant to throw and
    // the id has to outlive it — reading it back is the whole assertion.
    const rowId = await newDeliveryRow();
    await expect(
      deliver(n, AGENT_BOT_ID, failingIngest(), rowId),
    ).rejects.toThrow("could not be armed");

    expect((await ingestJobs()).length).toBe(before);
    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: rowId },
      select: { status: true },
    });
    expect(row.status).toBe("PROCESSING");
  });

  // WHAT THE LEDGER KEEPS ABOUT IT, which is the difference between a process death here being
  // recoverable and being silent. A delivery that dies between the claim and the arm leaves a row
  // nothing reads unless the row NAMES the message: `classifyStrandedDelivery` closes every
  // `message_updated` as carrying nothing, so the sweep would file no line and arm no replay, and
  // the transcription — the only readable form this message ever takes on a route where no turn
  // runs — would be gone with nobody told.
  test("the ledger row for a transcribed update names the message", async () => {
    const n = lateAudio(6008, { transcribed: true });
    if (!n) throw new Error("unreachable: the fixture is a valid event");
    const deliveryId = `late-media-ledger-${process.pid}-${crypto.randomUUID()}`;

    await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId,
      deliveryId,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
      deps: {
        makeClient: (async () =>
          ({
            downloadAttachment: async () => {
              throw new Error("the audio must not be downloaded");
            },
            sendMessage: async () => ({}),
            sendPrivateNote: async () => ({}),
          }) as unknown as ChatwootClient) as never,
        makeModel: () => {
          throw new Error("a late-media update must not run a turn");
        },
      },
    });

    const row = await suDb.chatwootWebhookDelivery.findFirst({
      where: { tenantId, deliveryId },
      select: { event: true, inboundMessageId: true, conversationId: true },
    });
    expect(row?.event).toBe("message_updated");
    expect(row?.inboundMessageId).toBe(6008);
    expect(row?.conversationId).toBe(CONV_ID);
  });

  // And the row an ordinary write-back leaves is unchanged, which is what keeps the pair a
  // discriminator: an inbound id on a `message_updated` can only have come from this build, so the
  // sweep can read it as "a transcription was owed" without mistaking a legacy row for one.
  test("an update with nothing analysed leaves the ledger's message column null", async () => {
    const n = lateAudio(6009, { transcribed: false });
    if (!n) throw new Error("unreachable: the fixture is a valid event");
    const deliveryId = `late-media-ledger-${process.pid}-${crypto.randomUUID()}`;

    await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId,
      deliveryId,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
      deps: {
        makeClient: (async () =>
          ({
            downloadAttachment: async () => {
              throw new Error("the audio must not be downloaded");
            },
            sendMessage: async () => ({}),
            sendPrivateNote: async () => ({}),
          }) as unknown as ChatwootClient) as never,
        makeModel: () => {
          throw new Error("a late-media update must not run a turn");
        },
      },
    });

    const row = await suDb.chatwootWebhookDelivery.findFirst({
      where: { tenantId, deliveryId },
      select: { inboundMessageId: true },
    });
    expect(row?.inboundMessageId).toBeNull();
  });

  // WHEN THE WORDS ARE OURS, NOT THE WIRE'S (issue #478 review, round 3). `ledgerFactsOf` runs before
  // the eager pass and reads the payload: on the update that brings an audio nobody has transcribed
  // yet it writes no message id, correctly — there were no words. The pass then pays a provider for
  // them and stashes them on the event, and from that instant this delivery owes an append that only
  // the row could name. So the row learns it there, and these are the two rules that fill has.
  test("the ledger learns a message whose words the eager pass produced", async () => {
    const rowId = await newDeliveryRow();
    const n = lateAudio(6011, { transcribed: true });
    if (!n) throw new Error("unreachable: the fixture is a valid event");

    await fillLedgerTranscribedMessage(tenantId, rowId, n, appDb);

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: rowId },
      select: { inboundMessageId: true },
    });
    expect(row.inboundMessageId).toBe(6011);
  });

  // FILL-ONLY, never an overwrite, which is the same rule the legacy fill has and for the same
  // reason: a row that already names its message names the right one, and a later write could only
  // move it. And nothing to fill from an update with no words — the pass produced none.
  test("the fill never moves a message the row already names, and needs words", async () => {
    const taken = await newDeliveryRow();
    await suDb.chatwootWebhookDelivery.update({
      where: { id: taken },
      data: { inboundMessageId: 4242 },
    });
    const withWords = lateAudio(6012, { transcribed: true });
    const without = lateAudio(6013, { transcribed: false });
    if (!withWords || !without)
      throw new Error("unreachable: the fixtures are valid");

    await fillLedgerTranscribedMessage(tenantId, taken, withWords, appDb);
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: taken },
          select: { inboundMessageId: true },
        })
      ).inboundMessageId,
    ).toBe(4242);

    const empty = await newDeliveryRow();
    await fillLedgerTranscribedMessage(tenantId, empty, without, appDb);
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: empty },
          select: { inboundMessageId: true },
        })
      ).inboundMessageId,
    ).toBeNull();
  });

  // WHERE THE FILL IS CALLED FROM, read off the source. The two cases above prove the rules; this
  // one proves the wiring, and it is read rather than driven because driving it means a vault
  // credential and an HTTP fake of a provider — the STT registry is a frozen map, so no stub can be
  // registered. What matters is the POSITION: inside the branch that just produced a transcription,
  // before the statement after it, because from there on the words exist nowhere durable but the row.
  test("the fill sits in the branch that produced the transcription", async () => {
    const src = await Bun.file(
      new URL("../../src/modules/chatwoot/webhook.ts", import.meta.url)
        .pathname,
    ).text();
    const stash = src.indexOf("n.message.transcribedText = text;");
    expect(stash).toBeGreaterThan(-1);
    const fill = src.indexOf("fillLedgerTranscribedMessage(", stash);
    expect(fill).toBeGreaterThan(stash);
    // Nothing between them but the assignment itself, comments, and the fill's own `await`: no other
    // call, no branch, nothing that could be skipped or that could throw first.
    const between = src
      .slice(stash, fill)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))
      .join(" ");
    expect(between).toBe("n.message.transcribedText = text; await");
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
