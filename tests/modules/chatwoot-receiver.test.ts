import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { mirrorChatwootEvent } from "@/modules/chatwoot/mirror";
import {
  normalizeChatwootEvent,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { ensureAgentBot } from "@/modules/chatwoot/provisioning";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import {
  outOfHoursGate,
  processChatwootDelivery,
  receiveChatwootWebhook,
} from "@/modules/chatwoot/webhook";
import {
  CHATWOOT_WEBHOOK_MOUNT,
  chatwootOutgoingUrl,
} from "@/modules/chatwoot/webhook-mount";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { seedChatwootInstance, withRunNamespace } from "../utils/chatwoot";

// ── mount constant + outgoing_url derivation (unit) ──
describe("chatwoot webhook mount", () => {
  test("the mount constant is the canonical receiver path", () => {
    expect(CHATWOOT_WEBHOOK_MOUNT).toBe("/api/v1/chatwoot/webhook");
  });
  test("outgoing_url derives from the mount constant; trailing slash trimmed", () => {
    expect(chatwootOutgoingUrl("http://localhost:3000", "tok")).toBe(
      "http://localhost:3000/api/v1/chatwoot/webhook/tok",
    );
    expect(chatwootOutgoingUrl("https://x/", "tok")).toBe(
      "https://x/api/v1/chatwoot/webhook/tok",
    );
  });
});

// ── reactive availability gate (unit) ──
describe("outOfHoursGate", () => {
  // Mon 09:00-17:00 UTC. 2024-01-08 is a Monday; 2024-01-07 a Sunday → fixed instants, no real clock.
  const HOURS = {
    windows: [{ day: 1, start: "09:00", end: "17:00" }],
    exceptions: [],
    timezone: "UTC",
  };
  const MON_MIDDAY = new Date("2024-01-08T12:00:00Z"); // open
  const MON_NIGHT = new Date("2024-01-08T20:00:00Z"); // closed
  const SUNDAY = new Date("2024-01-07T12:00:00Z"); // closed (no Sunday window)

  test("no schedule / empty windows → always on (never silenced)", () => {
    expect(outOfHoursGate(null, MON_NIGHT, false)).toEqual({
      silence: false,
      postNote: false,
    });
    expect(
      outOfHoursGate(
        { windows: [], exceptions: [], timezone: "UTC" },
        MON_NIGHT,
        false,
      ),
    ).toEqual({ silence: false, postNote: false });
  });

  test("inside the window → responds (no silence, no note)", () => {
    expect(outOfHoursGate(HOURS, MON_MIDDAY, false)).toEqual({
      silence: false,
      postNote: false,
    });
  });

  test("outside the window, notice not yet sent → silence + post the one-shot note", () => {
    expect(outOfHoursGate(HOURS, MON_NIGHT, false)).toEqual({
      silence: true,
      postNote: true,
    });
    expect(outOfHoursGate(HOURS, SUNDAY, false)).toEqual({
      silence: true,
      postNote: true,
    });
  });

  test("outside the window, notice already sent → silence WITHOUT re-posting (anti-spam)", () => {
    expect(outOfHoursGate(HOURS, MON_NIGHT, true)).toEqual({
      silence: true,
      postNote: false,
    });
  });
});

// ── attribution gate with bot identity (unit) ──
describe("shouldBotHandle with ourAgentBotId", () => {
  test("acts when unassigned or assigned to our own bot", () => {
    expect(
      shouldBotHandle(
        { assigneeType: null, status: "pending" },
        { ourAgentBotId: 9 },
      ),
    ).toBe(true);
    expect(
      shouldBotHandle(
        { assigneeType: "AgentBot", status: "pending", assigneeId: 9 },
        { ourAgentBotId: 9 },
      ),
    ).toBe(true);
  });
  test("stays silent when a DIFFERENT AgentBot owns the conversation", () => {
    expect(
      shouldBotHandle(
        { assigneeType: "AgentBot", status: "pending", assigneeId: 7 },
        { ourAgentBotId: 9 },
      ),
    ).toBe(false);
  });
  test("does not exclude when the assignee bot id is unknown", () => {
    expect(
      shouldBotHandle(
        { assigneeType: "AgentBot", status: "pending", assigneeId: null },
        { ourAgentBotId: 9 },
      ),
    ).toBe(true);
  });
  test("a human assignee still silences regardless of bot id", () => {
    expect(
      shouldBotHandle(
        { assigneeType: "User", status: "pending", assigneeId: 1 },
        { ourAgentBotId: 9 },
      ),
    ).toBe(false);
  });
});

// ── receiver pipeline (real DB) ──
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

const SECRET = "bot-webhook-secret";
const NOW = 1_700_000_000;
const sign = (ts: number, body: string) =>
  `sha256=${createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex")}`;
const headersFrom = (h: Record<string, string>) => (name: string) =>
  h[name.toLowerCase()] ?? null;
const signedHeaders = (body: string, ts = NOW, delivery = "uuid-1") =>
  headersFrom({
    "x-chatwoot-signature": sign(ts, body),
    "x-chatwoot-timestamp": String(ts),
    "x-chatwoot-delivery": delivery,
  });

let tenantId = 0n;
let instanceId = 0n;
let routeToken = "";

describe.skipIf(!dbUp)("chatwoot webhook receiver", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CW", slug: `cw-${process.pid}` },
    });
    tenantId = t.id;
    const { token, hash } = generateRouteToken();
    routeToken = token;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Atendente", systemPrompt: "x" },
    });
    // The route token now resolves a per-persona Agent Bot (id 9), not the instance.
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

  test("rejects an unknown route token with 401", async () => {
    await expect(
      receiveChatwootWebhook({
        routeToken: "not-a-real-token",
        rawBody: "{}",
        getHeader: () => null,
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("rejects an invalid HMAC signature with 401 (uniform)", async () => {
    const body = JSON.stringify({ event: "conversation_updated", id: 1 });
    await expect(
      receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: headersFrom({
          "x-chatwoot-signature": "sha256=deadbeef",
          "x-chatwoot-timestamp": String(NOW),
          "x-chatwoot-delivery": "uuid-bad",
        }),
        nowSeconds: NOW,
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  test("queues a signed event and processes it to PROCESSED", async () => {
    const body = JSON.stringify({
      event: "message_created",
      id: 1001,
      content: "olá",
      message_type: "incoming",
      private: false,
      conversation: {
        id: 42,
        inbox_id: 7,
        status: "pending",
        meta: { assignee_type: null, assignee: null },
      },
    });
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-ok"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");
    expect(r.tenantId).toBe(tenantId);
    expect(r.agentBotId).toBe(9);
    expect(r.normalized?.conversationId).toBe(42);

    const proc = await processChatwootDelivery({
      tenantId,
      instanceId: r.instanceId as bigint,
      deliveryRowId: r.deliveryRowId as bigint,
      agentBotId: r.agentBotId ?? null,
      normalized: r.normalized as NonNullable<typeof r.normalized>,
      base: appDb,
    });
    expect(proc).toBe("processed");

    const row = await suDb.chatwootWebhookDelivery.findUniqueOrThrow({
      where: { id: r.deliveryRowId as bigint },
    });
    expect(row.status).toBe("PROCESSED");
    expect(row.processedAt).not.toBeNull();
    expect(row.event).toBe("message_created");

    // Mirror: the conversation was upserted with status + inbox FK + thread key.
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 42 },
      include: { inbox: true },
    });
    expect(conv.status).toBe("pending");
    expect(conv.threadId).toBe(`${tenantId}:${instanceId}:42`);
    expect(conv.inbox?.chatwootInboxId).toBe(7);
  });

  test("is idempotent on the delivery UUID (duplicate, single row, safe reprocess)", async () => {
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 43,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 9 } },
    });
    const headers = signedHeaders(body, NOW, "uuid-dup");
    const first = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: headers,
      nowSeconds: NOW,
      base: appDb,
    });
    const second = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: headers,
      nowSeconds: NOW,
      base: appDb,
    });
    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("duplicate");
    expect(second.deliveryRowId).toBe(first.deliveryRowId as bigint);

    const count = await suDb.chatwootWebhookDelivery.count({
      where: { chatwootInstanceId: instanceId, deliveryId: "uuid-dup" },
    });
    expect(count).toBe(1);

    await processChatwootDelivery({
      tenantId,
      instanceId: first.instanceId as bigint,
      deliveryRowId: first.deliveryRowId as bigint,
      agentBotId: first.agentBotId ?? null,
      normalized: first.normalized as NonNullable<typeof first.normalized>,
      base: appDb,
    });
    expect(
      await processChatwootDelivery({
        tenantId,
        instanceId: first.instanceId as bigint,
        deliveryRowId: first.deliveryRowId as bigint,
        agentBotId: first.agentBotId ?? null,
        normalized: first.normalized as NonNullable<typeof first.normalized>,
        base: appDb,
      }),
    ).toBe("skipped");
  });

  test("ignores a payload with no event field", async () => {
    const body = JSON.stringify({ foo: 1 });
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-ign"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(r.outcome).toBe("ignored");
    expect(r.deliveryRowId).toBeUndefined();
  });

  test("issue #8: an inbound message during a human-owned period advances the handled watermark", async () => {
    // A customer message while a human owns the conversation (!act): the bot deliberately stays
    // silent, but the message must count as handled — otherwise the first debounce flush after the
    // human returns the conversation re-answers the whole human-era backlog.
    const body = JSON.stringify({
      event: "message_created",
      id: 2001,
      content: "isso está um absurdo!",
      message_type: "incoming",
      private: false,
      conversation: {
        id: 44,
        inbox_id: 7,
        status: "open",
        meta: { assignee_type: "User", assignee: { id: 5 } },
      },
    });
    const r = await receiveChatwootWebhook({
      routeToken,
      rawBody: body,
      getHeader: signedHeaders(body, NOW, "uuid-hmn"),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");
    const proc = await processChatwootDelivery({
      tenantId,
      instanceId: r.instanceId as bigint,
      deliveryRowId: r.deliveryRowId as bigint,
      agentBotId: r.agentBotId ?? null,
      normalized: r.normalized as NonNullable<typeof r.normalized>,
      base: appDb,
    });
    expect(proc).toBe("processed");
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 44 },
      select: { lastHandledMessageId: true },
    });
    expect(conv.lastHandledMessageId).toBe(2001);
  });

  // NOTE: End-to-end pin of the degraded-payload fallback (issue #27's second bug): a signed
  // message_created whose conversation snapshot carries NO meta must neither wipe the mirrored
  // human assignee nor read as bot-owned — the gate falls back to the mirror's effective state,
  // so the message takes the handled-skip path (watermark advances, no turn).
  test("a signed event without meta keeps the human owner and the gate stays closed", async () => {
    const deliver = async (body: string, uuid: string) => {
      const r = await receiveChatwootWebhook({
        routeToken,
        rawBody: body,
        getHeader: signedHeaders(body, NOW, uuid),
        nowSeconds: NOW,
        base: appDb,
      });
      expect(r.outcome).toBe("queued");
      const proc = await processChatwootDelivery({
        tenantId,
        instanceId: r.instanceId as bigint,
        deliveryRowId: r.deliveryRowId as bigint,
        agentBotId: r.agentBotId ?? null,
        normalized: r.normalized as NonNullable<typeof r.normalized>,
        base: appDb,
      });
      expect(proc).toBe("processed");
    };

    // A human owns conversation 46 (meta present).
    await deliver(
      JSON.stringify({
        event: "message_created",
        id: 2100,
        content: "quero falar com um atendente",
        message_type: "incoming",
        private: false,
        conversation: {
          id: 46,
          inbox_id: 7,
          status: "pending",
          meta: { assignee_type: "User", assignee: { id: 5, name: "Rita" } },
        },
      }),
      "uuid-degraded-1",
    );

    // Degraded snapshot: same conversation, NO meta at all.
    await deliver(
      JSON.stringify({
        event: "message_created",
        id: 2101,
        content: "alô?",
        message_type: "incoming",
        private: false,
        conversation: { id: 46, inbox_id: 7, status: "pending" },
      }),
      "uuid-degraded-2",
    );

    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 46 },
      select: {
        assigneeType: true,
        assigneeId: true,
        lastHandledMessageId: true,
      },
    });
    // Mirror guard: the stored human assignee survived the degraded event.
    expect(conv.assigneeType).toBe("User");
    expect(conv.assigneeId).toBe(5);
    // Gate: read the mirror's effective state → !act → handled-skip advances the watermark.
    expect(conv.lastHandledMessageId).toBe(2101);
  });
});

