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
import {
  endsTestPark,
  type TestPark,
  testParkHolds,
} from "@/modules/agents/test-mode";
import { CHATWOOT_AUTH_HEADER } from "@/modules/chatwoot/constants";
import { reconcileMirrorFromLive } from "@/modules/chatwoot/reconcile";
import {
  receiveChatwootWebhook,
  recordAndProcessChatwootDelivery,
} from "@/modules/chatwoot/webhook";
import { generateRouteToken } from "@/modules/webhooks/inbound/route-token";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";

// A test-mode agent bound to an inbox a team already answers: Chatwoot starts every conversation
// there `pending` (set_active_bot_conversation), the tab the team does not watch, and the silenced
// agent never answers it. These drive real deliveries through the receiver against a Chatwoot double
// that keeps the conversation's state the way the fork does: a bot's `open` with `expected_status`
// is refused with 409 once the status moved, an `open` runs the inbox's auto-assignment in the same
// save, and the bot assignment of a hand-back puts it back to `pending`.

const PARKED = new Date("2026-11-07T12:00:00Z");

describe("endsTestPark", () => {
  const park = (parkedAssigneeId: number | null): TestPark => ({
    parkedAt: PARKED,
    parkedAssigneeId,
  });
  const cases: Array<
    [string, TestPark, string | null, number | null, boolean]
  > = [
    ["a person other than the park's own", park(null), "User", 5, true],
    ["another person than the auto-assigned one", park(5), "User", 6, true],
    ["the person the park itself got", park(5), "User", 5, false],
    ["nobody", park(5), null, null, false],
    ["a bot", park(null), "AgentBot", 9, false],
    [
      "anything, when nothing was parked",
      { parkedAt: null, parkedAssigneeId: null },
      "User",
      5,
      false,
    ],
  ];
  for (const [name, p, type, id, expected] of cases) {
    test(`${name} → ${expected}`, () => {
      expect(endsTestPark(p, { assigneeType: type, assigneeId: id })).toBe(
        expected,
      );
    });
  }
});

describe("testParkHolds", () => {
  const park: TestPark = { parkedAt: PARKED, parkedAssigneeId: 5 };
  const cases: Array<
    [string, TestPark, string, string | null, number | null, boolean]
  > = [
    ["open and nobody holds it", park, "open", null, null, true],
    ["open and held by the park's own person", park, "open", "User", 5, true],
    ["open and held by somebody else", park, "open", "User", 6, false],
    ["held by another bot", park, "open", "AgentBot", 3, false],
    ["no longer open", park, "resolved", null, null, false],
    ["already back to pending", park, "pending", null, null, false],
    [
      "never parked",
      { parkedAt: null, parkedAssigneeId: null },
      "open",
      null,
      null,
      false,
    ],
  ];
  for (const [name, p, status, type, id, expected] of cases) {
    test(`${name} → ${expected}`, () => {
      expect(
        testParkHolds(p, { status, assigneeType: type, assigneeId: id }),
      ).toBe(expected);
    });
  }
});

const BOT_TOKEN = "PARK-BOT-TOKEN";
const ADMIN_TOKEN = "PARK-ADMIN-TOKEN";
const BOT_ID = 9;
const INBOX_ID = 7;
const SECRET = "park-webhook-secret";
// Who the inbox's auto-assignment picks when the conversation opens.
const AUTO_AGENT = 55;

interface CwCall {
  method: string;
  path: string;
  token: string;
  body: Record<string, unknown> | null;
}

