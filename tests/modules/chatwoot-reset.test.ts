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
import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";
import {
  processChatwootDelivery,
  receiveChatwootWebhook,
} from "@/modules/chatwoot/webhook";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { seedChatwootInstance } from "../utils/chatwoot";

// /reset drives real ChatwootClient calls (the command path builds its own client — no injectable
// factory reaches it), so the double here is `globalThis.fetch` shaped like a Chatwoot server.
//
// It AUTHENTICATES like one, which is the whole point: Chatwoot's AccessTokenAuthHelper leaves
// @access_token nil for a blank header and authenticate_access_token! renders 401 before any
// authorization runs. A stub that accepts any token is what let issue #79 ship — /reset built its
// client without a bot token, every bot-token call 401'd, and the customer was still told the
// conversation had been cleared.

const BOT_TOKEN = "BOT-TOKEN";
const ADMIN_TOKEN = "ADMIN-TOKEN";
const CONV_ID = 42;
const INBOX_ID = 7;
const KANBAN_TASK_ID = 55;

interface CwCall {
  method: string;
  path: string;
  token: string;
  body: unknown;
}

interface FakeChatwoot {
  calls: CwCall[];
  impl: typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// `failing` marks endpoints that answer 500 even with a valid token, so a test can drive a partial
// failure without going through the auth path.
function fakeChatwoot(failing: RegExp | null = null): FakeChatwoot {
  const calls: CwCall[] = [];
  const impl = (async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const token = new Headers(init?.headers).get(CHATWOOT_AUTH_HEADER) ?? "";
    const raw = init?.body;
    calls.push({
      method,
      path: url.pathname,
      token,
      body: typeof raw === "string" ? JSON.parse(raw) : null,
    });
    if (token.trim() === "") {
      return jsonResponse({ error: "Invalid Access Token" }, 401);
    }
    if (failing?.test(url.pathname))
      return jsonResponse({ error: "boom" }, 500);
    if (
      method === "GET" &&
      url.pathname.endsWith(`/conversations/${CONV_ID}`)
    ) {
      return jsonResponse({ id: CONV_ID, kanban_task: { id: KANBAN_TASK_ID } });
    }
    return jsonResponse({ id: 1 });
  }) as typeof fetch;
  return { calls, impl };
}

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

const SECRET = "reset-webhook-secret";
let tenantId = 0n;
let instanceId = 0n;
let routeToken = "";
let deliverySeq = 0;
const originalFetch = globalThis.fetch;

// Drives one /reset through the receiver and the processor, exactly as a live delivery would.
async function sendReset(): Promise<void> {
  deliverySeq += 1;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: "message_created",
    id: 9000 + deliverySeq,
    content: "/reset",
    message_type: "incoming",
    private: false,
    conversation: {
      id: CONV_ID,
      inbox_id: INBOX_ID,
      status: "pending",
      contact_inbox: { id: 301 },
      meta: { assignee_type: null, assignee: null },
    },
  });
  const r = await receiveChatwootWebhook({
    routeToken,
    rawBody: body,
    getHeader: (name: string) =>
      ({
        "x-chatwoot-signature": `sha256=${createHmac("sha256", SECRET)
          .update(`${nowSeconds}.${body}`)
          .digest("hex")}`,
        "x-chatwoot-timestamp": String(nowSeconds),
        "x-chatwoot-delivery": `reset-${deliverySeq}`,
      })[name.toLowerCase()] ?? null,
    nowSeconds,
    base: appDb,
  });
  await processChatwootDelivery({
    tenantId,
    instanceId: r.instanceId as bigint,
    deliveryRowId: r.deliveryRowId as bigint,
    agentBotId: r.agentBotId ?? null,
    normalized: r.normalized as NonNullable<typeof r.normalized>,
    base: appDb,
  });
}

const attributeCalls = (calls: CwCall[]) =>
  calls.filter((c) => c.path.endsWith("/custom_attributes"));
const ackCalls = (calls: CwCall[]) =>
  calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));

