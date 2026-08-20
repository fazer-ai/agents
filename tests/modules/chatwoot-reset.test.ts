import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createHmac } from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId, getCheckpointer } from "@/graph/checkpointer";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
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

// Drives one incoming message through the receiver and the processor, exactly as a live delivery
// would. Defaults to the /reset this suite is named for.
async function sendReset(content = "/reset", convId = CONV_ID): Promise<void> {
  deliverySeq += 1;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: "message_created",
    id: 9000 + deliverySeq,
    content,
    message_type: "incoming",
    private: false,
    conversation: {
      id: convId,
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

    // The compacted memory of past attendances lives in its own table, not in the graph thread, so
    // deleting the thread alone would leave it behind — and the next compaction renders it back into
    // the thread's first message. A /reset that says "memória" and resurrects it is a lie.
    test("the compacted memory of past attendances is cleared too", async () => {
      await suDb.attendanceSummary.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 301,
          conversationId: 999,
          lastMessageId: "msg-abc",
          summary: "orçamento de R$ 250 aprovado",
          messageCount: 4,
          attendanceAt: new Date(),
        },
      });
      // A compaction armed on a resolve waits out a grace window, so at any moment there can be one
      // sitting in the queue holding this very conversation. Left armed it fires minutes later and
      // writes a fresh row: memory the operator explicitly deleted, back with no trace of where it
      // came from.
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "MEMORY_COMPACT",
          dedupeKey: contactInboxThreadId(tenantId, instanceId, 301),
          runAt: new Date(Date.now() + 600_000),
          status: "PENDING",
          payload: {},
        },
      });
      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      await sendReset();

      expect(
        await suDb.attendanceSummary.count({
          where: { tenantId, contactInboxId: 301 },
        }),
      ).toBe(0);
      const job = await suDb.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "MEMORY_COMPACT",
          dedupeKey: contactInboxThreadId(tenantId, instanceId, 301),
        },
      });
      // cancelPendingJob retires a row as DONE (its vocabulary for "this will not run").
      expect(job?.status).toBe("DONE");
    });

    // The checkpoint is the one piece of the memory that a compaction can RECREATE. Deleted outside
    // the lock the rewrite holds, the order that loses is: reset deletes the thread, the claimed job
    // finishes its rewrite and writes the checkpoint back — with the memory head in it — and reset
    // then takes the lock and deletes rows that no longer describe what the agent can see. The
    // operator is told the memory was cleared and the agent keeps answering from it.
    //
    // Held from another connection, the lock proves the ordering directly: while it is held, nothing
    // of the memory may be gone.
    test("the checkpoint is deleted under the lock, not before it", async () => {
      const threadId = contactInboxThreadId(tenantId, instanceId, 301);
      const cp = await getCheckpointer();
      await buildThreadStateGraph(cp).updateState(
        { configurable: { thread_id: threadId } },
        { messages: [new HumanMessage("orçamento de R$ 250 aprovado")] },
        THREAD_STATE_NODE,
      );
      const read = () => cp.get({ configurable: { thread_id: threadId } });
      expect(await read()).toBeTruthy();
      await suDb.attendanceSummary.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId: 301,
          conversationId: 998,
          lastMessageId: "msg-lock",
          summary: "orçamento aprovado",
          messageCount: 2,
          attendanceAt: new Date(),
        },
      });

      const cw = fakeChatwoot();
      globalThis.fetch = cw.impl;
      const survived: boolean[] = [];
      // Kept OUT of the transaction's return value on purpose: returning it would make Prisma await
      // the reset before committing, and the reset is waiting on the lock that commit releases.
      let running: Promise<void> = Promise.resolve();
      let resetFailed: unknown;
      // The memory step is the FIRST of the reset, so it blocks here almost immediately.
      await suDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ingest:${threadId}`})::bigint)`;
        running = sendReset().catch((err) => {
          resetFailed = err;
        });
        for (let i = 0; i < 12; i++) {
          await new Promise((r) => setTimeout(r, 50));
          survived.push(Boolean(await read()));
        }
      });
      await running;
      expect(resetFailed).toBeUndefined();

      expect(survived.every(Boolean)).toBe(true);
      expect(await read()).toBeUndefined();
      expect(
        await suDb.attendanceSummary.count({
          where: { tenantId, contactInboxId: 301 },
        }),
      ).toBe(0);
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

    // The test-mode gate's private note carries a one-shot watermark, and the note is the only thing
    // that tells whoever watches the inbox WHY the bot is silent and how to activate it. A note the
    // API refused was never delivered, so stamping it would spend that one shot on nothing.
    test("a test-mode notice the API refused does not spend its one shot", async () => {
      const convId = 43;
      const inbox = await suDb.inbox.findFirstOrThrow({
        where: { tenantId, chatwootInboxId: INBOX_ID },
        select: { id: true },
      });
      const row = await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: inbox.id,
          chatwootConversationId: convId,
          contactInboxId: 302,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${convId}`,
        },
        select: { id: true },
      });

      const failing = fakeChatwoot(/\/messages$/);
      globalThis.fetch = failing.impl;
      await sendReset("oi, tem alguém?", convId);
      expect(
        (
          await suDb.conversation.findUniqueOrThrow({
            where: { id: row.id },
            select: { testNoticeSentAt: true },
          })
        ).testNoticeSentAt,
      ).toBeNull();

      // Still owed: the next message delivers it, and only then is the shot spent.
      const healthy = fakeChatwoot();
      globalThis.fetch = healthy.impl;
      await sendReset("alguém aí?", convId);
      expect(
        (
          await suDb.conversation.findUniqueOrThrow({
            where: { id: row.id },
            select: { testNoticeSentAt: true },
          })
        ).testNoticeSentAt,
      ).not.toBeNull();
      expect(
        healthy.calls.filter(
          (c) => c.method === "POST" && c.path.endsWith("/messages"),
        ),
      ).toHaveLength(1);
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