interface LiveConv {
  status: string;
  assigneeType: string | null;
  assigneeId: number | null;
  // The conversation's inbox, when it is not the test agent's main one.
  inboxId?: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fakeChatwoot(
  conversations: Map<number, LiveConv>,
  opts: {
    autoAssign?: boolean;
    // Runs before a live read answers, for whatever happened in Chatwoot (and reached the mirror)
    // while the caller was on its way to that read.
    beforeRead?: (convId: number) => Promise<void>;
  } = {},
) {
  const calls: CwCall[] = [];
  const impl = (async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const token = new Headers(init?.headers).get(CHATWOOT_AUTH_HEADER) ?? "";
    const raw = init?.body;
    const body = typeof raw === "string" ? JSON.parse(raw) : null;
    calls.push({ method, path: url.pathname, token, body });
    if (token.trim() === "") {
      return jsonResponse({ error: "Invalid Access Token" }, 401);
    }
    const m = url.pathname.match(/\/conversations\/(\d+)(\/[a-z_]+)?$/);
    const conv = m ? conversations.get(Number(m[1])) : undefined;
    if (m && conv) {
      const action = m[2] ?? "";
      if (method === "GET" && action === "") {
        await opts.beforeRead?.(Number(m[1]));
        return jsonResponse({
          id: Number(m[1]),
          inbox_id: conv.inboxId ?? INBOX_ID,
          status: conv.status,
          meta:
            conv.assigneeType === null
              ? { assignee_type: null, assignee: null }
              : {
                  assignee_type: conv.assigneeType,
                  assignee: { id: conv.assigneeId, type: conv.assigneeType },
                },
        });
      }
      if (method === "POST" && action === "/toggle_status") {
        if (
          body?.expected_status !== undefined &&
          body.expected_status !== conv.status
        ) {
          return jsonResponse(
            {
              error: "conversation status changed",
              current_status: conv.status,
            },
            409,
          );
        }
        conv.status = String(body?.status);
        if (conv.status === "open") {
          conv.assigneeType = opts.autoAssign ? "User" : null;
          conv.assigneeId = opts.autoAssign ? AUTO_AGENT : null;
        }
        return jsonResponse({ payload: { success: true } });
      }
      if (method === "POST" && action === "/assignments") {
        if (body?.assignee_type === "AgentBot") {
          conv.status = "pending";
          conv.assigneeType = "AgentBot";
          conv.assigneeId = Number(body.assignee_id);
          return jsonResponse({
            id: body.assignee_id,
            name: "Bot",
            bot_type: "webhook",
          });
        }
        conv.assigneeType = null;
        conv.assigneeId = null;
        return jsonResponse({});
      }
    }
    if (
      method === "GET" &&
      url.pathname.endsWith(`/inboxes/${INBOX_ID}/agent_bot`)
    ) {
      return jsonResponse({ agent_bot: { id: BOT_ID } });
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;
let inboxRowId = 0n;
let contactRowId = 0n;
let routeToken = "";
let deliverySeq = 0;
let nextConvId = 100;
const originalFetch = globalThis.fetch;

async function deliver(
  convId: number,
  content: string,
  live: LiveConv,
): Promise<void> {
  deliverySeq += 1;
  await send({
    event: "message_created",
    id: 7000 + deliverySeq,
    content,
    message_type: "incoming",
    private: false,
    conversation: conversationPayload(convId, live),
  });
}

function conversationPayload(convId: number, live: LiveConv) {
  return {
    id: convId,
    inbox_id: live.inboxId ?? INBOX_ID,
    status: live.status,
    contact_inbox: { id: 400 + convId },
    meta:
      live.assigneeType === null
        ? { assignee_type: null, assignee: null }
        : {
            assignee_type: live.assigneeType,
            assignee: { id: live.assigneeId, type: live.assigneeType },
          },
  };
}

// The event Chatwoot sends when a person is assigned or unassigned: the conversation itself, with
// the version that orders it after everything the mirror already holds.
async function deliverAssignment(convId: number, live: LiveConv) {
  deliverySeq += 1;
  await send({
    event: "conversation_updated",
    ...conversationPayload(convId, live),
    updated_at: Date.now() / 1000 + deliverySeq,
    changed_attributes: [{ assignee_id: {} }],
  });
}

async function send(payload: Record<string, unknown>): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = JSON.stringify(payload);
  const r = await receiveChatwootWebhook({
    routeToken,
    rawBody: body,
    getHeader: (name: string) =>
      ({
        "x-chatwoot-signature": `sha256=${createHmac("sha256", SECRET)
          .update(`${nowSeconds}.${body}`)
          .digest("hex")}`,
        "x-chatwoot-timestamp": String(nowSeconds),
        "x-chatwoot-delivery": `park-${process.pid}-${deliverySeq}`,
      })[name.toLowerCase()] ?? null,
    nowSeconds,
    base: appDb,
  });
  await recordAndProcessChatwootDelivery({
    tenantId,
    instanceId: r.instanceId as bigint,
    deliveryId: r.deliveryId as string,
    agentBotId: r.agentBotId ?? null,
    normalized: r.normalized as NonNullable<typeof r.normalized>,
    base: appDb,
  });
}

const WIDGET_INBOX_ID = 8;

// A conversation of the test agent's inbox, never activated, in the state Chatwoot created it.
async function seedConversation(
  extra: Record<string, unknown> = {},
): Promise<number> {
  nextConvId += 1;
  const convId = nextConvId;
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxRowId,
      contactId: contactRowId,
      chatwootConversationId: convId,
      contactInboxId: 400 + convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      ...extra,
    },
  });
  return convId;
}

