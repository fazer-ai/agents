import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  invalidateRouteTokenCache,
  ROUTE_TOKEN_CACHE_TTL_MS,
  writeRouteTokenCache,
} from "@/modules/chatwoot/route-token-cache";
import {
  receiveChatwootWebhook,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import {
  generateRouteToken,
  hashRouteToken,
} from "@/modules/webhooks/inbound/route-token";
import { seedChatwootInstance } from "../utils/chatwoot";

// The ack writes the ledger row, payload included, and answers only after it committed: Chatwoot never
// resends a 2xx, so a process that dies after the 200 must leave a row behind. A write that fails is
// not a 2xx, so Chatwoot's own retry carries the event.

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

const SECRET = "durable-ack-secret";
const NOW = 1_700_000_000;
const sign = (ts: number, body: string, secret = SECRET) =>
  `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
const headersFrom = (h: Record<string, string>) => (name: string) =>
  h[name.toLowerCase()] ?? null;
const signedHeaders = (body: string, delivery: string, secret = SECRET) =>
  headersFrom({
    "x-chatwoot-signature": sign(NOW, body, secret),
    "x-chatwoot-timestamp": String(NOW),
    "x-chatwoot-delivery": delivery,
  });

// A client that cannot open a transaction, the way an exhausted pool (or a dead database) refuses one.
function refusing(message: string): PrismaClient {
  const c = {
    $transaction: () => {
      throw new Error(message);
    },
    $extends: () => c,
  };
  return c as unknown as PrismaClient;
}

// The real client, with every transaction it opens counted.
function counted(client: PrismaClient, onTx: () => void): PrismaClient {
  const wrap = (target: object): object =>
    new Proxy(target, {
      get(t, prop, recv) {
        if (prop === "$transaction") {
          const orig = Reflect.get(t, prop, recv) as (
            ...a: unknown[]
          ) => Promise<unknown>;
          return (...args: unknown[]) => {
            onTx();
            return orig.apply(t, args);
          };
        }
        if (prop === "$extends") {
          const orig = Reflect.get(t, prop, recv) as (
            ...a: unknown[]
          ) => object;
          return (...args: unknown[]) => wrap(orig.apply(t, args));
        }
        return Reflect.get(t, prop, recv);
      },
    });
  return wrap(client as unknown as object) as PrismaClient;
}

let tenantId = 0n;
let instanceId = 0n;
let routeToken = "";

const messageBody = (messageId: number, conversationId: number) =>
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
      meta: { assignee_type: null, assignee: null },
    },
  });

const rowOf = (deliveryId: string) =>
  suDb.chatwootWebhookDelivery.findMany({
    where: { chatwootInstanceId: instanceId, deliveryId },
  });

const warmCache = () =>
  writeRouteTokenCache(hashRouteToken(routeToken), {
    tenantId,
    instanceId,
    agentBotId: 9,
    webhookSecret: encryptJson(SECRET),
  });

describe.skipIf(!dbUp)("the Chatwoot ack is durable (issue #1121)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Durable ack", slug: `durable-ack-${process.pid}` },
    });
    tenantId = t.id;
    const { token, hash } = generateRouteToken();
    routeToken = token;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://durable-ack.example.com",
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
  });

  afterAll(async () => {
    invalidateRouteTokenCache();
    if (tenantId !== 0n) {
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
  });

  test("the ledger row, payload included, exists when the ack returns", async () => {
    invalidateRouteTokenCache();
    const body = messageBody(5001, 501);
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, "durable-1"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");

    const rows = await rowOf("durable-1");
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.status).toBe("PENDING");
    expect(row?.event).toBe("message_created");
    // The bytes Chatwoot sent: what a drain after a restart processes from, with no Chatwoot read.
    expect(row?.payload).toBe(body);
    expect(row?.inboundMessageId).toBe(5001);
    expect(row?.routeAgentBotId).toBe(9);
    expect(r.deliveryRowId).toBe(row?.id);
  });

  test("a write that fails is not acked: Chatwoot keeps the event and retries", async () => {
    warmCache();
    const body = messageBody(5002, 502);
    await expect(
      receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, "durable-fail"),
        nowSeconds: NOW,
        base: appDb,
        ackBase: refusing("the ack pool refused"),
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(await rowOf("durable-fail")).toHaveLength(0);

    // The retry, once the database answers again, is the delivery: one row.
    const retried = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, "durable-fail"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(retried.outcome).toBe("queued");
    expect(await rowOf("durable-fail")).toHaveLength(1);
    invalidateRouteTokenCache();
  });

  test("the ack writes through its own pool, not the one turns and ingest share", async () => {
    warmCache();
    const body = messageBody(5003, 503);
    let ackTx = 0;
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, "durable-own-pool"),
      nowSeconds: NOW,
      // Every connection of the shared pool is taken: any transaction on it fails.
      base: refusing("the shared pool is exhausted"),
      ackBase: counted(appDb, () => ackTx++),
    });
    expect(r.outcome).toBe("queued");
    expect(ackTx).toBeGreaterThan(0);
    expect(await rowOf("durable-own-pool")).toHaveLength(1);
    invalidateRouteTokenCache();
  });

  test("a redelivery of a settled delivery is acked and not dispatched again", async () => {
    invalidateRouteTokenCache();
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 504,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });
    const first = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, "durable-dup"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(first.dispatch).toBe(true);
    expect(
      await recordAndProcessChatwootDelivery({
        tenantId,
        instanceId,
        deliveryId: "durable-dup",
        agentBotId: 9,
        normalized: first.normalized as NonNullable<typeof first.normalized>,
        base: appDb,
      }),
    ).toBe("processed");

    const again = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, "durable-dup"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(again.outcome).toBe("queued");
    expect(again.dispatch).toBe(false);
    const rows = await rowOf("durable-dup");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("PROCESSED");
    // Settled, so the words leave the ledger with it.
    expect(rows[0]?.payload).toBeNull();
  });

  test("ten acks of one delivery id at once leave one row and all answer 2xx", async () => {
    invalidateRouteTokenCache();
    warmCache();
    const body = messageBody(5005, 505);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        receiveChatwootWebhook({
          routeToken,
          rawBody: body,
          getHeader: signedHeaders(body, "durable-race"),
          nowSeconds: NOW,
          base: appDb,
        }),
      ),
    );
    expect(results.every((r) => r.outcome === "queued")).toBe(true);
    const rows = await rowOf("durable-race");
    expect(rows).toHaveLength(1);
    expect(new Set(results.map((r) => String(r.deliveryRowId)))).toEqual(
      new Set([String(rows[0]?.id)]),
    );
    invalidateRouteTokenCache();
  });

  // The receipt's binding generation is read by the ack's own INSERT, from the payload's inbox when it
  // names one and from the conversation's mirrored inbox when it does not.
  test("the row carries the inbox's binding generation, by the payload's inbox or the conversation's", async () => {
    invalidateRouteTokenCache();
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 77,
        name: "generation",
        bindingGeneration: 3,
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: 577,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:577`,
        inboxId: inbox.id,
      },
    });
    const byInbox = JSON.stringify({
      event: "message_created",
      id: 5770,
      content: "oi",
      message_type: "incoming",
      private: false,
      conversation: { id: 578, inbox_id: 77, status: "pending" },
    });
    const byConversation = JSON.stringify({
      event: "conversation_updated",
      id: 577,
      status: "pending",
    });
    const unknown = JSON.stringify({
      event: "conversation_updated",
      id: 579,
      status: "pending",
    });
    for (const [body, id] of [
      [byInbox, "durable-gen-inbox"],
      [byConversation, "durable-gen-conv"],
      [unknown, "durable-gen-none"],
    ] as const) {
      const r = await receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, id),
        nowSeconds: NOW,
        base: appDb,
      });
      expect(r.outcome).toBe("queued");
    }
    expect((await rowOf("durable-gen-inbox"))[0]?.bindingGeneration).toBe(3);
    expect((await rowOf("durable-gen-conv"))[0]?.bindingGeneration).toBe(3);
    expect((await rowOf("durable-gen-none"))[0]?.bindingGeneration).toBeNull();
    const conv = await rowOf("durable-gen-conv");
    expect(conv[0]?.conversationId).toBe(577);
  });

  // Part 3 of the issue. Rule three of the cache ("a failed lookup closes the stale window") existed
  // because a 200 was a promise nothing durable backed; now the ack's own write is that backing, so a
  // refresh that cannot reach the shared pool no longer turns every ack into a 500.
  test("a stale entry keeps answering while its refresh fails, with one lookup between them", async () => {
    invalidateRouteTokenCache();
    writeRouteTokenCache(
      hashRouteToken(routeToken),
      {
        tenantId,
        instanceId,
        agentBotId: 9,
        webhookSecret: encryptJson(SECRET),
      },
      { now: Date.now() - ROUTE_TOKEN_CACHE_TTL_MS - 1 },
    );
    let lookups = 0;
    const failingLookups = counted(
      refusing("the shared pool is exhausted"),
      () => lookups++,
    );
    const ids = Array.from({ length: 6 }, (_, i) => `durable-stale-${i}`);
    for (const id of ids) {
      const body = messageBody(5100 + ids.indexOf(id), 510);
      const r = await receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, id),
        nowSeconds: NOW,
        base: failingLookups,
        ackBase: appDb,
      });
      expect(r.outcome).toBe("queued");
      // Let the refresh fired behind the ack fail before the next delivery arrives.
      await new Promise((r) => setTimeout(r, 5));
    }
    for (const id of ids) expect(await rowOf(id)).toHaveLength(1);
    // Not one lookup per delivery: a failing refresh backs off instead of being retried by each one.
    expect(lookups).toBe(1);

    // The secret is still the stale entry's: a wrong signature is the same 401 as before.
    const forged = messageBody(5199, 510);
    await expect(
      receiveChatwootWebhook({
        routeToken,
        rawBody: forged,
        getHeader: signedHeaders(forged, "durable-stale-forged", "wrong"),
        nowSeconds: NOW,
        base: failingLookups,
        ackBase: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(await rowOf("durable-stale-forged")).toHaveLength(0);
    invalidateRouteTokenCache();
  });

  test("an invalidated entry is never served stale, and nothing is written for it", async () => {
    warmCache();
    // The disconnect path retires the entry; the lookup that would re-resolve it fails.
    invalidateRouteTokenCache();
    const body = messageBody(5200, 520);
    await expect(
      receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, "durable-retired"),
        nowSeconds: NOW,
        base: refusing("the shared pool is exhausted"),
        ackBase: appDb,
      }),
    ).rejects.toThrow();
    expect(await rowOf("durable-retired")).toHaveLength(0);
  });
});
