import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// A delivery on an OBSERVER's route (issue #476). The same inbox can have a responder of ours and
// an observer of ours, and Chatwoot delivers every event to each on its own route; what is asserted
// is that the observer's route takes the monitoring path with the OBSERVER's runtime — nothing
// posted, no flush, the message remembered under the observer — and that it touches nothing the
// responder's route owns: the handled watermark and the responder's own ledger row. On an inbox
// nobody of ours answers, the observer keeps the watermark, so a responder bound later does not
// answer the whole observed backlog as one burst.

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

const SHARED_INBOX = 84;
const OBSERVED_ONLY_INBOX = 85;
const RESPONDER_BOT = 24;
const OBSERVER_BOT = 25;
let tenantId = 0n;
let instanceId = 0n;
let responderId = 0n;
let observerId = 0n;
let deliverySeq = 0;
let messageSeq = 84_000;
let stamp = Math.floor(Date.now() / 1000);

const requests: { method: string; url: string }[] = [];
const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)("a delivery on an observer's route", () => {
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
      data: { name: "OBR", slug: `obr-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 51,
      baseUrl: "https://chat.observer-route.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const mk = async (name: string, mode: string, bot: number) => {
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name,
          systemPrompt: "…",
          modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
          enabled: true,
          mode,
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: bot,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `obr-route-${bot}-${process.pid}`,
          name,
        },
      });
      return agent.id;
    };
    responderId = await mk("Atendente", "production", RESPONDER_BOT);
    observerId = await mk("Observadora", "monitoring", OBSERVER_BOT);
    const shared = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: SHARED_INBOX,
        name: "SAC",
        agentId: responderId,
      },
    });
    const observedOnly = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: OBSERVED_ONLY_INBOX,
        name: "Humanos",
      },
    });
    await suDb.inboxObserver.createMany({
      data: [
        { tenantId, inboxId: shared.id, agentId: observerId },
        { tenantId, inboxId: observedOnly.id, agentId: observerId },
      ],
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
      "inbox_observers",
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
    inboxId: number,
    held: {
      assigneeType?: "User" | "AgentBot" | null;
      assigneeId?: number;
      noMeta?: boolean;
      status: string;
    },
    // When the source EMITTED this event. The stand-down beside a responder compares the binding
    // against this, not against our receipt, so a case about a binding made after the event has to
    // say when the event happened.
    emittedAt?: Date,
  ) {
    stamp += 1;
    return {
      id: convId,
      inbox_id: inboxId,
      status: held.status,
      contact_inbox: { id: 84_000 + convId },
      // `noMeta` is a DEGRADED event: no meta at all, so the payload says nothing about who holds the
      // conversation — which is not the same as saying nobody does.
      ...(held.noMeta
        ? {}
        : {
            meta: {
              ...(held.assigneeType === "User"
                ? { assignee_type: "User", assignee: { id: 5, name: "Ana" } }
                : held.assigneeType === "AgentBot"
                  ? {
                      assignee_type: "AgentBot",
                      assignee: { id: held.assigneeId ?? 0, name: "Robô" },
                    }
                  : { assignee: null }),
              sender: { id: 99, name: "Cliente" },
            },
          }),
      channel: "Channel::Api",
      last_activity_at: Math.floor((emittedAt?.getTime() ?? Date.now()) / 1000),
      updated_at: stamp,
    };
  }

  async function deliver(
    route: number,
    convId: number,
    inboxId: number,
    held: {
      assigneeType?: "User" | "AgentBot" | null;
      assigneeId?: number;
      noMeta?: boolean;
      status: string;
    },
    // A SPARSE payload names no inbox; the observer is then found through the mirrored conversation.
    sparse = false,
    content = "quero cancelar meu ingresso",
    // The moment the ledger row was RECEIVED. The stand-down beside a responder compares it against
    // the age of that responder's binding, so a case about a binding made later needs the two to be
    // orderable — and `now` for both is not.
    receivedAt?: Date,
    // A REPLAY of a row the ledger already records as an observer's, the shape the sweep's recovery
    // comes back through. `claimedAt` is stamped by that claim, which is what made the row able to
    // match itself in the sibling count.
    replay?: { routeAgentBotId: number; claimedAt: Date },
  ): Promise<{ messageId: number; deliveryRowId: bigint }> {
    deliverySeq += 1;
    messageSeq += 1;
    // The receipt doubles as the emission for a case that names one: an event our row received an
    // hour ago was emitted at least that long ago too.
    const conv = conversation(convId, inboxId, held, receivedAt) as Record<
      string,
      unknown
    >;
    if (sparse) delete conv.inbox_id;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageSeq,
      private: false,
      content,
      message_type: "incoming",
      sender: { id: 99, name: "Cliente", type: null },
      conversation: conv,
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: replay === undefined ? "PENDING" : "DEAD",
        ...(receivedAt === undefined ? {} : { receivedAt }),
        ...(replay === undefined
          ? {}
          : {
              conversationId: convId,
              inboundMessageId: messageSeq,
              routeAgentBotId: replay.routeAgentBotId,
              routeObserved: true,
              claimedAt: replay.claimedAt,
            }),
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: route,
      normalized: n,
      base: appDb,
      ...(replay === undefined
        ? {}
        : { routeObserved: true, claimFrom: "DEAD" as const }),
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
      select: { dedupeKey: true, payload: true },
      orderBy: { id: "asc" },
    });
  }

  async function row(convId: number) {
    return suDb.conversation.findFirst({
      where: { tenantId, chatwootConversationId: convId },
      select: { id: true, lastHandledMessageId: true, lastInboundAt: true },
    });
  }

  test("beside a responder of ours: the observer's runtime, nothing posted, NOT remembered a second time (the responder's route remembers), the watermark and the responder's row untouched", async () => {
    requests.length = 0;
    // The responder's own delivery of the same message, still being worked on its route.
    messageSeq += 1;
    const sharedMessage = messageSeq + 1;
    const responderRow = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-responder`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: 1,
        inboundMessageId: sharedMessage,
        routeAgentBotId: RESPONDER_BOT,
        claimedAt: new Date(),
      },
      select: { id: true },
    });
    const { messageId, deliveryRowId } = await deliver(
      OBSERVER_BOT,
      1,
      SHARED_INBOX,
      { assigneeType: "User", status: "open" },
    );
    expect(messageId).toBe(sharedMessage);

    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    // The thread is the contact-inbox's, shared with the responder, whose own route appends this
    // message (its turn, or its continuous ingestion). An append from here doubled it.
    expect(await jobs("INGEST_MESSAGE")).toEqual([]);
    const conv = await row(1);
    expect(conv?.lastHandledMessageId).toBeNull();
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: deliveryRowId },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSED");
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: responderRow.id },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSING");
    expect(
      await flowLogRows(suDb, {
        where: { tenantId, stage: "handoff", conversationId: conv?.id },
      }),
    ).toEqual([]);
  });

  test("on an inbox nobody of ours answers: remembered, and the watermark is the observer's to keep", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    const { messageId } = await deliver(OBSERVER_BOT, 2, OBSERVED_ONLY_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    expect((await row(2))?.lastHandledMessageId).toBe(messageId);
  });

  // A switched-off agent's contract: the message waits for the switch. Ingestion refuses a disabled
  // agent, so marking here would put it behind the watermark with nothing holding it, and a
  // monitoring agent arms no flush that could read it later.
  test("on an inbox nobody of ours answers, with the observer switched off: nothing remembered and nothing marked", async () => {
    requests.length = 0;
    await suDb.agent.update({
      where: { id: observerId },
      data: { enabled: false },
    });
    try {
      const before = (await jobs("INGEST_MESSAGE")).length;
      await deliver(OBSERVER_BOT, 44, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before);
      expect((await row(44))?.lastHandledMessageId).toBeNull();
    } finally {
      await suDb.agent.update({
        where: { id: observerId },
        data: { enabled: true },
      });
    }
  });

  test("a payload that names no inbox still reaches the observer, through the mirrored conversation", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    // Conversation 2 was mirrored with its inbox by the previous case; this message says nothing.
    const { messageId } = await deliver(
      OBSERVER_BOT,
      2,
      OBSERVED_ONLY_INBOX,
      { assigneeType: "User", status: "open" },
      true,
    );
    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    const ingest = await jobs("INGEST_MESSAGE");
    expect(ingest.length).toBe(before + 1);
    const last = ingest[ingest.length - 1]?.payload as
      | { agentId?: string }
      | undefined;
    expect(last?.agentId).toBe(String(observerId));
    expect((await row(2))?.lastHandledMessageId).toBe(messageId);
  });

  test("beside a responder that is switched off: remembered here, and the watermark moves (what it saw is the past when the switch returns)", async () => {
    requests.length = 0;
    await suDb.agent.update({
      where: { id: responderId },
      data: { enabled: false },
    });
    try {
      const before = (await jobs("INGEST_MESSAGE")).length;
      const { messageId } = await deliver(OBSERVER_BOT, 41, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect(await jobs("DEBOUNCE")).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
      expect((await row(41))?.lastHandledMessageId).toBe(messageId);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { enabled: true },
      });
    }
  });

  // The persona bot deleted out-of-band on Chatwoot leaves the binding standing and the responder's
  // route dead — the state the console shows as "missing", with a Reconnect beside it. Standing
  // down for a delivery that never comes would lose the message from memory entirely.
  test("beside a responder whose bot row is gone: remembered here, because no delivery of its own is coming", async () => {
    requests.length = 0;
    const bot = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { agentId: responderId },
    });
    await suDb.chatwootAgentBot.delete({ where: { id: bot.id } });
    try {
      const before = (await jobs("INGEST_MESSAGE")).length;
      await deliver(OBSERVER_BOT, 46, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect(await jobs("DEBOUNCE")).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    } finally {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId: bot.tenantId,
          chatwootInstanceId: bot.chatwootInstanceId,
          agentId: bot.agentId,
          chatwootAgentBotId: bot.chatwootAgentBotId,
          accessToken: bot.accessToken,
          webhookSecret: bot.webhookSecret,
          webhookRouteTokenHash: bot.webhookRouteTokenHash,
          name: bot.name,
        },
      });
    }
  });

  // Chatwoot picks a message's webhook recipients when it EMITS the event, so a responder bound
  // afterwards gets no delivery for it. Standing down there would omit the message from memory for
  // good: nothing scans a settled observer row again (issue #476 review, round 31).
  test("beside a responder bound after this message: remembered here, because no delivery of its own was ever fanned", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    const received = new Date(Date.now() - 60_000);
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 30_000) },
    });
    try {
      await deliver(
        OBSERVER_BOT,
        61,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "quero cancelar meu ingresso",
        received,
      );
      expect(customerFacing()).toEqual([]);
      expect(await jobs("DEBOUNCE")).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
      // ...AND THE MARK DOES NOT MOVE. An absent sibling row is not proof that none is coming — it
      // is also what one still in transit looks like — so the memory is paid here while the mark
      // stays the answering half's. Moved, it would put the message behind the watermark and the
      // responder's own delivery, arriving a moment later, would answer nobody.
      expect((await row(61))?.lastHandledMessageId).toBeNull();
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // The clock says the binding is newer, and the ledger says the delivery came anyway: the two
  // routes raced and this one lost. Direct evidence beats the inference, and folding here would
  // double the message in the shared thread.
  test("beside a responder bound after this message, whose own delivery is nonetheless in the ledger: NOT remembered a second time", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    const received = new Date(Date.now() - 60_000);
    const sharedMessage = messageSeq + 1;
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-responder-late`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: 62,
        inboundMessageId: sharedMessage,
        routeAgentBotId: RESPONDER_BOT,
        claimedAt: new Date(),
      },
    });
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 30_000) },
    });
    try {
      const { messageId } = await deliver(
        OBSERVER_BOT,
        62,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "quero cancelar meu ingresso",
        received,
      );
      expect(messageId).toBe(sharedMessage);
      expect(customerFacing()).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before);
      expect((await row(62))?.lastHandledMessageId).toBeNull();
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // THE RECEIPT IS THE EMISSION PLUS A NETWORK HOP PLUS HOWEVER LONG THE DELIVERY WAITED. Compared
  // against the receipt, a binding made anywhere in that stretch reads as covering a message it
  // never reached; compared against the payload's own clock it does not.
  test("beside a responder bound after the EVENT but before our receipt of it: remembered here", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    // The event happened two minutes ago, the binding a minute later, and our row received it now:
    // `responderBoundAt <= receivedAt` holds and says nothing.
    const emitted = new Date(Date.now() - 120_000);
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 60_000) },
    });
    try {
      const conv = conversation(
        67,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        emitted,
      );
      messageSeq += 1;
      deliverySeq += 1;
      const n = normalizeChatwootEvent({
        event: "message_created",
        id: messageSeq,
        private: false,
        content: "quero cancelar meu ingresso",
        message_type: "incoming",
        sender: { id: 99, name: "Cliente", type: null },
        conversation: conv,
      });
      if (!n) throw new Error("payload did not normalize");
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `obr-${process.pid}-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
        },
        select: { id: true },
      });
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OBSERVER_BOT,
        normalized: n,
        base: appDb,
      });
      expect(customerFacing()).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // INSIDE THE BAND THE CLOCKS SAY NOTHING. `responderBoundAt` is ours and `last_activity_at` is
  // Chatwoot's, so a binding stamped seconds before the event is only "older" if both hosts agree on
  // the time, which is not something either of them can promise. The ledger is asked instead, and
  // with no sibling there the message is the observer's — a duplicate line if the sibling was merely
  // in flight, against losing the message if it was never coming.
  test("beside a responder bound moments before this message: remembered here, since no clock settles it", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 20_000) },
    });
    try {
      await deliver(OBSERVER_BOT, 71, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // A COLLEAGUE'S REPLY IS OUTGOING, so the ledger names it through `humanReplyMessageId` and its
  // `inboundMessageId` is null by construction. Asked with the inbound column alone, the sibling was
  // never found — "not covered" without looking — and both routes appended the same reply to the
  // shared contact-inbox thread.
  test("a colleague's reply finds the responder's sibling on the column that names it", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    // Inside the skew band, so the clocks settle nothing and the ledger is what answers.
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 20_000) },
    });
    deliverySeq += 1;
    messageSeq += 1;
    const replyId = messageSeq;
    // The responder's own delivery of the SAME reply, already on the ledger.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-reply-sibling`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: 72,
        humanReplyShape: "composer",
        humanReplyMessageId: replyId,
        routeAgentBotId: RESPONDER_BOT,
        claimedAt: new Date(),
      },
    });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: replyId,
      private: false,
      content: "Oi! Vou verificar seu pedido agora.",
      message_type: "outgoing",
      sender: { id: 5, name: "Ana", type: "user" },
      conversation: conversation(72, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      }),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
      },
      select: { id: true },
    });
    try {
      await processChatwootDelivery({
        tenantId,
        instanceId,
        deliveryRowId: delivery.id,
        agentBotId: OBSERVER_BOT,
        normalized: n,
        base: appDb,
      });
      expect(customerFacing()).toEqual([]);
      // The responder's route remembers it; a second append from here is the duplicate.
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before);
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // `bindInbox` calls Chatwoot BEFORE it commits `agentId`, so a message arriving inside that window
  // is fanned to a responder route the local mirror does not know yet: that delivery resolves no
  // runtime, answers nothing and settles. Counting it as coverage hands the message to a route that
  // already declined it, and NEITHER route answers or remembers.
  test("beside a responder bound after this message, whose sibling delivery already ran blind: remembered here", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    const received = new Date(Date.now() - 60_000);
    const boundAt = new Date(Date.now() - 30_000);
    const sharedMessage = messageSeq + 1;
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-responder-blind`,
        event: "message_created",
        status: "PROCESSED",
        conversationId: 64,
        inboundMessageId: sharedMessage,
        routeAgentBotId: RESPONDER_BOT,
        receivedAt: received,
        // Claimed BEFORE the binding committed: it ran with no agent bound and covered nothing.
        claimedAt: new Date(boundAt.getTime() - 5_000),
        processedAt: new Date(boundAt.getTime() - 4_000),
      },
    });
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: boundAt },
    });
    try {
      const { messageId } = await deliver(
        OBSERVER_BOT,
        64,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "quero cancelar meu ingresso",
        received,
      );
      expect(messageId).toBe(sharedMessage);
      expect(customerFacing()).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // The ordinary shape, stated on its own rather than left to a fixture that never set the column: a
  // binding older than the delivery is one Chatwoot fanned to, whether or not its row has landed —
  // and OLDER BY A MARGIN, because the two stamps come from different hosts. Ten minutes is outside
  // the band, so no clock skew can turn this answer around.
  test("beside a responder bound well before this message: NOT remembered here, even with no ledger row of its own yet", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 10 * 60_000) },
    });
    try {
      await deliver(OBSERVER_BOT, 63, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before);
      expect((await row(63))?.lastHandledMessageId).toBeNull();
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // THE RESOLUTION NOW STANDS BEFORE THE CLAIM, so a transient failure there rejects with the row
  // still PENDING and its role unsaid — the webhook long since acknowledged, and no caller left to
  // ask again. A handful of attempts is what separates "the pool was briefly exhausted" from a
  // message the recovery will refuse.
  test("a transient failure resolving the route is retried, and the delivery still records its role", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    let failures = 0;
    // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
    const wrap = (target: any): any =>
      new Proxy(target, {
        get(t, prop, recv) {
          if (prop === "$extends")
            return (...a: unknown[]) => wrap(t.$extends(...a));
          if (prop === "$transaction")
            return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
              t.$transaction((tx: unknown) => fn(wrap(tx)), ...rest);
          if (prop !== "chatwootAgentBot") return Reflect.get(t, prop, recv);
          const delegate = Reflect.get(t, prop, recv);
          return new Proxy(delegate, {
            get(d, k, r) {
              const inner = Reflect.get(d, k, r);
              if (k !== "findFirst") return inner;
              return async (args: unknown) => {
                // Twice, then let it through: the point is that the attempt after a stumble wins.
                if (failures < 2) {
                  failures += 1;
                  throw new Error("pool exhausted");
                }
                return (inner as (a: unknown) => Promise<unknown>).call(
                  d,
                  args,
                );
              };
            },
          });
        },
      });

    deliverySeq += 1;
    messageSeq += 1;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageSeq,
      private: false,
      content: "quero cancelar meu ingresso",
      message_type: "incoming",
      sender: { id: 99, name: "Cliente", type: null },
      conversation: conversation(70, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      }),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
      },
      select: { id: true },
    });

    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: OBSERVER_BOT,
      normalized: n,
      base: wrap(appDb) as typeof appDb,
      deps: { sleep: async () => {} },
    });

    expect(failures).toBe(2);
    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
      select: { routeObserved: true, status: true },
    });
    // The role is stated and the message remembered, which is the pair a spent resolution loses.
    expect(row.routeObserved).toBe(true);
    expect(row.status).toBe("PROCESSED");
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
  });

  // THE CLAIM STATES THE ROLE, so a row that is PROCESSING has already said what it is. Written by a
  // second statement it had its own failure path — rejecting inside a detached task, long after the
  // webhook answered 200 — and the row it left said nothing, which the recovery refuses to guess at.
  test("the claim itself records the route role, so no row is ever PROCESSING without one", async () => {
    requests.length = 0;
    const { deliveryRowId } = await deliver(OBSERVER_BOT, 68, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    const observed = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: deliveryRowId },
      select: { routeObserved: true, claimedAt: true },
    });
    expect(observed.routeObserved).toBe(true);
    expect(observed.claimedAt).not.toBeNull();

    // The responder's own route states the other value, on the same statement.
    const { deliveryRowId: responderRow } = await deliver(
      RESPONDER_BOT,
      69,
      SHARED_INBOX,
      { assigneeType: "User", status: "open" },
    );
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: responderRow },
          select: { routeObserved: true },
        })
      ).routeObserved,
    ).toBe(false);
  });

  // THE REPLAY NEVER RESTATES THE ROLE DOWNWARD. The recovery validates the observer's bot before it
  // dispatches; this resolution runs after that, so a bot reprovisioned or deleted in between leaves
  // no observer runtime on a row the ledger says was a watcher's. Restating `false` from that
  // reading hands the row to the inbox's own derivation, and on a human-owned conversation the
  // responder path settles it PROCESSED with nobody having remembered the message — and with the
  // role that would have sent it back overwritten (issue #476 review, round 53).
  test("a replay whose observer runtime is gone is left DEAD, not restated as the responder", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    const bot = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { agentId: observerId },
    });
    await suDb.chatwootAgentBot.delete({ where: { id: bot.id } });
    let deliveryRowId: bigint;
    try {
      ({ deliveryRowId } = await deliver(
        OBSERVER_BOT,
        73,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "quero cancelar meu ingresso",
        undefined,
        { routeAgentBotId: OBSERVER_BOT, claimedAt: new Date() },
      ));
    } finally {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId: bot.tenantId,
          chatwootInstanceId: bot.chatwootInstanceId,
          agentId: bot.agentId,
          chatwootAgentBotId: bot.chatwootAgentBotId,
          accessToken: bot.accessToken,
          webhookSecret: bot.webhookSecret,
          webhookRouteTokenHash: bot.webhookRouteTokenHash,
          name: bot.name,
        },
      });
    }
    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: deliveryRowId },
      select: { routeObserved: true, status: true, attempts: true },
    });
    // Untouched: the role it was recorded under, the state that keeps it on the worklist, and the
    // attempt it never spent.
    expect(row.routeObserved).toBe(true);
    expect(row.status).toBe("DEAD");
    expect(row.attempts).toBe(0);
    // And nothing ran on the responder's behalf.
    expect(customerFacing()).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before);
  });

  // ONE BOT SERVES EVERY ROLE ITS AGENT HOLDS. Unobserve the watcher and bind it as the responder,
  // and the responder's bot id is the one THIS row arrived on — while the recovery's own claim
  // stamps `claimedAt` after the binding. Counted, the row proves itself covered by a responder
  // delivery that never existed, and closes with nothing remembering the message.
  test("a replayed observer row does not count as its own responder sibling", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    const boundAt = new Date(Date.now() - 30_000);
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: OBSERVED_ONLY_INBOX },
      data: { agentId: observerId, responderBoundAt: boundAt },
    });
    try {
      const { messageId } = await deliver(
        OBSERVER_BOT,
        65,
        OBSERVED_ONLY_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "quero cancelar meu ingresso",
        new Date(Date.now() - 60_000),
        {
          routeAgentBotId: OBSERVER_BOT,
          claimedAt: new Date(boundAt.getTime() + 5_000),
        },
      );
      expect(customerFacing()).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
      // AND THE MARK MOVES, because this is a REPLAY: the delivery got here only after the sweep
      // gave up on it, so a sibling that was ever coming has long since arrived. Held back, it
      // would be withheld from the responder bound meanwhile, which would then flush from a
      // watermark predating the whole observed backlog.
      expect((await row(65))?.lastHandledMessageId).toBe(messageId);
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: OBSERVED_ONLY_INBOX },
        data: { agentId: null, responderBoundAt: null },
      });
    }
  });

  // The command stand-down rests on the same premise the memory one does: the responder's own
  // delivery carries the `/teste`. Bound after the emission, it never received one, and dropping the
  // command here loses it from every memory.
  test("a control command beside a responder bound after it IS folded in, since no route of its own carried it", async () => {
    requests.length = 0;
    await suDb.agent.update({
      where: { id: responderId },
      data: { mode: "test" },
    });
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 30_000) },
    });
    try {
      const before = (await jobs("INGEST_MESSAGE")).length;
      await deliver(
        OBSERVER_BOT,
        66,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "/teste",
        new Date(Date.now() - 60_000),
      );
      expect(customerFacing()).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
      // ...AND THE INBOUND MARK MOVES WITH IT. Ordinary customer text here, so suppressing
      // `lastInboundAt` would leave the follow-up episode gate and the 24h service window reading
      // the previous inbound for a message the customer just sent.
      expect((await row(66))?.lastInboundAt).not.toBeNull();
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { mode: "production" },
      });
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  test("beside a responder in test mode: remembered here, and the watermark stays the responder's (it may still answer an activated conversation)", async () => {
    requests.length = 0;
    await suDb.agent.update({
      where: { id: responderId },
      data: { mode: "test" },
    });
    try {
      const before = (await jobs("INGEST_MESSAGE")).length;
      await deliver(OBSERVER_BOT, 42, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect(await jobs("DEBOUNCE")).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
      expect((await row(42))?.lastHandledMessageId).toBeNull();
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { mode: "production" },
      });
    }
  });

  // WHAT MAKES A ROUTE AN OBSERVER'S is the delivery: the fork delivers to a bot's route only because
  // that bot is the inbox's responder or an observer of it. The row follows Chatwoot's agreement, so
  // the first events can arrive before it — and a monitoring agent on a route that is not the
  // responder's is an observer's with or without the row.
  test("a monitoring agent's bot with no row yet, on an inbox it does not answer, is still the observer's route", async () => {
    requests.length = 0;
    const vigia = await suDb.agent.create({
      data: {
        tenantId,
        name: "Vigia",
        systemPrompt: "…",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "monitoring",
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: vigia.id,
        chatwootAgentBotId: 26,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `obr-route-26-${process.pid}`,
        name: "Vigia",
      },
    });
    const before = (await jobs("INGEST_MESSAGE")).length;
    const { messageId } = await deliver(26, 43, OBSERVED_ONLY_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    expect((await row(43))?.lastHandledMessageId).toBe(messageId);
  });

  // `/teste` on a shared inbox is the RESPONDER's command. On this route the mode read is the
  // observer's, so the command reads as ordinary text — and folding it in would put it in the shared
  // thread, where an ingestion racing the responder's `/reset` appends it back after the reset.
  test("a control command beside a responder is not folded into the shared memory", async () => {
    requests.length = 0;
    await suDb.agent.update({
      where: { id: responderId },
      data: { mode: "test" },
    });
    try {
      const before = (await jobs("INGEST_MESSAGE")).length;
      await deliver(
        OBSERVER_BOT,
        48,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "/teste",
      );
      expect(customerFacing()).toEqual([]);
      expect((await jobs("INGEST_MESSAGE")).length).toBe(before);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { mode: "production" },
      });
    }
  });

  // ...but a monitoring bot that HOLDS the conversation is on the assigned bot's route, not an
  // observer's: the fork delivers to the conversation's assignee bot too, and a bot that used to be
  // the inbox's responder keeps holding what it was assigned. Read as an observer's, that route
  // would answer nothing while the current responder's own route stands down before a conversation
  // another bot holds — and nobody would answer at all.
  test("a monitoring bot that holds the conversation is the assigned bot's route, not an observer's", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    const { messageId } = await deliver(26, 47, SHARED_INBOX, {
      assigneeType: "AgentBot",
      assigneeId: 26,
      status: "open",
    });
    expect(customerFacing()).toEqual([]);
    // Folded in under the inbox's RESPONDER, which is what the assigned bot's route does with a
    // message no turn covers — never under the monitoring bot whose route this is.
    const armed = (
      await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "INGEST_MESSAGE" },
        select: { payload: true },
      })
    ).filter((j) => JSON.stringify(j.payload).includes(String(messageId)));
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    expect(
      armed.some((j) =>
        JSON.stringify(j.payload).includes(`"agentId":"${responderId}"`),
      ),
    ).toBe(true);
  });

  // With NO responder there is nobody to hand it to: the watcher's memory is the only one the inbox
  // has, and the assigned bot's path would resolve no runtime at all.
  test("...but on an inbox nobody answers, the watcher keeps the conversations it holds", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    await deliver(OBSERVER_BOT, 52, OBSERVED_ONLY_INBOX, {
      assigneeType: "AgentBot",
      assigneeId: OBSERVER_BOT,
      status: "open",
    });
    expect(customerFacing()).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
  });

  // The watcher that used to answer: an agent added as the inbox's observer still HOLDS the
  // conversations it was assigned back then, and those deliveries stay the assigned bot's.
  test("an observer that holds the conversation is still the assigned bot's route", async () => {
    requests.length = 0;
    const before = (await jobs("INGEST_MESSAGE")).length;
    const { messageId } = await deliver(OBSERVER_BOT, 50, SHARED_INBOX, {
      assigneeType: "AgentBot",
      assigneeId: OBSERVER_BOT,
      status: "open",
    });
    // The message is folded in under the RESPONDER, which is what the assigned bot's route does with
    // a conversation no turn covers — never under the watcher, whose route this is not.
    const armed = (
      await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "INGEST_MESSAGE" },
        select: { payload: true },
      })
    ).filter((j) => JSON.stringify(j.payload).includes(String(messageId)));
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    expect(
      armed.some((j) =>
        JSON.stringify(j.payload).includes(`"agentId":"${responderId}"`),
      ),
    ).toBe(true);
    expect(
      armed.some((j) =>
        JSON.stringify(j.payload).includes(`"agentId":"${observerId}"`),
      ),
    ).toBe(false);
  });

  // An EXPLICIT unassignment is an answer, not silence: the mirror must not overrule it with a
  // stale owner it has not caught up with.
  test("an explicitly unassigned payload is not overruled by the mirror", async () => {
    requests.length = 0;
    // Mirrored as held by the watcher's own bot, from when it answered this inbox.
    await deliver(OBSERVER_BOT, 51, OBSERVED_ONLY_INBOX, {
      assigneeType: "AgentBot",
      assigneeId: OBSERVER_BOT,
      status: "open",
    });
    const before = (await jobs("INGEST_MESSAGE")).length;
    const { messageId } = await deliver(OBSERVER_BOT, 51, OBSERVED_ONLY_INBOX, {
      assigneeType: null,
      status: "open",
    });
    const armed = (
      await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "INGEST_MESSAGE" },
        select: { payload: true },
      })
    ).filter((j) => JSON.stringify(j.payload).includes(String(messageId)));
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    // Unassigned, so this route is the observer's: the message is remembered under the WATCHER.
    expect(
      armed.some((j) =>
        JSON.stringify(j.payload).includes(`"agentId":"${observerId}"`),
      ),
    ).toBe(true);
  });

  // A DEGRADED payload names no assignee at all, and the mirror is what still knows the conversation
  // is held by the bot that used to answer this inbox. Read as "held by nobody", the route would be
  // taken for an observer's and the customer would go unanswered.
  test("a payload with no assignee falls back to the mirror before claiming an observer's route", async () => {
    requests.length = 0;
    // Mirrored as the previous case left it: held by bot 26, which is not this inbox's responder.
    await suDb.conversation.updateMany({
      where: { tenantId, chatwootConversationId: 47 },
      data: { assigneeType: "AgentBot", assigneeId: 26 },
    });
    const { messageId } = await deliver(26, 47, SHARED_INBOX, {
      noMeta: true,
      status: "open",
    });
    expect(customerFacing()).toEqual([]);
    // The route is the assigned bot's, so the message is the RESPONDER's to remember.
    const armed = (
      await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "INGEST_MESSAGE" },
        select: { payload: true },
      })
    ).filter((j) => JSON.stringify(j.payload).includes(String(messageId)));
    expect(
      armed.some((j) =>
        JSON.stringify(j.payload).includes(`"agentId":"${responderId}"`),
      ),
    ).toBe(true);
  });

  test("a production agent's bot with no binding on the inbox keeps the responder path it had (a mirror that drifted)", async () => {
    requests.length = 0;
    const outra = await suDb.agent.create({
      data: {
        tenantId,
        name: "Outra",
        systemPrompt: "…",
        modelConfig: { provider: "openai", model: "gpt-5.4-mini" },
        enabled: true,
        mode: "production",
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: outra.id,
        chatwootAgentBotId: 27,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `obr-route-27-${process.pid}`,
        name: "Outra",
      },
    });
    // On the shared inbox the responder's own path folds a human-held message in and moves the
    // watermark; the observer's path beside that responder would do neither.
    const before = (await jobs("INGEST_MESSAGE")).length;
    const { messageId } = await deliver(27, 44, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(customerFacing()).toEqual([]);
    expect((await jobs("INGEST_MESSAGE")).length).toBe(before + 1);
    expect((await row(44))?.lastHandledMessageId).toBe(messageId);
  });

  // The role is RECORDED, because nothing after the fact can derive it: the observer row follows
  // Chatwoot's agreement, and a binding that moved since is about a different moment.
  test("the delivery row remembers which route it arrived on, observer or responder", async () => {
    requests.length = 0;
    const { deliveryRowId } = await deliver(OBSERVER_BOT, 53, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: deliveryRowId },
          select: { routeObserved: true },
        })
      ).routeObserved,
    ).toBe(true);

    // ...and a responder's delivery says so explicitly. Null is neither role: it is "nobody
    // decided", which is what a delivery stranded before the receiver got this far leaves behind,
    // and the recovery refuses to guess for it.
    const responderDelivery = await deliver(RESPONDER_BOT, 54, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: responderDelivery.deliveryRowId },
          select: { routeObserved: true },
        })
      ).routeObserved,
    ).toBe(false);
  });

  test("control: the responder's own route on the shared inbox still arms a flush", async () => {
    requests.length = 0;
    await deliver(RESPONDER_BOT, 3, SHARED_INBOX, {
      assigneeType: null,
      status: "pending",
    });
    expect((await jobs("DEBOUNCE")).length).toBe(1);
  });
});
