import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn } from "@/lib/tenancy";
import { followUpDedupeKey } from "@/modules/channel-redirect/followup";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// A MONITORING agent watches and never answers (issue #209). The guarantee is asserted at the two
// seams that hold it, against the effects an operator can see:
//
//   - the receiver: a customer message on a conversation the bot holds, and one a human holds, each
//     arm no turn and post nothing, leave no `handoff` trail line, advance the handled watermark and
//     settle the delivery — and are folded into memory (an INGEST_MESSAGE job), which is the whole
//     point of the mode;
//   - the config load: every speaker loads the agent there first, and a monitoring agent loads for
//     nobody except a caller that says it never speaks.
//
// A production agent on the same inbox is the control: the same message arms a flush.

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

const INBOX_ID = 81;
const OUR_BOT = 19;
let tenantId = 0n;
let instanceId = 0n;
let agentDbId = 0n;
let deliverySeq = 0;
let messageSeq = 81_000;
let stamp = Math.floor(Date.now() / 1000);

// Every request the receiver makes of the stub Chatwoot. A monitoring delivery must leave it empty of
// anything customer-facing; the list is asserted, not the absence of a mock.
const requests: { method: string; url: string }[] = [];
const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)("a monitoring agent never answers", () => {
  beforeAll(async () => {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      requests.push({
        method: init?.method ?? "GET",
        url: typeof input === "string" ? input : input.toString(),
      });
      return new Response(JSON.stringify({ payload: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const t = await suDb.tenant.create({
      data: { name: "MON", slug: `mon-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 31,
      baseUrl: "https://chat.monitoring.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Observadora",
        systemPrompt: "Você observa.",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "monitoring",
        // Follow-up ON on purpose: the arm in isFollowUpLive is what keeps this from chasing.
        settings: { followUp: { enabled: true } },
      },
    });
    agentDbId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: OUR_BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `mon-route-${process.pid}`,
        name: "Observadora",
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
    if (!dbUp) return;
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

  function conversation(
    convId: number,
    held: { assigneeType?: "User" | null; status: string },
    // The contact, when a case needs one the mirror can identify (the authorization gate asks the
    // endpoint about a phone, an email or an identifier, and stays silent about a contact with none).
    sender: Record<string, unknown> = { id: 88, name: "Cliente" },
  ) {
    stamp += 1;
    return {
      id: convId,
      inbox_id: INBOX_ID,
      status: held.status,
      contact_inbox: { id: 81_000 + convId },
      meta: {
        ...(held.assigneeType === "User"
          ? { assignee_type: "User", assignee: { id: 5, name: "Ana" } }
          : { assignee: null }),
        sender,
      },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
      updated_at: stamp,
    };
  }

  async function deliver(
    convId: number,
    held: { assigneeType?: "User" | null; status: string },
    content = "quero cancelar meu ingresso",
    // A SPARSE payload: the conversation names no inbox, which some events and a rebuilt body do.
    // The receiver then has to reach the agent through the mirrored conversation. A BARE one names
    // no contact-inbox either, which is what memory is keyed by.
    sparse = false,
    bare = false,
    // The client the delivery path runs on, for a case that injects a failure into it.
    base: PrismaClient = appDb,
  ): Promise<{ messageId: number; deliveryRowId: bigint }> {
    deliverySeq += 1;
    messageSeq += 1;
    const conv = conversation(convId, held) as Record<string, unknown>;
    if (sparse) delete conv.inbox_id;
    if (bare) delete conv.contact_inbox;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageSeq,
      private: false,
      content,
      message_type: "incoming",
      sender: { id: 88, name: "Cliente", type: null },
      conversation: conv,
    });
    if (!n) throw new Error("payload did not normalize");
    // With the facts the real claim writes (conversation, inbound message): they are what a
    // settlement finds the row by.
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `mon-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
        conversationId: convId,
        inboundMessageId: messageSeq,
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: OUR_BOT,
      normalized: n,
      base,
    });
    return { messageId: messageSeq, deliveryRowId: delivery.id };
  }

  function customerFacing() {
    return requests.filter(
      (r) =>
        r.method !== "GET" &&
        /\/(messages|toggle_status|toggle_typing_status|assignments)(\?|$)/.test(
          r.url,
        ),
    );
  }

  async function jobs(kind: "DEBOUNCE" | "INGEST_MESSAGE") {
    return suDb.schedulerJob.findMany({
      where: { tenantId, kind },
      select: { dedupeKey: true, status: true },
    });
  }

  async function row(convId: number) {
    return suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: convId },
      select: {
        id: true,
        lastHandledMessageId: true,
        testActivatedAt: true,
      },
    });
  }

  // A client whose scheduler refuses the ingest job, for the cases about what the observer marks
  // on the strength of that enqueue.
  function failingIngest(counter?: { attempts: number }): PrismaClient {
    return appDb.$extends({
      query: {
        schedulerJob: {
          $allOperations({ args, query }) {
            const shape = JSON.stringify(args, (_k, v) =>
              typeof v === "bigint" ? String(v) : v,
            );
            if (shape.includes("INGEST_MESSAGE")) {
              if (counter) counter.attempts += 1;
              throw new Error("injected: scheduler unavailable");
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
  }

  async function deliveryStatus(id: bigint) {
    return (
      await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      })
    ).status;
  }

  // A production agent answering directly (no debounce), flipped to monitoring INSIDE the model
  // call, on the given client. The agent is put back to monitoring afterwards. `run` is the
  // delivery's own promise, for the cases where it is expected to reject.
  async function directTurnUnderFlip(opts: {
    convId: number;
    content: string;
    base: PrismaClient;
    afterFlip?: () => void;
    settings?: Record<string, unknown>;
  }) {
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "production",
        settings: {
          followUp: { enabled: true },
          debounce: { enabled: false },
          ...opts.settings,
        },
      },
    });
    const sent: string[] = [];
    const seen = { outcome: null as string | null };
    const flip = async () => {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
      opts.afterFlip?.();
    };
    class FlippingModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(
        ...args: Parameters<FakeListChatModel["_generate"]>
      ): ReturnType<FakeListChatModel["_generate"]> {
        await flip();
        return super._generate(...args);
      }
      override async *_streamResponseChunks(
        ...args: Parameters<FakeListChatModel["_streamResponseChunks"]>
      ): ReturnType<FakeListChatModel["_streamResponseChunks"]> {
        await flip();
        yield* super._streamResponseChunks(...args);
      }
    }
    deliverySeq += 1;
    messageSeq += 1;
    const messageId = messageSeq;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      content: opts.content,
      message_type: "incoming",
      sender: { id: 88, name: "Cliente", type: null },
      conversation: conversation(opts.convId, {
        assigneeType: null,
        status: "pending",
      }),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `mon-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
        conversationId: opts.convId,
        inboundMessageId: messageId,
      },
      select: { id: true },
    });
    const run = processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: OUR_BOT,
      normalized: n,
      base: opts.base,
      onDirectTurn: (r) => {
        seen.outcome =
          r.kind === "outcome" ? r.outcome : `error:${String(r.error)}`;
      },
      deps: {
        makeClient: (async () =>
          ({
            sendMessage: async (_id: number, text: string) => {
              sent.push(text);
              return {};
            },
            sendPrivateNote: async () => ({}),
            toggleTyping: async () => ({}),
            getConversationLabels: async () => [],
            listLabels: async () => [],
            listCustomAttributeDefinitions: async () => [],
          }) as unknown as ChatwootClient) as never,
        makeModel: () =>
          new FlippingModel({ responses: ["Vou verificar seu pedido."] }),
      },
    }).finally(async () => {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring", settings: { followUp: { enabled: true } } },
      });
    });
    return { run, sent, seen, messageId, deliveryRowId: delivery.id };
  }

  test("a message on a conversation the bot holds: no turn, nothing posted, remembered", async () => {
    requests.length = 0;
    const { messageId, deliveryRowId } = await deliver(1, {
      assigneeType: null,
      status: "pending",
    });

    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(1);
    const conv = await row(1);
    expect(conv?.lastHandledMessageId).toBe(messageId);
    const ledger = await suDb.chatwootWebhookDelivery.findUnique({
      where: { id: deliveryRowId },
      select: { status: true },
    });
    expect(ledger?.status).toBe("PROCESSED");
    expect(
      await flowLogRows(suDb, {
        where: { tenantId, stage: "handoff", conversationId: conv?.id },
      }),
    ).toEqual([]);
  });

  test("a message on a conversation a human holds: remembered too, and no trail line", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    const { messageId } = await deliver(2, {
      assigneeType: "User",
      status: "open",
    });

    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    const conv = await row(2);
    expect(conv?.lastHandledMessageId).toBe(messageId);
    // The closed-gate trail is about a bot that would have answered; a watcher leaves none.
    expect(
      await flowLogRows(suDb, {
        where: { tenantId, stage: "handoff", conversationId: conv?.id },
      }),
    ).toEqual([]);
  });

  test("a payload that names no inbox reaches the agent through the mirrored conversation, and is still watched", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    // Conversation 1 was mirrored with its inbox by the first case; this message says nothing.
    const { messageId } = await deliver(
      1,
      { assigneeType: null, status: "pending" },
      "e o reembolso?",
      true,
    );

    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    expect((await row(1))?.lastHandledMessageId).toBe(messageId);
  });

  test("a payload that names no contact-inbox is still remembered, through the mirrored conversation", async () => {
    // The observer's path marks the message handled before ingestion runs, and ingestion keys
    // memory by the contact-inbox; a payload without one has to reach the stored row's (review
    // round 14).
    requests.length = 0;
    const { messageId } = await deliver(
      1,
      { assigneeType: null, status: "pending" },
      "e a taxa?",
      true,
      true,
    );
    expect(customerFacing()).toEqual([]);
    const ingested = (await jobs("INGEST_MESSAGE")).map((j) => j.dedupeKey);
    expect(ingested.some((k) => k.endsWith(`:${messageId}`))).toBe(true);
    expect((await row(1))?.lastHandledMessageId).toBe(messageId);
  });

  test("a message with no contact-inbox thread anywhere is left unmarked, and its delivery unsettled", async () => {
    // The payload names no contact-inbox and neither does the mirrored row, so there is no thread
    // to remember the message on. Marked handled, it would be absent from every memory for good;
    // left unmarked (review round 18) it is the burst a flush after a flip back to production
    // answers, and a sibling delivery of it still being worked stays in the sweep's worklist
    // instead of being settled as consumed.
    requests.length = 0;
    const ingestBefore = (await jobs("INGEST_MESSAGE")).length;
    const sibling = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `mon-sibling-${process.pid}`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: 17,
        inboundMessageId: messageSeq + 1,
      },
      select: { id: true },
    });
    const { messageId, deliveryRowId } = await deliver(
      17,
      { assigneeType: null, status: "pending" },
      "cadê meu ingresso?",
      false,
      true,
    );
    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(ingestBefore);
    const conv = await row(17);
    expect(conv).not.toBeNull();
    expect(conv?.lastHandledMessageId ?? null).not.toBe(messageId);
    const status = async (id: bigint) =>
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id },
          select: { status: true },
        })
      ).status;
    expect(await status(deliveryRowId)).toBe("PROCESSED");
    expect(await status(sibling.id)).toBe("PROCESSING");
  });

  test("an observer whose ingestion cannot be armed marks nothing, and leaves the delivery to the sweep", async () => {
    // The enqueue is the observer's reason to mark (review round 19): a scheduler write that does
    // not land would otherwise leave the message below the watermark with no ingest job, absent
    // from memory for good, since a monitoring agent arms no flush and the next observed message
    // moves the watermark past it. So the delivery fails instead, and its row stays PROCESSING for
    // the sweep's recovery to re-run.
    requests.length = 0;
    const ingestBefore = (await jobs("INGEST_MESSAGE")).length;
    const failing = appDb.$extends({
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
    const messageId = messageSeq + 1;
    const deliveryId = `mon-${process.pid}-${deliverySeq + 1}`;
    await expect(
      deliver(
        18,
        { assigneeType: null, status: "pending" },
        "oi, sumiu meu pedido",
        false,
        false,
        failing,
      ),
    ).rejects.toThrow("could not be armed");
    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(ingestBefore);
    expect((await row(18))?.lastHandledMessageId ?? null).not.toBe(messageId);
    const ledger = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId },
      select: { status: true },
    });
    expect(ledger.status).toBe("PROCESSING");
  });

  test("a human-held message under an observer is settled only once its ingestion has it", async () => {
    // The human-held mark has its own reason (issue #8) and used to close the delivery's row ahead
    // of the ingestion; with the enqueue then failing, the row was already terminal and the sweep
    // could not recover it (review round 20). Under an observer it waits for the enqueue too.
    requests.length = 0;
    const ingestBefore = (await jobs("INGEST_MESSAGE")).length;
    const messageId = messageSeq + 1;
    const deliveryId = `mon-${process.pid}-${deliverySeq + 1}`;
    await expect(
      deliver(
        19,
        { assigneeType: "User", status: "open" },
        "e agora?",
        false,
        false,
        failingIngest(),
      ),
    ).rejects.toThrow("could not be armed");
    expect(customerFacing()).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(ingestBefore);
    expect((await row(19))?.lastHandledMessageId ?? null).not.toBe(messageId);
    const ledger = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId },
      select: { status: true },
    });
    expect(ledger.status).toBe("PROCESSING");
  });

  test("a turn that stood down for the observer settles nothing until the ingestion has the message", async () => {
    // The stand-down's own settlement closed the row before the observer was asked (review
    // round 20); an enqueue failing after it left a terminal row the sweep cannot recover.
    const r = await directTurnUnderFlip({
      convId: 20,
      content: "meu pedido sumiu",
      base: failingIngest(),
    });
    await expect(r.run).rejects.toThrow("could not be armed");
    expect(r.sent).toEqual([]);
    expect(r.seen.outcome).toBe("agent-unavailable");
    const ingested = (await jobs("INGEST_MESSAGE")).map((j) => j.dedupeKey);
    expect(ingested.some((k) => k.endsWith(`:${r.messageId}`))).toBe(false);
    // The watermark is the turn's own to move; what keeps the message recoverable is the row.
    expect(await deliveryStatus(r.deliveryRowId)).toBe("PROCESSING");
  });

  test("a turn that stood down, whose observer read fails, leaves the delivery for the sweep", async () => {
    // Whether the agent observes could not be read after the stand-down. Taken for "no", the
    // message would be settled as consumed and remembered by nobody (review round 20).
    const armed = { on: false, reads: 0 };
    const failing = appDb.$extends({
      query: {
        agent: {
          findUnique({ args, query }) {
            const keys = Object.keys(
              (args.select ?? {}) as Record<string, unknown>,
            )
              .sort()
              .join(",");
            if (armed.on && keys === "enabled,mode") {
              armed.reads += 1;
              if (armed.reads === 2) {
                throw new Error("injected: agent unreadable");
              }
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const r = await directTurnUnderFlip({
      convId: 21,
      content: "cadê a resposta?",
      base: failing,
      afterFlip: () => {
        armed.on = true;
      },
    });
    await expect(r.run).rejects.toThrow("could not be read");
    expect(r.sent).toEqual([]);
    expect(r.seen.outcome).toBe("agent-unavailable");
    expect(armed.reads).toBe(2);
    const ingested = (await jobs("INGEST_MESSAGE")).map((j) => j.dedupeKey);
    expect(ingested.some((k) => k.endsWith(`:${r.messageId}`))).toBe(false);
    expect(await deliveryStatus(r.deliveryRowId)).toBe("PROCESSING");
  });

  test("an observed message whose watermark cannot be advanced is not settled, and waits for the sweep", async () => {
    // The ingestion has the message; the mark is the hand-over's closing write. Settled with the
    // watermark still below the message, the row is terminal and a flush after a flip back to
    // production answers a message that was watched (review round 21).
    requests.length = 0;
    const failing = appDb.$extends({
      query: {
        conversation: {
          updateMany({ args, query }) {
            const data = args.data as { lastHandledMessageId?: unknown };
            if (data.lastHandledMessageId != null) {
              throw new Error("injected: watermark write failed");
            }
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const messageId = messageSeq + 1;
    const deliveryId = `mon-${process.pid}-${deliverySeq + 1}`;
    await expect(
      deliver(
        22,
        { assigneeType: null, status: "pending" },
        "e o estorno?",
        false,
        false,
        failing,
      ),
    ).rejects.toThrow("could not be advanced");
    expect(customerFacing()).toEqual([]);
    const ingested = (await jobs("INGEST_MESSAGE")).map((j) => j.dedupeKey);
    expect(ingested.some((k) => k.endsWith(`:${messageId}`))).toBe(true);
    expect((await row(22))?.lastHandledMessageId ?? null).not.toBe(messageId);
    const ledger = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
      where: { tenantId, deliveryId },
      select: { status: true },
    });
    expect(ledger.status).toBe("PROCESSING");
  });

  test("a PRODUCTION agent's gate that consumes the message, flipped inside it, hands the message to the observer", async () => {
    // The authorization denial consumes the message, and `rt` was read as production before the
    // gate ran. Flipped to monitoring inside the endpoint's round-trip, the message was marked and
    // settled ahead of the ingestion, and an enqueue failing after that was swallowed as
    // production's best-effort ingestion is (review round 21). Under an observer it is a retry.
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "production",
        settings: {
          followUp: { enabled: true },
          debounce: { enabled: false },
          contactAuth: {
            enabled: true,
            url: "https://203.0.113.9:9443/check",
            denyMessage: "Não consegui confirmar seu cadastro.",
            handoffEnabled: false,
          },
        },
      },
    });
    const sent: string[] = [];
    const seen = { asked: 0 };
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const messageId = messageSeq;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageId,
        private: false,
        content: "quero meu reembolso",
        message_type: "incoming",
        sender: { id: 90, name: "Cliente identificada", type: null },
        conversation: conversation(
          23,
          { assigneeType: null, status: "pending" },
          {
            id: 90,
            name: "Cliente identificada",
            phone_number: "+5511999990090",
          },
        ),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
          conversationId: 23,
          inboundMessageId: messageId,
        },
        select: { id: true },
      });
      await expect(
        processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OUR_BOT,
          normalized: n,
          base: failingIngest(),
          deps: {
            makeClient: (async () =>
              ({
                sendMessage: async (_id: number, text: string) => {
                  sent.push(text);
                  return {};
                },
                sendPrivateNote: async () => ({}),
                toggleTyping: async () => ({}),
                toggleStatus: async () => ({}),
                getConversationLabels: async () => [],
                listLabels: async () => [],
                listCustomAttributeDefinitions: async () => [],
              }) as unknown as ChatwootClient) as never,
            makeModel: () => {
              throw new Error("a denied contact must not reach the model");
            },
            contactAuthFetch: (async () => {
              seen.asked += 1;
              await suDb.agent.update({
                where: { id: agentDbId },
                data: { mode: "monitoring" },
              });
              return new Response(JSON.stringify({ authorized: false }), {
                status: 200,
              });
            }) as unknown as typeof fetch,
          },
        }),
      ).rejects.toThrow("could not be armed");
      expect(seen.asked).toBe(1);
      expect(sent).toEqual([]);
      expect((await row(23))?.lastHandledMessageId ?? null).not.toBe(messageId);
      expect(await deliveryStatus(delivery.id)).toBe("PROCESSING");
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("a reply handed to the observer inside its turn retires the redirect ladder, and the dispatch does not re-arm it", async () => {
    // The observing path retires the ladder (round 13) from a mode read before the gate; a delivery
    // handed over INSIDE its turn had passed that read as production, and its dispatch re-armed
    // the ladder on the way out — a template to a lead the observer now remembers, on the first
    // flip back to production (review round 22).
    const widgetThreadId = `${tenantId}:${instanceId}:24`;
    const ladder = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "REDIRECT_FOLLOWUP",
        dedupeKey: followUpDedupeKey(widgetThreadId),
        status: "PENDING",
        runAt: new Date(Date.now() + 3_600_000),
        payload: {
          stage: "chat",
          widgetThreadId,
          agentId: String(agentDbId),
          entryInboxId: 80,
        },
      },
      select: { id: true, runAt: true },
    });
    const r = await directTurnUnderFlip({
      convId: 24,
      content: "voltei, e agora?",
      base: appDb,
      settings: {
        channelRedirect: {
          enabled: true,
          widgetInboxId: INBOX_ID,
          entryInboxId: 80,
          chatFollowupEnabled: true,
        },
      },
    });
    await r.run;
    expect(r.sent).toEqual([]);
    expect(r.seen.outcome).toBe("agent-unavailable");
    const after = await suDb.schedulerJob.findUniqueOrThrow({
      where: { id: ladder.id },
      select: { status: true, runAt: true },
    });
    expect(after.status).toBe("DONE");
    // Retired where it stood, never re-armed on the way: the arm would have moved its due time.
    expect(after.runAt.getTime()).toBe(ladder.runAt.getTime());
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "REDIRECT_FOLLOWUP", status: "PENDING" },
      }),
    ).toBe(0);
  });

  test("a TEST agent's consumed audio, handed to the observer inside the gate, is remembered with its transcription", async () => {
    // The eager media pass runs ahead of the gate for an agent that ingests continuously and on
    // the answer path for a test agent; a consumed message of a test agent ran neither, so the
    // observer would remember the audio as its attachment marker (review round 22).
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "test",
        settings: { followUp: { enabled: true }, debounce: { enabled: false } },
      },
    });
    const sent: string[] = [];
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const messageId = messageSeq;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageId,
        private: false,
        content: "",
        message_type: "incoming",
        sender: { id: 88, name: "Cliente", type: null },
        attachments: [
          {
            id: 91,
            file_type: "audio",
            data_url: "https://chat.mon.example/audio/91.ogg",
            transcribed_text: "quero cancelar meu ingresso",
          },
        ],
        conversation: conversation(25, {
          assigneeType: null,
          status: "pending",
        }),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
          conversationId: 25,
          inboundMessageId: messageId,
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        deps: {
          makeClient: (async () => {
            await suDb.agent.update({
              where: { id: agentDbId },
              data: { mode: "monitoring" },
            });
            return {
              sendMessage: async (_id: number, text: string) => {
                sent.push(text);
                return {};
              },
              sendPrivateNote: async () => ({}),
              toggleTyping: async () => ({}),
              getConversationLabels: async () => [],
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            } as unknown as ChatwootClient;
          }) as never,
          makeModel: () => {
            throw new Error("a consumed delivery must not reach the model");
          },
        },
      });
      expect(sent).toEqual([]);
      const job = await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "INGEST_MESSAGE",
          dedupeKey: { endsWith: `:${messageId}` },
        },
        select: { payloadSecret: true },
      });
      expect(job).not.toBeNull();
      const text = decryptJson<string>(job?.payloadSecret ?? "");
      expect(text).toContain("quero cancelar meu ingresso");
      expect((await row(25))?.lastHandledMessageId).toBe(messageId);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("a colleague's reply the observer cannot remember is retried, then reported on the conversation", async () => {
    // The enqueue of a human reply's append failed; nothing recovers an outgoing message's body
    // (the sweep cannot rebuild one), so the append is retried inline as the ledger claim is, and
    // once the retries are spent the loss is an error line on the conversation, not a process
    // warning (review round 24). The delivery itself completes: no recovery to leave the row for.
    requests.length = 0;
    const ingestBefore = (await jobs("INGEST_MESSAGE")).length;
    const counter = { attempts: 0 };
    deliverySeq += 1;
    messageSeq += 1;
    const messageId = messageSeq;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageId,
      private: false,
      content: "Oi! Vou verificar seu pedido agora.",
      message_type: "outgoing",
      sender: { id: 5, name: "Ana", type: "user" },
      conversation: conversation(26, { assigneeType: "User", status: "open" }),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `mon-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
        conversationId: 26,
      },
      select: { id: true },
    });
    const outcome = await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: OUR_BOT,
      normalized: n,
      base: failingIngest(counter),
      deps: { sleep: async () => {} },
    });
    expect(outcome).toBe("processed");
    expect(counter.attempts).toBe(4);
    expect(customerFacing()).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(ingestBefore);
    expect(await deliveryStatus(delivery.id)).toBe("PROCESSED");
    const conv = await row(26);
    const lines = await flowLogRows(suDb, {
      where: { tenantId, stage: "memory", conversationId: conv?.id },
    });
    expect(lines.length).toBe(1);
    expect(lines[0]?.status).toBe("error");
  });

  // The PERMANENT half of the same loss (issue #476 review, round 37). A conversation whose
  // contact-inbox neither the payload nor the mirror names has nowhere to hold the reply, so
  // ingestion answers "no-thread" — nothing to retry, and no later attempt that would find one.
  // Reported like the spent retries above: unreported, the row settles with the reply in nobody's
  // memory and no line anywhere, because the mark block is inbound-only and never sees this.
  test("a colleague's reply with no memory thread is reported, not settled in silence", async () => {
    requests.length = 0;
    const ingestBefore = (await jobs("INGEST_MESSAGE")).length;
    deliverySeq += 1;
    messageSeq += 1;
    const convId = 27;
    const conv = conversation(convId, {
      assigneeType: "User",
      status: "open",
    }) as Record<string, unknown>;
    // No contact-inbox anywhere: not in the payload, and the mirror writes none from it either.
    delete conv.contact_inbox;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageSeq,
      private: false,
      content: "Oi! Vou verificar seu pedido agora.",
      message_type: "outgoing",
      sender: { id: 5, name: "Ana", type: "user" },
      conversation: conv,
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `mon-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
        conversationId: convId,
      },
      select: { id: true },
    });
    expect(
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
      }),
    ).toBe("processed");
    expect(customerFacing()).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(ingestBefore);
    const convRow = await row(convId);
    const lines = await flowLogRows(suDb, {
      where: { tenantId, stage: "memory", conversationId: convRow?.id },
    });
    expect(lines.length).toBe(1);
    expect(lines[0]?.status).toBe("error");
  });

  test("/teste never activates a monitoring agent, and answers nothing", async () => {
    requests.length = 0;
    await deliver(3, { assigneeType: null, status: "pending" }, "/teste");

    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect((await row(3))?.testActivatedAt).toBeNull();
  });

  test("the config seam refuses the agent for every speaker, and loads it for a caller that never speaks", async () => {
    const ctx = { tenantId, userId: null, role: "TENANT_ADMIN" as const };
    const args = {
      tenantId,
      instanceId,
      conversationId: 1,
      agentId: agentDbId,
      threadId: `${tenantId}:${instanceId}:1`,
    };
    expect(
      await runScopedOn(appDb, ctx, (db) => loadAgentConfig(db, args)),
    ).toBeNull();
    expect(
      await runScopedOn(appDb, ctx, (db) =>
        loadAgentConfig(db, args, { ignoreMode: true }),
      ),
    ).not.toBeNull();
    // The playground is an operator talking to the agent in a fenced thread, not the customer.
    expect(
      await runScopedOn(appDb, ctx, (db) =>
        loadAgentConfig(db, args, { ignoreDisabled: true }),
      ),
    ).not.toBeNull();
  });

  test("an agent flipped to monitoring while its turn ran posts nothing", async () => {
    // A production agent, answering directly (no debounce, so the turn runs inside this delivery),
    // whose operator flips the mode INSIDE the model call. The config the turn loaded still says
    // production; the send fence has to ask again — and the turn stands down as the agent being
    // unavailable, NOT as a run /reset withdrew: the rolled-back turn left the message in nobody's
    // memory, so the receiver reads the agent again and hands it to the observer's ingestion, with
    // the watermark past it (review round 6).
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "production",
        settings: { followUp: { enabled: true }, debounce: { enabled: false } },
      },
    });
    const sent: string[] = [];
    const seen = { outcome: null as string | null };
    const flip = async () => {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
    };
    // Both entry points, because which one the graph takes is the model adapter's business — and
    // `bindTools`, because the fake answers it with a NEW instance of its own class, which is how a
    // subclass silently stops being the model the graph invokes.
    class FlippingModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(
        ...args: Parameters<FakeListChatModel["_generate"]>
      ): ReturnType<FakeListChatModel["_generate"]> {
        await flip();
        return super._generate(...args);
      }
      override async *_streamResponseChunks(
        ...args: Parameters<FakeListChatModel["_streamResponseChunks"]>
      ): ReturnType<FakeListChatModel["_streamResponseChunks"]> {
        await flip();
        yield* super._streamResponseChunks(...args);
      }
    }
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "meu ingresso não chegou",
        message_type: "incoming",
        sender: { id: 88, name: "Cliente", type: null },
        conversation: conversation(5, {
          assigneeType: null,
          status: "pending",
        }),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        onDirectTurn: (r) => {
          seen.outcome =
            r.kind === "outcome" ? r.outcome : `error:${String(r.error)}`;
        },
        deps: {
          makeClient: (async () =>
            ({
              sendMessage: async (_id: number, text: string) => {
                sent.push(text);
                return {};
              },
              sendPrivateNote: async () => ({}),
              toggleTyping: async () => ({}),
              getConversationLabels: async () => [],
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            }) as unknown as ChatwootClient) as never,
          makeModel: () =>
            new FlippingModel({ responses: ["Vou verificar seu pedido."] }),
        },
      });
      expect(sent).toEqual([]);
      expect(seen.outcome).toBe("agent-unavailable");
      const ingested = (await jobs("INGEST_MESSAGE")).map((j) => j.dedupeKey);
      expect(ingested.some((k) => k.endsWith(`:${messageSeq}`))).toBe(true);
      expect((await row(5))?.lastHandledMessageId).toBe(messageSeq);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("an agent flipped to monitoring between two balloons sends the first and not the second", async () => {
    // The flip lands AFTER the model call and after every check that sits next to it: inside the
    // SEND of the first balloon of a split reply. A re-read placed at "the send boundary" answers
    // once for the whole reply; the fence has to be asked before each balloon (issue #209 review,
    // round 4) — and before each balloon's typing indicator, which is customer-facing too (round 9):
    // the second balloon shows no typing, pauses for nothing, and never goes out.
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "production",
        settings: {
          followUp: { enabled: true },
          debounce: { enabled: false },
          split: { enabled: true, minDelayMs: 0, maxDelayMs: 0 },
        },
      },
    });
    const sent: string[] = [];
    const seen = { outcome: null as string | null, pauses: 0, typing: 0 };
    class BoundModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
    }
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "cadê meu ingresso?",
        message_type: "incoming",
        sender: { id: 88, name: "Cliente", type: null },
        conversation: conversation(6, {
          assigneeType: null,
          status: "pending",
        }),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        onDirectTurn: (r) => {
          seen.outcome =
            r.kind === "outcome" ? r.outcome : `error:${String(r.error)}`;
        },
        deps: {
          makeClient: (async () =>
            ({
              sendMessage: async (_id: number, text: string) => {
                sent.push(text);
                // The operator flips the mode while the first balloon is on its way out.
                if (sent.length === 1) {
                  await suDb.agent.update({
                    where: { id: agentDbId },
                    data: { mode: "monitoring" },
                  });
                }
                return {};
              },
              sendPrivateNote: async () => ({}),
              toggleTyping: async (_id: number, on: boolean) => {
                if (on) seen.typing += 1;
                return {};
              },
              getMessages: async () => ({ payload: [] }),
              getConversationLabels: async () => [],
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            }) as unknown as ChatwootClient) as never,
          makeModel: () =>
            new BoundModel({
              responses: ["Vou verificar seu pedido.\n\nMe dá um minuto."],
            }),
          // The typing pause before each balloon.
          sleep: async () => {
            seen.pauses += 1;
          },
        },
      });
      expect(sent).toEqual(["Vou verificar seu pedido."]);
      expect(seen.typing).toBe(1);
      expect(seen.pauses).toBe(1);
      // Not "posted-partial": a run called off between balloons attempted nothing after the fence,
      // by decision, and the split reports that as a delivery rather than a failure (see
      // ReplyDelivery in src/modules/split/service.ts).
      expect(seen.outcome).toBe("posted");
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("an agent flipped to monitoring during the authorization call posts no denial", async () => {
    // The receiver's own gate posts to the customer too — the away message, the redirect link, the
    // authorization denial — and `observing` was read before the gate ran. The authorization
    // round-trip is the wait an operator's flip can land in; the denial after it has to ask again
    // (issue #209 review, round 5).
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "production",
        settings: {
          followUp: { enabled: true },
          debounce: { enabled: false },
          contactAuth: {
            enabled: true,
            url: "https://203.0.113.9:9443/check",
            denyMessage: "Não consegui confirmar seu cadastro.",
            handoffEnabled: false,
          },
        },
      },
    });
    const sent: string[] = [];
    const seen = { asked: 0 };
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "quero meu reembolso",
        message_type: "incoming",
        sender: { id: 89, name: "Cliente identificada", type: null },
        conversation: conversation(
          7,
          { assigneeType: null, status: "pending" },
          {
            id: 89,
            name: "Cliente identificada",
            phone_number: "+5511999990089",
          },
        ),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        deps: {
          makeClient: (async () =>
            ({
              sendMessage: async (_id: number, text: string) => {
                sent.push(text);
                return {};
              },
              sendPrivateNote: async () => ({}),
              toggleTyping: async () => ({}),
              toggleStatus: async () => ({}),
              getConversationLabels: async () => [],
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            }) as unknown as ChatwootClient) as never,
          makeModel: () => {
            throw new Error("a denied contact must not reach the model");
          },
          // The endpoint's round-trip, and the operator flips the mode inside it.
          contactAuthFetch: (async () => {
            seen.asked += 1;
            await suDb.agent.update({
              where: { id: agentDbId },
              data: { mode: "monitoring" },
            });
            return new Response(JSON.stringify({ authorized: false }), {
              status: 200,
            });
          }) as unknown as typeof fetch,
        },
      });
      expect(seen.asked).toBe(1);
      expect(sent).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("an agent flipped to monitoring while the gate builds its client posts no denial either", async () => {
    // The client build is I/O of its own — the persona read, the construction — and it used to sit
    // between the gate's asks and the send (review round 7).
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "production",
        settings: {
          followUp: { enabled: true },
          debounce: { enabled: false },
          contactAuth: {
            enabled: true,
            url: "https://203.0.113.9:9443/check",
            denyMessage: "Não consegui confirmar seu cadastro.",
            handoffEnabled: false,
          },
        },
      },
    });
    const sent: string[] = [];
    const seen = { built: 0 };
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "quero meu reembolso de novo",
        message_type: "incoming",
        sender: { id: 89, name: "Cliente identificada", type: null },
        conversation: conversation(
          9,
          { assigneeType: null, status: "pending" },
          {
            id: 89,
            name: "Cliente identificada",
            phone_number: "+5511999990089",
          },
        ),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        deps: {
          // The flip lands inside the construction of the persona's client.
          makeClient: (async () => {
            seen.built += 1;
            await suDb.agent.update({
              where: { id: agentDbId },
              data: { mode: "monitoring" },
            });
            return {
              sendMessage: async (_id: number, text: string) => {
                sent.push(text);
                return {};
              },
              sendPrivateNote: async () => ({}),
              toggleTyping: async () => ({}),
              toggleStatus: async () => ({}),
              getConversationLabels: async () => [],
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            } as unknown as ChatwootClient;
          }) as never,
          makeModel: () => {
            throw new Error("a denied contact must not reach the model");
          },
          contactAuthFetch: (async () =>
            new Response(JSON.stringify({ authorized: false }), {
              status: 200,
            })) as unknown as typeof fetch,
        },
      });
      expect(seen.built).toBeGreaterThanOrEqual(1);
      expect(sent).toEqual([]);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("a turn that throws after the flip still hands the message to the observer", async () => {
    // The turn leaves through the receiver's catch, not through an outcome, and the message is the
    // observer's just the same (review round 8): remembered, and marked handled.
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "production",
        settings: { followUp: { enabled: true }, debounce: { enabled: false } },
      },
    });
    const sent: string[] = [];
    const seen = { outcome: null as string | null };
    class FlipThenThrowModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(): ReturnType<FakeListChatModel["_generate"]> {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "monitoring" },
        });
        throw new Error("provider down");
      }
    }
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "e agora?",
        message_type: "incoming",
        sender: { id: 88, name: "Cliente", type: null },
        conversation: conversation(10, {
          assigneeType: null,
          status: "pending",
        }),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        onDirectTurn: (r) => {
          seen.outcome = r.kind === "outcome" ? r.outcome : "error";
        },
        deps: {
          makeClient: (async () =>
            ({
              sendMessage: async (_id: number, text: string) => {
                sent.push(text);
                return {};
              },
              sendPrivateNote: async () => ({}),
              toggleTyping: async () => ({}),
              getConversationLabels: async () => [],
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            }) as unknown as ChatwootClient) as never,
          makeModel: () => new FlipThenThrowModel({ responses: ["nunca"] }),
        },
      });
      expect(seen.outcome).toBe("error");
      expect(sent).toEqual([]);
      const ingested = (await jobs("INGEST_MESSAGE")).map((j) => j.dedupeKey);
      expect(ingested.some((k) => k.endsWith(`:${messageSeq}`))).toBe(true);
      expect((await row(10))?.lastHandledMessageId).toBe(messageSeq);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("an agent flipped to monitoring inside the model call runs none of the tools it asked for", async () => {
    // The turn's fence covers the sends; the graph asks its own copy at the tool boundary, and a
    // copy derived from the episode alone let `assign_label` write — and the slow-tool ack post —
    // for an agent that had just been flipped (issue #209 review, round 5).
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "production",
        settings: { followUp: { enabled: true }, debounce: { enabled: false } },
      },
    });
    const sent: string[] = [];
    const labels: string[][] = [];
    const seen = { outcome: null as string | null, generations: 0 };
    const flip = async () => {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring" },
      });
    };
    // First generation: flips, then asks for a tool. Second: the reply. The graph invokes the model
    // (it never streams it), so `_generate` is the one entry point a tool call comes through.
    class FlippingToolModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(
        ...args: Parameters<FakeListChatModel["_generate"]>
      ): ReturnType<FakeListChatModel["_generate"]> {
        seen.generations += 1;
        if (seen.generations === 1) {
          await flip();
          const message = new AIMessage({
            content: "",
            tool_calls: [
              { name: "assign_label", args: { label: "vip" }, id: "call-1" },
            ],
          });
          return { generations: [{ text: "", message }] };
        }
        return super._generate(...args);
      }
    }
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "sou cliente vip",
        message_type: "incoming",
        sender: { id: 88, name: "Cliente", type: null },
        conversation: conversation(8, {
          assigneeType: null,
          status: "pending",
        }),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        onDirectTurn: (r) => {
          seen.outcome =
            r.kind === "outcome" ? r.outcome : `error:${String(r.error)}`;
        },
        deps: {
          makeClient: (async () =>
            ({
              sendMessage: async (_id: number, text: string) => {
                sent.push(text);
                return {};
              },
              sendPrivateNote: async () => ({}),
              toggleTyping: async () => ({}),
              getConversationLabels: async () => [],
              setConversationLabels: async (_id: number, next: string[]) => {
                labels.push(next);
                return {};
              },
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            }) as unknown as ChatwootClient) as never,
          makeModel: () =>
            new FlippingToolModel({ responses: ["Anotado como VIP."] }),
        },
      });
      expect(seen.generations).toBeGreaterThanOrEqual(1);
      expect(labels).toEqual([]);
      expect(sent).toEqual([]);
      expect(seen.outcome).toBe("agent-unavailable");
      const ingested = (await jobs("INGEST_MESSAGE")).map((j) => j.dedupeKey);
      expect(ingested.some((k) => k.endsWith(`:${messageSeq}`))).toBe(true);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("an agent switched off AND in monitoring takes the switched-off path: nothing marked, nothing remembered, nothing armed", async () => {
    // The observer's path marks the message handled and ingestion refuses a switched-off agent, so
    // an agent that is both must not take it (review round 11): off, the message waits for the
    // switch, unmarked, as it does for any switched-off agent.
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { enabled: false, mode: "monitoring" },
    });
    requests.length = 0;
    const ingestBefore = (await jobs("INGEST_MESSAGE")).length;
    try {
      const { messageId } = await deliver(11, {
        assigneeType: null,
        status: "pending",
      });
      expect(customerFacing()).toEqual([]);
      expect(await jobs("DEBOUNCE")).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(ingestBefore);
      const r = await row(11);
      expect(r?.lastHandledMessageId ?? null).not.toBe(messageId);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { enabled: true, mode: "monitoring" },
      });
    }
  });

  test("a TEST agent flipped to monitoring inside its turn still hands the message to the observer", async () => {
    // A test agent ingests only on its answer path, and the ingestion gate read that from the
    // runtime the delivery was decided with; the stand-down's hand-over has to carry past it
    // (review round 12).
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "test",
        settings: { followUp: { enabled: true }, debounce: { enabled: false } },
      },
    });
    // Already activated with /teste, so the delivery takes the answer path.
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: INBOX_ID },
      select: { id: true },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        chatwootConversationId: 12,
        contactInboxId: 81_012,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:12`,
        lastEventAt: new Date(Date.now() - 60_000),
        testActivatedAt: new Date(Date.now() - 30_000),
      },
    });
    const sent: string[] = [];
    const seen = { outcome: null as string | null };
    class FlippingModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(
        ...args: Parameters<FakeListChatModel["_generate"]>
      ): ReturnType<FakeListChatModel["_generate"]> {
        await suDb.agent.update({
          where: { id: agentDbId },
          data: { mode: "monitoring" },
        });
        return super._generate(...args);
      }
    }
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "testando aqui",
        message_type: "incoming",
        sender: { id: 88, name: "Cliente", type: null },
        conversation: conversation(12, {
          assigneeType: null,
          status: "pending",
        }),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        onDirectTurn: (r) => {
          seen.outcome =
            r.kind === "outcome" ? r.outcome : `error:${String(r.error)}`;
        },
        deps: {
          makeClient: (async () =>
            ({
              sendMessage: async (_id: number, text: string) => {
                sent.push(text);
                return {};
              },
              sendPrivateNote: async () => ({}),
              toggleTyping: async () => ({}),
              getConversationLabels: async () => [],
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            }) as unknown as ChatwootClient) as never,
          makeModel: () =>
            new FlippingModel({ responses: ["Testando também."] }),
        },
      });
      expect(sent).toEqual([]);
      expect(seen.outcome).toBe("agent-unavailable");
      const ingested = (await jobs("INGEST_MESSAGE")).map((j) => j.dedupeKey);
      expect(ingested.some((k) => k.endsWith(`:${messageSeq}`))).toBe(true);
      expect((await row(12))?.lastHandledMessageId).toBe(messageSeq);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  // The edit that flips the mode is usually the edit that adds the label groups, and `rt.settings`
  // predates it — so arming off that snapshot answered `off` and the message was remembered and
  // never classified. `boundObserverRuntime` cannot cover it: that agent is the inbox's responder,
  // so it holds no observer row (issue #477 review, round 12).
  test("a flip that also adds the taxonomy still arms the verdict", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { mode: "production", settings: { debounce: { enabled: false } } },
    });
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: INBOX_ID },
      select: { id: true },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inbox.id,
        chatwootConversationId: 31,
        contactInboxId: 81_031,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:31`,
        lastEventAt: new Date(Date.now() - 60_000),
      },
    });
    class FlippingModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(
        ...args: Parameters<FakeListChatModel["_generate"]>
      ): ReturnType<FakeListChatModel["_generate"]> {
        // The one edit: monitoring AND the taxonomy it is meant to classify into.
        await suDb.agent.update({
          where: { id: agentDbId },
          data: {
            mode: "monitoring",
            settings: {
              debounce: { enabled: false },
              monitoring: {
                labelGroups: [
                  { name: "assunto", values: ["cancelamento", "outros"] },
                ],
              },
            },
          },
        });
        return super._generate(...args);
      }
    }
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "quero cancelar",
        message_type: "incoming",
        sender: { id: 88, name: "Cliente", type: null },
        conversation: conversation(31, {
          assigneeType: null,
          status: "pending",
        }),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        onDirectTurn: () => {},
        deps: {
          makeClient: (async () =>
            ({
              sendMessage: async () => ({}),
              sendPrivateNote: async () => ({}),
              toggleTyping: async () => ({}),
              getConversationLabels: async () => [],
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            }) as unknown as ChatwootClient) as never,
          makeModel: () => new FlippingModel({ responses: ["oi"] }),
        },
      });
      const armed = await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "OBSERVE" },
        select: { payload: true },
      });
      expect(armed).toHaveLength(1);
    } finally {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "OBSERVE" },
      });
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("a watched reply on the widget conversation retires the pending redirect ladder", async () => {
    // The ladder's cancel-on-reply is a re-arm the observing path never reaches; the ladder has to
    // be retired there instead, or a flip back to production sends a template to a lead who
    // already answered (review round 13).
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "monitoring",
        settings: {
          followUp: { enabled: true },
          channelRedirect: {
            enabled: true,
            widgetInboxId: INBOX_ID,
            entryInboxId: 80,
            chatFollowupEnabled: true,
          },
        },
      },
    });
    const widgetThreadId = `${tenantId}:${instanceId}:13`;
    const ladder = await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "REDIRECT_FOLLOWUP",
        dedupeKey: followUpDedupeKey(widgetThreadId),
        status: "PENDING",
        runAt: new Date(Date.now() + 3_600_000),
        payload: {
          stage: "chat",
          widgetThreadId,
          agentId: String(agentDbId),
          entryInboxId: 80,
        },
      },
      select: { id: true },
    });
    try {
      requests.length = 0;
      await deliver(13, { assigneeType: null, status: "pending" }, "voltei");
      expect(customerFacing()).toEqual([]);
      const after = await suDb.schedulerJob.findUniqueOrThrow({
        where: { id: ladder.id },
        select: { status: true },
      });
      expect(after.status).toBe("DONE");
      expect(
        await suDb.schedulerJob.count({
          where: { tenantId, kind: "REDIRECT_FOLLOWUP", status: "PENDING" },
        }),
      ).toBe(0);
      // And on a SPARSE payload, through the inbox the runtime was recovered from (round 14). The
      // same row, re-armed: the dedupe key is unique per thread.
      await suDb.schedulerJob.update({
        where: { id: ladder.id },
        data: { status: "PENDING" },
      });
      await deliver(
        13,
        { assigneeType: null, status: "pending" },
        "voltei de novo",
        true,
      );
      expect(
        (
          await suDb.schedulerJob.findUniqueOrThrow({
            where: { id: ladder.id },
            select: { status: true },
          })
        ).status,
      ).toBe("DONE");
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: { mode: "monitoring", settings: { followUp: { enabled: true } } },
      });
    }
  });

  test("a TEST agent's gate that consumes the delivery, flipped inside it, still hands the message to the observer", async () => {
    // The gate consumes a message on a conversation never activated with /teste, and `rt` was read
    // before it ran; flipped to monitoring inside the gate's own client build, the message would be
    // marked handled and refused by the ingestion gate (review round 17).
    await suDb.agent.update({
      where: { id: agentDbId },
      data: {
        mode: "test",
        settings: { followUp: { enabled: true }, debounce: { enabled: false } },
      },
    });
    const sent: string[] = [];
    const seen = { built: 0 };
    try {
      deliverySeq += 1;
      messageSeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "oi, tem alguém?",
        message_type: "incoming",
        sender: { id: 88, name: "Cliente", type: null },
        conversation: conversation(14, {
          assigneeType: null,
          status: "pending",
        }),
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `mon-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OUR_BOT,
        normalized: n,
        base: appDb,
        deps: {
          makeClient: (async () => {
            seen.built += 1;
            await suDb.agent.update({
              where: { id: agentDbId },
              data: { mode: "monitoring" },
            });
            return {
              sendMessage: async (_id: number, text: string) => {
                sent.push(text);
                return {};
              },
              sendPrivateNote: async () => ({}),
              toggleTyping: async () => ({}),
              getConversationLabels: async () => [],
              listLabels: async () => [],
              listCustomAttributeDefinitions: async () => [],
            } as unknown as ChatwootClient;
          }) as never,
          makeModel: () => {
            throw new Error("a consumed delivery must not reach the model");
          },
        },
      });
      expect(sent).toEqual([]);
      const ingested = (await jobs("INGEST_MESSAGE")).map((j) => j.dedupeKey);
      expect(ingested.some((k) => k.endsWith(`:${messageSeq}`))).toBe(true);
      expect((await row(14))?.lastHandledMessageId).toBe(messageSeq);
    } finally {
      await suDb.agent.update({
        where: { id: agentDbId },
        data: {
          mode: "monitoring",
          settings: { followUp: { enabled: true } },
        },
      });
    }
  });

  test("control: the same message on a production agent arms a flush", async () => {
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { mode: "production" },
    });
    requests.length = 0;
    await deliver(4, { assigneeType: null, status: "pending" });

    expect((await jobs("DEBOUNCE")).length).toBe(1);
    await suDb.agent.update({
      where: { id: agentDbId },
      data: { mode: "monitoring" },
    });
  });
});
