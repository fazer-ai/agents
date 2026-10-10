import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import { drainInFlight, resetShutdownForTest } from "@/lib/shutdown";
import {
  ADMISSION_MAX_WAITING,
  admissionLaneOf,
  admitChatwootDelivery,
  chatwootAdmissionState,
  drainStoredChatwootDeliveries,
  QUEUED_RECHECK_AFTER_MS,
  resetChatwootAdmissionForTest,
  runQueuedDelivery,
  STORED_DELIVERY_MAX_AGE_MS,
} from "@/modules/chatwoot/delivery-queue";
import {
  registerDeliverySweepHandler,
  STALE_AFTER_MS,
} from "@/modules/chatwoot/delivery-sweep";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { MAX_RECOVERY_AGE_MS } from "@/modules/chatwoot/recover-delivery";
import { invalidateRouteTokenCache } from "@/modules/chatwoot/route-token-cache";
import { receiveChatwootWebhook } from "@/modules/chatwoot/webhook";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { seedChatwootInstance } from "../utils/chatwoot";

// A bounded number of deliveries is processed at once, the rest wait as ledger rows instead of
// competing for the pool, and a row whose process died after the ack is processed from what the ack
// stored rather than lost.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function held() {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { gate, release: () => release() };
}

afterEach(() => {
  resetChatwootAdmissionForTest();
  resetShutdownForTest();
});

// Restated in the queue to keep the sweep's handler free of a load-time cycle; one number all the same,
// since past it the recovery refuses the row too.
test("the drain gives a body up at the recovery's own age ceiling", () => {
  expect(STORED_DELIVERY_MAX_AGE_MS).toBe(MAX_RECOVERY_AGE_MS);
});

describe("admission", () => {
  test("no more than the limit run at once; the rest wait their turn", async () => {
    resetChatwootAdmissionForTest(2);
    const gates = Array.from({ length: 6 }, () => held());
    let running = 0;
    let peak = 0;
    let finished = 0;
    gates.forEach((g, i) => {
      expect(
        admitChatwootDelivery(BigInt(i + 1), async () => {
          running++;
          peak = Math.max(peak, running);
          await g.gate;
          running--;
          finished++;
        }),
      ).toBe(true);
    });
    await sleep(5);
    expect(chatwootAdmissionState()).toMatchObject({
      running: 2,
      waiting: 4,
      limit: 2,
    });
    for (const g of gates) {
      g.release();
      await sleep(2);
    }
    await sleep(5);
    expect(finished).toBe(6);
    expect(peak).toBe(2);
    expect(chatwootAdmissionState()).toMatchObject({ running: 0, waiting: 0 });
  });

  // A takeover reaches a running turn through these events, so they must not wait behind the turns.
  test("an event that is not a customer message runs while every turn slot is busy", async () => {
    resetChatwootAdmissionForTest(1);
    const g = held();
    admitChatwootDelivery(101n, () => g.gate, "turn");
    let metaRan = false;
    expect(
      admitChatwootDelivery(
        102n,
        async () => {
          metaRan = true;
        },
        "meta",
      ),
    ).toBe(true);
    await sleep(5);
    expect(metaRan).toBe(true);
    g.release();
  });

  test("a delivery whose slot opens past the age ceiling is not run", async () => {
    resetChatwootAdmissionForTest(1);
    let ran = false;
    admitChatwootDelivery(
      40_000n,
      async () => {
        ran = true;
      },
      "turn",
      Date.now() - STORED_DELIVERY_MAX_AGE_MS - 1,
    );
    for (let i = 0; i < 100 && chatwootAdmissionState().running > 0; i++)
      await sleep(5);
    expect(ran).toBe(false);
  });

  test("a full turn backlog does not turn a takeover event away", async () => {
    resetChatwootAdmissionForTest(1);
    const g = held();
    for (let i = 0; i <= ADMISSION_MAX_WAITING; i++)
      admitChatwootDelivery(BigInt(10_000 + i), () => g.gate, "turn");
    expect(admitChatwootDelivery(20_000n, async () => {}, "turn")).toBe(false);
    expect(admitChatwootDelivery(20_001n, async () => {}, "meta")).toBe(true);
    g.release();
  });

  test("only a customer's incoming public message takes the turn lane", () => {
    const msg = (messageType: string, priv = false) =>
      ({
        event: "message_created",
        conversationId: 1,
        contactInboxId: null,
        inboxId: 7,
        status: "pending",
        message: { messageType, private: priv },
      }) as unknown as Parameters<typeof admissionLaneOf>[0];
    expect(admissionLaneOf(msg("incoming"))).toBe("turn");
    // Late media on a customer's message runs its transcription or vision: a turn's cost.
    expect(
      admissionLaneOf({ ...msg("incoming"), event: "message_updated" }),
    ).toBe("turn");
    expect(admissionLaneOf(msg("outgoing"))).toBe("meta");
    expect(admissionLaneOf(msg("incoming", true))).toBe("meta");
    expect(
      admissionLaneOf({
        ...msg("incoming"),
        event: "conversation_status_changed",
        message: undefined,
      }),
    ).toBe("meta");
  });

  test("a row already held is not admitted twice", async () => {
    resetChatwootAdmissionForTest(1);
    const g = held();
    let runs = 0;
    const run = async () => {
      runs++;
      await g.gate;
    };
    expect(admitChatwootDelivery(7n, run)).toBe(true);
    expect(admitChatwootDelivery(7n, run)).toBe(false);
    g.release();
    await sleep(5);
    expect(runs).toBe(1);
    // Done, so a later dispatch of the same row (a redelivery) is admitted again; its CAS decides.
    expect(admitChatwootDelivery(7n, async () => {})).toBe(true);
  });

  test("a throwing delivery frees its slot", async () => {
    resetChatwootAdmissionForTest(1);
    let second = false;
    admitChatwootDelivery(1n, async () => {
      throw new Error("boom");
    });
    admitChatwootDelivery(2n, async () => {
      second = true;
    });
    await sleep(10);
    expect(second).toBe(true);
    expect(chatwootAdmissionState().running).toBe(0);
  });

  // The waiting rows are durable: on SIGTERM nothing new starts, they stay PENDING with their
  // payload, and the next boot (or another replica) drains them.
  test("a draining process starts nothing new", async () => {
    resetChatwootAdmissionForTest(1);
    const g = held();
    let started = 0;
    admitChatwootDelivery(1n, async () => {
      started++;
      await g.gate;
    });
    admitChatwootDelivery(2n, async () => {
      started++;
    });
    // SIGTERM: the drain waits for what runs and starts nothing that waits.
    const drained = drainInFlight({ boundMs: 2_000 });
    g.release();
    expect((await drained).drained).toBe(true);
    await sleep(10);
    expect(started).toBe(1);
  });
});

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