// ── provisioning ↔ receiver round trip (real DB, stubbed Chatwoot client) ──
describe.skipIf(!dbUp)("agent bot provisioning", () => {
  const PROV_SECRET = "provisioned-secret";

  test("creates the persona bot, persists the secret/token, and the receiver verifies with it", async () => {
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 2,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    const agent = await suDb.agent.create({
      data: { tenantId, name: "Vendas", systemPrompt: "x" },
    });

    const calls = {
      createAgentBot: [] as Array<{ name: string; outgoingUrl: string }>,
    };
    const stubClient = {
      createAgentBot: async (p: { name: string; outgoingUrl: string }) => {
        calls.createAgentBot.push(p);
        return { id: 55, access_token: "ACCESS_55", secret: PROV_SECRET };
      },
    } as unknown as ChatwootClient;

    // Lazy per-persona provisioning: mints the bot for (instance, agent), named after the persona.
    const bot = await ensureAgentBot(
      tenantId,
      inst.id,
      agent.id,
      "Vendas",
      stubClient,
      { base: appDb },
    );

    expect(bot.chatwootAgentBotId).toBe(55);
    expect(bot.accessToken).toBe("ACCESS_55");
    expect(calls.createAgentBot).toHaveLength(1);
    expect(calls.createAgentBot[0]?.name).toBe("Vendas");
    const outgoingUrl = calls.createAgentBot[0]?.outgoingUrl as string;
    expect(outgoingUrl).toMatch(
      /\/api\/v1\/chatwoot\/webhook\/[A-Za-z0-9_-]+$/,
    );

    // Persisted on the per-persona row: secret + token encrypted; route token only as its hash.
    const saved = await suDb.chatwootAgentBot.findFirstOrThrow({
      where: { chatwootInstanceId: inst.id, agentId: agent.id },
    });
    expect(saved.chatwootAgentBotId).toBe(55);
    expect(saved.name).toBe("Vendas");
    expect(decryptJson<string>(saved.webhookSecret)).toBe(PROV_SECRET);
    expect(decryptJson<string>(saved.accessToken)).toBe("ACCESS_55");

    // Round trip: a webhook signed with the provisioned secret, addressed to the token embedded in
    // the outgoing_url, resolves to THIS bot and verifies.
    const token = outgoingUrl.split("/").pop() as string;
    const body = JSON.stringify({
      event: "conversation_updated",
      id: 99,
      inbox_id: 7,
      status: "pending",
      meta: { assignee_type: "AgentBot", assignee: { id: 55 } },
    });
    const sig = `sha256=${createHmac("sha256", PROV_SECRET).update(`${NOW}.${body}`).digest("hex")}`;
    const r = await receiveChatwootWebhook({
      routeToken: token,
      rawBody: body,
      getHeader: headersFrom({
        "x-chatwoot-signature": sig,
        "x-chatwoot-timestamp": String(NOW),
        "x-chatwoot-delivery": "uuid-prov",
      }),
      nowSeconds: NOW,
      base: appDb,
    });
    expect(r.outcome).toBe("queued");
    expect(r.tenantId).toBe(tenantId);
    expect(r.instanceId).toBe(inst.id);
    expect(r.agentBotId).toBe(55);
  });

  test("is idempotent for an existing persona bot (returns it, no new bot)", async () => {
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
    });
    const agent = await suDb.agent.findFirstOrThrow({
      where: { tenantId, name: "Vendas" },
    });
    let created = 0;
    const stubClient = {
      // The bot still exists on Chatwoot → ensure reuses it, no new bot.
      listAgentBots: async () => [{ id: 55, name: "Vendas" }],
      createAgentBot: async () => {
        created += 1;
        return { id: 999, access_token: "x", secret: "y" };
      },
    } as unknown as ChatwootClient;
    const bot = await ensureAgentBot(
      tenantId,
      inst.id,
      agent.id,
      "Vendas",
      stubClient,
      { base: appDb },
    );
    // The first test already provisioned bot 55 for this (instance, agent); ensure reuses it.
    expect(bot.chatwootAgentBotId).toBe(55);
    expect(created).toBe(0);
  });

  test("re-provisions when the stored bot was deleted on Chatwoot", async () => {
    const inst = await suDb.chatwootInstance.findFirstOrThrow({
      where: { tenantId, accountId: 2 },
    });
    const agent = await suDb.agent.findFirstOrThrow({
      where: { tenantId, name: "Vendas" },
    });
    let created = 0;
    const stubClient = {
      // Bot 55 is GONE on Chatwoot (operator deleted it out-of-band) → ensure must re-provision.
      listAgentBots: async () => [],
      createAgentBot: async (p: { name: string; outgoingUrl: string }) => {
        created += 1;
        expect(p.name).toBe("Vendas");
        return { id: 56, access_token: "ACCESS_56", secret: "secret-56" };
      },
    } as unknown as ChatwootClient;
    const bot = await ensureAgentBot(
      tenantId,
      inst.id,
      agent.id,
      "Vendas",
      stubClient,
      { base: appDb },
    );
    expect(created).toBe(1);
    expect(bot.chatwootAgentBotId).toBe(56);
    // The SAME row was refreshed in place (unique on tenant+instance+agent), not duplicated.
    const rows = await suDb.chatwootAgentBot.findMany({
      where: { chatwootInstanceId: inst.id, agentId: agent.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chatwootAgentBotId).toBe(56);
    expect(decryptJson<string>(rows[0]?.accessToken as string)).toBe(
      "ACCESS_56",
    );
  });
});

