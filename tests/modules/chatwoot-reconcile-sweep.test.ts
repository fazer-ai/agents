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
        const pages = s.pages?.get(inboxId);
        if (pages) return pages[page - 1] ?? [];
        return page === 1 ? (s.conversations.get(inboxId) ?? []) : [];
      },
      async getMessages(conversationId: number) {
        return s.messages.get(conversationId) ?? [];
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