const SECRET = "delivery-queue-secret";
const NOW = 1_700_000_000;
const headers = (body: string, delivery: string) => {
  const h: Record<string, string> = {
    "x-chatwoot-signature": `sha256=${createHmac("sha256", SECRET).update(`${NOW}.${body}`).digest("hex")}`,
    "x-chatwoot-timestamp": String(NOW),
    "x-chatwoot-delivery": delivery,
  };
  return (name: string) => h[name.toLowerCase()] ?? null;
};

let tenantId = 0n;
let instanceId = 0n;
let routeToken = "";

// A conversation update: it runs the whole delivery path down to PROCESSED with no turn and no
// Chatwoot call, so what is under test is the queue and not the agent.
const updateBody = (conversationId: number) =>
  JSON.stringify({
    event: "conversation_updated",
    id: conversationId,
    inbox_id: 7,
    status: "pending",
    meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
  });

// The state a process leaves behind when it dies right after the 200: the row the ack wrote, and
// nothing running it.
async function ackOnly(deliveryId: string, conversationId: number) {
  const body = updateBody(conversationId);
  const r = await receiveChatwootWebhook({
    routeToken,
    rawBody: body,
    getHeader: headers(body, deliveryId),
    nowSeconds: NOW,
    base: appDb,
  });
  return r.deliveryRowId as bigint;
}

const rowById = (id: bigint) =>
  suDb.chatwootWebhookDelivery.findUniqueOrThrow({ where: { id } });

const settled = async (id: bigint) => {
  for (let i = 0; i < 200; i++) {
    const row = await rowById(id);
    if (row.status !== "PENDING" && row.status !== "PROCESSING") return row;
    await sleep(25);
  }
  return rowById(id);
};

