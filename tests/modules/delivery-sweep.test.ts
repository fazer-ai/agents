import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId } from "@/graph/checkpointer";
import {
  deliverySweepHandler,
  ensureDeliverySweep,
  finish,
  sweepStrandedDeliveries,
} from "@/modules/chatwoot/delivery-sweep";
import { setConnectedAccounts } from "@/modules/chatwoot/management";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  processChatwootDelivery,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

// A Chatwoot delivery stranded by a process death, and the sweep that says so (issue #228).
//
// `processChatwootDelivery` brackets its work between a CAS `PENDING -> PROCESSING` and a final
// `-> PROCESSED`, with the 200 already out before either. A process that dies anywhere in there
// leaves a non-terminal row with nothing working it, and no redelivery is coming.
//
// The strand is produced here by writing the row in the state a dead process leaves behind, because
// that is the only way a live process can be in it: if the process survives to the end of the
// function, the second CAS runs. That the state is REACHABLE was measured separately, by injecting
// an interruption between the two CAS points on this repo's own code — it leaves
// `status = PROCESSING, attempts = 0`, exactly the row below.
//
// The sweep does NOT answer the customer (that is #295), so the effect asserted is the pair a
// stranded row leaves for an operator: the ledger row terminal on DEAD, and an error-level line on
// the conversation, which is what the Logs page reads and the alert channels dispatch.

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
const STALE_MS = 30 * 60 * 1000;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let deliverySeq = 0;

const threadOf = (convId: number) =>
  chatwootThreadId(tenantId, instanceId, convId);

async function seedConversation(
  convId: number,
  over: { lastHandledMessageId?: number | null } = {},
) {
  return suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastHandledMessageId: over.lastHandledMessageId ?? null,
      contactInboxId: 61_000 + convId,
    },
    select: { id: true },
  });
}

// A ledger row in the state a process death leaves behind.
async function seedStrandedDelivery(over: {
  conversationId: number | null;
  ageMs: number;
  inboundMessageId?: number | null;
  status?: "PENDING" | "PROCESSING";
  event?: string;
}): Promise<bigint> {
  deliverySeq += 1;
  const row = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `sweep-${process.pid}-${deliverySeq}`,
      event: over.event ?? "message_created",
      status: over.status ?? "PROCESSING",
      receivedAt: new Date(Date.now() - over.ageMs),
      conversationId: over.conversationId,
      inboundMessageId: over.inboundMessageId ?? null,
    },
    select: { id: true },
  });
  return row.id;
}

async function statusOf(rowId: bigint) {
  return suDb.chatwootWebhookDelivery.findUniqueOrThrow({
    where: { id: rowId },
    select: { status: true, processedAt: true },
  });
}

// Polled and scoped: emitFlowEvent is fire-and-forget, so an unpolled read races the write it is
// asserting and an unscoped one answers with a neighbour's row.
async function deliveryLines(convDbId: bigint | null, waitMs = 2000) {
  const started = Date.now();
  while (true) {
    const rows = await suDb.executionLog.findMany({
      where: {
        tenantId,
        stage: "delivery",
        ...(convDbId !== null ? { conversationId: convDbId } : {}),
      },
      select: { level: true, status: true, detail: true },
    });
    if (rows.length > 0 || Date.now() - started > waitMs) return rows;
    await Bun.sleep(25);
  }
}

// The line a strand leaves when the mirror does not know the conversation: no conversation id to
// scope by, so it is found by its absence. Polled for the same reason as the scoped read.
async function unscopedDeliveryLines(waitMs = 2000) {
  const started = Date.now();
  while (true) {
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, stage: "delivery", conversationId: null },
      select: { level: true, detail: true },
    });
    if (rows.length > 0 || Date.now() - started > waitMs) return rows;
    await Bun.sleep(25);
  }
}