describe.skipIf(!dbUp)(
  "/reset clears through an authenticated bot client",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Reset", slug: `reset-${process.pid}` },
      });
      tenantId = t.id;
      const { token, hash } = generateRouteToken();
      routeToken = token;
      // TEST-NET-3 (RFC 5737, reserved for documentation) on the discard port: an IP literal keeps the
      // SSRF guard off DNS, and the address is public enough to pass its blocked-range check. Nothing is
      // dialed either way — globalThis.fetch is the double.
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 1,
        baseUrl: "https://203.0.113.10:9",
        adminToken: encryptJson(ADMIN_TOKEN),
      });
      instanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "x",
          mode: "test",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: INBOX_ID,
          name: "WhatsApp",
          agentId: agent.id,
        },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson(BOT_TOKEN),
          webhookSecret: encryptJson(SECRET),
          webhookRouteTokenHash: hash,
          name: "Atendente",
        },
      });
      // Test mode must already be ACTIVE for this conversation, or /reset defers to the silence gate.
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: inbox.id,
          chatwootConversationId: CONV_ID,
          contactInboxId: 301,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
          testActivatedAt: new Date(),
        },
      });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    afterAll(async () => {
      globalThis.fetch = originalFetch;
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    });

    test("the custom-attributes call carries the persona bot's token, so the clear lands", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const attrs = attributeCalls(cw.calls);
      expect(attrs).toHaveLength(1);
      // The defect: this token was "" and Chatwoot answered 401, so the attributes survived the reset.
      expect(attrs[0]?.token).toBe(BOT_TOKEN);
      expect(attrs[0]?.body).toEqual({ custom_attributes: {} });
    });

    test("a failed step does not skip the independent ones that follow it", async () => {
      const cw = fakeChatwoot(/\/custom_attributes$/);
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(attributeCalls(cw.calls)).toHaveLength(1);
      // Labels, attributes and the kanban card are independent cleanups. Sharing one try meant the
      // first failure swallowed the rest, and the card kept the previous episode's dates.
      expect(
        cw.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels")),
      ).toBe(true);
      expect(
        cw.calls.some(
          (c) =>
            c.method === "PATCH" &&
            c.path.endsWith(`/kanban/tasks/${KANBAN_TASK_ID}`),
        ),
      ).toBe(true);
    });

    test("a failure on the last remote step still leaves the local cleanups done", async () => {
      await suDb.conversation.update({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_ID,
          },
        },
        data: { testNoticeSentAt: new Date(), lastFollowUpAt: new Date() },
      });
      const cw = fakeChatwoot(/\/kanban\/tasks\//);
      globalThis.fetch = cw.impl;
      await sendReset();

      // The kanban card is the last Chatwoot call, but the watermark clear comes after it. Unguarded,
      // its failure would throw past everything below, including the ack.
      const conv = await suDb.conversation.findUniqueOrThrow({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: CONV_ID,
          },
        },
        select: { testNoticeSentAt: true, lastFollowUpAt: true },
      });
      expect(conv.testNoticeSentAt).toBeNull();
      expect(conv.lastFollowUpAt).toBeNull();
      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      expect(
        String((acks[0]?.body as { content?: unknown } | null)?.content ?? ""),
      ).toMatch(/kanban/i);
    });

    // Building the persona client reads the DB and resolves DNS through the SSRF guard, so it throws on
    // its own during an outage. Outside the best-effort boundary that abandoned the whole reset after
    // the memory had already been wiped, leaving no acknowledgement at all.
    test("a client that cannot even be built does not abandon the local cleanups", async () => {
      const other = await suDb.tenant.create({
        data: { name: "ResetBlocked", slug: `reset-blocked-${process.pid}` },
      });
      try {
        const { token, hash } = generateRouteToken();
        // http + loopback: refused by the SSRF guard before any request is attempted.
        const inst = await seedChatwootInstance(suDb, {
          tenantId: other.id,
          accountId: 1,
          baseUrl: "http://127.0.0.1:9",
          adminToken: encryptJson(ADMIN_TOKEN),
        });
        const agent = await suDb.agent.create({
          data: {
            tenantId: other.id,
            name: "Atendente",
            systemPrompt: "x",
            mode: "test",
          },
        });
        const inbox = await suDb.inbox.create({
          data: {
            tenantId: other.id,
            chatwootInstanceId: inst.id,
            chatwootInboxId: INBOX_ID,
            name: "WhatsApp",
            agentId: agent.id,
          },
        });
        await suDb.chatwootAgentBot.create({
          data: {
            tenantId: other.id,
            chatwootInstanceId: inst.id,
            agentId: agent.id,
            chatwootAgentBotId: 9,
            accessToken: encryptJson(BOT_TOKEN),
            webhookSecret: encryptJson(SECRET),
            webhookRouteTokenHash: hash,
            name: "Atendente",
          },
        });
        await suDb.conversation.create({
          data: {
            tenantId: other.id,
            chatwootInstanceId: inst.id,
            inboxId: inbox.id,
            chatwootConversationId: CONV_ID,
            contactInboxId: 302,
            status: "pending",
            threadId: `${other.id}:${inst.id}:${CONV_ID}`,
            testActivatedAt: new Date(),
            testNoticeSentAt: new Date(),
            lastFollowUpAt: new Date(),
          },
        });

        const cw = fakeChatwoot();
        globalThis.fetch = cw.impl;
        const nowSeconds = Math.floor(Date.now() / 1000);
        const body = JSON.stringify({
          event: "message_created",
          id: 9500,
          content: "/reset",
          message_type: "incoming",
          private: false,
          conversation: {
            id: CONV_ID,
            inbox_id: INBOX_ID,
            status: "pending",
            contact_inbox: { id: 302 },
            meta: { assignee_type: null, assignee: null },
          },
        });
        const r = await receiveChatwootWebhook({
          routeToken: token,
          rawBody: body,
          getHeader: (name: string) =>
            ({
              "x-chatwoot-signature": `sha256=${createHmac("sha256", SECRET)
                .update(`${nowSeconds}.${body}`)
                .digest("hex")}`,
              "x-chatwoot-timestamp": String(nowSeconds),
              "x-chatwoot-delivery": "reset-blocked",
            })[name.toLowerCase()] ?? null,
          nowSeconds,
          base: appDb,
        });
        await processChatwootDelivery({
          tenantId: other.id,
          instanceId: r.instanceId as bigint,
          deliveryRowId: r.deliveryRowId as bigint,
          agentBotId: r.agentBotId ?? null,
          normalized: r.normalized as NonNullable<typeof r.normalized>,
          base: appDb,
        });

        // Nothing could be sent (the ack shares the same blocked base URL), but the local slate is
        // still clean and the run reached the end instead of dying halfway.
        expect(cw.calls).toHaveLength(0);
        const conv = await suDb.conversation.findUniqueOrThrow({
          where: {
            tenantId_chatwootInstanceId_chatwootConversationId: {
              tenantId: other.id,
              chatwootInstanceId: inst.id,
              chatwootConversationId: CONV_ID,
            },
          },
          select: { testNoticeSentAt: true, lastFollowUpAt: true },
        });
        expect(conv.testNoticeSentAt).toBeNull();
        expect(conv.lastFollowUpAt).toBeNull();
      } finally {
        await suDb.tenant.delete({ where: { id: other.id } }).catch(() => {});
      }
    });

    test("a partial reset is not announced as a full one", async () => {
      const cw = fakeChatwoot(/\/custom_attributes$/);
      globalThis.fetch = cw.impl;
      await sendReset();

      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      const text = String(
        (acks[0]?.body as { content?: unknown } | null)?.content ?? "",
      );
      expect(text).not.toBe(
        "🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos.",
      );
      expect(text).toMatch(/atributos/i);
    });

    test("a clean reset still announces the full success", async () => {
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      const acks = ackCalls(cw.calls);
      expect(acks).toHaveLength(1);
      expect(
        String((acks[0]?.body as { content?: unknown } | null)?.content ?? ""),
      ).toBe(
        "🔄 Memória, preferência de áudio e etiquetas/atributos desta conversa foram limpos.",
      );
    });
  },
);
