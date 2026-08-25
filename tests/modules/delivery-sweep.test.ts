import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { sweepStrandedDeliveries } from "@/modules/chatwoot/delivery-sweep";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  processChatwootDelivery,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { debounceDedupeKey } from "@/modules/debounce/service";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// A Chatwoot delivery stranded on PROCESSING, and the sweep that gets the customer answered anyway
// (issue #228).
//
// `processChatwootDelivery` brackets its work between a CAS `PENDING -> PROCESSING` and a final
// `-> PROCESSED`. A process that dies in between leaves the row on PROCESSING forever: Chatwoot has
// its 200 and will not redeliver, and a redelivery would CAS against `PENDING` and match nothing.
// The customer's message is then never answered by anything.
//
// The strand is produced here by writing the row in the state a dead process leaves behind, because
// that is the only way a live process can be in it: if the process survives to the end of the
// function, the second CAS runs. That the state is REACHABLE was measured separately, by injecting
// an interruption between the two CAS points on this repo's own code — it leaves
// `status = PROCESSING, attempts = 0`, exactly the row below.
//
// The effect asserted is the customer's reply reaching Chatwoot, not the ledger row changing colour:
// the issue is a lost message, and a row that says PROCESSED while nothing was answered would pass a
// ledger-only test.

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

const CHATWOOT_INBOX_ID = 61;
const AGENT_BOT_ID = 9;
const REPLY = "Desculpe a demora! Como posso ajudar?";
const STALE_MS = 10 * 60 * 1000;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let deliverySeq = 0;

const threadOf = (convId: number) =>
  chatwootThreadId(tenantId, instanceId, convId);

// Stub Chatwoot: the flush's re-read is the ONLY place the customer's message comes from once the
// delivery that carried it is gone, so this is what makes the recovery observable.
function makeStub(opts: {
  messages: Array<{ id: number; content: string }>;
  sent: Array<[number, string]>;
}) {
  const client = {
    getMessages: async () => ({
      payload: opts.messages.map((m) => ({
        id: m.id,
        content: m.content,
        message_type: 0,
        private: false,
      })),
    }),
    sendMessage: async (conversationId: number, content: string) => {
      opts.sent.push([conversationId, content]);
      return {};
    },
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
  return async () => client;
}

async function seedConversation(
  convId: number,
  over: { lastHandledMessageId?: number | null } = {},
) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      assigneeId: null,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastHandledMessageId: over.lastHandledMessageId ?? null,
      contactInboxId: 61_000 + convId,
    },
  });
}

// A ledger row in the state a process death leaves behind.
async function seedStrandedDelivery(over: {
  conversationId: number | null;
  ageMs: number;
  attempts?: number;
}): Promise<bigint> {
  deliverySeq += 1;
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `sweep-${process.pid}-${deliverySeq}`,
      event: "message_created",
      status: "PROCESSING",
      attempts: over.attempts ?? 0,
      receivedAt: new Date(Date.now() - over.ageMs),
      conversationId: over.conversationId,
    },
    select: { id: true },
  });
  return row.id;
}

function debounceJobFor(convId: number, id: bigint): ClaimedJob {
  return {
    id,
    tenantId,
    kind: "DEBOUNCE",
    payload: { threadId: threadOf(convId), agentBotId: AGENT_BOT_ID },
    attempts: 0,
    claimSeq: 0,
  };
}

async function armedFlush(convId: number) {
  return suDb.schedulerJob.findFirst({
    where: {
      tenantId,
      kind: "DEBOUNCE",
      dedupeKey: debounceDedupeKey(threadOf(convId)),
    },
    select: { id: true, status: true, payload: true },
  });
}

