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
import { encryptJson } from "@/api/lib/crypto";
import { drainInFlight, resetShutdownForTest } from "@/lib/shutdown";
import {
  ADMISSION_MAX_WAITING,
  admissionLaneOf,
  admitChatwootDelivery,
  chatwootAdmissionState,
  drainStoredChatwootDeliveries,
  resetChatwootAdmissionForTest,
  STORED_DELIVERY_MAX_AGE_MS,
} from "@/modules/chatwoot/delivery-queue";
import {
  registerDeliverySweepHandler,
  STALE_AFTER_MS,
} from "@/modules/chatwoot/delivery-sweep";
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
