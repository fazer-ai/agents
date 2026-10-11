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
import { parseChatwootMessages } from "@/modules/chatwoot/messages";
import {
  owedCustomerMessage,
  reconciledDeliveryId,
  reconcileFromChatwoot,
  reconcileSweepHandler,
} from "@/modules/chatwoot/reconcile-sweep";
import { deliveryRecoveryDedupeKey } from "@/modules/chatwoot/recover-delivery";
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
  } catch {
    dbUp = false;
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
      async getMessages(conversationId: number, opts?: { before?: number }) {
        const all = s.messages.get(conversationId) ?? [];
        if (!Array.isArray(all)) return all;
        const before = opts?.before;
        const older =
          before === undefined
            ? all
            : all.filter((m) => (m as { id: number }).id < before);
        return older.slice(-20);
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
      select: { level: true, detail: true },
    });
    const reconciled = lines.filter(
      (l) => (l.detail as { outcome?: string })?.outcome === "reconciled",
    );
    expect(reconciled.filter((l) => l.level === "info")).toHaveLength(2);
    const headline = reconciled.filter((l) => l.level === "warn");
    expect(headline).toHaveLength(1);
    const detail = headline[0]?.detail as { handedToRecovery?: number } | null;
    expect(detail?.handedToRecovery).toBe(2);
  });
});
