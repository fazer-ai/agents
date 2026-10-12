import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  ChatwootClient,
  type ChatwootInboxConversation,
} from "@/modules/chatwoot/client";
import {
  maxIncomingId,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  owedCustomerMessage,
  reconciledDeliveryId,
  reconcileFromChatwoot,
  reconcileSweepHandler,
} from "@/modules/chatwoot/reconcile-sweep";
import { deliveryRecoveryDedupeKey } from "@/modules/chatwoot/recover-delivery";
import { alertSummary } from "@/modules/flowlog/alerts";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// The reconciliation from Chatwoot: a customer message the delivery ledger never
// received is found by reading Chatwoot and handed to the recovery that already exists, as a DEAD row
// received at the message's own creation. Driven against a scripted Chatwoot: the listing and the
// message pages are what the sweep reads, and the ledger and the scheduler are what it writes.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const INBOX = 81;
const UNBOUND = 82;
const BOT = 21;
const NOW = new Date("2026-10-11T18:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

let tenantId = 0n;
let instanceId = 0n;

interface Scripted {
  conversations: Map<number, ChatwootInboxConversation[]>;
  // Every page of an inbox's listing, for a read longer than one page.
  pages?: Map<number, ChatwootInboxConversation[][]>;
  pinned?: number[];
  // Every answer of the pin listing in call order, for pins that change under the read.
  pinnedCalls?: number[][];
  // Every answer of the listing in call order, for a listing that changes under the read.
  calls?: ChatwootInboxConversation[][];
  messages: Map<number, unknown[]>;
  failInbox?: number;
  listed: number[];
}

function chatwoot(s: Scripted) {
  return async () =>
    ({
      async listInboxConversations(
        inboxId: number,
        status: string,
        page: number,
      ) {
        s.listed.push(inboxId);
        if (inboxId === s.failInbox) throw new Error("HTTP 502");
        expect(status).toBe("pending");
        if (s.calls) return s.calls.shift() ?? [];
        const pages = s.pages?.get(inboxId);
        if (pages) return pages[page - 1] ?? [];
        return page === 1 ? (s.conversations.get(inboxId) ?? []) : [];
      },
      async listPinnedConversationIds() {
        return new Set(
          s.pinnedCalls ? (s.pinnedCalls.shift() ?? []) : (s.pinned ?? []),
        );
      },
      // Twenty messages a page, newest last, and `before` reads the page ending below that id, as
      // Chatwoot pages a conversation.
      async getMessages(
        conversationId: number,
        opts?: { before?: number; after?: number },
      ) {
        const all = s.messages.get(conversationId) ?? [];
        if (!Array.isArray(all)) return all;
        // The catch-up read: every message with a higher id, a hundred at most, reactions included.
        if (opts?.after !== undefined) {
          const after = opts.after;
          return (all as { id: number }[])
            .filter((m) => m.id > after)
            .sort((a, b) => a.id - b.id)
            .slice(0, 100);
        }
        // Ordered and cut by `(created_at, id)`, as the fork's finder does. A reaction whose target is
        // off the page is left out of it, which `offPage` stands in for.
        type Row = { id: number; created_at?: number; offPage?: boolean };
        const key = (m: Row) => [m.created_at ?? 0, m.id] as const;
        const before = (a: Row, b: Row) =>
          key(a)[0] < key(b)[0] || (key(a)[0] === key(b)[0] && a.id < b.id);
        const sorted = [...(all as Row[])].sort((a, b) =>
          before(a, b) ? -1 : before(b, a) ? 1 : 0,
        );
        const cursor = sorted.find((m) => m.id === opts?.before);
        const older =
          opts?.before === undefined
            ? sorted
            : sorted.filter((m) =>
                cursor ? before(m, cursor) : m.id < (opts.before as number),
              );
        return older.filter((m) => !m.offPage).slice(-20);
      },
    }) as unknown as ChatwootClient;
}

const incoming = (id: number, at: Date) => ({
  id,
  message_type: 0,
  private: false,
  created_at: epoch(at),
  content: "oi",
});
const outgoing = (id: number, at: Date) => ({
  id,
  message_type: 1,
  private: false,
  created_at: epoch(at),
  content: "olá",
  sender: { id: 7, type: "user" },
});
// A reply from our own bot, which answers only what its turn took.
const ourReply = (id: number, at: Date) => ({
  ...outgoing(id, at),
  sender: { id: BOT, type: "agent_bot" },
});

const conv = (
  id: number,
  at: Date,
  assigneeType: string | null = "AgentBot",
): ChatwootInboxConversation => ({
  id,
  status: "pending",
  assigneeType,
  lastActivityAt: at,
});

async function ledgerFor(conversationId: number) {
  return suDb.chatwootWebhookDelivery.findMany({
    where: { chatwootInstanceId: instanceId, conversationId },
    select: {
      id: true,
      deliveryId: true,
      status: true,
      receivedAt: true,
      inboundMessageId: true,
      routeAgentBotId: true,
      routeObserved: true,
    },
  });
}

async function recoveryArmedFor(rowId: bigint) {
  return suDb.schedulerJob.findFirst({
    where: {
      tenantId,
      kind: "DELIVERY_RECOVERY",
      dedupeKey: deliveryRecoveryDedupeKey(rowId),
    },
    select: { id: true },
  });
}

describe("which message a conversation owes", () => {
  test("the customer spoke last: that message", () => {
    const rows = parseChatwootMessages([
      outgoing(1, minutesAgo(30)),
      incoming(2, minutesAgo(20)),
    ]);
    expect(owedCustomerMessage(rows)?.id).toBe(2);
  });
  test("we spoke last: nothing is owed", () => {
    const rows = parseChatwootMessages([
      incoming(1, minutesAgo(30)),
      outgoing(2, minutesAgo(20)),
    ]);
    expect(owedCustomerMessage(rows)).toBeNull();
  });
  test("a private note or an activity line after the customer does not answer them", () => {
    const rows = parseChatwootMessages([
      incoming(1, minutesAgo(30)),
      { ...outgoing(2, minutesAgo(25)), private: true },
      { id: 3, message_type: 2, created_at: epoch(minutesAgo(20)) },
    ]);
    expect(owedCustomerMessage(rows)?.id).toBe(1);
  });
  test("a blank incoming message after the customer's request does not take its place", () => {
    const rows = parseChatwootMessages([
      outgoing(1, minutesAgo(40)),
      incoming(2, minutesAgo(30)),
      { ...incoming(3, minutesAgo(20)), content: "  " },
    ]);
    expect(owedCustomerMessage(rows)?.id).toBe(2);
  });
  test("an incoming reaction after the request is the newest customer message, as the recovery reads it", () => {
    const rows = parseChatwootMessages([
      incoming(1, minutesAgo(30)),
      {
        ...incoming(2, minutesAgo(20)),
        content: "👍",
        content_attributes: { is_reaction: true },
      },
    ]);
    expect(maxIncomingId(rows, 0)).toBe(2);
    expect(owedCustomerMessage(rows)?.id).toBe(2);
  });
  test("an imported incoming message is no lost delivery: nothing is owed", () => {
    const rows = parseChatwootMessages([
      incoming(1, minutesAgo(30)),
      {
        ...incoming(2, minutesAgo(20)),
        content_attributes: { imported: true },
      },
    ]);
    expect(owedCustomerMessage(rows)).toBeNull();
  });
  test("a sender-less outgoing message after the customer (an automation, an away message) does not answer them", () => {
    const { sender: _, ...automation } = outgoing(2, minutesAgo(20));
    const rows = parseChatwootMessages([
      incoming(1, minutesAgo(30)),
      automation,
    ]);
    expect(owedCustomerMessage(rows)?.id).toBe(1);
  });
});

describe("the conversation listing", () => {
  const listing = async (body: unknown) => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const c = new ChatwootClient(
      {
        baseUrl: "https://chat.example.com",
        accountId: 5,
        adminToken: "admin",
        botToken: "bot",
      },
      fetchImpl,
    );
    return c.listInboxConversations(81, "pending", 1);
  };
  test("an empty payload is the end of the listing", async () => {
    expect(await listing({ data: { payload: [] } })).toEqual([]);
  });
  test("a listing with no payload array, or with a row it cannot read, is an error and not the end", async () => {
    await expect(listing({ data: {} })).rejects.toThrow("no payload array");
    await expect(
      listing({ data: { payload: [{ status: "pending" }] } }),
    ).rejects.toThrow("unreadable row");
  });
});