describe.skipIf(!dbUp)("draining the rows the ack stored", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Delivery queue", slug: `delivery-queue-${process.pid}` },
    });
    tenantId = t.id;
    const { token, hash } = generateRouteToken();
    routeToken = token;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://delivery-queue.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Atendente", systemPrompt: "x" },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson(SECRET),
        webhookRouteTokenHash: hash,
        name: "Atendente",
      },
    });
    invalidateRouteTokenCache();
  });

  afterAll(async () => {
    invalidateRouteTokenCache();
    if (tenantId !== 0n) {
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
  });

  test("a row left behind by a dead process is processed from its payload at boot", async () => {
    const id = await ackOnly("queue-boot", 601);
    // Boot: every stored row, whatever its age, since nothing in this process holds any.
    const r = await drainStoredChatwootDeliveries({ base: appDb, minAgeMs: 0 });
    expect(r.admitted).toBeGreaterThanOrEqual(1);
    const row = await settled(id);
    expect(row.status).toBe("PROCESSED");
    expect(row.payload).toBeNull();
    // It was the drain that processed it, not a recovery from the sweep's DEAD verdict.
    expect(row.attempts).toBe(0);
  });

  test("the periodic pass leaves a fresh row to the process that is holding it", async () => {
    const id = await ackOnly("queue-fresh", 602);
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 60_000,
    });
    expect(r.admitted).toBe(0);
    expect((await rowById(id)).status).toBe("PENDING");

    // A minute later it is nobody's, and the pass takes it.
    await suDb.chatwootWebhookDelivery.update({
      where: { id },
      data: { receivedAt: new Date(Date.now() - 2 * 60_000) },
    });
    const later = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 60_000,
    });
    expect(later.admitted).toBe(1);
    expect((await settled(id)).status).toBe("PROCESSED");
  });

  const pastWindow = (id: bigint, ms = STALE_AFTER_MS + 60_000) =>
    suDb.chatwootWebhookDelivery.update({
      where: { id },
      data: { receivedAt: new Date(Date.now() - ms) },
    });
  const mirror = (conversationId: number) =>
    suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${conversationId}`,
      },
    });

  const customerMessage = (conversationId: number, messageId: number) =>
    JSON.stringify({
      event: "message_created",
      id: messageId,
      content: "oi",
      message_type: "incoming",
      private: false,
      conversation: {
        id: conversationId,
        inbox_id: 7,
        status: "pending",
        updated_at: Math.floor(Date.now() / 1000) - 600,
        meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
      },
    });
  const ackMessage = async (deliveryId: string, conversationId: number) => {
    const body = customerMessage(conversationId, conversationId * 100);
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: headers(body, deliveryId),
      nowSeconds: NOW,
      base: appDb,
    });
    return r.deliveryRowId as bigint;
  };
  // A Chatwoot client whose conversation read answers `live` and whose every other call is recorded.
  // The default newest page reaches back past every stored message and holds nothing newer.
  const fakeClient = (
    live: unknown,
    calls: string[],
    messages: unknown = [
      { id: 1, content: "oi", message_type: "incoming", private: false },
    ],
  ) =>
    new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : async () => {
              calls.push(String(prop));
              return prop === "getConversation"
                ? live
                : prop === "getMessages"
                  ? messages
                  : {};
            },
    });
  // The live read is newer than any stored event: its version is now.
  const heldByPerson = (conversationId: number) => ({
    id: conversationId,
    status: "open",
    inbox_id: 7,
    updated_at: Math.floor(Date.now() / 1000),
    last_activity_at: Math.floor(Date.now() / 1000),
    meta: { assignee_type: "User", assignee: { id: 55, name: "Ana" } },
  });

  // With no mirror yet (the process died before the first message was mirrored), the live ownership
  // is what creates it, not the stored snapshot.
  test("a stored first message of a conversation takes its ownership from the live read", async () => {
    const id = await ackMessage("queue-replay-unmirrored", 616);
    const calls: string[] = [];
    await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      deps: {
        makeClient: async () => fakeClient(heldByPerson(616), calls) as never,
      },
    });
    await settled(id);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 616 },
    });
    expect(conv.assigneeType).toBe("User");
    expect(conv.assigneeId).toBe(55);
    expect(calls).not.toContain("sendMessage");
  });

  // A live read that cannot say who holds the conversation is not a reason to fall back on the stored
  // snapshot: the row waits, with its body, for the next pass.
  test("a live read that cannot say who holds the conversation defers the replay", async () => {
    const id = await ackMessage("queue-replay-unreadable", 617);
    const calls: string[] = [];
    await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      deps: {
        makeClient: async () =>
          fakeClient(
            {
              id: 617,
              status: "pending",
              meta: { assignee_type: "AgentBot", assignee: {} },
            },
            calls,
          ) as never,
      },
    });
    for (let i = 0; i < 100 && chatwootAdmissionState().running > 0; i++)
      await sleep(5);
    const row = await rowById(id);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.payload).not.toBeNull();
    await suDb.chatwootWebhookDelivery.update({
      where: { id },
      data: { status: "PROCESSED", payload: null },
    });
  });

  // A stored message ties a resolve that came after it at whole-second resolution; the replay must not
  // reopen what the reconcile just closed.
  test("a replayed message does not reopen a conversation the live read says is resolved", async () => {
    await mirror(624);
    const t = Math.floor(Date.now() / 1000) - 60;
    const body = JSON.stringify({
      event: "message_created",
      id: 62_400,
      content: "oi",
      message_type: "incoming",
      private: false,
      conversation: {
        id: 624,
        inbox_id: 7,
        status: "pending",
        updated_at: t + 0.1,
        last_activity_at: t,
        meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
      },
    });
    const r0 = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: headers(body, "queue-replay-resolved"),
      nowSeconds: NOW,
      base: appDb,
    });
    const calls: string[] = [];
    await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      deps: {
        makeClient: async () =>
          fakeClient(
            {
              id: 624,
              status: "resolved",
              inbox_id: 7,
              updated_at: t + 0.5,
              last_activity_at: t,
              meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
            },
            calls,
          ) as never,
      },
    });
    await settled(r0.deliveryRowId as bigint);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 624 },
    });
    expect(conv.status).toBe("resolved");
    expect(calls).not.toContain("sendMessage");
  });

  // Customer messages that fill a batch without filling their lane do not leave a status change
  // stored behind them for the next pass.
  test("a pass reads on past a batch of customer messages to the status change behind them", async () => {
    resetChatwootAdmissionForTest(1);
    const g = held();
    admitChatwootDelivery(-2n, () => g.gate, "turn");
    const first = await ackMessage("queue-scan-turn-1", 625);
    const second = await ackMessage("queue-scan-turn-2", 626);
    const status = await ackOnly("queue-scan-meta", 627);
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      batch: 1,
    });
    expect(r.admitted).toBe(3);
    expect((await settled(status)).status).toBe("PROCESSED");
    g.release();
    for (const id of [first, second])
      await suDb.chatwootWebhookDelivery.update({
        where: { id },
        data: { status: "PROCESSED", payload: null },
      });
  });

  // The customer wrote again before the replay: the newer message's delivery carries the reply, and
  // the older one is ingested into memory without a turn.
  test("a stored message the customer has already written past is ingested, not answered", async () => {
    await mirror(628);
    const id = await ackMessage("queue-replay-behind", 628);
    const calls: string[] = [];
    const botHolds = {
      ...heldByPerson(628),
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    };
    await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      deps: {
        makeClient: async () =>
          fakeClient(botHolds, calls, [
            {
              id: 62_800,
              content: "oi",
              message_type: "incoming",
              private: false,
            },
            {
              id: 62_805,
              content: "outra coisa",
              message_type: "incoming",
              private: false,
            },
          ]) as never,
      },
    });
    const row = await settled(id);
    expect(row.status).toBe("PROCESSED");
    // Settled as memory owed, not as a turn the bot ran.
    expect(row.owesMemoryOnly).toBe(true);
    expect(calls).not.toContain("sendMessage");
  });

  // A person answered the stored message (and gave the conversation back) before the replay.
  test("a stored message a person already answered is ingested, not answered again", async () => {
    await mirror(632);
    const id = await ackMessage("queue-replay-answered", 632);
    const calls: string[] = [];
    await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      deps: {
        makeClient: async () =>
          fakeClient(
            {
              ...heldByPerson(632),
              status: "pending",
              meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
            },
            calls,
            [
              {
                id: 63_200,
                content: "oi",
                message_type: "incoming",
                private: false,
              },
              {
                id: 63_204,
                content: "já resolvi",
                message_type: "outgoing",
                private: false,
                sender: { type: "user", id: 55 },
              },
            ],
          ) as never,
      },
    });
    const row = await settled(id);
    expect(row.status).toBe("PROCESSED");
    expect(row.owesMemoryOnly).toBe(true);
    expect(calls).not.toContain("sendMessage");
  });

  // A newest page that does not reach back to the stored message cannot say whether the customer
  // wrote again: the replay waits.
  test("a newest page that cannot answer defers the replay", async () => {
    await mirror(629);
    const id = await ackMessage("queue-replay-short-page", 629);
    const calls: string[] = [];
    await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      deps: {
        makeClient: async () =>
          fakeClient(
            {
              ...heldByPerson(629),
              status: "pending",
              meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
            },
            calls,
            [],
          ) as never,
      },
    });
    for (let i = 0; i < 100 && chatwootAdmissionState().running > 0; i++)
      await sleep(5);
    const row = await rowById(id);
    expect(row.status).toBe("PENDING");
    expect(row.payload).not.toBeNull();
    await suDb.chatwootWebhookDelivery.update({
      where: { id },
      data: { status: "PROCESSED", payload: null },
    });
  });

  // A live delivery that waited long for its slot asks the same question when the slot opens.
  test("a queued customer message that waited past the recheck is ingested, not answered, once written past", async () => {
    await mirror(630);
    const id = await ackMessage("queue-live-written-past", 630);
    const calls: string[] = [];
    const message = (await rowById(id)).payload as string;
    const normalized = normalizeChatwootEvent(
      JSON.parse(decryptJson<string>(message)),
    );
    if (!normalized) throw new Error("the stored body did not normalize");
    await runQueuedDelivery({
      tenantId,
      instanceId,
      deliveryRowId: id,
      agentBotId: 9,
      normalized,
      receiptBindingGeneration: null,
      receivedAt: Date.now() - QUEUED_RECHECK_AFTER_MS - 1,
      base: appDb,
      deps: {
        makeClient: async () =>
          fakeClient(heldByPerson(630), calls, [
            {
              id: 63_000,
              content: "oi",
              message_type: "incoming",
              private: false,
            },
            {
              id: 63_009,
              content: "deixa",
              message_type: "incoming",
              private: false,
            },
          ]) as never,
      },
    });
    expect(calls).toContain("getMessages");
    const row = await rowById(id);
    expect(row.status).toBe("PROCESSED");
    expect(row.owesMemoryOnly).toBe(true);
    expect(calls).not.toContain("sendMessage");
  });

  test("a queued delivery that did not wait is not checked again", async () => {
    await mirror(631);
    const id = await ackMessage("queue-live-no-wait", 631);
    const calls: string[] = [];
    const normalized = normalizeChatwootEvent(
      JSON.parse(decryptJson<string>((await rowById(id)).payload as string)),
    );
    if (!normalized) throw new Error("the stored body did not normalize");
    await runQueuedDelivery({
      tenantId,
      instanceId,
      deliveryRowId: id,
      agentBotId: 9,
      normalized,
      receiptBindingGeneration: null,
      receivedAt: Date.now(),
      base: appDb,
      deps: {
        makeClient: async () => fakeClient(heldByPerson(631), calls) as never,
      },
    });
    expect(calls).not.toContain("getMessages");
  });

  // A live read with no ownership in it is not a statement that nobody holds the conversation.
  test("a live read that states no ownership defers the replay", async () => {
    const id = await ackMessage("queue-replay-unstated", 622);
    const calls: string[] = [];
    await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      deps: {
        makeClient: async () =>
          fakeClient(
            { id: 622, status: "pending", inbox_id: 7 },
            calls,
          ) as never,
      },
    });
    for (let i = 0; i < 100 && chatwootAdmissionState().running > 0; i++)
      await sleep(5);
    const row = await rowById(id);
    expect(row.status).toBe("PENDING");
    expect(row.payload).not.toBeNull();
    await suDb.chatwootWebhookDelivery.update({
      where: { id },
      data: { status: "PROCESSED", payload: null },
    });
  });

  // A full customer-message lane turns its rows away, and the pass pages on to the other lane's rows
  // behind them instead of reading the same refused batch every time.
  test("a full turn lane does not hide the stored status changes behind it", async () => {
    resetChatwootAdmissionForTest(1);
    const g = held();
    for (let i = 0; i <= ADMISSION_MAX_WAITING; i++)
      admitChatwootDelivery(BigInt(30_000 + i), () => g.gate, "turn");
    const turnRow = await ackMessage("queue-lane-full-turn", 618);
    const metaRow = await ackOnly("queue-lane-full-meta", 619);
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      batch: 1,
    });
    expect(r.admitted).toBe(1);
    expect((await settled(metaRow)).status).toBe("PROCESSED");
    expect((await rowById(turnRow)).status).toBe("PENDING");
    g.release();
    await suDb.chatwootWebhookDelivery.update({
      where: { id: turnRow },
      data: { status: "PROCESSED", payload: null },
    });
  });

  // The binding a row was received under must still stand when it is replayed: an observer made the
  // responder since asks what the role was at receipt, which the delivery recovery answers.
  test("a stored customer message whose inbox binding moved since receipt is left to the sweep", async () => {
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 77,
        name: "Rebound",
      },
    });
    const ack = async (deliveryId: string, body: string) =>
      (
        await receiveChatwootWebhook({
          routeToken,
          rawBody: body,
          getHeader: headers(body, deliveryId),
          nowSeconds: NOW,
          base: appDb,
        })
      ).deliveryRowId as bigint;
    const message = await ack(
      "queue-rebound-message",
      JSON.stringify({
        event: "message_created",
        id: 62_000,
        content: "oi",
        message_type: "incoming",
        private: false,
        conversation: {
          id: 620,
          inbox_id: 77,
          status: "pending",
          meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
        },
      }),
    );
    // A status change has no recovery to go to, so it is mirrored whatever the binding did.
    const status = await ack(
      "queue-rebound-status",
      JSON.stringify({
        event: "conversation_updated",
        id: 623,
        inbox_id: 77,
        status: "open",
        meta: { assignee_type: "User", assignee: { id: 55 } },
      }),
    );
    expect((await rowById(message)).bindingGeneration).toBe(
      inbox.bindingGeneration,
    );
    await suDb.inbox.update({
      where: { id: inbox.id },
      data: { bindingGeneration: { increment: 1 } },
    });
    await drainStoredChatwootDeliveries({ base: appDb, tenantId, minAgeMs: 0 });
    expect((await settled(status)).status).toBe("PROCESSED");
    for (let i = 0; i < 100 && chatwootAdmissionState().running > 0; i++)
      await sleep(5);
    const row = await rowById(message);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.payload).toBeNull();
    await suDb.chatwootWebhookDelivery.update({
      where: { id: message },
      data: { status: "PROCESSED" },
    });
  });

  // The mirror a replay creates carries the live read's version, so a status or assignment that is
  // newer than the stored message but older than the live read cannot overwrite the takeover.
  test("a mirror created by a replay is stamped with the live read's version", async () => {
    const t0 = Math.floor(Date.now() / 1000) - 600;
    const message = JSON.stringify({
      event: "message_created",
      id: 62_100,
      content: "oi",
      message_type: "incoming",
      private: false,
      conversation: {
        id: 621,
        inbox_id: 7,
        status: "pending",
        updated_at: t0,
        meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
      },
    });
    const r0 = await receiveChatwootWebhook({
      routeToken,
      rawBody: message,
      getHeader: headers(message, "queue-version-msg"),
      nowSeconds: NOW,
      base: appDb,
    });
    const id = r0.deliveryRowId as bigint;
    const calls: string[] = [];
    await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      deps: {
        makeClient: async () =>
          fakeClient(
            { ...heldByPerson(621), updated_at: t0 + 300 },
            calls,
          ) as never,
      },
    });
    await settled(id);
    // Late: newer than the message, older than the live read, and still saying the bot holds it.
    const late = JSON.stringify({
      event: "conversation_updated",
      id: 621,
      inbox_id: 7,
      status: "pending",
      updated_at: t0 + 100,
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });
    const r1 = await receiveChatwootWebhook({
      routeToken,
      rawBody: late,
      getHeader: headers(late, "queue-version-late"),
      nowSeconds: NOW,
      base: appDb,
    });
    await drainStoredChatwootDeliveries({ base: appDb, tenantId, minAgeMs: 0 });
    await settled(r1.deliveryRowId as bigint);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 621 },
    });
    expect(conv.assigneeType).toBe("User");
  });

  // A stored customer message can be replayed after a takeover whose own webhooks never reached the
  // mirror while the process was down: the live conversation is reconciled before the replay.
  test("a stored customer message is replayed against the live conversation, not the stale mirror", async () => {
    await mirror(615);
    const body = JSON.stringify({
      event: "message_created",
      id: 61_500,
      content: "oi",
      message_type: "incoming",
      private: false,
      conversation: {
        id: 615,
        inbox_id: 7,
        status: "pending",
        meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
      },
    });
    const r0 = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: headers(body, "queue-replay-live"),
      nowSeconds: NOW,
      base: appDb,
    });
    const id = r0.deliveryRowId as bigint;
    const calls: string[] = [];
    const fake = new Proxy(
      {
        getMessages: async () => [
          { id: 1, content: "oi", message_type: "incoming", private: false },
        ],
        getConversation: async () => {
          calls.push("getConversation");
          return {
            id: 615,
            status: "open",
            inbox_id: 7,
            last_activity_at: Math.floor(Date.now() / 1000),
            meta: {
              assignee_type: "User",
              assignee: { id: 55, name: "Ana" },
            },
          };
        },
      } as Record<string, unknown>,
      {
        get: (t, prop) =>
          prop === "then"
            ? undefined
            : prop in t
              ? t[prop as string]
              : async () => {
                  calls.push(String(prop));
                  return {};
                },
      },
    );
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      deps: { makeClient: async () => fake as never },
    });
    expect(r.admitted).toBe(1);
    await settled(id);
    expect(calls[0]).toBe("getConversation");
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 615 },
    });
    // The person who took over holds it, so the gate went silent instead of running a turn.
    expect(conv.assigneeType).toBe("User");
    expect(conv.assigneeId).toBe(55);
    expect(calls).not.toContain("sendMessage");
  });

  // Past the sweep's window a stored row is still the drain's, and the sweep leaves it alone: the
  // recovery would rebuild it from Chatwoot only for some rows (a mirrored conversation, a stated
  // route), and the body answers all of them.
  test("a row past the sweep's window is drained, not swept, also with its conversation mirrored", async () => {
    const id = await ackOnly("queue-old", 607);
    await mirror(607);
    await pastWindow(id);
    resetChatwootAdmissionForTest(1);
    const g = held();
    admitChatwootDelivery(-1n, () => g.gate, "meta");
    registerDeliverySweepHandler();
    await getJobHandler("DELIVERY_SWEEP")?.(
      { tenantId } as unknown as ClaimedJob,
      appDb,
    );
    // Admitted and waiting behind the busy slot, so the sweep that ran after it found it PENDING.
    const waiting = await rowById(id);
    expect(waiting.status).toBe("PENDING");
    expect(waiting.payload).not.toBeNull();
    g.release();
    const row = await settled(id);
    expect(row.status).toBe("PROCESSED");
    expect(row.attempts).toBe(0);
  });

  // A row whose processing throws before its claim stays PENDING with its body. Left in the query, the
  // same oldest rows would fill every pass and the rows behind them would age out unprocessed.
  test("a row that just failed here does not take the batch from the rows behind it", async () => {
    resetChatwootAdmissionForTest();
    const failing = await ackOnly("queue-fails", 611);
    const behind = await ackOnly("queue-behind", 612);
    admitChatwootDelivery(failing, async () => {
      throw new Error("fails before its claim");
    });
    for (let i = 0; i < 100 && chatwootAdmissionState().running > 0; i++)
      await sleep(5);
    expect((await rowById(failing)).status).toBe("PENDING");
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      batch: 1,
      maxPages: 1,
    });
    expect(r.admitted).toBe(1);
    expect((await settled(behind)).status).toBe("PROCESSED");
    expect((await rowById(failing)).status).toBe("PENDING");
    // The queue is reset between tests and this row would be drained by the next one.
    await suDb.chatwootWebhookDelivery.update({
      where: { id: failing },
      data: { status: "PROCESSED", payload: null },
    });
  });

  // A busy queue can hold an admitted row past the ceiling; it is asked again when its slot opens.
  test("a row that crosses the age ceiling while it waits is not processed", async () => {
    const id = await ackOnly("queue-crosses-ceiling", 613);
    await pastWindow(id, STORED_DELIVERY_MAX_AGE_MS - 300);
    resetChatwootAdmissionForTest(1);
    const g = held();
    admitChatwootDelivery(-1n, () => g.gate, "meta");
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
    });
    expect(r.admitted).toBe(1);
    await sleep(600);
    g.release();
    for (let i = 0; i < 100 && chatwootAdmissionState().running > 0; i++)
      await sleep(5);
    const row = await rowById(id);
    expect(row.status).toBe("PENDING");
    expect(row.attempts).toBe(0);
    expect(row.payload).toBeNull();
  });

  // ...and is still retried, with the room the others leave, on the very next pass.
  test("a row that failed here is retried on the next pass when the batch has room", async () => {
    resetChatwootAdmissionForTest();
    const failing = await ackOnly("queue-fails-once", 614);
    admitChatwootDelivery(failing, async () => {
      throw new Error("fails before its claim");
    });
    for (let i = 0; i < 100 && chatwootAdmissionState().running > 0; i++)
      await sleep(5);
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
    });
    expect(r.admitted).toBe(1);
    expect((await settled(failing)).status).toBe("PROCESSED");
  });

  // A row an older build wrote has no body. Its redelivery stores one while the row still owes its
  // first attempt, so a redelivery the full queue turned away (here: one nobody admitted) is drained.
  test("a bodyless legacy row gets its body from a redelivery and is drained from it", async () => {
    const legacy = await suDb.chatwootWebhookDelivery.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        deliveryId: "queue-legacy",
        event: "conversation_updated",
        status: "PENDING",
      },
    });
    const id = await ackOnly("queue-legacy", 610);
    expect(id).toBe(legacy.id);
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
    });
    expect(r.admitted).toBe(1);
    const row = await settled(id);
    expect(row.status).toBe("PROCESSED");
    expect(row.payload).toBeNull();
  });

  // The sweep leaves a PENDING row with a body to the drain, so a body the drain cannot read must not
  // stay: it is dropped and the row goes back to the sweep.
  test("a stored body that no longer normalizes is dropped, not kept", async () => {
    const id = await ackOnly("queue-garbled", 609);
    await suDb.chatwootWebhookDelivery.update({
      where: { id },
      data: { payload: "not json" },
    });
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
    });
    expect(r.admitted).toBe(0);
    const row = await rowById(id);
    expect(row.status).toBe("PENDING");
    expect(row.payload).toBeNull();
  });

  test("past the ceiling a stored body is cleared and the row is left to the sweep", async () => {
    const id = await ackOnly("queue-ceiling", 608);
    await pastWindow(id, STORED_DELIVERY_MAX_AGE_MS + 60_000);
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 60_000,
    });
    expect(r.admitted).toBe(0);
    expect(r.cleared).toBe(1);
    expect((await rowById(id)).payload).toBeNull();
  });

  // The periodic pass rides the sweep's own scheduler job: no second timer, and a stored row that no
  // boot drained (a replica that died while another kept serving) is processed within one interval.
  test("the delivery sweep's pass drains the stored rows before it sweeps", async () => {
    const id = await ackOnly("queue-sweep", 605);
    await suDb.chatwootWebhookDelivery.update({
      where: { id },
      data: { receivedAt: new Date(Date.now() - 2 * 60_000) },
    });
    registerDeliverySweepHandler();
    const handler = getJobHandler("DELIVERY_SWEEP");
    expect(handler).toBeDefined();
    await handler?.({ tenantId } as unknown as ClaimedJob, appDb);
    const row = await settled(id);
    expect(row.status).toBe("PROCESSED");
    expect(row.payload).toBeNull();
  });

  // A row can leave PENDING by a road that does not clear the body: the sweep's verdict on a row that
  // crossed its window between two passes, or an older release claiming it during a rolling deploy.
  test("a row that left PENDING without its claim clearing the body loses it on the next pass", async () => {
    const id = await ackOnly("queue-left", 606);
    await suDb.chatwootWebhookDelivery.update({
      where: { id },
      data: { status: "PROCESSED" },
    });
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 60_000,
    });
    expect(r.cleared).toBeGreaterThanOrEqual(1);
    const row = await rowById(id);
    expect(row.status).toBe("PROCESSED");
    expect(row.payload).toBeNull();
  });

  test("a stored row held by this process is not admitted a second time", async () => {
    resetChatwootAdmissionForTest(1);
    const g = held();
    // The only slot is busy, so the row waits in this process's queue.
    admitChatwootDelivery(-1n, () => g.gate, "meta");
    const id = await ackOnly("queue-held", 604);
    const first = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
    });
    const second = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
    });
    expect(first.admitted).toBe(1);
    expect(second.admitted).toBe(0);
    g.release();
    expect((await settled(id)).status).toBe("PROCESSED");
  });

  test("rows this process holds do not use up the batch that reaches a row nobody holds", async () => {
    resetChatwootAdmissionForTest(1);
    const g = held();
    admitChatwootDelivery(-1n, () => g.gate, "meta");
    const mine = await ackOnly("queue-held-batch-a", 605);
    const first = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      batch: 1,
    });
    expect(first.admitted).toBe(1);
    // The held row has the lower id: a one-row batch that still counted it would never reach this one.
    const orphan = await ackOnly("queue-held-batch-b", 606);
    const second = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 0,
      batch: 1,
    });
    expect(second.admitted).toBe(1);
    g.release();
    expect((await settled(mine)).status).toBe("PROCESSED");
    expect((await settled(orphan)).status).toBe("PROCESSED");
  });
});