const rowOf = (convId: number) =>
  suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: {
      status: true,
      assigneeType: true,
      assigneeId: true,
      testActivatedAt: true,
      testParkedOpenAt: true,
      testParkedAssigneeId: true,
    },
  });

const toggles = (calls: CwCall[], convId: number) =>
  calls.filter(
    (c) =>
      c.method === "POST" &&
      c.path.endsWith(`/conversations/${convId}/toggle_status`),
  );
const handBacks = (calls: CwCall[], convId: number) =>
  calls.filter(
    (c) =>
      c.method === "POST" &&
      c.path.endsWith(`/conversations/${convId}/assignments`),
  );
const posts = (calls: CwCall[], convId: number) =>
  calls.filter(
    (c) =>
      c.method === "POST" &&
      c.path.endsWith(`/conversations/${convId}/messages`),
  );
const textOf = (c: CwCall) => String(c.body?.content ?? "");

describe.skipIf(!dbUp)(
  "a test-mode agent parks its silenced conversations open",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Park", slug: `park-${process.pid}` },
      });
      tenantId = t.id;
      const { token, hash } = generateRouteToken();
      routeToken = token;
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
          // NOTE: runnable, so the hand-back of /teste has an agent to hand the conversation to.
          modelConfig: {
            provider: "openai-compatible",
            model: "local",
            baseURL: "https://llm.example.invalid/v1",
          },
        },
      });
      agentId = agent.id;
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: INBOX_ID,
          name: "WhatsApp",
          agentId: agent.id,
        },
      });
      inboxRowId = inbox.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: BOT_ID,
          accessToken: encryptJson(BOT_TOKEN),
          webhookSecret: encryptJson(SECRET),
          webhookRouteTokenHash: hash,
          name: "Atendente",
        },
      });
      const contact = await suDb.contact.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootContactId: 909,
          name: "Cliente",
        },
      });
      contactRowId = contact.id;
    });

    afterEach(async () => {
      globalThis.fetch = originalFetch;
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "test", enabled: true, settings: {} },
      });
    });

    afterAll(async () => {
      globalThis.fetch = originalFetch;
      if (!dbUp) return;
      await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    });

    test("a silenced conversation opens for the team, once, and the agent says nothing", async () => {
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live, { autoAssign: true });
      globalThis.fetch = cw.impl;

      await deliver(convId, "oi, quero um orçamento", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });

      // One conditional toggle, as the persona: the bot's `open` is Chatwoot's handoff, the write that
      // notifies the inbox's members and runs its auto-assignment.
      expect(toggles(cw.calls, convId).map((c) => [c.token, c.body])).toEqual([
        [BOT_TOKEN, { status: "open", expected_status: "pending" }],
      ]);
      expect(live.get(convId)?.status).toBe("open");
      // Nothing reaches the customer: the only post is the operator's private note, and it says the
      // conversation went to the team.
      const out = posts(cw.calls, convId);
      expect(out.every((c) => c.body?.private === true)).toBe(true);
      expect(out.map(textOf).join(" ")).toContain("aberta para a equipe");
      // The park is recorded with who Chatwoot assigned it to in that same write.
      const row = await rowOf(convId);
      expect(row.testParkedOpenAt).not.toBeNull();
      expect(row.testParkedAssigneeId).toBe(AUTO_AGENT);
      expect(row.testActivatedAt).toBeNull();

      // The next message finds it open (the payload says so) and nothing moves it again.
      await deliver(convId, "alguém aí?", {
        status: "open",
        assigneeType: "User",
        assigneeId: AUTO_AGENT,
      });
      expect(toggles(cw.calls, convId)).toHaveLength(1);
      expect(live.get(convId)?.status).toBe("open");
    });

    test("a production agent leaves its conversations pending, for itself", async () => {
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production", enabled: false },
      });
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live);
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      expect(toggles(cw.calls, convId)).toHaveLength(0);
      expect((await rowOf(convId)).testParkedOpenAt).toBeNull();
    });

    test("an activated test conversation stays with the agent", async () => {
      await suDb.agent.update({
        where: { id: agentId },
        data: { enabled: false },
      });
      const convId = await seedConversation({ testActivatedAt: new Date() });
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live);
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      expect(toggles(cw.calls, convId)).toHaveLength(0);
    });

    test("a toggle Chatwoot refuses records no park", async () => {
      const convId = await seedConversation();
      // Chatwoot has already moved it (a person resolved it) while the mirror still says pending.
      const live = new Map<number, LiveConv>([
        [convId, { status: "resolved", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live);
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      expect(toggles(cw.calls, convId)).toHaveLength(1);
      expect(live.get(convId)?.status).toBe("resolved");
      expect((await rowOf(convId)).testParkedOpenAt).toBeNull();
    });

    test("/teste on a parked conversation gives it back to the agent, with no /reset", async () => {
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live, { autoAssign: true });
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      expect(live.get(convId)).toEqual({
        status: "open",
        assigneeType: "User",
        assigneeId: AUTO_AGENT,
      });

      await deliver(convId, "/teste", {
        status: "open",
        assigneeType: "User",
        assigneeId: AUTO_AGENT,
      });

      // Back to `pending` and the bot, in Chatwoot and in the mirror.
      expect(handBacks(cw.calls, convId).map((c) => c.body)).toEqual([
        { assignee_id: BOT_ID, assignee_type: "AgentBot" },
      ]);
      expect(live.get(convId)).toEqual({
        status: "pending",
        assigneeType: "AgentBot",
        assigneeId: BOT_ID,
      });
      const row = await rowOf(convId);
      expect(row.status).toBe("pending");
      expect(row.testActivatedAt).not.toBeNull();
      expect(row.testParkedOpenAt).toBeNull();
      // The acknowledgement is the plain one, public, with nothing about /reset.
      const ack = posts(cw.calls, convId).filter((c) =>
        textOf(c).includes("Modo teste ativado"),
      );
      expect(ack.map(textOf)).toEqual([
        "🧪 Modo teste ativado para esta conversa.",
      ]);
      expect(ack[0]?.body?.private).not.toBe(true);
    });

    test("/teste leaves a parked conversation that a person took since", async () => {
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live);
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      // A person picks it up, and the mirror hears it from Chatwoot's own event.
      live.set(convId, {
        status: "open",
        assigneeType: "User",
        assigneeId: 61,
      });
      await deliverAssignment(convId, {
        status: "open",
        assigneeType: "User",
        assigneeId: 61,
      });
      expect((await rowOf(convId)).testParkedOpenAt).toBeNull();

      await deliver(convId, "/teste", {
        status: "open",
        assigneeType: "User",
        assigneeId: 61,
      });
      expect(handBacks(cw.calls, convId)).toHaveLength(0);
      expect(live.get(convId)).toEqual({
        status: "open",
        assigneeType: "User",
        assigneeId: 61,
      });
      expect(posts(cw.calls, convId).map(textOf).join(" ")).toContain("/reset");
    });

    test("/teste leaves a parked conversation a person took and let go of", async () => {
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live);
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      live.set(convId, {
        status: "open",
        assigneeType: "User",
        assigneeId: 61,
      });
      await deliverAssignment(convId, {
        status: "open",
        assigneeType: "User",
        assigneeId: 61,
      });
      live.set(convId, {
        status: "open",
        assigneeType: null,
        assigneeId: null,
      });
      await deliverAssignment(convId, {
        status: "open",
        assigneeType: null,
        assigneeId: null,
      });
      await deliver(convId, "/teste", {
        status: "open",
        assigneeType: null,
        assigneeId: null,
      });
      expect(handBacks(cw.calls, convId)).toHaveLength(0);
      expect(live.get(convId)?.status).toBe("open");
    });

    test("/teste asks Chatwoot, so a person the mirror has not heard of yet keeps it", async () => {
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live);
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      // Assigned in Chatwoot, and the event that would tell the mirror has not arrived.
      live.set(convId, {
        status: "open",
        assigneeType: "User",
        assigneeId: 61,
      });
      await deliver(convId, "/teste", {
        status: "open",
        assigneeType: null,
        assigneeId: null,
      });
      expect(handBacks(cw.calls, convId)).toHaveLength(0);
      expect(live.get(convId)?.assigneeId).toBe(61);
    });

    test("a live read that finds another person ends the park too", async () => {
      const convId = await seedConversation({
        status: "open",
        testParkedOpenAt: new Date(),
        testParkedAssigneeId: AUTO_AGENT,
      });
      await reconcileMirrorFromLive({
        tenantId,
        instanceId,
        conversationId: convId,
        live: {
          status: "open",
          assigneeType: "User",
          assigneeId: 61,
          assigneeName: null,
          lastActivityAt: new Date(),
          inboxId: INBOX_ID,
          updatedAt: Date.now() / 1000,
          latestMessageId: null,
          assigneeStated: true,
          snoozedUntil: undefined,
        },
        base: appDb,
      });
      const row = await rowOf(convId);
      expect(row.assigneeId).toBe(61);
      expect(row.testParkedOpenAt).toBeNull();
    });

    test("a person who takes and lets go while /teste runs still keeps the conversation from it", async () => {
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      let duringTeste = false;
      const cw = fakeChatwoot(live, {
        beforeRead: async (id) => {
          if (!duringTeste || id !== convId) return;
          duringTeste = false;
          // The person's assignment reached the mirror (which ends the park), and they let go.
          await suDb.conversation.updateMany({
            where: { tenantId, chatwootConversationId: convId },
            data: { testParkedOpenAt: null, testParkedAssigneeId: null },
          });
        },
      });
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      duringTeste = true;
      await deliver(convId, "/teste", {
        status: "open",
        assigneeType: null,
        assigneeId: null,
      });
      expect(handBacks(cw.calls, convId)).toHaveLength(0);
      expect(live.get(convId)?.status).toBe("open");
    });

    test("a conversation resolved after /teste looked stays resolved", async () => {
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      let readsInTeste: number | null = null;
      const cw = fakeChatwoot(live, {
        autoAssign: true,
        beforeRead: async (id) => {
          if (readsInTeste === null || id !== convId) return;
          readsInTeste += 1;
          // The refresh saw it open and held by the park's assignee; somebody resolves it after.
          if (readsInTeste === 2) {
            const c = live.get(convId);
            if (c) c.status = "resolved";
          }
        },
      });
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      readsInTeste = 0;
      await deliver(convId, "/teste", {
        status: "open",
        assigneeType: "User",
        assigneeId: AUTO_AGENT,
      });
      expect(readsInTeste).toBeGreaterThanOrEqual(2);
      expect(handBacks(cw.calls, convId)).toHaveLength(0);
      expect(live.get(convId)?.status).toBe("resolved");
    });

    test("/teste on an open conversation the agent never parked keeps today's answer", async () => {
      const convId = await seedConversation({ status: "open" });
      const live = new Map<number, LiveConv>([
        [convId, { status: "open", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live);
      globalThis.fetch = cw.impl;
      await deliver(convId, "/teste", {
        status: "open",
        assigneeType: null,
        assigneeId: null,
      });
      expect(handBacks(cw.calls, convId)).toHaveLength(0);
      expect(posts(cw.calls, convId).map(textOf).join(" ")).toContain("/reset");
    });

    test("switching the agent to production leaves the parked conversations open", async () => {
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live);
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      await suDb.agent.update({
        where: { id: agentId },
        data: { mode: "production", enabled: false },
      });
      await deliver(convId, "e aí?", {
        status: "open",
        assigneeType: null,
        assigneeId: null,
      });
      expect(handBacks(cw.calls, convId)).toHaveLength(0);
      expect(toggles(cw.calls, convId)).toHaveLength(1);
      expect(live.get(convId)?.status).toBe("open");
    });

    test("a contact refused by the rule in a silenced conversation is opened for the team too", async () => {
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            contactAuth: {
              enabled: true,
              rule: { kind: "label", label: "suporte" },
              denyMessage: "Não atendemos por aqui.",
              handoffEnabled: false,
            },
          },
        },
      });
      const convId = await seedConversation();
      const live = new Map<number, LiveConv>([
        [convId, { status: "pending", assigneeType: null, assigneeId: null }],
      ]);
      const cw = fakeChatwoot(live);
      globalThis.fetch = cw.impl;
      await deliver(convId, "oi", {
        status: "pending",
        assigneeType: null,
        assigneeId: null,
      });
      expect(toggles(cw.calls, convId)).toHaveLength(1);
      expect(live.get(convId)?.status).toBe("open");
      // Still no copy and no note: the refusal stays silent under test mode.
      expect(posts(cw.calls, convId)).toHaveLength(0);
    });
    for (const resolvedMidway of [false, true])
      test(
        resolvedMidway
          ? "/teste leaves the parked other half of a redirect episode resolved when it was resolved meanwhile"
          : "/teste on one half of a redirect episode gives the parked other half back too",
        async () => {
          const widgetInbox = await suDb.inbox.create({
            data: {
              tenantId,
              chatwootInstanceId: instanceId,
              chatwootInboxId: WIDGET_INBOX_ID,
              name: "Chat do site",
              agentId,
            },
          });
          await suDb.agent.update({
            where: { id: agentId },
            data: {
              settings: {
                channelRedirect: {
                  enabled: true,
                  entryInboxId: INBOX_ID,
                  widgetInboxId: WIDGET_INBOX_ID,
                },
              },
            },
          });
          try {
            const widgetConvId = await seedConversation({
              inboxId: widgetInbox.id,
              status: "open",
              testParkedOpenAt: new Date(),
            });
            const entryConvId = await seedConversation();
            const live = new Map<number, LiveConv>([
              [
                entryConvId,
                { status: "pending", assigneeType: null, assigneeId: null },
              ],
              [
                widgetConvId,
                {
                  status: "open",
                  assigneeType: null,
                  assigneeId: null,
                  inboxId: WIDGET_INBOX_ID,
                },
              ],
            ]);
            let widgetReads = 0;
            const cw = fakeChatwoot(live, {
              beforeRead: async (id) => {
                if (!resolvedMidway || id !== widgetConvId) return;
                widgetReads += 1;
                const c = live.get(widgetConvId);
                if (widgetReads === 2 && c) c.status = "resolved";
              },
            });
            globalThis.fetch = cw.impl;
            await deliver(entryConvId, "oi", {
              status: "pending",
              assigneeType: null,
              assigneeId: null,
            });
            await deliver(entryConvId, "/teste", {
              status: "open",
              assigneeType: null,
              assigneeId: null,
            });
            expect(live.get(entryConvId)?.status).toBe("pending");
            expect(live.get(widgetConvId)).toEqual(
              resolvedMidway
                ? {
                    status: "resolved",
                    assigneeType: null,
                    assigneeId: null,
                    inboxId: WIDGET_INBOX_ID,
                  }
                : {
                    status: "pending",
                    assigneeType: "AgentBot",
                    assigneeId: BOT_ID,
                    inboxId: WIDGET_INBOX_ID,
                  },
            );
            expect((await rowOf(widgetConvId)).testParkedOpenAt).toBeNull();
          } finally {
            await suDb.conversation.deleteMany({
              where: { tenantId, inboxId: widgetInbox.id },
            });
            await suDb.inbox.delete({ where: { id: widgetInbox.id } });
          }
        },
      );
  },
);