// ── mirror sync (real DB) ──
describe.skipIf(!dbUp)("chatwoot mirror sync", () => {
  const ev = (
    over: Partial<NormalizedChatwootEvent>,
  ): NormalizedChatwootEvent => ({
    event: "conversation_updated",
    conversationId: 500,
    contactInboxId: null,
    inboxId: 7,
    status: "pending",
    assigneeType: null,
    assigneeId: null,
    assigneeName: null,
    contact: {
      id: 321,
      name: "Maria",
      email: null,
      phone: "+5511999",
      identifier: "ext-1",
    },
    inboxName: "Suporte",
    channel: "Channel::Api",
    lastActivityAt: 1000,
    ...over,
  });

  test("first event creates conversation + contact + inbox", async () => {
    const r = await mirrorChatwootEvent(tenantId, instanceId, ev({}), appDb);
    expect(r.applied).toBe(true);
    expect(r.prevAssigneeId).toBeNull();

    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 500 },
      include: { contact: true, inbox: true },
    });
    expect(conv.status).toBe("pending");
    expect(conv.contact?.name).toBe("Maria");
    expect(conv.contact?.phone).toBe("+5511999");
    expect(conv.inbox?.name).toBe("Suporte");
    expect(conv.inbox?.channelType).toBe("Channel::Api");
  });

  test("a newer event updates status/assignee", async () => {
    const r = await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        lastActivityAt: 2000,
        status: "open",
        assigneeId: 5,
        assigneeType: "User",
        assigneeName: "Maria Atendente",
      }),
      appDb,
    );
    expect(r.applied).toBe(true);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 500 },
    });
    expect(conv.status).toBe("open");
    expect(conv.assigneeId).toBe(5);
    expect(conv.assigneeType).toBe("User");
    // The human's display name is mirrored so the console shows it instead of "Human #id".
    expect(conv.assigneeName).toBe("Maria Atendente");
  });

  test("an older (out-of-order) event is skipped, no status regression", async () => {
    const r = await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({ lastActivityAt: 1500, status: "resolved", assigneeId: null }),
      appDb,
    );
    expect(r.applied).toBe(false);
    expect(r.prevAssigneeId).toBe(5); // saw the prior human assignee before deciding
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 500 },
    });
    expect(conv.status).toBe("open"); // not regressed to "resolved"
    expect(conv.assigneeId).toBe(5);
  });

  test("the same contact across conversations dedupes to one row", async () => {
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({ conversationId: 501, lastActivityAt: 3000 }),
      appDb,
    );
    const count = await suDb.contact.count({
      where: { tenantId, chatwootContactId: 321 },
    });
    expect(count).toBe(1);
  });

  test("contactInboxId is persisted from the payload and not wiped by a later event without it", async () => {
    // Create with the native ContactInbox id present.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({ conversationId: 520, contactInboxId: 9900, lastActivityAt: 6000 }),
      appDb,
    );
    let conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 520 },
    });
    expect(conv.contactInboxId).toBe(9900);
    // A later event WITHOUT the field must not clear the stored id (only sets when present).
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({ conversationId: 520, contactInboxId: null, lastActivityAt: 7000 }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 520 },
    });
    expect(conv.contactInboxId).toBe(9900);
  });

  test("an incoming message advances lastInboundAt; suppressInboundWatermark holds it back (command path)", async () => {
    const incoming = (lastActivityAt: number): NormalizedChatwootEvent =>
      ev({
        conversationId: 510,
        event: "message_created",
        message: {
          id: 1,
          content: "oi",
          messageType: "incoming",
          private: false,
        },
        lastActivityAt,
      });
    // A genuine incoming message anchors lastInboundAt.
    await mirrorChatwootEvent(tenantId, instanceId, incoming(4000), appDb);
    let conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 510 },
    });
    const firstInbound = conv.lastInboundAt;
    expect(firstInbound).not.toBeNull();
    // A later incoming message WITH suppression (an active /teste|/reset command): lastInboundAt stays
    // put — so the sweep won't see a fresh customer reply — while lastEventAt still advances.
    await mirrorChatwootEvent(tenantId, instanceId, incoming(5000), appDb, {
      suppressInboundWatermark: true,
    });
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 510 },
    });
    expect(conv.lastInboundAt?.getTime()).toBe(firstInbound?.getTime());
    expect(conv.lastEventAt?.getTime()).toBe(5000 * 1000);
  });

  test("custom attribute bags are mirrored, and a payload without them preserves the stored ones", async () => {
    const withBags = ev({
      conversationId: 530,
      lastActivityAt: 9000,
      customAttributes: { origem: "Instagram" },
      kanbanAttributes: { orcamento: 3200 },
      contact: {
        id: 322,
        name: "Joana",
        email: null,
        phone: null,
        identifier: null,
        customAttributes: { plano: "pro" },
      },
    });
    await mirrorChatwootEvent(tenantId, instanceId, withBags, appDb);
    let conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 530 },
      include: { contact: true },
    });
    expect(conv.customAttributes).toEqual({ origem: "Instagram" });
    expect(conv.kanbanAttributes).toEqual({ orcamento: 3200 });
    expect(conv.contact?.customAttributes).toEqual({ plano: "pro" });

    // NOTE: A later event that carries no bags (degraded payload) must NOT wipe what is stored.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 530,
        lastActivityAt: 9100,
        contact: {
          id: 322,
          name: "Joana",
          email: null,
          phone: null,
          identifier: null,
        },
      }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 530 },
      include: { contact: true },
    });
    expect(conv.customAttributes).toEqual({ origem: "Instagram" });
    expect(conv.kanbanAttributes).toEqual({ orcamento: 3200 });
    expect(conv.contact?.customAttributes).toEqual({ plano: "pro" });

    // NOTE: A newer event with a new bag REPLACES it wholesale (Chatwoot ships the whole hash).
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 530,
        lastActivityAt: 9200,
        customAttributes: { etapa: "proposta" },
      }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 530 },
      include: { contact: true },
    });
    expect(conv.customAttributes).toEqual({ etapa: "proposta" });

    // NOTE: An EXPLICIT {} is a real "the operator cleared everything", not a degraded payload:
    // unlike an absent bag it must clear the stored one, on all three scopes.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 530,
        lastActivityAt: 9300,
        customAttributes: {},
        kanbanAttributes: {},
        contact: {
          id: 322,
          name: "Joana",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: {},
        },
      }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 530 },
      include: { contact: true },
    });
    expect(conv.customAttributes).toEqual({});
    expect(conv.kanbanAttributes).toEqual({});
    expect(conv.contact?.customAttributes).toEqual({});
  });

  test("a stale event cannot roll back the mirrored contact attributes", async () => {
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 540,
        lastActivityAt: 9500,
        contact: {
          id: 324,
          name: "Rita",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "pro" },
        },
      }),
      appDb,
    );

    // NOTE: The contact upsert runs BEFORE the conversation's stale check (the conversation row
    // needs the contact id), so without the per-contact watermark this out-of-order delivery would
    // downgrade the stored plan even though the conversation update itself is skipped.
    const stale = await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 540,
        lastActivityAt: 9400,
        contact: {
          id: 324,
          name: "Rita",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "free" },
        },
      }),
      appDb,
    );
    expect(stale.applied).toBe(false);
    const contact = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 324 },
    });
    expect(contact.customAttributes).toEqual({ plano: "pro" });

    // NOTE: …and a genuinely newer delivery still gets through.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 540,
        lastActivityAt: 9600,
        contact: {
          id: 324,
          name: "Rita",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "enterprise" },
        },
      }),
      appDb,
    );
    const fresh = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 324 },
    });
    expect(fresh.customAttributes).toEqual({ plano: "enterprise" });

    // NOTE: An undated payload has no place in the order. Stamping it with OUR receipt time would
    // make it beat every real Chatwoot timestamp, so it must not displace a positioned snapshot.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 540,
        lastActivityAt: null,
        contact: {
          id: 324,
          name: "Rita",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "free" },
        },
      }),
      appDb,
    );
    const undated = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 324 },
    });
    expect(undated.customAttributes).toEqual({ plano: "enterprise" });
  });

  test("an undated payload still bootstraps a contact nothing has positioned yet", async () => {
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 550,
        lastActivityAt: null,
        contact: {
          id: 326,
          name: "Ana",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "trial" },
        },
      }),
      appDb,
    );
    const seeded = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 326 },
    });
    expect(seeded.customAttributes).toEqual({ plano: "trial" });
    // NOTE: …and the watermark stays null, so the first DATED event still takes over.
    expect(seeded.customAttributesAt).toBeNull();

    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 550,
        lastActivityAt: 9700,
        contact: {
          id: 326,
          name: "Ana",
          email: null,
          phone: null,
          identifier: null,
          customAttributes: { plano: "pro" },
        },
      }),
      appDb,
    );
    const dated = await suDb.contact.findFirstOrThrow({
      where: { tenantId, chatwootContactId: 326 },
    });
    expect(dated.customAttributes).toEqual({ plano: "pro" });
    expect(dated.customAttributesAt).not.toBeNull();
  });

  // NOTE: Same sentinel convention as the attribute bags right above: `undefined` = "this payload
  // said nothing about the assignee" (no meta) and must preserve the stored trio; an explicit null
  // = a real unassign carried by meta. Without the guard, any degraded event silently wipes an
  // 'AgentBot'/'User' — which is what made issue #27 intermittent.
  test("an event without meta preserves the stored assignee; meta with null assignee clears it", async () => {
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 560,
        lastActivityAt: 9800,
        assigneeType: "AgentBot",
        assigneeId: 9,
        assigneeName: "Bot",
      }),
      appDb,
    );

    // Degraded payload: the normalizer saw no meta, so the trio is undefined.
    const degraded = await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 560,
        lastActivityAt: 9900,
        assigneeType: undefined,
        assigneeId: undefined,
        assigneeName: undefined,
      }),
      appDb,
    );
    expect(degraded.applied).toBe(true);
    let conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 560 },
    });
    expect(conv.assigneeType).toBe("AgentBot");
    expect(conv.assigneeId).toBe(9);
    expect(conv.assigneeName).toBe("Bot");
    // The mirror result reports the EFFECTIVE state (what is stored), not the payload's silence.
    expect(degraded.assigneeType).toBe("AgentBot");
    expect(degraded.assigneeId).toBe(9);

    // Meta present with no assignee = a real unassign; it must still clear.
    await mirrorChatwootEvent(
      tenantId,
      instanceId,
      ev({
        conversationId: 560,
        lastActivityAt: 10000,
        assigneeType: null,
        assigneeId: null,
        assigneeName: null,
      }),
      appDb,
    );
    conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: 560 },
    });
    expect(conv.assigneeType).toBeNull();
    expect(conv.assigneeId).toBeNull();
    expect(conv.assigneeName).toBeNull();
  });

  test("normalize: a payload without meta leaves the assignee trio undefined; meta without assignee yields null", () => {
    const noMeta = normalizeChatwootEvent({
      event: "conversation_updated",
      id: 561,
      status: "pending",
    });
    expect(noMeta?.assigneeType).toBeUndefined();
    expect(noMeta?.assigneeId).toBeUndefined();
    expect(noMeta?.assigneeName).toBeUndefined();

    const unassigned = normalizeChatwootEvent({
      event: "conversation_updated",
      id: 561,
      status: "pending",
      meta: { assignee_type: null, assignee: null },
    });
    expect(unassigned?.assigneeType).toBeNull();
    expect(unassigned?.assigneeId).toBeNull();
    expect(unassigned?.assigneeName).toBeNull();
  });
});