describe.skipIf(!dbUp)("a delivery stranded by a process death", () => {
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
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {},
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
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "inboxes",
      "chatwoot_agent_bots",
      "agent_tool_selections",
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

  test("cannot be recovered by a redelivery: the CAS matches nothing", async () => {
    const convId = 8801;
    await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: 9001,
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
    expect((await statusOf(rowId)).status).toBe("PROCESSING");

    // Dropped here because the sweep is tenant-wide: left behind, this row is a second stranded
    // delivery for every later test's pass, and their counts would be about two rows.
    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("is recorded as a loss the operator can find", async () => {
    const convId = 8802;
    const messageId = 9101;
    // The watermark is below the message: nothing ever answered it.
    const conv = await seedConversation(convId, {
      lastHandledMessageId: messageId - 1,
    });
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: messageId,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(1);

    // Terminal, and DEAD rather than PROCESSED: `WHERE status = 'DEAD'` is the list of customers
    // who wrote and were never answered, and closing it as PROCESSED would hide it from that list.
    const row = await statusOf(rowId);
    expect(row.status).toBe("DEAD");
    expect(row.processedAt).not.toBeNull();

    // The half an operator actually reads: an error line ON the conversation, which is what the
    // Logs page renders and what the alert channels dispatch.
    const lines = await deliveryLines(conv.id);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (line === undefined) throw new Error("no delivery line was written");
    expect(line.level).toBe("error");
    const detail = line.detail as Record<string, unknown>;
    expect(detail.outcome).toBe("stranded");
    expect(detail.messageId).toBe(messageId);
    expect(detail.knownToMirror).toBe(true);
  });

  test("records a PENDING strand too, which the CAS never reached", async () => {
    // The ack is spent before the ledger row is written, so a death between the insert and the CAS
    // leaves PENDING. #226's answer — a redelivery goes on to the CAS instead of being dropped —
    // only helps when a redelivery arrives, and Chatwoot holds a 200, so usually none does.
    const convId = 8803;
    const messageId = 9201;
    const conv = await seedConversation(convId, {
      lastHandledMessageId: messageId - 1,
    });
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: messageId,
      status: "PENDING",
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(1);
    expect((await statusOf(rowId)).status).toBe("DEAD");
    expect((await deliveryLines(conv.id))[0]?.level).toBe("error");
  });

  test("leaves a delivery that is still in flight alone", async () => {
    const convId = 8804;
    const conv = await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: 5_000,
      inboundMessageId: 9301,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.tooFresh).toBe(1);
    expect(counts.lost).toBe(0);
    expect((await statusOf(rowId)).status).toBe("PROCESSING");
    expect(await deliveryLines(conv.id, 200)).toHaveLength(0);

    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("closes a strand whose message was answered anyway", async () => {
    // A redelivery, or a later burst's flush, moved the watermark past it. Nothing is owed, so it
    // must not appear in the loss list.
    const convId = 8805;
    const messageId = 9401;
    const conv = await seedConversation(convId, {
      lastHandledMessageId: messageId,
    });
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: messageId,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.closed).toBe(1);
    expect(counts.lost).toBe(0);
    expect((await statusOf(rowId)).status).toBe("PROCESSED");
    expect(await deliveryLines(conv.id, 200)).toHaveLength(0);
  });

  test("reports a loss when the agent does not coalesce, whatever the watermark", async () => {
    // With debouncing off each delivery answers its own message directly, so a LATER message moves
    // the watermark past the stranded one without the model ever having seen it. Reading that as
    // "answered" would close a real loss, and the same numbers read the other way one test up.
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Direto",
        systemPrompt: "p",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: { debounce: { enabled: false } },
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: CHATWOOT_INBOX_ID + 1,
        name: "Direto",
        agentId: agent.id,
      },
    });
    const convId = 8814;
    const messageId = 9451;
    const conv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: convId,
        status: "pending",
        inboxId: inbox.id,
        threadId: threadOf(convId),
        lastEventAt: new Date(),
        // Past the stranded message, exactly as in the coalescing test above.
        lastHandledMessageId: messageId + 40,
        contactInboxId: 61_000 + convId,
      },
      select: { id: true },
    });
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: messageId,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(1);
    expect(counts.closed).toBe(0);
    expect((await statusOf(rowId)).status).toBe("DEAD");
    expect((await deliveryLines(conv.id))[0]?.level).toBe("error");
  });

  test("closes a strand that carried no inbound message", async () => {
    // A conversation update, or the bot's own reply coming back around as a `message_created`.
    // Neither is a customer waiting.
    const convId = 8806;
    const conv = await seedConversation(convId);
    const rowId = await seedStrandedDelivery({
      conversationId: convId,
      ageMs: STALE_MS * 2,
      inboundMessageId: null,
      event: "conversation_updated",
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.closed).toBe(1);
    expect(counts.lost).toBe(0);
    expect((await statusOf(rowId)).status).toBe("PROCESSED");
    expect(await deliveryLines(conv.id, 200)).toHaveLength(0);
  });

  test("reports a loss even when the mirror does not know the conversation", async () => {
    // The process died before the mirror write, so there is no watermark to compare against. The
    // safe reading of a question that cannot be answered is the one that puts the row in front of
    // an operator, and the line is filed without a conversation because it is the only trace there
    // is.
    const rowId = await seedStrandedDelivery({
      conversationId: 8899,
      ageMs: STALE_MS * 2,
      inboundMessageId: 9501,
    });

    const counts = await sweepStrandedDeliveries({ tenantId, base: appDb });
    expect(counts.lost).toBe(1);
    expect((await statusOf(rowId)).status).toBe("DEAD");

    const lines = await unscopedDeliveryLines();
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (line === undefined) throw new Error("no delivery line was written");
    expect((line.detail as Record<string, unknown>).knownToMirror).toBe(false);
  });

  test("writes nothing over a row that moved under it", async () => {
    // The terminal write CASes on the status the scan read. Losing that race means a redelivery
    // claimed the row in between and is processing the event right now — the outcome this sweep
    // exists to report the absence of — so nothing is recorded. Asked directly: a constructed race
    // here goes green for the wrong reason more often than it detects.
    const rowId = await seedStrandedDelivery({
      conversationId: 8807,
      ageMs: STALE_MS * 2,
      inboundMessageId: 9601,
      status: "PENDING",
    });
    const stale = {
      id: rowId,
      status: "PENDING" as const,
      chatwootInstanceId: instanceId,
      deliveryId: "x",
      event: "message_created",
      receivedAt: new Date(),
      conversationId: 8807,
      inboundMessageId: 9601,
    };
    // Somebody else claimed it.
    await suDb.chatwootWebhookDelivery.update({
      where: { id: rowId },
      data: { status: "PROCESSING" },
    });

    expect(await finish(stale, tenantId, "DEAD", appDb)).toBe(false);
    expect((await statusOf(rowId)).status).toBe("PROCESSING");

    await suDb.chatwootWebhookDelivery.delete({ where: { id: rowId } });
  });

  test("is armed when a Chatwoot account is connected, not only at boot", async () => {
    // The boot arm alone leaves a first-run install with nothing: `/setup` creates the tenant after
    // boot has already counted zero tenants, and there is no second arming point.
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId} AND kind = 'DELIVERY_SWEEP'`,
    );
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    // A NEW account: account 61 is already connected by the seed, and reconnecting an active one
    // takes a branch that creates nothing.
    await setConnectedAccounts(
      ctx,
      [61, 62],
      { makeClient: async () => ({ listInboxes: async () => [] }) as never },
      appDb,
    );
    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "DELIVERY_SWEEP" },
      select: { status: true },
    });
    expect(job?.status).toBe("PENDING");
  });

  test("comes back from the dead on a re-arm", async () => {
    // A job's failure budget counts its whole LIFETIME (`rescheduleJob` never clears `attempts`),
    // so a sweep meant to run forever is dead-lettered on its fifth failure ever. A re-arm that did
    // not reset would revive the row only for it to die on the next one. Issue #287 is the general
    // case; this is the arming call answering for itself.
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId} AND kind = 'DELIVERY_SWEEP'`,
    );
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "DELIVERY_SWEEP",
        dedupeKey: "delivery-sweep",
        runAt: new Date(),
        status: "DEAD",
        attempts: 4,
        payload: {},
      },
    });

    await ensureDeliverySweep(tenantId, appDb);

    const job = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, kind: "DELIVERY_SWEEP" },
      select: { status: true, attempts: true },
    });
    expect(job.status).toBe("PENDING");
    expect(job.attempts).toBe(0);
  });

  test("clears its failure budget on a pass that completed", async () => {
    // The other half of #287, and the half `ensureDeliverySweep` cannot reach: every successful
    // cycle goes through `rescheduleJob`, which preserves `attempts` by design.
    const result = await deliverySweepHandler(
      {
        id: 1n,
        tenantId,
        kind: "DELIVERY_SWEEP",
        payload: {},
        attempts: 4,
        claimSeq: 1,
      },
      appDb,
    );
    expect(result.outcome).toBe("reschedule");
    expect((result as { resetAttempts?: boolean }).resetAttempts).toBe(true);
  });

  test("records the two ids recovery needs, and only for an INBOUND message", async () => {
    const convId = 8808;
    await seedConversation(convId);
    const incoming = await deliverThrough(convId, 9701, "incoming");
    expect(incoming.conversationId).toBe(convId);
    expect(incoming.inboundMessageId).toBe(9701);

    // The bot's own reply comes back as a `message_created` too. Recorded with no inbound id, which
    // is what stops a stranded outgoing delivery from being reported as a customer left unanswered.
    const outgoing = await deliverThrough(convId, 9702, "outgoing");
    expect(outgoing.conversationId).toBe(convId);
    expect(outgoing.inboundMessageId).toBeNull();

    // And an incoming `message_updated` — usually our own media write-back coming back around. It
    // is incoming, but it drives no turn, so nobody is waiting on it either.
    const updated = await deliverThrough(convId, 9703, "incoming", {
      event: "message_updated",
    });
    expect(updated.conversationId).toBe(convId);
    expect(updated.inboundMessageId).toBeNull();
  });

  async function deliverThrough(
    convId: number,
    messageId: number,
    direction: "incoming" | "outgoing",
    over: { event?: string } = {},
  ) {
    const n = normalizeChatwootEvent({
      event: over.event ?? "message_created",
      id: messageId,
      private: false,
      content: "oi",
      message_type: direction,
      sender: { id: 77, name: "Cliente", type: null },
      conversation: {
        id: convId,
        inbox_id: CHATWOOT_INBOX_ID,
        // Held by a human, so the delivery takes the gate's exit and spends no model call. What is
        // asserted is the LEDGER INSERT, which happens before any of that.
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
    const deliveryId = `sweep-real-${process.pid}-${messageId}`;
    await recordAndProcessChatwootDelivery({
      tenantId,
      instanceId,
      deliveryId,
      agentBotId: AGENT_BOT_ID,
      normalized: n,
      base: appDb,
    });
    return suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId },
      select: { conversationId: true, inboundMessageId: true },
    });
  }
});
