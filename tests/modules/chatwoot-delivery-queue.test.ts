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
  admitChatwootDelivery,
  chatwootAdmissionState,
  drainStoredChatwootDeliveries,
  resetChatwootAdmissionForTest,
  STORED_DELIVERY_STALE_MS,
} from "@/modules/chatwoot/delivery-queue";
import {
  registerDeliverySweepHandler,
  STALE_AFTER_MS,
} from "@/modules/chatwoot/delivery-sweep";
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

// Restated in the queue to keep the sweep's handler free of a load-time cycle; one number all the same.
test("the drain hands over to the sweep at the sweep's own threshold", () => {
  expect(STORED_DELIVERY_STALE_MS).toBe(STALE_AFTER_MS);
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

  // Past the sweep's window the row is the sweep's (DEAD and a recovery), so the drain does not race
  // it; it only takes the words off a row that will not be processed from them.
  test("a row past the sweep's window is not drained, and its payload is cleared", async () => {
    const id = await ackOnly("queue-old", 603);
    await suDb.chatwootWebhookDelivery.update({
      where: { id },
      data: {
        receivedAt: new Date(Date.now() - STORED_DELIVERY_STALE_MS - 60_000),
      },
    });
    const r = await drainStoredChatwootDeliveries({
      base: appDb,
      tenantId,
      minAgeMs: 60_000,
    });
    expect(r.admitted).toBe(0);
    expect(r.cleared).toBe(1);
    const row = await rowById(id);
    expect(row.status).toBe("PENDING");
    expect(row.payload).toBeNull();
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

  test("a stored row held by this process is not admitted a second time", async () => {
    resetChatwootAdmissionForTest(1);
    const g = held();
    // The only slot is busy, so the row waits in this process's queue.
    admitChatwootDelivery(-1n, () => g.gate);
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
});