// ── loadChatwootClient (real DB) ──
describe.skipIf(!dbUp)("loadChatwootClient", () => {
  test("decrypts the admin token; bot token is admin-only by default and overridable", async () => {
    const capture = async () => {
      let captured: ConstructorParameters<typeof ChatwootClient>[0] | null =
        null;
      return {
        get: () => captured,
        makeClient: async (
          cfg: ConstructorParameters<typeof ChatwootClient>[0],
        ) => {
          captured = cfg;
          return {} as ChatwootClient;
        },
      };
    };

    // Default: admin token decrypted, bot token empty (the persona bot token is passed by the
    // posting paths, not read from the instance).
    const a = await capture();
    await loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      makeClient: a.makeClient,
    });
    const cfgA = a.get() as unknown as ConstructorParameters<
      typeof ChatwootClient
    >[0];
    expect(cfgA.baseUrl).toBe(withRunNamespace("https://chat.example.com"));
    expect(cfgA.accountId).toBe(1);
    expect(cfgA.adminToken).toBe("ADMIN");
    expect(cfgA.botToken).toBe("");

    // Override: a posting path supplies the persona bot token.
    const b = await capture();
    await loadChatwootClient(tenantId, instanceId, {
      base: appDb,
      makeClient: b.makeClient,
      botToken: "PERSONA_BOT",
    });
    const cfgB = b.get() as unknown as ConstructorParameters<
      typeof ChatwootClient
    >[0];
    expect(cfgB.botToken).toBe("PERSONA_BOT");
  });
});

// Module-scope teardown: runs after BOTH describes so the provisioning suite still has the
// tenant and live connections that the receiver suite's beforeAll created.
afterAll(async () => {
  if (!dbUp) return;
  if (tenantId) {
    for (const table of [
      "chatwoot_webhook_deliveries",
      "conversations",
      "contacts",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "chatwoot_instances",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
      );
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
  }
  await suDb.$disconnect();
  await appDb.$disconnect();
});