describe.skipIf(!dbUp)("reconciling from Chatwoot", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RCN", slug: `rcn-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 81,
      baseUrl: "https://chat.reconcile.example",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: BOT,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `rcn-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: UNBOUND,
        name: "Sem agente",
      },
    });
  });

  beforeEach(async () => {
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    await suDb.chatwootWebhookDelivery.deleteMany({ where: { tenantId } });
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { reconciledUntil: minutesAgo(40) },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.schedulerJob.deleteMany({ where: { tenantId } });
      await clearFlowLog(suDb, { tenantId });
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a customer message the ledger never received is handed to the recovery, dated by the message", async () => {
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(501, minutesAgo(25))]]]),
      messages: new Map([
        [501, [outgoing(9000, minutesAgo(60)), incoming(9001, minutesAgo(25))]],
      ]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(1);
    const [row] = await ledgerFor(501);
    expect(row).toMatchObject({
      deliveryId: reconciledDeliveryId(501, 9001),
      status: "DEAD",
      inboundMessageId: 9001,
      routeAgentBotId: BOT,
      routeObserved: false,
    });
    // The recovery's age ceilings measure the customer's wait, not the sweep's.
    expect(row?.receivedAt.getTime()).toBe(epoch(minutesAgo(25)) * 1000);
    expect(await recoveryArmedFor(row?.id as bigint)).not.toBeNull();
    // Only the bound inbox is read.
    expect([...new Set(s.listed)]).toEqual([INBOX]);
  });

  test("a message the ledger already holds is left to whatever holds it", async () => {
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "uuid-from-chatwoot",
        event: "message_created",
        status: "PROCESSED",
        conversationId: 502,
        inboundMessageId: 9002,
      },
    });
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(502, minutesAgo(25))]]]),
      messages: new Map([[502, [incoming(9002, minutesAgo(25))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(0);
    expect(await ledgerFor(502)).toHaveLength(1);
  });

  test("a conversation a person holds, one where we spoke last, and one gone quiet before the window are not touched", async () => {
    const s: Scripted = {
      conversations: new Map([
        [
          INBOX,
          [
            conv(503, minutesAgo(25), "User"),
            conv(504, minutesAgo(25)),
            conv(505, minutesAgo(90)),
          ],
        ],
      ]),
      messages: new Map([
        [503, [incoming(9003, minutesAgo(25))]],
        [504, [incoming(9004, minutesAgo(30)), outgoing(9005, minutesAgo(25))]],
        [505, [incoming(9006, minutesAgo(90))]],
      ]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(0);
    for (const id of [503, 504, 505]) expect(await ledgerFor(id)).toEqual([]);
  });

  test("a conversation that moved recently over a customer message older than the window is not handed over", async () => {
    // A label written now moves the conversation; the message it owes is from before the cursor, and
    // a pass that read it then would have found it. The first pass reads back one recovery ceiling and
    // no further, for the same reason: it is not where a backlog is handed to the team.
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(510, minutesAgo(15))]]]),
      messages: new Map([[510, [incoming(9011, minutesAgo(180))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.conversationsRead).toBe(1);
    expect(counts.handedToRecovery).toBe(0);
    expect(await ledgerFor(510)).toEqual([]);
  });

  test("a message younger than Chatwoot's retry ladder is left for the next pass, which still reads it", async () => {
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(506, minutesAgo(3))]]]),
      messages: new Map([[506, [incoming(9007, minutesAgo(3))]]]),
      listed: [],
    };
    const first = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(first.handedToRecovery).toBe(0);
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const second = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: later,
      makeClient: chatwoot(s),
    });
    expect(second.handedToRecovery).toBe(1);
  });

  test("a second pass over the same message arms nothing more", async () => {
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(507, minutesAgo(25))]]]),
      messages: new Map([[507, [incoming(9008, minutesAgo(25))]]]),
      listed: [],
    };
    await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { reconciledUntil: minutesAgo(40) },
    });
    const again = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(again.handedToRecovery).toBe(0);
    expect(await ledgerFor(507)).toHaveLength(1);
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "DELIVERY_RECOVERY" },
      }),
    ).toBe(1);
  });

  test("an observer's delivery of the message does not cover the responder's that never arrived", async () => {
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "observer-delivery",
        event: "message_created",
        status: "PROCESSED",
        conversationId: 510,
        inboundMessageId: 9020,
        routeAgentBotId: BOT + 1,
        routeObserved: true,
      },
    });
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(510, minutesAgo(25))]]]),
      messages: new Map([[510, [incoming(9020, minutesAgo(25))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(1);
    const rows = await ledgerFor(510);
    expect(
      rows.find((r) => r.deliveryId === reconciledDeliveryId(510, 9020))
        ?.routeAgentBotId,
    ).toBe(BOT);
  });

  test("a transcription's update naming the message does not cover the creation that never arrived", async () => {
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "transcription-update",
        event: "message_updated",
        status: "PROCESSED",
        conversationId: 515,
        inboundMessageId: 9025,
        routeAgentBotId: BOT,
      },
    });
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(515, minutesAgo(25))]]]),
      messages: new Map([[515, [incoming(9025, minutesAgo(25))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(1);
  });

  test("a lost message behind a page of notes is found on an older page, and one too far back fails the inbox", async () => {
    const notes = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        ...outgoing(from + i, minutesAgo(20)),
        private: true,
      }));
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(570, minutesAgo(20))]]]),
      messages: new Map([
        [570, [incoming(9070, minutesAgo(25)), ...notes(9071, 25)]],
      ]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(1);
    expect((await ledgerFor(570)).map((r) => r.inboundMessageId)).toEqual([
      9070,
    ]);

    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { reconciledUntil: minutesAgo(40) },
    });
    const buried: Scripted = {
      conversations: new Map([[INBOX, [conv(571, minutesAgo(20))]]]),
      messages: new Map([
        [571, [incoming(9100, minutesAgo(25)), ...notes(9101, 205)]],
      ]),
      listed: [],
    };
    const failed = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(buried),
    });
    expect(failed.inboxesFailed).toBe(1);
  });

  test("older pages are walked by time, so imported history numbered newest-first does not stall the read", async () => {
    // The request, then sixty imported messages after it in time whose ids run against their times.
    const imported = Array.from({ length: 60 }, (_, i) => ({
      id: 14_001 + i,
      message_type: 1,
      private: false,
      created_at: epoch(minutesAgo(21 + i * 0.1)),
      content: "histórico",
      content_attributes: { imported: true },
      sender: { id: 7, type: "user" },
    }));
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(1400, minutesAgo(20))]]]),
      messages: new Map([
        [1400, [incoming(14000, minutesAgo(28)), ...imported]],
      ]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(0);
    expect((await ledgerFor(1400)).map((r) => r.inboundMessageId)).toEqual([
      14000,
    ]);
  });

  test("a lost reaction to a message off the newest page is found through the catch-up read", async () => {
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "answered-turn",
        event: "message_created",
        status: "PROCESSED",
        conversationId: 1500,
        inboundMessageId: 15000,
        routeAgentBotId: BOT,
        routeObserved: false,
      },
    });
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(1500, minutesAgo(20))]]]),
      messages: new Map([
        [
          1500,
          [
            incoming(15000, minutesAgo(30)),
            ourReply(15001, minutesAgo(29)),
            {
              ...incoming(15002, minutesAgo(20)),
              content: "👍",
              content_attributes: { is_reaction: true },
              offPage: true,
            },
          ],
        ],
      ]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(1);
    expect(
      (await ledgerFor(1500)).map((r) => r.inboundMessageId).sort(),
    ).toEqual([15000, 15002]);
  });

  test("a lost reaction followed by a note on the page is still found", async () => {
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "answered-turn-1700",
        event: "message_created",
        status: "PROCESSED",
        conversationId: 1700,
        inboundMessageId: 17000,
        routeAgentBotId: BOT,
        routeObserved: false,
      },
    });
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(1700, minutesAgo(20))]]]),
      messages: new Map([
        [
          1700,
          [
            incoming(17000, minutesAgo(30)),
            {
              ...incoming(17001, minutesAgo(21)),
              content: "👍",
              content_attributes: { is_reaction: true },
              offPage: true,
            },
            { ...outgoing(17002, minutesAgo(20)), private: true },
          ],
        ],
      ]),
      listed: [],
    };
    await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(
      (await ledgerFor(1700)).map((r) => r.inboundMessageId).sort(),
    ).toEqual([17000, 17001]);
  });

  test("a lost reaction to a message pages back, behind a page of notes, is still found", async () => {
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "answered-turn-1800",
        event: "message_created",
        status: "PROCESSED",
        conversationId: 1800,
        inboundMessageId: 18000,
        routeAgentBotId: BOT,
        routeObserved: false,
      },
    });
    const notes = Array.from({ length: 45 }, (_, i) => ({
      ...outgoing(18_002 + i, minutesAgo(24 - i * 0.05)),
      private: true,
    }));
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(1800, minutesAgo(20))]]]),
      messages: new Map([
        [
          1800,
          [
            incoming(18000, minutesAgo(30)),
            {
              ...incoming(18001, minutesAgo(25)),
              content: "👍",
              content_attributes: { is_reaction: true },
              offPage: true,
            },
            ...notes,
          ],
        ],
      ]),
      listed: [],
    };
    await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(
      (await ledgerFor(1800)).map((r) => r.inboundMessageId).sort(),
    ).toEqual([18000, 18001]);
  });

  test("a backdated import the catch-up read brings in does not move the history cursor", async () => {
    const notes = Array.from({ length: 20 }, (_, i) => ({
      ...outgoing(19_001 + i, minutesAgo(29 - i * 0.1)),
      private: true,
    }));
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(1900, minutesAgo(20))]]]),
      messages: new Map([
        [
          1900,
          [
            incoming(19_000, minutesAgo(30)),
            ...notes,
            // Imported with a higher id but dated before the request.
            {
              ...outgoing(19_500, minutesAgo(40)),
              private: true,
              content_attributes: { imported: true },
            },
          ],
        ],
      ]),
      listed: [],
    };
    await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect((await ledgerFor(1900)).map((r) => r.inboundMessageId)).toEqual([
      19_000,
    ]);
  });

  test("a backdated incoming import the catch-up read brings in is not taken as the owed message", async () => {
    const notes = Array.from({ length: 20 }, (_, i) => ({
      ...outgoing(19_601 + i, minutesAgo(29 - i * 0.1)),
      private: true,
    }));
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(1960, minutesAgo(20))]]]),
      messages: new Map([
        [
          1960,
          [
            incoming(19_600, minutesAgo(30)),
            ...notes,
            // An incoming history import from yesterday, numbered above everything else.
            { ...incoming(19_900, minutesAgo(24 * 60)) },
          ],
        ],
      ]),
      listed: [],
    };
    await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect((await ledgerFor(1960)).map((r) => r.inboundMessageId)).toEqual([
      19_600,
    ]);
  });

  test("the catch-up read is followed past a full page to the newest message", async () => {
    const reactions = Array.from({ length: 105 }, (_, i) => ({
      ...incoming(16_001 + i, minutesAgo(25 - i * 0.04)),
      content: "👍",
      content_attributes: { is_reaction: true },
      offPage: true,
    }));
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(1600, minutesAgo(20))]]]),
      messages: new Map([
        [1600, [ourReply(16000, minutesAgo(30)), ...reactions]],
      ]),
      listed: [],
    };
    await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect((await ledgerFor(1600)).map((r) => r.inboundMessageId)).toEqual([
      16_105,
    ]);
  });

  test("a conversation pinned during the read does not end it before the recent ones", async () => {
    const s: Scripted = {
      conversations: new Map(),
      pages: new Map([
        [INBOX, [[conv(800, minutesAgo(600))], [conv(801, minutesAgo(20))]]],
      ]),
      // Unpinned when the first listing starts, pinned by the time it ends.
      pinnedCalls: [[], [800], [800], [800], [800], [800]],
      messages: new Map([[801, [incoming(9801, minutesAgo(20))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(0);
    expect((await ledgerFor(801)).map((r) => r.inboundMessageId)).toEqual([
      9801,
    ]);
  });

  test("two reads that stop at the same row are not stable while the pins changed around them", async () => {
    const s: Scripted = {
      conversations: new Map(),
      pages: new Map([
        [INBOX, [[conv(810, minutesAgo(600))], [conv(811, minutesAgo(20))]]],
      ]),
      // Pinned during the first read, unpinned and pinned again around the second.
      pinnedCalls: [[], [810], [], [810], [810], [810], [810], [810]],
      messages: new Map([[811, [incoming(9811, minutesAgo(20))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(0);
    expect((await ledgerFor(811)).map((r) => r.inboundMessageId)).toEqual([
      9811,
    ]);
  });

  test("a busy inbox is read to the end of the window, however many pages that takes", async () => {
    // Fifty pages of recent conversations we already answered, and the lost message on the last one.
    const pages: ChatwootInboxConversation[][] = [];
    const messages = new Map<number, unknown[]>();
    for (let p = 0; p < 50; p++) {
      const page: ChatwootInboxConversation[] = [];
      for (let i = 0; i < 25; i++) {
        const id = 10_000 + p * 25 + i;
        page.push(conv(id, minutesAgo(20)));
        messages.set(id, [
          incoming(id * 10, minutesAgo(21)),
          outgoing(id * 10 + 1, minutesAgo(20)),
        ]);
      }
      pages.push(page);
    }
    const lost = 10_000 + 49 * 25 + 24;
    messages.set(lost, [incoming(lost * 10, minutesAgo(20))]);
    const s: Scripted = {
      conversations: new Map(),
      pages: new Map([[INBOX, pages]]),
      messages,
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(0);
    expect(counts.handedToRecovery).toBe(1);
    expect((await ledgerFor(lost)).map((r) => r.inboundMessageId)).toEqual([
      lost * 10,
    ]);
  });

  test("pinned conversations filling a whole page do not end the read before the recent ones", async () => {
    const pinnedPage = [1, 2, 3, 4, 5].map((i) =>
      conv(530 + i, minutesAgo(600)),
    );
    const s: Scripted = {
      conversations: new Map(),
      pages: new Map([[INBOX, [pinnedPage, [conv(540, minutesAgo(20))]]]]),
      pinned: pinnedPage.map((c) => c.id),
      messages: new Map([[540, [incoming(9040, minutesAgo(20))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(1);
    expect((await ledgerFor(540)).map((r) => r.inboundMessageId)).toEqual([
      9040,
    ]);
  });

  test("an unreadable message page fails the inbox and keeps the cursor", async () => {
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(550, minutesAgo(20))]]]),
      messages: new Map([[550, { meta: {} } as unknown as unknown[]]]),
      listed: [],
    };
    // And a page whose newest row cannot be read: the older customer message would read as owed or
    // not depending on what that row was.
    const unreadableRow: Scripted = {
      conversations: new Map([[INBOX, [conv(551, minutesAgo(20))]]]),
      messages: new Map([
        [551, [incoming(9051, minutesAgo(25)), { message_type: 1 }]],
      ]),
      listed: [],
    };
    const rowCounts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(unreadableRow),
    });
    expect(rowCounts.inboxesFailed).toBe(1);
    expect(await ledgerFor(551)).toHaveLength(0);
    // And rows that keep their id but lose the time or the kind they need to be placed.
    for (const [id, row] of [
      [552, { id: 9053, message_type: 0, private: false, content: "oi" }],
      [553, { id: 9054, private: false, created_at: epoch(minutesAgo(20)) }],
    ] as const) {
      const degraded: Scripted = {
        conversations: new Map([[INBOX, [conv(id, minutesAgo(20))]]]),
        messages: new Map([[id, [incoming(id * 10, minutesAgo(25)), row]]]),
        listed: [],
      };
      const c = await reconcileFromChatwoot({
        tenantId,
        base: appDb,
        now: NOW,
        makeClient: chatwoot(degraded),
      });
      expect(c.inboxesFailed).toBe(1);
    }
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(1);
    const kept = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { reconciledUntil: true },
    });
    expect(kept.reconciledUntil?.getTime()).toBe(minutesAgo(40).getTime());
  });

  test("the handler commits its run, so a pass past the deadline still reschedules", async () => {
    let committed = false;
    const result = await reconcileSweepHandler(
      {
        id: 1n,
        tenantId: -1n,
        kind: "RECONCILE_SWEEP",
      } as unknown as Parameters<typeof reconcileSweepHandler>[0],
      appDb,
      {
        signal: new AbortController().signal,
        commit: () => {
          committed = true;
        },
      },
    );
    expect(committed).toBe(true);
    expect(result.outcome).toBe("reschedule");
  });

  test("a conversation leaving pending mid-read shifts the pages, and the lost message behind it is still found", async () => {
    const all = Array.from({ length: 50 }, (_, i) =>
      conv(600 + i, minutesAgo(20)),
    );
    const messages = new Map<number, unknown[]>();
    for (const c of all)
      messages.set(c.id, [
        incoming(c.id * 10, minutesAgo(21)),
        outgoing(c.id * 10 + 1, minutesAgo(20)),
      ]);
    messages.set(625, [incoming(6250, minutesAgo(20))]);
    // The first conversation leaves pending after page one is read: page two starts one row later,
    // and the 26th conversation (625) is on neither page of that listing.
    const shifted = all.slice(1);
    const s: Scripted = {
      conversations: new Map(),
      calls: [
        all.slice(0, 25),
        shifted.slice(25, 50),
        [],
        shifted.slice(0, 25),
        shifted.slice(25, 50),
        [],
        shifted.slice(0, 25),
        shifted.slice(25, 50),
        [],
      ],
      messages,
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(0);
    expect(counts.handedToRecovery).toBe(1);
    expect((await ledgerFor(625)).map((r) => r.inboundMessageId)).toEqual([
      6250,
    ]);
  });

  test("a listing that keeps revealing conversations from before the pass fails the inbox; one moved after the pass began does not", async () => {
    const revealing: Scripted = {
      conversations: new Map(),
      calls: [
        [conv(700, minutesAgo(20))],
        [],
        [conv(701, minutesAgo(20))],
        [],
        [conv(702, minutesAgo(20))],
        [],
        [conv(703, minutesAgo(20))],
        [],
        [conv(704, minutesAgo(20))],
        [],
      ],
      messages: new Map(),
      listed: [],
    };
    const failed = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(revealing),
    });
    expect(failed.inboxesFailed).toBe(1);

    const later = new Date(NOW.getTime() + 60_000);
    const moving: Scripted = {
      conversations: new Map(),
      calls: [
        [conv(710, minutesAgo(20))],
        [],
        [conv(711, later), conv(710, minutesAgo(20))],
        [],
        [conv(712, later), conv(711, later), conv(710, minutesAgo(20))],
        [],
        [conv(713, later), conv(710, minutesAgo(20))],
        [],
        [conv(714, later), conv(710, minutesAgo(20))],
        [],
      ],
      messages: new Map(),
      listed: [],
    };
    const ok = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(moving),
    });
    expect(ok.inboxesFailed).toBe(0);
  });

  test("a second read naming only judged conversations is not proof: the one it skipped is still found", async () => {
    const all = Array.from({ length: 50 }, (_, i) =>
      conv(900 + i, minutesAgo(20)),
    );
    const messages = new Map<number, unknown[]>();
    for (const c of all)
      messages.set(c.id, [
        incoming(c.id * 10, minutesAgo(21)),
        outgoing(c.id * 10 + 1, minutesAgo(20)),
      ]);
    messages.set(925, [incoming(9250, minutesAgo(20))]);
    // Both reads lose a row to a departure between their pages, and 925 falls in that gap twice; the
    // second read names nothing new, only fewer. The third reads the listing whole.
    const rest = all.slice(1);
    const s: Scripted = {
      conversations: new Map(),
      calls: [
        all.slice(0, 25),
        all.slice(26, 50),
        [],
        rest.slice(0, 24),
        rest.slice(25, 49),
        [],
        rest,
        [],
        rest,
        [],
      ],
      messages,
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(0);
    expect((await ledgerFor(925)).map((r) => r.inboundMessageId)).toEqual([
      9250,
    ]);
  });

  test("an unclassified receipt is placed by its route: another bot under the same binding is an observer, the responder's bot or an older binding covers", async () => {
    await suDb.chatwootWebhookDelivery.createMany({
      data: [
        {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: "stranded-observer",
          event: "message_created",
          status: "PENDING",
          conversationId: 517,
          inboundMessageId: 9027,
          routeAgentBotId: BOT + 1,
          bindingGeneration: 0,
        },
        {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: "stranded-responder",
          event: "message_created",
          status: "PENDING",
          conversationId: 518,
          inboundMessageId: 9028,
          routeAgentBotId: BOT,
          bindingGeneration: 0,
        },
        {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: "stranded-before-rebind",
          event: "message_created",
          status: "PENDING",
          conversationId: 519,
          inboundMessageId: 9029,
          routeAgentBotId: BOT + 2,
          bindingGeneration: -1,
        },
      ],
    });
    const s: Scripted = {
      conversations: new Map([
        [
          INBOX,
          [
            conv(517, minutesAgo(25)),
            conv(518, minutesAgo(25)),
            conv(519, minutesAgo(25)),
          ],
        ],
      ]),
      messages: new Map([
        [517, [incoming(9027, minutesAgo(25))]],
        [518, [incoming(9028, minutesAgo(25))]],
        [519, [incoming(9029, minutesAgo(25))]],
      ]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(1);
    expect(await ledgerFor(517)).toHaveLength(2);
    expect(await ledgerFor(518)).toHaveLength(1);
    expect(await ledgerFor(519)).toHaveLength(1);
  });

  test("a responder's delivery from before a rebind still covers the message", async () => {
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "previous-responder",
        event: "message_created",
        status: "PROCESSED",
        conversationId: 516,
        inboundMessageId: 9026,
        routeAgentBotId: BOT + 5,
        routeObserved: false,
      },
    });
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(516, minutesAgo(25))]]]),
      messages: new Map([[516, [incoming(9026, minutesAgo(25))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(0);
    expect(await ledgerFor(516)).toHaveLength(1);
  });

  test("two identical reads whose pages overlap do not prove the window covered", async () => {
    const all = Array.from({ length: 50 }, (_, i) =>
      conv(950 + i, minutesAgo(20)),
    );
    const messages = new Map<number, unknown[]>();
    for (const c of all)
      messages.set(c.id, [
        incoming(c.id * 10, minutesAgo(21)),
        outgoing(c.id * 10 + 1, minutesAgo(20)),
      ]);
    messages.set(975, [incoming(9750, minutesAgo(20))]);
    // Ties ordered differently per request: page two repeats 974 and never names 975, every time.
    const overlapping = [all.slice(0, 25), [all[24], ...all.slice(26, 50)], []];
    const s: Scripted = {
      conversations: new Map(),
      calls: [
        ...overlapping,
        ...overlapping,
        ...overlapping,
        ...overlapping,
        ...overlapping,
      ] as ChatwootInboxConversation[][],
      messages,
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(1);
    const kept = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { reconciledUntil: true },
    });
    expect(kept.reconciledUntil?.getTime()).toBe(minutesAgo(40).getTime());
  });

  test("an overlapped read is no baseline: a later read that skips the same row by a shift does not match it", async () => {
    const all = Array.from({ length: 50 }, (_, i) =>
      conv(1000 + i, minutesAgo(20)),
    );
    const messages = new Map<number, unknown[]>();
    for (const c of all)
      messages.set(c.id, [
        incoming(c.id * 10, minutesAgo(21)),
        outgoing(c.id * 10 + 1, minutesAgo(20)),
      ]);
    messages.set(1025, [incoming(10250, minutesAgo(20))]);
    const rest = all.slice(1);
    const s: Scripted = {
      conversations: new Map(),
      calls: [
        // Overlapping pages: 1024 twice, 1025 on neither.
        all.slice(0, 25),
        [all[24], ...all.slice(26, 50)] as ChatwootInboxConversation[],
        [],
        // 1000 leaves between the pages: 1025 shifts out of both, naming the same set as above.
        all.slice(0, 25),
        all.slice(26, 50),
        [],
        rest.slice(0, 25),
        rest.slice(25, 49),
        [],
        rest.slice(0, 25),
        rest.slice(25, 49),
        [],
      ],
      messages,
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(0);
    expect((await ledgerFor(1025)).map((r) => r.inboundMessageId)).toEqual([
      10250,
    ]);
  });

  test("an overlapped read never confirms a clean one that missed the same row", async () => {
    const all = Array.from({ length: 50 }, (_, i) =>
      conv(1100 + i, minutesAgo(20)),
    );
    const messages = new Map<number, unknown[]>();
    for (const c of all)
      messages.set(c.id, [
        incoming(c.id * 10, minutesAgo(21)),
        outgoing(c.id * 10 + 1, minutesAgo(20)),
      ]);
    messages.set(1125, [incoming(11250, minutesAgo(20))]);
    const s: Scripted = {
      conversations: new Map(),
      calls: [
        // A clean read that a shift made miss 1125.
        all.slice(0, 25),
        all.slice(26, 50),
        [],
        // An overlapped read naming the same set: 1124 twice, 1125 on neither.
        all.slice(0, 25),
        [all[24], ...all.slice(26, 50)] as ChatwootInboxConversation[],
        [],
        all.slice(0, 25),
        all.slice(25, 50),
        [],
        all.slice(0, 25),
        all.slice(25, 50),
        [],
      ],
      messages,
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(0);
    expect((await ledgerFor(1125)).map((r) => r.inboundMessageId)).toEqual([
      11250,
    ]);
  });

  test("our bot's reply after a lost message does not hide it, and one after a received message is no loss", async () => {
    await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "received-normally",
        event: "message_created",
        status: "PROCESSED",
        conversationId: 581,
        inboundMessageId: 9081,
        routeAgentBotId: BOT,
        routeObserved: false,
      },
    });
    const s: Scripted = {
      conversations: new Map([
        [INBOX, [conv(580, minutesAgo(20)), conv(581, minutesAgo(20))]],
      ]),
      messages: new Map([
        [580, [incoming(9080, minutesAgo(25)), ourReply(9082, minutesAgo(20))]],
        [581, [incoming(9081, minutesAgo(25)), ourReply(9083, minutesAgo(20))]],
      ]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(1);
    expect((await ledgerFor(580)).map((r) => r.inboundMessageId)).toEqual([
      9080,
    ]);
    expect(await ledgerFor(581)).toHaveLength(1);
  });

  test("a message from before the responder was bound is not made the responder's work", async () => {
    await suDb.inbox.updateMany({
      where: { tenantId, chatwootInboxId: INBOX },
      // Bound 600 ms into a second: a message stamped with that whole second may have followed it.
      data: { responderBoundAt: new Date(minutesAgo(22).getTime() + 600) },
    });
    try {
      const s: Scripted = {
        conversations: new Map([
          [
            INBOX,
            [
              conv(590, minutesAgo(20)),
              conv(591, minutesAgo(20)),
              conv(589, minutesAgo(20)),
            ],
          ],
        ]),
        messages: new Map([
          [590, [incoming(9090, minutesAgo(25))]],
          [591, [incoming(9091, minutesAgo(20))]],
          [589, [incoming(9089, minutesAgo(22))]],
        ]),
        listed: [],
      };
      const counts = await reconcileFromChatwoot({
        tenantId,
        base: appDb,
        now: NOW,
        makeClient: chatwoot(s),
      });
      expect(counts.handedToRecovery).toBe(2);
      expect(await ledgerFor(590)).toHaveLength(0);
      expect((await ledgerFor(589)).map((r) => r.inboundMessageId)).toEqual([
        9089,
      ]);
      expect((await ledgerFor(591)).map((r) => r.inboundMessageId)).toEqual([
        9091,
      ]);
    } finally {
      await suDb.inbox.updateMany({
        where: { tenantId, chatwootInboxId: INBOX },
        data: { responderBoundAt: null },
      });
    }
  });

  test("a message a turn already decided without a ledger row is no loss: a claim, a dispensal range, or a floor past it", async () => {
    const mirror = async (
      chatwootConversationId: number,
      marks: {
        lastHandledMessageId?: number;
        replyClaimFloorMessageId?: number;
        resetAtMessageId?: number;
      } = {},
    ) =>
      suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId,
          status: "pending",
          threadId: `rcn-${process.pid}-${chatwootConversationId}`,
          lastEventAt: minutesAgo(20),
          ...marks,
        },
        select: { id: true },
      });
    const claimed = await mirror(592);
    await suDb.messageReplyClaim.create({
      data: {
        tenantId,
        conversationId: claimed.id,
        messageId: 9092,
        reason: "CLAIMED",
      },
    });
    const ranged = await mirror(593);
    await suDb.replyDispensal.create({
      data: {
        tenantId,
        conversationId: ranged.id,
        fromMessageId: 9000,
        toMessageId: 9100,
      },
    });
    await mirror(594, { lastHandledMessageId: 9094 });
    await mirror(595, { lastHandledMessageId: 9094 });
    // Per-message era: a mark past the message is a later message decided alone, not this one.
    await mirror(596, {
      lastHandledMessageId: 9200,
      replyClaimFloorMessageId: 9000,
    });
    await mirror(597, {
      resetAtMessageId: 9097,
      replyClaimFloorMessageId: 9000,
    });
    // The message each conversation is owed, by its Chatwoot id: claimed, inside the dispensal range,
    // at the handled floor, and past the floor with nothing written about it.
    const owed = new Map([
      [592, 9092],
      [593, 9093],
      [594, 9094],
      [595, 9095],
      [596, 9096],
      [597, 9097],
    ]);
    const s: Scripted = {
      conversations: new Map([
        [INBOX, [...owed.keys()].map((id) => conv(id, minutesAgo(20)))],
      ]),
      messages: new Map(
        [...owed].map(([id, msg]) => [
          id,
          [incoming(msg, minutesAgo(25)), ourReply(msg + 1000, minutesAgo(20))],
        ]),
      ),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(2);
    expect((await ledgerFor(595)).map((r) => r.inboundMessageId)).toEqual([
      9095,
    ]);
    expect((await ledgerFor(596)).map((r) => r.inboundMessageId)).toEqual([
      9096,
    ]);
    expect(await ledgerFor(597)).toHaveLength(0);
  });

  test("judging the conversations does not count against the listing budget", async () => {
    const slow: Scripted = {
      conversations: new Map([
        [INBOX, [conv(1200, minutesAgo(20)), conv(1201, minutesAgo(20))]],
      ]),
      messages: new Map([
        [1200, [incoming(12000, minutesAgo(21))]],
        [1201, [incoming(12010, minutesAgo(21))]],
      ]),
      listed: [],
    };
    const makeClient = chatwoot(slow);
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: async (...args: Parameters<typeof makeClient>) => {
        const c = await makeClient(...args);
        const getMessages = c.getMessages.bind(c);
        c.getMessages = (async (...a: Parameters<typeof getMessages>) => {
          await Bun.sleep(40);
          return getMessages(...a);
        }) as typeof c.getMessages;
        return c;
      },
      listingBudgetMs: 30,
    });
    expect(counts.inboxesFailed).toBe(0);
    expect(counts.handedToRecovery).toBe(2);
  });

  test("a listing that keeps growing past its budget fails the inbox and keeps the cursor", async () => {
    let next = 20_000;
    const endless = async () =>
      ({
        async listPinnedConversationIds() {
          return new Set<number>();
        },
        async listInboxConversations() {
          await Bun.sleep(5);
          return Array.from({ length: 25 }, () => conv(next++, minutesAgo(20)));
        },
        async getMessages() {
          return [];
        },
      }) as unknown as ChatwootClient;
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: endless,
      listingBudgetMs: 50,
    });
    expect(counts.inboxesFailed).toBe(1);
    const kept = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { reconciledUntil: true },
    });
    expect(kept.reconciledUntil?.getTime()).toBe(minutesAgo(40).getTime());
  });

  test("a conversation that cannot be judged does not hide the lost message behind it, and the inbox still fails", async () => {
    const s: Scripted = {
      conversations: new Map([
        [INBOX, [conv(1300, minutesAgo(20)), conv(1301, minutesAgo(19))]],
      ]),
      messages: new Map([
        [1300, { meta: {} } as unknown as unknown[]],
        [1301, [incoming(13010, minutesAgo(20))]],
      ]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(1);
    expect((await ledgerFor(1301)).map((r) => r.inboundMessageId)).toEqual([
      13010,
    ]);
    const kept = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { reconciledUntil: true },
    });
    expect(kept.reconciledUntil?.getTime()).toBe(minutesAgo(40).getTime());
  });

  test("a first pass that fails is retried over the same window, not one that slid with the clock", async () => {
    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { reconciledUntil: null },
    });
    const failing: Scripted = {
      conversations: new Map(),
      messages: new Map(),
      failInbox: INBOX,
      listed: [],
    };
    await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(failing),
    });
    // Ten minutes later, a message from five hours fifty-five minutes before the first pass: inside
    // that pass's window, outside one computed from the retry's own clock.
    const later = new Date(NOW.getTime() + 10 * 60_000);
    const s: Scripted = {
      conversations: new Map([[INBOX, [conv(1310, minutesAgo(30))]]]),
      messages: new Map([[1310, [incoming(13100, minutesAgo(355))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: later,
      makeClient: chatwoot(s),
    });
    expect(counts.handedToRecovery).toBe(1);
  });

  test("a monitoring agent's lost message is owed memory only", async () => {
    const inbox = await suDb.inbox.findFirstOrThrow({
      where: { tenantId, chatwootInboxId: INBOX },
      select: { agentId: true },
    });
    const agentId = inbox.agentId as bigint;
    await suDb.agent.update({
      where: { id: agentId },
      data: { mode: "monitoring" },
    });
    try {
      const s: Scripted = {
        conversations: new Map([[INBOX, [conv(2000, minutesAgo(20))]]]),
        messages: new Map([[2000, [incoming(20000, minutesAgo(20))]]]),
        listed: [],
      };
      await reconcileFromChatwoot({
        tenantId,
        base: appDb,
        now: NOW,
        makeClient: chatwoot(s),
      });
      const row = await suDb.chatwootWebhookDelivery.findFirstOrThrow({
        where: { chatwootInstanceId: instanceId, conversationId: 2000 },
        select: { owesMemoryOnly: true },
      });
      expect(row.owesMemoryOnly).toBe(true);
    } finally {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production" },
      });
    }
  });

  test("a conversation with no activity time fails the inbox and keeps the cursor", async () => {
    const s: Scripted = {
      conversations: new Map([
        [INBOX, [{ ...conv(560, minutesAgo(20)), lastActivityAt: null }]],
      ]),
      messages: new Map(),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(1);
    const kept = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { reconciledUntil: true },
    });
    expect(kept.reconciledUntil?.getTime()).toBe(minutesAgo(40).getTime());
  });

  test("a listing that repeats its page fails the inbox and keeps the cursor", async () => {
    const page = [conv(520, minutesAgo(20))];
    const s: Scripted = {
      conversations: new Map(),
      pages: new Map([[INBOX, [page, page, page]]]),
      messages: new Map([[520, [outgoing(9030, minutesAgo(20))]]]),
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    expect(counts.inboxesFailed).toBe(1);
    const kept = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { reconciledUntil: true },
    });
    expect(kept.reconciledUntil?.getTime()).toBe(minutesAgo(40).getTime());
  });

  test("the cursor advances to the settle line after a pass that read every inbox, and not after one that failed", async () => {
    const ok: Scripted = {
      conversations: new Map(),
      messages: new Map(),
      listed: [],
    };
    await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(ok),
    });
    const after = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { reconciledUntil: true },
    });
    expect(after.reconciledUntil?.getTime()).toBe(minutesAgo(10).getTime());

    await suDb.chatwootInstance.update({
      where: { id: instanceId },
      data: { reconciledUntil: minutesAgo(40) },
    });
    const failing: Scripted = {
      conversations: new Map(),
      messages: new Map(),
      failInbox: INBOX,
      listed: [],
    };
    const counts = await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(failing),
    });
    expect(counts.inboxesFailed).toBe(1);
    const kept = await suDb.chatwootInstance.findUniqueOrThrow({
      where: { id: instanceId },
      select: { reconciledUntil: true },
    });
    expect(kept.reconciledUntil?.getTime()).toBe(minutesAgo(40).getTime());
  });

  test("a pass that hands anything over leaves one warn line with the count, and one info line per conversation", async () => {
    const before = new Date();
    const s: Scripted = {
      conversations: new Map([
        [INBOX, [conv(508, minutesAgo(25)), conv(509, minutesAgo(20))]],
      ]),
      messages: new Map([
        [508, [incoming(9009, minutesAgo(25))]],
        [509, [incoming(9010, minutesAgo(20))]],
      ]),
      listed: [],
    };
    await reconcileFromChatwoot({
      tenantId,
      base: appDb,
      now: NOW,
      makeClient: chatwoot(s),
    });
    // flowlog-scope: tenant-wide. The subject is how many lines the pass wrote, and the warn line
    // names no conversation; the tenant is this file's and every case clears it first.
    const lines = await flowLogRows(suDb, {
      where: { tenantId, stage: "delivery", createdAt: { gte: before } },
      select: { level: true, detail: true, errorMessage: true },
    });
    const reconciled = lines.filter(
      (l) => (l.detail as { outcome?: string })?.outcome === "reconciled",
    );
    expect(reconciled.filter((l) => l.level === "info")).toHaveLength(2);
    const headline = reconciled.filter((l) => l.level === "warn");
    expect(headline).toHaveLength(1);
    const detail = headline[0]?.detail as { handedToRecovery?: number } | null;
    expect(detail?.handedToRecovery).toBe(2);
    // The alert's text is the line's message, so the count has to be in it.
    const warn = headline[0] as unknown as {
      level: string;
      errorMessage: string | null;
    };
    expect(
      alertSummary({
        stage: "delivery",
        level: "warn",
        status: "error",
        errorMessage: warn.errorMessage ?? undefined,
        detail: { outcome: "reconciled" },
      } as never),
    ).toContain("2 customer messages");
  });
});
