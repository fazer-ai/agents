import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { chatwootThreadId, contactInboxThreadId } from "@/graph/checkpointer";
import { ingestDedupeKey } from "@/graph/ingest-job";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import {
  processChatwootDelivery,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// A delivery on an OBSERVER's route. The same inbox can have a responder of ours and an observer of
// ours, and Chatwoot delivers every event to each on its own route; the observer's route takes the
// monitoring path with the OBSERVER's runtime (nothing posted, no flush) and touches nothing the
// responder's route owns: the handled watermark and the responder's own ledger row. On an inbox
// nobody of ours answers, the observer remembers nothing (the only reader of that memory is a
// responder's turn) and keeps the watermark, so a responder bound later does not answer the whole
// observed backlog as one burst.

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
// A QUE CONVERSA CADA MENSAGEM PERTENCE, registrado onde a mensagem NASCE, o único lugar onde isso é
// sabido sem inferência. Deixa uma asserção perguntar pela LINHA da mensagem sem repetir o número da
// conversa em cada caso.
const convOfMessage = new Map<number, number>();
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
    convOfMessage.set(messageSeq, convId);
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

  // "FOI ARMADA INGESTÃO PARA ESTA MENSAGEM" PERGUNTA PELA LINHA DELA, não pelo tamanho da
  // população: concluir o job apaga a linha (`JOB_DELETE_ON_DONE`) e `drainPendingIngest` drena as
  // pendentes de uma thread, então um delta sobre a população erra nos dois sentidos. A THREAD É A DO
  // CONTACT-INBOX (`contactInboxThreadId`); montada com `chatwootThreadId`, a chave de OBSERVE, a
  // pergunta responde "não armada" para tudo e os casos negativos passam por construção.
  function threadOf(convId: number) {
    return contactInboxThreadId(tenantId, instanceId, 84_000 + convId);
  }

  async function ingestRowFor(messageId: number) {
    const convId = convOfMessage.get(messageId);
    expect(
      convId,
      `a mensagem ${messageId} não foi registrada em convOfMessage. Toda mensagem deste arquivo se ` +
        `registra onde nasce (no \`deliver\`, ou ao lado do \`messageSeq += 1\` de quem monta a entrega ` +
        `à mão), e sem isso não dá para saber qual thread nomeia a linha dela.`,
    ).toBeDefined();
    return suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "INGEST_MESSAGE",
        dedupeKey: ingestDedupeKey(threadOf(convId as number), messageId),
      },
      select: { payload: true },
    });
  }

  // SOB QUAL AGENTE a linha foi armada, lido do campo da própria linha.
  function agentOf(row: { payload: unknown } | null) {
    return (row?.payload as { agentId?: string } | undefined)?.agentId;
  }

  async function ingestArmedFor(messageId: number) {
    return (await ingestRowFor(messageId)) !== null;
  }

  async function jobs(kind: "DEBOUNCE" | "INGEST_MESSAGE") {
    return suDb.schedulerJob.findMany({
      where: { tenantId, kind },
      select: { dedupeKey: true, payload: true },
      orderBy: { id: "asc" },
    });
  }

  // WHICH ROUTE the delivery took, as its own claim recorded it. On an inbox nobody of ours answers
  // the observer's route remembers nothing, so this is the witness a case about routing reads there.
  async function routeObservedOf(deliveryRowId: bigint) {
    return (
      await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
        where: { id: deliveryRowId },
        select: { routeObserved: true },
      })
    ).routeObserved;
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
    convOfMessage.set(messageSeq, 1);
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
    // NOTE: The thread is the contact-inbox's, shared with the responder, whose own route appends
    // this message (its turn, or its continuous ingestion); an append from here would double it.
    // Asked about THIS message's row, not the tenant's whole population.
    expect(await ingestArmedFor(messageId)).toBe(false);
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

  // NOTE: Nothing reads the contact-inbox thread on this inbox: a person answers it, and the
  // observer's tick reads the conversation from Chatwoot. Appending there would claim a job per
  // message from the share the observations wait on. The watermark is still this route's, and the
  // verdict is still armed.
  test("on an inbox nobody of ours answers: NOT remembered, and the watermark is still the observer's to keep", async () => {
    requests.length = 0;
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    const { messageId, deliveryRowId } = await deliver(
      OBSERVER_BOT,
      2,
      OBSERVED_ONLY_INBOX,
      { assigneeType: "User", status: "open" },
    );
    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect(await ingestArmedFor(messageId)).toBe(false);
    expect((await row(2))?.lastHandledMessageId).toBe(messageId);
    expect(await routeObservedOf(deliveryRowId)).toBe(true);
    const verdict = await suDb.schedulerJob.findMany({
      where: {
        tenantId,
        kind: "OBSERVE",
        dedupeKey: `observe:${chatwootThreadId(tenantId, instanceId, 2)}:${observerId}`,
      },
      select: { status: true },
    });
    expect(verdict).toEqual([{ status: "PENDING" }]);
    expect(
      await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
        where: { id: deliveryRowId },
        select: { status: true, routeRemembers: true },
      }),
    ).toEqual({ status: "PROCESSED", routeRemembers: false });
  });

  // NOTE: THE SWITCH IS NOT WHAT DECIDES IT: a row-backed observer ignores its mode, and an observer
  // whose mode reads as one that ingests continuously still has nobody to remember for here.
  test("on an inbox nobody of ours answers, an observer whose mode ingests continuously still remembers nothing", async () => {
    requests.length = 0;
    await suDb.agent.update({
      where: { id: observerId },
      data: { mode: "production" },
    });
    try {
      const { messageId, deliveryRowId } = await deliver(
        OBSERVER_BOT,
        90,
        OBSERVED_ONLY_INBOX,
        { assigneeType: "User", status: "open" },
      );
      expect(customerFacing()).toEqual([]);
      expect(await routeObservedOf(deliveryRowId)).toBe(true);
      expect(await ingestArmedFor(messageId)).toBe(false);
      expect((await row(90))?.lastHandledMessageId).toBe(messageId);
    } finally {
      await suDb.agent.update({
        where: { id: observerId },
        data: { mode: "monitoring" },
      });
    }
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
      const { messageId } = await deliver(
        OBSERVER_BOT,
        44,
        OBSERVED_ONLY_INBOX,
        {
          assigneeType: "User",
          status: "open",
        },
      );
      expect(customerFacing()).toEqual([]);
      expect(await ingestArmedFor(messageId)).toBe(false);
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
    // Conversation 2 was mirrored with its inbox by an earlier case; this message says nothing.
    const { messageId, deliveryRowId } = await deliver(
      OBSERVER_BOT,
      2,
      OBSERVED_ONLY_INBOX,
      { assigneeType: "User", status: "open" },
      true,
    );
    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect(await routeObservedOf(deliveryRowId)).toBe(true);
    expect((await row(2))?.lastHandledMessageId).toBe(messageId);
  });

  test("beside a responder that is switched off: remembered here, and the watermark moves (what it saw is the past when the switch returns)", async () => {
    requests.length = 0;
    await suDb.agent.update({
      where: { id: responderId },
      data: { enabled: false },
    });
    try {
      const { messageId } = await deliver(OBSERVER_BOT, 41, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect(await jobs("DEBOUNCE")).toEqual([]);
      expect(await ingestArmedFor(messageId)).toBe(true);
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
      const { messageId } = await deliver(OBSERVER_BOT, 46, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect(await jobs("DEBOUNCE")).toEqual([]);
      expect(await ingestArmedFor(messageId)).toBe(true);
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

  // NOTE: Chatwoot picks a message's webhook recipients when it EMITS the event, so a responder bound
  // afterwards gets no delivery for it. Standing down there would omit the message from memory for
  // good: nothing scans a settled observer row again.
  test("beside a responder bound after this message: remembered here, because no delivery of its own was ever fanned", async () => {
    requests.length = 0;
    const received = new Date(Date.now() - 60_000);
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 30_000) },
    });
    try {
      const { messageId } = await deliver(
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
      expect(await ingestArmedFor(messageId)).toBe(true);
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
      expect(await ingestArmedFor(messageId)).toBe(false);
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
      convOfMessage.set(messageSeq, 67);
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
      expect(await ingestArmedFor(messageSeq)).toBe(true);
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
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 20_000) },
    });
    try {
      const { messageId } = await deliver(OBSERVER_BOT, 71, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect(await ingestArmedFor(messageId)).toBe(true);
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
    // Inside the skew band, so the clocks settle nothing and the ledger is what answers.
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 20_000) },
    });
    deliverySeq += 1;
    messageSeq += 1;
    convOfMessage.set(messageSeq, 72);
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
      expect(await ingestArmedFor(replyId)).toBe(false);
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // NOTE: ...AND A `true` THE SIBLING HAS NOT FINISHED ACTING ON DOES NOT SILENCE THIS ROUTE. The
  // claim writes that value before the ingestion it promises: a responder switched off in between,
  // then crashing or failing to enqueue, leaves a row claiming a reply it never folded in, and no
  // sweep repairs it (a takeover recovery does not carry the reply body). Only on the REPLY column:
  // there, erring toward ingesting costs an append the dedup window catches, while on an inbound
  // message it can append one the responder's turn is about to answer, which nothing catches.
  test("a reply whose sibling only INTENDED to remember is remembered here", async () => {
    requests.length = 0;
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 20_000) },
    });
    deliverySeq += 1;
    messageSeq += 1;
    convOfMessage.set(messageSeq, 86);
    const replyId = messageSeq;
    // The responder's own delivery, claimed while it was on: `routeRemembers` says `true` and the
    // row never got past PROCESSING, which is what a crash between the claim and the enqueue leaves.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-reply-intent`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: 86,
        humanReplyShape: "composer",
        humanReplyMessageId: replyId,
        routeAgentBotId: RESPONDER_BOT,
        claimedAt: new Date(),
        routeRemembers: true,
      },
    });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: replyId,
      private: false,
      content: "Oi! Vou verificar seu pedido agora.",
      message_type: "outgoing",
      sender: { id: 5, name: "Ana", type: "user" },
      conversation: conversation(86, SHARED_INBOX, {
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
    // ...and the switch flipped after that claim, which is what makes the recorded intent false.
    await suDb.agent.update({
      where: { id: responderId },
      data: { enabled: false },
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
      // The reply is folded in HERE, because nothing else is going to.
      expect(await ingestArmedFor(replyId)).toBe(true);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { enabled: true },
      });
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // NOTE: ...AND THAT HOLDS WITH THE RESPONDER STILL ON. Falling back to the responder's CURRENT
  // mode for an unfinished reply sibling reads "remembers" for exactly this responder, and the
  // sibling crashing a moment later leaves the reply in nobody's memory. So the answer is `false`,
  // the only thing actually known, and being early costs an append the shared dedupe key and the
  // `human_agent` window refuse.
  test("a reply whose sibling is still working is remembered here even with the responder on", async () => {
    requests.length = 0;
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 20_000) },
    });
    deliverySeq += 1;
    messageSeq += 1;
    convOfMessage.set(messageSeq, 87);
    const replyId = messageSeq;
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-reply-working`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: 87,
        humanReplyShape: "composer",
        humanReplyMessageId: replyId,
        routeAgentBotId: RESPONDER_BOT,
        claimedAt: new Date(),
        routeRemembers: true,
      },
    });
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: replyId,
      private: false,
      content: "Oi! Vou verificar seu pedido agora.",
      message_type: "outgoing",
      sender: { id: 5, name: "Ana", type: "user" },
      conversation: conversation(87, SHARED_INBOX, {
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
      // The responder is production and enabled the whole time: the mode reading would have silenced
      // this route, and the sibling's own unfinished state is what does not.
      expect(await ingestArmedFor(replyId)).toBe(true);
      // NOTE: ...AND FILED UNDER THE RESPONDER. Its own delivery arms the same job when it finishes
      // and the later arm replaces the payload, so arming here under the observer would let the
      // route that got there last decide whose compaction settings summarise the attendance.
      expect(
        (
          (await ingestRowFor(replyId))?.payload as
            | { agentId?: string }
            | undefined
        )?.agentId,
      ).toBe(String(responderId));
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // NOTE: WHOSE MEMORY IT IS, when the responder does not hold it. The observer's route appends the
  // reply either way; filed under the responder only while that responder remembers continuously,
  // so a switched-off one or one in `test` leaves it under the observer. And the compaction the
  // payload carries is the owner's.
  test("a colleague's reply beside a responder is filed under whoever remembers it", async () => {
    const { settings, mode } = await suDb.agent.findUniqueOrThrow({
      where: { id: responderId },
      select: { settings: true, mode: true },
    });
    const variants = [
      {
        data: { settings: { memory: { compaction: { enabled: false } } } },
        owner: responderId,
        compaction: false,
      },
      { data: { enabled: false }, owner: observerId, compaction: true },
      { data: { mode: "test" }, owner: observerId, compaction: true },
    ] as const;
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 20_000) },
    });
    try {
      for (const v of variants) {
        await suDb.agent.update({ where: { id: responderId }, data: v.data });
        deliverySeq += 1;
        messageSeq += 1;
        convOfMessage.set(messageSeq, 88);
        const replyId = messageSeq;
        await suDb.chatwootWebhookDelivery.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            deliveryId: `obr-${process.pid}-owner-${deliverySeq}`,
            event: "message_created",
            status: "PROCESSING",
            conversationId: 88,
            humanReplyShape: "composer",
            humanReplyMessageId: replyId,
            routeAgentBotId: RESPONDER_BOT,
            claimedAt: new Date(),
            routeRemembers: true,
          },
        });
        const n = normalizeChatwootEvent({
          event: "message_created",
          id: replyId,
          private: false,
          content: "Já confirmei com o financeiro.",
          message_type: "outgoing",
          sender: { id: 5, name: "Ana", type: "user" },
          conversation: conversation(88, SHARED_INBOX, {
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
          base: appDb,
        });
        const payload = (await ingestRowFor(replyId))?.payload as {
          agentId: string;
          compactionEnabled: boolean;
        };
        expect(payload.agentId).toBe(String(v.owner));
        expect(payload.compactionEnabled).toBe(v.compaction);
        await suDb.agent.update({
          where: { id: responderId },
          data: { settings: settings ?? {}, enabled: true, mode },
        });
      }
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { settings: settings ?? {}, enabled: true, mode },
      });
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
      expect(await ingestArmedFor(messageId)).toBe(true);
      // NOTE: The responder never received it, so it holds no part of this append: filed under the
      // observer's own agent.
      expect(
        (
          (await ingestRowFor(messageId))?.payload as
            | { agentId?: string }
            | undefined
        )?.agentId,
      ).toBe(String(observerId));
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
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: SHARED_INBOX },
      data: { responderBoundAt: new Date(Date.now() - 10 * 60_000) },
    });
    try {
      const { messageId } = await deliver(OBSERVER_BOT, 63, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect(await ingestArmedFor(messageId)).toBe(false);
      expect((await row(63))?.lastHandledMessageId).toBeNull();
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: SHARED_INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  // NOTE: THE RESOLUTION STANDS BEFORE THE CLAIM, so a transient failure there rejects with the row
  // still PENDING and its role unsaid, the webhook long since acknowledged and no caller left to ask
  // again. A handful of attempts separates "the pool was briefly exhausted" from a message the
  // recovery will refuse.
  test("a transient failure resolving the route is retried, and the delivery still records its role", async () => {
    requests.length = 0;
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
    convOfMessage.set(messageSeq, 70);
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
    // NOTE: The role is stated and the delivery settled, the pair a spent resolution loses. On this
    // inbox the route remembers nothing, so the memory is no witness here.
    expect(row.routeObserved).toBe(true);
    expect(row.status).toBe("PROCESSED");
    expect(await ingestArmedFor(messageSeq)).toBe(false);
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

  // NOTE: THE REPLAY NEVER RESTATES THE ROLE DOWNWARD. The recovery validates the observer's bot
  // before it dispatches and this resolution runs after, so a bot reprovisioned or deleted between
  // them leaves no observer runtime on a row the ledger says was a watcher's. Restating `false`
  // would hand the row to the inbox's own derivation, and on a human-owned conversation the
  // responder path settles it PROCESSED with nobody having remembered the message, overwriting the
  // role that would have sent it back.
  test("a replay whose observer runtime is gone is left DEAD, not restated as the responder", async () => {
    requests.length = 0;
    const bot = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { agentId: observerId },
    });
    await suDb.chatwootAgentBot.delete({ where: { id: bot.id } });
    let deliveryRowId: bigint;
    let messageId: number;
    try {
      ({ deliveryRowId, messageId } = await deliver(
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
    expect(await ingestArmedFor(messageId)).toBe(false);
  });

  // ONE BOT SERVES EVERY ROLE ITS AGENT HOLDS. Unobserve the watcher and bind it as the responder,
  // and the responder's bot id is the one THIS row arrived on — while the recovery's own claim
  // stamps `claimedAt` after the binding. Counted, the row proves itself covered by a responder
  // delivery that never existed, and closes with nothing remembering the message.
  test("a replayed observer row does not count as its own responder sibling", async () => {
    requests.length = 0;
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
      expect(await ingestArmedFor(messageId)).toBe(true);
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
      const { messageId } = await deliver(
        OBSERVER_BOT,
        66,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "/teste",
        new Date(Date.now() - 60_000),
      );
      expect(customerFacing()).toEqual([]);
      expect(await ingestArmedFor(messageId)).toBe(true);
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
      const { messageId } = await deliver(OBSERVER_BOT, 42, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(customerFacing()).toEqual([]);
      expect(await jobs("DEBOUNCE")).toEqual([]);
      expect(await ingestArmedFor(messageId)).toBe(true);
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
    const { messageId, deliveryRowId } = await deliver(
      26,
      43,
      OBSERVED_ONLY_INBOX,
      { assigneeType: "User", status: "open" },
    );
    expect(customerFacing()).toEqual([]);
    expect(await jobs("DEBOUNCE")).toEqual([]);
    expect(await routeObservedOf(deliveryRowId)).toBe(true);
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
      const { messageId } = await deliver(
        OBSERVER_BOT,
        48,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "/teste",
      );
      expect(customerFacing()).toEqual([]);
      expect(await ingestArmedFor(messageId)).toBe(false);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { mode: "production" },
      });
    }
  });

  // ...but a monitoring bot that HOLDS the conversation is on the assigned bot's route, not an
  // observer's: the fork delivers to the conversation's assignee bot too, and a bot that was the
  // inbox's responder keeps holding what it was assigned. Read as an observer's, that route
  // would answer nothing while the current responder's own route stands down before a conversation
  // another bot holds — and nobody would answer at all.
  test("a monitoring bot that holds the conversation is the assigned bot's route, not an observer's", async () => {
    requests.length = 0;
    const { messageId } = await deliver(26, 47, SHARED_INBOX, {
      assigneeType: "AgentBot",
      assigneeId: 26,
      status: "open",
    });
    expect(customerFacing()).toEqual([]);
    // Folded in under the inbox's RESPONDER, which is what the assigned bot's route does with
    // a message no turn covers, never under the monitoring bot whose route this is. A linha desta
    // mensagem tem chave própria: as faixas de `contactInboxId` e `messageId` se sobrepõem, então
    // substring do payload casa linhas de outras mensagens.
    const armed = await ingestRowFor(messageId);
    expect(await ingestArmedFor(messageId)).toBe(true);
    expect(agentOf(armed)).toBe(String(responderId));
  });

  // With NO responder there is nobody to hand it to: the assigned bot's path would resolve no
  // runtime at all, and the watcher's route is the one that keeps the watermark and the verdict.
  test("...but on an inbox nobody answers, the watcher keeps the conversations it holds", async () => {
    requests.length = 0;
    const { deliveryRowId } = await deliver(
      OBSERVER_BOT,
      52,
      OBSERVED_ONLY_INBOX,
      { assigneeType: "AgentBot", assigneeId: OBSERVER_BOT, status: "open" },
    );
    expect(customerFacing()).toEqual([]);
    expect(await routeObservedOf(deliveryRowId)).toBe(true);
  });

  // NOTE: a watcher that once answered: an agent added as the inbox's observer still HOLDS the
  // conversations it was assigned back then, and those deliveries stay the assigned bot's.
  test("an observer that holds the conversation is still the assigned bot's route", async () => {
    requests.length = 0;
    const { messageId } = await deliver(OBSERVER_BOT, 50, SHARED_INBOX, {
      assigneeType: "AgentBot",
      assigneeId: OBSERVER_BOT,
      status: "open",
    });
    // The message is folded in under the RESPONDER, which is what the assigned bot's route
    // does with a conversation no turn covers, never under the watcher, whose route this is not. A
    // linha desta mensagem tem chave própria: as faixas de `contactInboxId` e `messageId` se
    // sobrepõem, então substring do payload casa linhas de outras mensagens.
    const armed = await ingestRowFor(messageId);
    expect(await ingestArmedFor(messageId)).toBe(true);
    expect(agentOf(armed)).toBe(String(responderId));
    expect(agentOf(armed)).not.toBe(String(observerId));
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
    const { deliveryRowId } = await deliver(
      OBSERVER_BOT,
      51,
      OBSERVED_ONLY_INBOX,
      {
        assigneeType: null,
        status: "open",
      },
    );
    // Unassigned, so this route is the observer's.
    expect(await routeObservedOf(deliveryRowId)).toBe(true);
  });

  // A DEGRADED payload names no assignee at all, and the mirror is what still knows the conversation
  // is held by the bot that answered this inbox before. Read as "held by nobody", the route would be
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
    // The route is the assigned bot's, so the message is the RESPONDER's to remember. A linha
    // desta mensagem tem chave própria: as faixas de `contactInboxId` e `messageId` se sobrepõem,
    // então substring do payload casa linhas de outras mensagens.
    const armed = await ingestRowFor(messageId);
    expect(agentOf(armed)).toBe(String(responderId));
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
    const { messageId } = await deliver(27, 44, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(customerFacing()).toEqual([]);
    expect(await ingestArmedFor(messageId)).toBe(true);
    expect((await row(44))?.lastHandledMessageId).toBe(messageId);
  });

  // The role is RECORDED, because nothing after the fact can derive it: the observer row follows
  // Chatwoot's agreement, and a binding that moved since is about a different moment.
  test("the delivery row remembers which route it arrived on, observer or responder", async () => {
    requests.length = 0;
    const observerDelivery = await deliver(OBSERVER_BOT, 53, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: observerDelivery.deliveryRowId },
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
          select: { routeObserved: true, routeRemembers: true },
        })
      ).routeObserved,
    ).toBe(false);

    // NOTE: ...AND THE SAME STATEMENT SAYS WHAT THE ROUTE DOES WITH A MESSAGE IT DOES NOT ANSWER. The
    // observer's route folds it in (that is the whole of its work), and so does a responder that is
    // switched on and ingests continuously.
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: observerDelivery.deliveryRowId },
          select: { routeRemembers: true },
        })
      ).routeRemembers,
    ).toBe(true);
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: responderDelivery.deliveryRowId },
          select: { routeRemembers: true },
        })
      ).routeRemembers,
    ).toBe(true);

    // A TEST-MODE responder answers what it is activated for and folds nothing else in, and its own
    // delivery says so — which is the fact the observer beside it reads instead of a mode that may
    // have moved since.
    await suDb.agent.update({
      where: { id: responderId },
      data: { mode: "test" },
    });
    try {
      const inTest = await deliver(RESPONDER_BOT, 77, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(
        (
          await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
            where: { id: inTest.deliveryRowId },
            select: { routeRemembers: true },
          })
        ).routeRemembers,
      ).toBe(false);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { mode: "production" },
      });
    }
  });

  test("control: the responder's own route on the shared inbox still arms a flush", async () => {
    requests.length = 0;
    await deliver(RESPONDER_BOT, 3, SHARED_INBOX, {
      assigneeType: null,
      status: "pending",
    });
    expect((await jobs("DEBOUNCE")).length).toBe(1);
  });
  // The watcher's verdict: a customer message on an observed conversation arms the one OBSERVE row
  // of that conversation, and a resolve delivered on the observer's route pulls it forward, on the
  // shared inbox too, where the responder answers for the compaction.
  async function deliverStatus(
    route: number,
    convId: number,
    inboxId: number,
    status: string,
    // A payload the mirror will REJECT as out of order: `updated_at` is the conversation's version,
    // and one below what the mirror already holds is an event that arrived late.
    staleVersion = false,
    // The base to run on, so a test can make a read fail underneath this path.
    base = appDb,
  ) {
    deliverySeq += 1;
    const raw = conversation(convId, inboxId, { assigneeType: "User", status });
    const n = normalizeChatwootEvent({
      event: "conversation_status_changed",
      ...raw,
      ...(staleVersion ? { updated_at: 1 } : {}),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-${deliverySeq}`,
        event: "conversation_status_changed",
        status: "PENDING",
      },
      select: { id: true },
    });
    await processChatwootDelivery({
      tenantId,
      instanceId,
      deliveryRowId: delivery.id,
      agentBotId: route,
      normalized: n,
      base,
    });
    return delivery.id;
  }

  function observeRows() {
    return suDb.schedulerJob.findMany({
      where: { tenantId, kind: "OBSERVE" },
      select: { dedupeKey: true, payload: true, runAt: true, status: true },
      orderBy: { id: "asc" },
    });
  }

  // NOTE: ARMING IS THE MODE, and nothing else: a watcher is the ordinary agent that cannot answer,
  // so being enabled, in monitoring mode and on the inbox is the whole condition (no label group
  // required).
  test("a customer message on the observer's route arms its OBSERVE row", async () => {
    // Cleared first: every customer message on this route arms one now, so the deliveries the tests
    // above made have rows of their own.
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    await deliver(OBSERVER_BOT, 4, OBSERVED_ONLY_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    const rows = await observeRows();
    expect(rows).toHaveLength(1);
    const armed = rows[0];
    if (!armed) throw new Error("no OBSERVE row");
    expect(armed.dedupeKey).toBe(
      `observe:${chatwootThreadId(tenantId, instanceId, 4)}:${observerId}`,
    );
    expect(armed.status).toBe("PENDING");
    const payload = armed.payload as Record<string, unknown>;
    expect(payload.reason).toBe("burst");
    expect(payload.agentId).toBe(String(observerId));
    expect(payload.conversationId).toBe(4);
    expect(armed.runAt.getTime()).toBeGreaterThan(Date.now() + 15_000);
    expect(customerFacing()).toEqual([]);
  });

  test("a resolve on the observer's route pulls the verdict forward, on the shared inbox as well, and the responder's route arms none", async () => {
    await deliverStatus(OBSERVER_BOT, 4, OBSERVED_ONLY_INBOX, "resolved");
    let rows = await observeRows();
    expect(rows).toHaveLength(1);
    const pulled = rows[0];
    if (!pulled) throw new Error("no OBSERVE row");
    expect((pulled.payload as { reason: string }).reason).toBe("resolved");
    expect(pulled.runAt.getTime()).toBeLessThanOrEqual(Date.now());

    // The shared inbox: the responder (production) answers it, and the resolve reaches the
    // observer on its own route. Conversation 1 was mirrored open by the first test above.
    await deliverStatus(RESPONDER_BOT, 1, SHARED_INBOX, "resolved");
    expect(await observeRows()).toHaveLength(1);
    await deliverStatus(OBSERVER_BOT, 1, SHARED_INBOX, "resolved");
    rows = await observeRows();
    expect(rows).toHaveLength(2);
    const shared = rows.find(
      (r) =>
        r.dedupeKey ===
        `observe:${chatwootThreadId(tenantId, instanceId, 1)}:${observerId}`,
    );
    if (!shared) throw new Error("no OBSERVE row for the shared inbox");
    expect((shared.payload as { agentId: string }).agentId).toBe(
      String(observerId),
    );
    expect((shared.payload as { reason: string }).reason).toBe("resolved");
    expect(customerFacing()).toEqual([]);
  });

  // NOTE: A DELAYED RESOLVE THE MIRROR REJECTED is not a resolve: read off the payload alone it would
  // pull the verdict forward and let an `on_resolve` agent relabel a conversation that is open again,
  // so the effective status is the mirror's. THE COMPACTION FOLLOWS THE MEMORY: on an inbox nobody
  // of ours answers the observer's route remembers nothing, so an attendance ending there has
  // nothing to summarise; beside a responder, the responder's own compaction is armed.
  test("a resolve on an inbox nobody of ours answers arms no compaction, and the responder's inbox still does", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "MEMORY_COMPACT" },
    });
    await deliverStatus(OBSERVER_BOT, 91, OBSERVED_ONLY_INBOX, "open");
    await deliverStatus(OBSERVER_BOT, 91, OBSERVED_ONLY_INBOX, "resolved");
    expect(
      await suDb.schedulerJob.findMany({
        where: { tenantId, kind: "MEMORY_COMPACT" },
      }),
    ).toEqual([]);

    await deliverStatus(RESPONDER_BOT, 92, SHARED_INBOX, "open");
    await deliverStatus(RESPONDER_BOT, 92, SHARED_INBOX, "resolved");
    const armed = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "MEMORY_COMPACT" },
      select: { payload: true },
    });
    expect(
      armed.map((j) => (j.payload as { agentId: string }).agentId),
    ).toEqual([String(responderId)]);
  });

  test("a stale resolve the mirror rejected arms no verdict", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    // The conversation is open and current...
    await deliverStatus(OBSERVER_BOT, 9, OBSERVED_ONLY_INBOX, "open");
    expect(await observeRows()).toHaveLength(0);
    // ...and a resolve from before that lands late.
    await deliverStatus(OBSERVER_BOT, 9, OBSERVED_ONLY_INBOX, "resolved", true);
    expect(await observeRows()).toHaveLength(0);
    // A resolve that IS current still arms, which is the case this must not break.
    await deliverStatus(OBSERVER_BOT, 9, OBSERVED_ONLY_INBOX, "resolved");
    expect(await observeRows()).toHaveLength(1);
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
  });

  // NOTE: The arming block runs on a delivery that is already CLAIMED, and a status-only event
  // carries no `inboundMessageId`, so nothing recovers it: a transient read failure there must not
  // escape past the compaction and the redirect closing that follow.
  test("a read that fails while arming the final verdict does not strand the delivery", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
    const failing = (target: any): any =>
      new Proxy(target, {
        get(t, prop, recv) {
          if (prop === "$extends")
            return (...a: unknown[]) => failing(t.$extends(...a));
          if (prop === "$transaction")
            return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
              t.$transaction((tx: unknown) => fn(failing(tx)), ...rest);
          if (prop !== "inbox") return Reflect.get(t, prop, recv);
          const delegate = Reflect.get(t, prop, recv);
          return new Proxy(delegate, {
            get(d, k, r) {
              const inner = Reflect.get(d, k, r);
              if (k !== "findFirst" && k !== "findUnique") return inner;
              return async () => {
                throw new Error("pool exhausted");
              };
            },
          });
        },
      });
    const rowId = await deliverStatus(
      OBSERVER_BOT,
      10,
      OBSERVED_ONLY_INBOX,
      "resolved",
      false,
      failing(appDb) as typeof appDb,
    );
    // Nothing armed, and the delivery still settled: the block is best-effort as a whole.
    expect(await observeRows()).toHaveLength(0);
    expect(
      (
        await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
          where: { id: rowId },
          select: { status: true },
        })
      ).status,
    ).toBe("PROCESSED");
  });

  // `observing` is a statement about the ROUTE, not about the agent. A disabled observer still owns
  // it, and arming there leaves a verdict pending on a message the agent was explicitly off for.
  test("a switched-off observer arms no burst", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    await suDb.agent.update({
      where: { id: observerId },
      data: { enabled: false },
    });
    try {
      await deliver(OBSERVER_BOT, 11, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(await observeRows()).toHaveLength(0);
    } finally {
      await suDb.agent.update({
        where: { id: observerId },
        data: { enabled: true },
      });
    }
  });

  // NOTE: OBSERVATION IS NOT A REPLY PATH. On the shared inbox the observer's bot can still HOLD a
  // conversation from a life before the rebind: the reply route is then the responder's, and
  // `observerRuntimeForRoute` answers null. Hung off that answer, the watcher would classify none of
  // the conversations its own bot holds, neither the burst nor the final verdict.
  test("a bound observer whose bot holds the conversation still gets its verdict", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    await suDb.agent.update({
      where: { id: observerId },
      data: {
        settings: {
          monitoring: {
            labelGroups: [
              { name: "assunto", values: ["cancelamento", "outros"] },
            ],
          },
        },
      },
    });
    try {
      // The observer's own bot is the assignee, on the inbox the responder answers.
      await deliver(OBSERVER_BOT, 12, SHARED_INBOX, {
        assigneeType: "AgentBot",
        assigneeId: OBSERVER_BOT,
        status: "open",
      });
      const rows = await observeRows();
      expect(rows).toHaveLength(1);
      expect(
        (rows[0]?.payload as { agentId: string } | undefined)?.agentId,
      ).toBe(String(observerId));
      // ...and the resolve reaches it too.
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "OBSERVE" },
      });
      await deliverStatus(OBSERVER_BOT, 12, SHARED_INBOX, "resolved");
      const onResolve = await observeRows();
      expect(onResolve).toHaveLength(1);
      expect(
        (onResolve[0]?.payload as { reason: string } | undefined)?.reason,
      ).toBe("resolved");
      expect(customerFacing()).toEqual([]);
    } finally {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "OBSERVE" },
      });
      await suDb.agent.update({
        where: { id: observerId },
        data: { settings: {} },
      });
    }
  });

  // NOTE: A BOT THAT WAS DETACHED KEEPS RECEIVING THE EVENTS OF A CONVERSATION IT STILL OWNS, so
  // "delivery, no row" is the ordinary post-detach state, not evidence of an attachment being
  // written. Read as the latter, it would arm a verdict for an agent nobody observes with, which
  // retries to DEAD on every message.
  test("a detached observer whose bot still holds the conversation arms nothing", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    await suDb.agent.update({
      where: { id: observerId },
      data: {
        settings: {
          monitoring: {
            labelGroups: [
              { name: "assunto", values: ["cancelamento", "outros"] },
            ],
          },
        },
      },
    });
    const rows = await suDb.inboxObserver.findMany({
      where: { tenantId, agentId: observerId },
      select: { id: true, inboxId: true },
    });
    await suDb.inboxObserver.deleteMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    try {
      await deliver(OBSERVER_BOT, 14, SHARED_INBOX, {
        assigneeType: "AgentBot",
        assigneeId: OBSERVER_BOT,
        status: "open",
      });
      expect(await observeRows()).toHaveLength(0);
      expect(customerFacing()).toEqual([]);
    } finally {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "OBSERVE" },
      });
      for (const r of rows)
        await suDb.inboxObserver.create({
          data: { tenantId, inboxId: r.inboxId, agentId: observerId },
        });
      await suDb.agent.update({
        where: { id: observerId },
        data: { settings: {} },
      });
    }
  });

  // NOTE: A CONTROL COMMAND IS NOT CUSTOMER CONTENT. `/teste` and `/reset` are an operator talking to
  // the runtime; the responder consumes them, and a verdict armed on one classifies the conversation
  // off an instruction (and in `/reset`'s case wakes up after the command cleared the labels and
  // puts them back).
  test("a control command arms no verdict on the observer's route", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    await suDb.agent.update({
      where: { id: observerId },
      data: {
        settings: {
          monitoring: {
            labelGroups: [
              { name: "assunto", values: ["cancelamento", "outros"] },
            ],
          },
        },
      },
    });
    await suDb.agent.update({
      where: { id: responderId },
      data: { mode: "test" },
    });
    try {
      await deliver(
        OBSERVER_BOT,
        13,
        SHARED_INBOX,
        { assigneeType: "User", status: "open" },
        false,
        "/teste",
      );
      expect(await observeRows()).toHaveLength(0);
      // An ordinary message on the same conversation still arms, so the gate is the command and not
      // the route.
      await deliver(OBSERVER_BOT, 13, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(await observeRows()).toHaveLength(1);
    } finally {
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "OBSERVE" },
      });
      await suDb.agent.update({
        where: { id: responderId },
        data: { mode: "production" },
      });
      await suDb.agent.update({
        where: { id: observerId },
        data: { settings: {} },
      });
    }
  });
  // NOTE: THE WORLD A DELIVERY ARRIVED IN, WRITTEN DOWN. Every reader of the route's role re-derives
  // it from the binding as it stands NOW, and an administrative write can land between Chatwoot
  // emitting the event and that reading. The row records the generation counter it was RECEIVED
  // under, written by the INSERT rather than by the claim: the rows that most need it are the ones a
  // process death stranded before any claim.
  test("the ledger records the inbox's generation at receipt, and a redelivery does not move it", async () => {
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: OBSERVED_ONLY_INBOX },
      select: { id: true, bindingGeneration: true },
    });
    const received = inbox.bindingGeneration + 7;
    await suDb.inbox.update({
      where: { id: inbox.id },
      data: { bindingGeneration: received },
    });
    deliverySeq += 1;
    messageSeq += 1;
    const deliveryId = `obr-${process.pid}-gen-${deliverySeq}`;
    const n = normalizeChatwootEvent({
      event: "message_created",
      id: messageSeq,
      private: false,
      content: "quero cancelar meu ingresso",
      message_type: "incoming",
      sender: { id: 99, name: "Cliente", type: null },
      conversation: conversation(68, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      }),
    });
    if (!n) throw new Error("payload did not normalize");
    try {
      await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId,
        deliveryId,
        agentBotId: OBSERVER_BOT,
        normalized: n,
        base: appDb,
      });
      const row = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
        where: { tenantId, deliveryId },
        select: { bindingGeneration: true },
      });
      expect(row.bindingGeneration).toBe(received);

      // ...AND A REDELIVERY DOES NOT RE-DATE IT. Chatwoot resends the same delivery id, and the
      // reading taken then is about a later world; written onto the row it would claim the message
      // arrived under a binding made after it. The row keeps what its own receipt recorded, which is
      // why this column is deliberately not in the ledger's fillable list.
      await suDb.inbox.update({
        where: { id: inbox.id },
        data: { bindingGeneration: received + 3 },
      });
      await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId,
        deliveryId,
        agentBotId: OBSERVER_BOT,
        normalized: n,
        base: appDb,
      });
      const again = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
        where: { tenantId, deliveryId },
        select: { bindingGeneration: true },
      });
      expect(again.bindingGeneration).toBe(received);
    } finally {
      await suDb.inbox.update({
        where: { id: inbox.id },
        data: { bindingGeneration: inbox.bindingGeneration },
      });
    }
  });

  // NOTE: A BINDING MOVED BEFORE THE CLAIM IS A SILENT LOSS, NOT A WRONG ANSWER. An unobserve and a
  // promotion landing before the claim leave a reading that resolves no runtime, and on an inbox with
  // no responder there is nothing else to resolve to. Settled there, the row goes PROCESSED having
  // looked at nothing and the observer's memory (the only one this inbox has) loses a customer
  // message. The generation separates that from the ordinary empty reading (an inbox nothing of ours
  // answers), which goes on settling as it does.
  test("a delivery whose binding moved before its claim, and now resolves nothing, is left for the sweep", async () => {
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: OBSERVED_ONLY_INBOX },
      select: { id: true, bindingGeneration: true },
    });
    const observerRow = await suDb.inboxObserver.findFirstOrThrow({
      where: { tenantId, inboxId: inbox.id, agentId: observerId },
      select: { id: true },
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
      conversation: conversation(69, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      }),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-moved-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
        bindingGeneration: inbox.bindingGeneration,
      },
      select: { id: true },
    });
    try {
      // The unobserve and the promotion, both landed: the row is gone and the persona no longer
      // monitors, so nothing on this inbox answers for this bot any more.
      await suDb.inboxObserver.delete({ where: { id: observerRow.id } });
      await suDb.agent.update({
        where: { id: observerId },
        data: { mode: "production" },
      });
      await suDb.inbox.update({
        where: { id: inbox.id },
        data: { bindingGeneration: inbox.bindingGeneration + 1 },
      });

      await expect(
        processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OBSERVER_BOT,
          normalized: n,
          base: appDb,
          receiptBindingGeneration: inbox.bindingGeneration,
        }),
      ).rejects.toThrow("the binding moved");
      const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
        select: { status: true, claimedAt: true },
      });
      expect(row.status).toBe("PENDING");
      expect(row.claimedAt).toBeNull();
    } finally {
      await suDb.inbox.update({
        where: { id: inbox.id },
        data: { bindingGeneration: inbox.bindingGeneration },
      });
      await suDb.agent.update({
        where: { id: observerId },
        data: { mode: "monitoring" },
      });
      await suDb.inboxObserver.create({
        data: { tenantId, inboxId: inbox.id, agentId: observerId },
      });
    }
  });

  // A READING THAT FAILED IS NOT A READING THAT SAID NOTHING. Null switches the refusal OFF:
  // the CAS goes through and the delivery settles PROCESSED with no runtime having looked at it, the
  // exact loss the refusal prevents, from a transient database failure. Both queries propagate, and
  // the row stays PENDING for the sweep. A pair because they are two queries on the same path: the
  // generation, read inside the resolution (and so retried), and the row's own status, read at the
  // refusal.
  const failingClient = (
    model: string,
    op: string,
    // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
    matches: (args: any) => boolean,
    // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
  ): any => {
    // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
    const wrap = (target: any): any =>
      new Proxy(target, {
        get(t, prop, recv) {
          if (prop === "$extends")
            return (...a: unknown[]) => wrap(t.$extends(...a));
          if (prop === "$transaction")
            return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
              t.$transaction((tx: unknown) => fn(wrap(tx)), ...rest);
          if (prop !== model) return Reflect.get(t, prop, recv);
          const delegate = Reflect.get(t, prop, recv);
          return new Proxy(delegate, {
            get(d, k, r) {
              const inner = Reflect.get(d, k, r);
              if (k !== op) return inner;
              // biome-ignore lint/suspicious/noExplicitAny: proxying Prisma's client surface
              return async (args: any) => {
                if (matches(args)) throw new Error("pool exhausted");
                return (inner as (a: unknown) => Promise<unknown>).call(
                  d,
                  args,
                );
              };
            },
          });
        },
      });
    return wrap(appDb);
  };

  // The world the two cases below both need: a delivery on a bot route whose binding has since moved
  // and which now resolves no runtime at all — every condition of the refusal true except the one
  // query under test.
  const movedWorld = async (convId: number, prefix: string) => {
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: OBSERVED_ONLY_INBOX },
      select: { id: true, bindingGeneration: true },
    });
    const observerRow = await suDb.inboxObserver.findFirstOrThrow({
      where: { tenantId, inboxId: inbox.id, agentId: observerId },
      select: { id: true },
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
      conversation: conversation(convId, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      }),
    });
    if (!n) throw new Error("payload did not normalize");
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-${prefix}-${deliverySeq}`,
        event: "message_created",
        status: "PENDING",
        bindingGeneration: inbox.bindingGeneration,
      },
      select: { id: true },
    });
    await suDb.inboxObserver.delete({ where: { id: observerRow.id } });
    await suDb.agent.update({
      where: { id: observerId },
      data: { mode: "production" },
    });
    await suDb.inbox.update({
      where: { id: inbox.id },
      data: { bindingGeneration: inbox.bindingGeneration + 1 },
    });
    const restore = async () => {
      await suDb.inbox.update({
        where: { id: inbox.id },
        data: { bindingGeneration: inbox.bindingGeneration },
      });
      await suDb.agent.update({
        where: { id: observerId },
        data: { mode: "monitoring" },
      });
      await suDb.inboxObserver.create({
        data: { tenantId, inboxId: inbox.id, agentId: observerId },
      });
    };
    return { n, delivery, receipt: inbox.bindingGeneration, restore };
  };

  test("a generation read that fails does not settle the delivery", async () => {
    const { n, delivery, receipt, restore } = await movedWorld(84, "genfail");
    try {
      await expect(
        processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OBSERVER_BOT,
          normalized: n,
          base: failingClient(
            "inbox",
            "findFirst",
            // NOTE: The FALLBACK query alone, the one that must not swallow a failure. The runtime
            // resolvers read the same column on the same model and must go on answering, or this test
            // would prove the retry loop and not the swallow: they select more than this one field.
            (args) =>
              args?.select?.bindingGeneration === true &&
              Object.keys(args?.select ?? {}).length === 1,
          ),
          receiptBindingGeneration: receipt,
          deps: { sleep: async () => {} },
        }),
      ).rejects.toThrow("pool exhausted");
      const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
        select: { status: true, claimedAt: true },
      });
      expect(row.status).toBe("PENDING");
      expect(row.claimedAt).toBeNull();
    } finally {
      await restore();
    }
  });

  test("a status read that fails does not settle the delivery either", async () => {
    const { n, delivery, receipt, restore } = await movedWorld(85, "statfail");
    try {
      await expect(
        processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OBSERVER_BOT,
          normalized: n,
          base: failingClient(
            "chatwootWebhookDelivery",
            "findUnique",
            (args) =>
              args?.select?.status === true &&
              Object.keys(args?.select ?? {}).length === 1,
          ),
          receiptBindingGeneration: receipt,
          deps: { sleep: async () => {} },
        }),
      ).rejects.toThrow("pool exhausted");
      const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
        where: { id: delivery.id },
        select: { status: true, claimedAt: true },
      });
      expect(row.status).toBe("PENDING");
      expect(row.claimedAt).toBeNull();
    } finally {
      await restore();
    }
  });

  // NOTE: ...AND IT IS NOT RAISED ON A ROW THERE IS NOTHING TO LEAVE. `claimFrom` is what this call
  // EXPECTS the status to be: Chatwoot reposting an event whose row already settled arrives claiming
  // PENDING all the same, and the CAS turns that into the `skipped` an idempotent duplicate
  // deserves. Raised ahead of the CAS, an ordinary duplicate would become an async dispatch failure
  // promising a sweep pickup, and a settled row is on no sweep worklist.
  test("a repost of a delivery that already settled is skipped, not refused", async () => {
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: OBSERVED_ONLY_INBOX },
      select: { id: true, bindingGeneration: true },
    });
    const observerRow = await suDb.inboxObserver.findFirstOrThrow({
      where: { tenantId, inboxId: inbox.id, agentId: observerId },
      select: { id: true },
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
      conversation: conversation(83, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      }),
    });
    if (!n) throw new Error("payload did not normalize");
    // The row this delivery already produced, settled half an hour ago.
    const delivery = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-repost-${deliverySeq}`,
        event: "message_created",
        status: "PROCESSED",
        claimedAt: new Date(),
        bindingGeneration: inbox.bindingGeneration,
      },
      select: { id: true },
    });
    try {
      // ...and the same movement the case above sets up, so every other condition of the refusal is
      // true and the row's own status is the only thing standing between it and a throw.
      await suDb.inboxObserver.delete({ where: { id: observerRow.id } });
      await suDb.agent.update({
        where: { id: observerId },
        data: { mode: "production" },
      });
      await suDb.inbox.update({
        where: { id: inbox.id },
        data: { bindingGeneration: inbox.bindingGeneration + 1 },
      });

      expect(
        await processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OBSERVER_BOT,
          normalized: n,
          base: appDb,
          receiptBindingGeneration: inbox.bindingGeneration,
        }),
      ).toBe("skipped");
      // ...and the settled row is exactly where it was.
      expect(
        (
          await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
            where: { id: delivery.id },
            select: { status: true },
          })
        ).status,
      ).toBe("PROCESSED");
    } finally {
      await suDb.inbox.update({
        where: { id: inbox.id },
        data: { bindingGeneration: inbox.bindingGeneration },
      });
      await suDb.agent.update({
        where: { id: observerId },
        data: { mode: "monitoring" },
      });
      await suDb.inboxObserver.create({
        data: { tenantId, inboxId: inbox.id, agentId: observerId },
      });
    }
  });

  // ...AND THE SAME EMPTY READING, WITH THE GENERATION SAYING NOTHING MOVED, SETTLES AS IT ALWAYS
  // HAS. A bot that still owns an older conversation goes on receiving its events after being
  // detached, and an inbox nobody of ours answers resolves nothing for perfectly ordinary reasons.
  // Refusing on the empty reading alone would turn every one of those into a row an operator has to
  // read.
  test("a delivery that resolves nothing under an unmoved binding is settled, not refused", async () => {
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: OBSERVED_ONLY_INBOX },
      select: { id: true },
    });
    const observerRow = await suDb.inboxObserver.findFirstOrThrow({
      where: { tenantId, inboxId: inbox.id, agentId: observerId },
      select: { id: true },
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
      conversation: conversation(72, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      }),
    });
    if (!n) throw new Error("payload did not normalize");
    try {
      // The world this delivery arrives in is the one AFTER the detach: the point of this case is an
      // empty reading whose binding has not moved SINCE the message, which is the ordinary shape of
      // an inbox nothing of ours answers. The generation is therefore read once the row and the mode
      // are where they will be — and read at all rather than assumed, since the detach itself steps
      // the counter through the trigger.
      await suDb.inboxObserver.delete({ where: { id: observerRow.id } });
      await suDb.agent.update({
        where: { id: observerId },
        data: { mode: "production" },
      });
      const settled = await suDb.inbox.findUniqueOrThrow({
        where: { id: inbox.id },
        select: { bindingGeneration: true },
      });
      const delivery = await suDb.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: `obr-${process.pid}-steady-${deliverySeq}`,
          event: "message_created",
          status: "PENDING",
          bindingGeneration: settled.bindingGeneration,
        },
        select: { id: true },
      });
      expect(
        await processChatwootDelivery({
          tenantId,
          instanceId,
          deliveryRowId: delivery.id,
          agentBotId: OBSERVER_BOT,
          normalized: n,
          base: appDb,
          receiptBindingGeneration: settled.bindingGeneration,
        }),
      ).toBe("processed");
    } finally {
      await suDb.agent.update({
        where: { id: observerId },
        data: { mode: "monitoring" },
      });
      await suDb.inboxObserver.create({
        data: { tenantId, inboxId: inbox.id, agentId: observerId },
      });
    }
  });
  // NOTE: The stand-down beside a responder is NOT decided by reading that responder's mode and
  // switch when the observer asks. The two deliveries are concurrent by construction (one message,
  // two routes), so a switch flipped between them would keep this route quiet about a message the
  // responder never folded in. The sibling row states what its own claim resolved, and that is read.
  test("beside a responder whose own delivery recorded that it remembers nothing, the message is remembered here", async () => {
    requests.length = 0;
    const sharedMessage = messageSeq + 1;
    // The responder's own delivery, claimed while its agent was in test mode or switched off. Its
    // agent reads as production and enabled NOW, which is the whole point: the mode moved between
    // the two deliveries and only the row remembers what was true for that one.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-remembers-none`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: 74,
        inboundMessageId: sharedMessage,
        routeAgentBotId: RESPONDER_BOT,
        claimedAt: new Date(),
        routeObserved: false,
        routeRemembers: false,
      },
    });
    const { messageId } = await deliver(OBSERVER_BOT, 74, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(messageId).toBe(sharedMessage);
    expect(customerFacing()).toEqual([]);
    expect(await ingestArmedFor(messageId)).toBe(true);
  });

  // ...AND THE SAME READING IN THE OTHER DIRECTION. The responder's delivery folded the message in;
  // its agent has since been moved to test mode, which the mode reading would take as "nobody
  // remembered it" — and this route would append a second copy of a message the shared thread
  // already holds.
  test("beside a responder whose own delivery recorded that it remembers, this route stands down even though the mode has since changed", async () => {
    requests.length = 0;
    const sharedMessage = messageSeq + 1;
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-remembers-yes`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: 75,
        inboundMessageId: sharedMessage,
        routeAgentBotId: RESPONDER_BOT,
        claimedAt: new Date(),
        routeObserved: false,
        routeRemembers: true,
      },
    });
    await suDb.agent.update({
      where: { id: responderId },
      data: { mode: "test" },
    });
    try {
      const { messageId } = await deliver(OBSERVER_BOT, 75, SHARED_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      expect(messageId).toBe(sharedMessage);
      expect(customerFacing()).toEqual([]);
      expect(await ingestArmedFor(messageId)).toBe(false);
    } finally {
      await suDb.agent.update({
        where: { id: responderId },
        data: { mode: "production" },
      });
    }
  });

  // NOTE: ...AND THE SIBLING IS THE RESPONDER'S DELIVERY OF THE SAME EVENT. One customer message
  // reaches the ledger twice (the creation, and the `message_updated` that carries a voice note's
  // transcription), both naming it through `inboundMessageId`. Matched without the event, this
  // delivery would read the OTHER one's decision, the wrong one wherever the mode moved between them.
  test("a sibling delivery of a different event does not answer for this one", async () => {
    requests.length = 0;
    const sharedMessage = messageSeq + 1;
    // The responder's TRANSCRIPTION delivery of the same message, claimed while its agent remembered
    // nothing. The creation this test delivers has no sibling of its own, so the mode reading — the
    // responder is production and enabled — is what must answer, and it says the responder has it.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-remembers-other-event`,
        event: "message_updated",
        status: "PROCESSING",
        conversationId: 81,
        inboundMessageId: sharedMessage,
        routeAgentBotId: RESPONDER_BOT,
        claimedAt: new Date(),
        routeObserved: false,
        routeRemembers: false,
      },
    });
    const { messageId } = await deliver(OBSERVER_BOT, 81, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(messageId).toBe(sharedMessage);
    expect(await ingestArmedFor(messageId)).toBe(false);
  });

  // ...and a sibling that has not claimed yet says nothing, so the mode reading stands — which is
  // what every delivery did before the column existed. This is the part of the window the change
  // narrows rather than closes, and it is asserted so a later reading cannot quietly widen it.
  test("beside a responder whose delivery has not claimed yet, the mode is what answers", async () => {
    requests.length = 0;
    const sharedMessage = messageSeq + 1;
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-remembers-unstated`,
        event: "message_created",
        status: "PENDING",
        conversationId: 76,
        inboundMessageId: sharedMessage,
        routeAgentBotId: RESPONDER_BOT,
      },
    });
    const { messageId } = await deliver(OBSERVER_BOT, 76, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(messageId).toBe(sharedMessage);
    expect(await ingestArmedFor(messageId)).toBe(false);
  });
  // NOTE: ...AND WHEN THE RESPONDER HAS SEVERAL DELIVERIES OF THE SAME EVENT, THE NEWEST ANSWERS,
  // even unclaimed. `message_updated` can fire more than once and a redelivery repeats an event, so
  // nothing on those rows identifies their fan-out; skipping rows that stated nothing would walk
  // back to an OLDER delivery's answer. Null from the latest means the responder has not decided,
  // which falls back to its CURRENT mode, what its own claim is about to read anyway. Here the older
  // delivery remembered nothing while the responder is production and enabled now.
  test("the newest sibling answers, even unclaimed, and an older one does not answer for it", async () => {
    requests.length = 0;
    const sharedMessage = messageSeq + 1;
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-newest-sibling-old`,
        event: "message_created",
        status: "PROCESSING",
        conversationId: 82,
        inboundMessageId: sharedMessage,
        routeAgentBotId: RESPONDER_BOT,
        claimedAt: new Date(),
        routeObserved: false,
        routeRemembers: false,
      },
    });
    // The fan-out this delivery belongs to, still unclaimed: the responder's row is in the ledger
    // and its decision is not.
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: `obr-${process.pid}-newest-sibling-new`,
        event: "message_created",
        status: "PENDING",
        conversationId: 82,
        inboundMessageId: sharedMessage,
        routeAgentBotId: RESPONDER_BOT,
      },
    });
    const { messageId } = await deliver(OBSERVER_BOT, 82, SHARED_INBOX, {
      assigneeType: "User",
      status: "open",
    });
    expect(messageId).toBe(sharedMessage);
    expect(customerFacing()).toEqual([]);
    expect(await ingestArmedFor(messageId)).toBe(false);
  });
  // NOTE: THE ATTACH WINDOW HAS A FACT OF ITS OWN. The row is written first, unstamped, before
  // Chatwoot agrees, and the receiver reports that as the window: the verdict armed off it says
  // `attaching`, so the tick retries instead of completing on a binding that has not landed, which
  // for a resolve is permanent.
  test("a delivery inside the attach window is reported as attaching", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: OBSERVED_ONLY_INBOX },
      select: { id: true },
    });
    // The row as `observeInbox` writes it before asking the fork.
    await suDb.inboxObserver.updateMany({
      where: { tenantId, inboxId: inbox.id, agentId: observerId },
      data: { attachedAt: null },
    });
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: observerId },
      select: { settings: true },
    });
    await suDb.agent.update({
      where: { id: observerId },
      data: {
        settings: {
          monitoring: {
            labelGroups: [
              { name: "assunto", values: ["cancelamento", "outros"] },
            ],
          },
        },
      },
    });
    try {
      await deliver(OBSERVER_BOT, 79, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      const rows = await observeRows();
      expect(rows).toHaveLength(1);
      const armed = rows[0];
      if (!armed) throw new Error("no OBSERVE row");
      expect((armed.payload as { attaching?: boolean }).attaching).toBe(true);
    } finally {
      await suDb.inboxObserver.updateMany({
        where: { tenantId, inboxId: inbox.id, agentId: observerId },
        data: { attachedAt: new Date() },
      });
      await suDb.agent.update({
        where: { id: observerId },
        data: { settings: before.settings ?? {} },
      });
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "OBSERVE" },
      });
    }
  });

  // ...and a stamped row is not a window: the same delivery arms an ordinary verdict.
  test("a delivery on a settled observer binding is not reported as attaching", async () => {
    await suDb.schedulerJob.deleteMany({
      where: { tenantId, kind: "OBSERVE" },
    });
    const before = await suDb.agent.findUniqueOrThrow({
      where: { id: observerId },
      select: { settings: true },
    });
    await suDb.agent.update({
      where: { id: observerId },
      data: {
        settings: {
          monitoring: {
            labelGroups: [
              { name: "assunto", values: ["cancelamento", "outros"] },
            ],
          },
        },
      },
    });
    try {
      await deliver(OBSERVER_BOT, 80, OBSERVED_ONLY_INBOX, {
        assigneeType: "User",
        status: "open",
      });
      const rows = await observeRows();
      expect(rows).toHaveLength(1);
      const armed = rows[0];
      if (!armed) throw new Error("no OBSERVE row");
      expect(
        (armed.payload as { attaching?: boolean }).attaching,
      ).toBeUndefined();
    } finally {
      await suDb.agent.update({
        where: { id: observerId },
        data: { settings: before.settings ?? {} },
      });
      await suDb.schedulerJob.deleteMany({
        where: { tenantId, kind: "OBSERVE" },
      });
    }
  });
});
