import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  invalidateRouteTokenCache,
  writeRouteTokenCache,
} from "@/modules/chatwoot/route-token-cache";
import { receiveChatwootWebhook } from "@/modules/chatwoot/webhook";
import {
  generateRouteToken,
  hashRouteToken,
} from "@/modules/webhooks/inbound/route-token";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { outboundUrl } from "../utils/outbound";

// A WhatsApp session inbox's connection change reaches every bot route of the inbox and is applied
// inside the ack, ordered by the fork's `changed_at`: one `channel.connected` or `channel.disconnected`
// per edge of `open`, however many copies arrive and in whatever order (docs/chatwoot.md).

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

const SECRET = "inbox-connection-secret";
const NOW = Math.floor(Date.now() / 1000);
const RESPONDER = 21;
const OBSERVER = 22;
const sign = (body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(`${NOW}.${body}`).digest("hex")}`;

let tenantId = 0n;
let instanceId = 0n;
const tokens: Record<number, string> = {};
let seq = 0;

const at = (second: number) =>
  `2026-10-15T12:00:${String(second).padStart(2, "0")}.123456Z`;

function report(
  inbox: number,
  connection: string | null,
  previous: string | null,
  changedAt: string,
) {
  return JSON.stringify({
    event: "inbox_provider_connection_updated",
    account: { id: 1 },
    inbox: {
      id: inbox,
      name: "WhatsApp",
      channel_type: "Channel::Whatsapp",
      provider: "zapi",
    },
    provider_connection: connection === null ? {} : { connection },
    previous_connection: previous,
    changed_at: changedAt,
  });
}

function deliver(
  raw: string,
  opts: { bot?: number; ackBase?: PrismaClient } = {},
) {
  const delivery = `ic-${process.pid}-${++seq}`;
  return receiveChatwootWebhook({
    routeToken: tokens[opts.bot ?? RESPONDER] as string,
    rawBody: raw,
    getHeader: (name) =>
      ({
        "x-chatwoot-signature": sign(raw),
        "x-chatwoot-timestamp": String(NOW),
        "x-chatwoot-delivery": delivery,
      })[name.toLowerCase()] ?? null,
    nowSeconds: NOW,
    base: appDb,
    ackBase: opts.ackBase ?? appDb,
  });
}

async function eventsFor(chatwootInboxId: number) {
  const rows = await suDb.outboundWebhookDelivery.findMany({
    where: { tenantId },
    orderBy: { id: "asc" },
    select: { event: true, payload: true },
  });
  return rows
    .map((r) => ({
      event: r.event,
      data: (r.payload as { data: Record<string, unknown> }).data,
    }))
    .filter((r) => r.data.chatwoot_inbox_id === String(chatwootInboxId));
}

async function seedInbox(chatwootInboxId: number) {
  return suDb.inbox.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootInboxId,
      name: "WhatsApp",
      channelType: "Channel::Whatsapp",
      provider: "zapi",
    },
  });
}

describe.skipIf(!dbUp)("channel connection events", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "Inbox connection",
        slug: `inbox-connection-${process.pid}`,
      },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://inbox-connection.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    for (const bot of [RESPONDER, OBSERVER]) {
      const agent = await suDb.agent.create({
        data: { tenantId, name: `Agente ${bot}`, systemPrompt: "x" },
      });
      const { token, hash } = generateRouteToken();
      tokens[bot] = token;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: bot,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson(SECRET),
          webhookRouteTokenHash: hash,
          name: `Agente ${bot}`,
        },
      });
      writeRouteTokenCache(hashRouteToken(token), {
        tenantId,
        instanceId,
        agentBotId: bot,
        webhookSecret: encryptJson(SECRET),
      });
    }
    await suDb.webhookSubscription.create({
      data: {
        tenantId,
        url: outboundUrl("/channel"),
        events: ["channel.*"],
        enabled: true,
      },
    });
  });

  afterAll(async () => {
    invalidateRouteTokenCache();
    if (tenantId !== 0n) {
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
  });

  // The bug it catches: the event acked and dropped, or announced without the inbox it is about.
  test("a session coming online is one channel.connected naming the inbox", async () => {
    const inbox = await seedInbox(101);
    const r = await deliver(report(101, "open", "close", at(1)));

    expect(r.outcome).toBe("processed");
    expect(await eventsFor(101)).toEqual([
      {
        event: "channel.connected",
        data: {
          inbox_id: String(inbox.id),
          chatwoot_inbox_id: "101",
          provider: "zapi",
          connection: "open",
          previous_connection: "close",
          changed_at: at(1),
        },
      },
    ]);
    const stored = await suDb.inbox.findUniqueOrThrow({
      where: { id: inbox.id },
      select: { connection: true },
    });
    expect(stored.connection).toBe("open");
  });

  // The bug it catches: each bot route announcing the same change, so a subscriber sees it twice.
  test("the responder's and the observer's copies of one change announce it once", async () => {
    await seedInbox(102);
    const raw = report(102, "close", "open", at(2));
    const [a, b] = await Promise.all([
      deliver(raw, { bot: RESPONDER }),
      deliver(raw, { bot: OBSERVER }),
    ]);

    expect([a.outcome, b.outcome].sort()).toEqual(["ignored", "processed"]);
    expect((await eventsFor(102)).map((e) => e.event)).toEqual([
      "channel.disconnected",
    ]);
  });

  // The bug it catches: an older change delivered late flipping the state back and announcing an
  // edge that already happened.
  test("a change arriving after a newer one is dropped and does not move the state", async () => {
    await seedInbox(103);
    await deliver(report(103, "open", "close", at(10)));
    const late = await deliver(report(103, "close", "open", at(5)));
    await deliver(report(103, "close", "open", at(20)));

    expect(late.outcome).toBe("ignored");
    const events = await eventsFor(103);
    expect(events.map((e) => e.event)).toEqual([
      "channel.connected",
      "channel.disconnected",
    ]);
    expect(events[1]?.data.previous_connection).toBe("open");
  });

  // The bug it catches: every state change announced, so pairing (close, connecting, a new QR) reads
  // as the channel going up and down.
  test("a move between two states that are not open is stored and announces nothing", async () => {
    const inbox = await seedInbox(104);
    const stored = () =>
      suDb.inbox.findUniqueOrThrow({
        where: { id: inbox.id },
        select: { connection: true, connectionAt: true },
      });
    // Each state is read back after its own delivery, with the time the report carried.
    for (const [second, connection, previous] of [
      [1, "connecting", "close"],
      [2, "reconnecting", "connecting"],
      [3, null, "reconnecting"],
    ] as const) {
      await deliver(report(104, connection, previous, at(second)));
      const row = await stored();
      expect(row.connection).toBe(connection);
      expect(row.connectionAt?.toISOString()).toBe(
        new Date(at(second)).toISOString(),
      );
    }

    expect(await eventsFor(104)).toEqual([]);
  });

  // The bug it catches: the edge read off the body's previous value, which misses a drop when the
  // change in between was never delivered here.
  test("the edge is taken from the stored state once there is one", async () => {
    await seedInbox(105);
    await deliver(report(105, "open", "close", at(1)));
    await deliver(report(105, "close", "connecting", at(3)));

    const events = await eventsFor(105);
    expect(events.map((e) => e.event)).toEqual([
      "channel.connected",
      "channel.disconnected",
    ]);
    expect(events[1]?.data.previous_connection).toBe("open");
  });

  // The bug it catches: a write that failed acked as received, so Chatwoot never retries the change.
  test("a change that cannot be written is a 503, with nothing stored", async () => {
    const inbox = await seedInbox(106);
    const refusing = {
      $transaction: () => {
        throw new Error("the pool refused");
      },
      $extends: () => refusing,
    } as unknown as PrismaClient;

    await expect(
      deliver(report(106, "open", "close", at(1)), { ackBase: refusing }),
    ).rejects.toMatchObject({ statusCode: 503 });
    const stored = await suDb.inbox.findUniqueOrThrow({
      where: { id: inbox.id },
      select: { connectionAt: true },
    });
    expect(stored.connectionAt).toBeNull();
  });

  // The bug it catches: the general transaction budget, which waits on a held inbox lock past
  // Chatwoot's ~5s ack deadline instead of answering 503 for a retry.
  test("a held inbox lock answers 503 inside the ack deadline", async () => {
    const inbox = await seedInbox(108);
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked = () => {};
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = suDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM inboxes WHERE id = ${inbox.id} FOR UPDATE`;
        locked();
        await held;
      },
      { timeout: 20_000 },
    );
    await isLocked;
    const started = Date.now();
    try {
      await expect(
        deliver(report(108, "open", "close", at(1))),
      ).rejects.toMatchObject({ statusCode: 503 });
      expect(Date.now() - started).toBeLessThan(4_500);
    } finally {
      release();
      await holder;
    }
  }, 15_000);

  // The bug it catches: an inbox nobody mirrored here, or a body missing the time that orders it,
  // written or announced anyway.
  test("an unmirrored inbox and a body without changed_at are acked with nothing written", async () => {
    const unknown = await deliver(report(999, "open", "close", at(1)));
    await seedInbox(107);
    const shapeless = JSON.parse(report(107, "open", "close", at(1)));
    delete shapeless.changed_at;
    const malformed = await deliver(JSON.stringify(shapeless));

    expect(unknown.outcome).toBe("ignored");
    expect(malformed.outcome).toBe("ignored");
    expect(await eventsFor(999)).toEqual([]);
    expect(await eventsFor(107)).toEqual([]);
  });
});