describe.skipIf(!dbUp)("a delivery stranded on PROCESSING", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SWP", slug: `swp-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 61,
      baseUrl: "https://chat.sweep.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          debounce: { enabled: true, windowSeconds: 15 },
          split: { enabled: false },
        },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: AGENT_BOT_ID,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `swp-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const table of [
      "execution_logs",
      "scheduler_jobs",
      "llm_usage",
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "vault_entries",
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

  test("cannot be recovered by a redelivery: the CAS matches nothing", async () => {
    const convId = 8801;
    await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
    });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 9001,
      private: false,
      content: "oi, continua aí?",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        status: "pending",
        contact_inbox: { id: 61_000 + convId },
        meta: { assignee: null, sender: { id: 77, name: "Cliente" } },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("payload did not normalize");

    // This is what every redelivery of that event does, and why the message is lost: Chatwoot's
    // retry ladder is spent, and even a manual replay walks into the same closed door.
    const outcome = await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: rowId,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
    });
    expect(outcome).toBe("skipped");
    const after = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: rowId },
      select: { status: true },
    });
    expect(after.status).toBe("PROCESSING");

    // Dropped here because the sweep is tenant-wide: left behind, this row is a second stranded
    // delivery for every later test's pass, and their verdict counts would be about two rows.
    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("is recovered by the sweep, and the customer gets the answer", async () => {
    const convId = 8802;
    const messageId = 9101;
    // The watermark is below the message: the delivery died before anything answered it.
    await seedConversation(convId, { lastHandledMessageId: messageId - 1 });
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
    });

    expect(await armedFlush(convId)).toBeNull();

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.recover).toBe(1);

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: rowId },
      select: { status: true, attempts: true },
    });
    expect(row.status).toBe("PROCESSED");
    // The column the schema has carried since the ledger existed, and that nothing wrote until now.
    expect(row.attempts).toBe(1);

    const job = await armedFlush(convId);
    if (job === null) throw new Error("the sweep armed no flush");
    expect(job.status).toBe("PENDING");
    // The identity the flush needs to tell OUR bot from another persona's, derived from the mirror
    // rather than stored on the delivery.
    expect((job.payload as { agentBotId?: number }).agentBotId).toBe(
      AGENT_BOT_ID,
    );

    // The effect the issue is about: the message the dead delivery was carrying gets answered. The
    // stub is what proves the flush never needed the event body — it re-reads from Chatwoot.
    const sent: Array<[number, string]> = [];
    const out = await flushDebounceJob({
      job: debounceJobFor(convId, job.id),
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: [REPLY] }),
        makeClient: makeStub({
          messages: [{ id: messageId, content: "oi, continua aí?" }],
          sent,
        }),
        checkpointer: new MemorySaver(),
        sleep: async () => {},
      },
    });
    expect(out.outcome).toBe("done");
    expect(sent).toEqual([[convId, REPLY]]);
  });

  test("leaves a delivery that is still in flight alone", async () => {
    const convId = 8803;
    await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: 5_000,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts["in-flight"]).toBe(1);
    expect(counts.recover).toBe(0);

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: rowId },
      select: { status: true, attempts: true },
    });
    expect(row.status).toBe("PROCESSING");
    expect(row.attempts).toBe(0);
    // Nothing armed: a live process is still holding this delivery, and a flush racing it would
    // answer the burst twice.
    expect(await armedFlush(convId)).toBeNull();

    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("records a loss when the mirror does not know the conversation", async () => {
    // The one strand this design cannot recover: the process died between the CAS and the mirror
    // write, so no row exists to read the inbox and the bot's identity from. What matters is that
    // the ledger says a message was LOST rather than closing the row as if it had been handled —
    // `WHERE status = 'DEAD'` is the only place an operator can find these.
    const convId = 8804;
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.recover).toBe(1);

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: rowId },
      select: { status: true, attempts: true },
    });
    expect(row.status).toBe("DEAD");
    expect(row.attempts).toBe(1);
    expect(await armedFlush(convId)).toBeNull();
  });

  test("closes a stranded delivery that names no conversation", async () => {
    const rowId = await seedStrandedDelivery({
      conversationId: null,
      ageMs: STALE_MS * 2,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.unrecoverable).toBe(1);

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: rowId },
      select: { status: true, processedAt: true },
    });
    // PROCESSED, not DEAD, and the difference is the point: an event that names no conversation
    // carries no customer message, so nothing was lost and it must not appear in the loss list.
    expect(row.status).toBe("PROCESSED");
    expect(row.processedAt).not.toBeNull();
  });

  test("gives up on a delivery whose recovery keeps failing", async () => {
    const convId = 8805;
    await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      attempts: 3,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.exhausted).toBe(1);

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: rowId },
      select: { status: true, attempts: true },
    });
    expect(row.status).toBe("DEAD");
    expect(row.attempts).toBe(4);
    // A poisoned delivery stops cycling: nothing is armed, and the next pass will not see it.
    expect(await armedFlush(convId)).toBeNull();
    expect(
      (await sweepStrandedDeliveries({ tenantId, base: appDb })).exhausted,
    ).toBe(0);
  });

  test("records the conversation on the ledger row, which is what recovery needs", async () => {
    const convId = 8806;
    await seedConversation(convId);
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: 9601,
      private: false,
      content: "oi",
      message_type: "incoming",
      sender: { id: 77, name: "Cliente", type: null },
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        // Held by a human, so the delivery takes the gate's exit and never spends a model call.
        // What is being asserted is the LEDGER INSERT, which happens before any of that.
        status: "open",
        contact_inbox: { id: 61_000 + convId },
        meta: {
          assignee_type: "User",
          assignee: { id: 5, name: "Ana" },
          sender: { id: 77, name: "Cliente" },
        },
        channel: "Channel::Api",
        last_activity_at: Math.floor(Date.now() / 1000),
        updated_at: Math.floor(Date.now() / 1000),
      },
    });
    if (!n) throw new Error("payload did not normalize");
    const deliveryId = `sweep-real-${process.pid}`;
    await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId,
      deliveryId,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
    });

    const row = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId },
      select: { conversationId: true, event: true },
    });
    expect(row.conversationId).toBe(convId);
    // And nothing else about the event: no column here can hold the customer's words.
    expect(row.event).toBe("message_created");
  });
});
