// A control command (`/teste`, `/reset`) is only honoured when the agent it lands on is in `test`
// mode, and issue #270 is what happens when that question gets asked twice of two different rows.
// `commandActive` resolves the agent from the inbox id IN THE PAYLOAD; the test-mode gate that
// silences the conversation resolves it from the inbox id STORED on the mirrored conversation. When
// those disagree the operator sends `/teste` and gets back the private note telling them to send
// `/teste` — a dead end with no way out from inside the conversation.
//
// The reported diagnosis (the channel-redirect gate eating the command) is REFUTED here, on purpose
// and by a passing test: with `channelRedirect.enabled` on the entry inbox, `/teste` activates and
// acks exactly as it does without it. The redirect gate sits after the test-mode gate and is never
// reached with a live command in hand.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { seedChatwootInstance } from "../utils/chatwoot";

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

const BASE_URL = "https://203.0.113.22:9";
const ENTRY = 771;
const WIDGET = 772;
const PLAIN = 773;
const BOT = 77;

let tenantId = 0n;
let instanceId = 0n;
let entryInboxId = 0n;
let plainInboxId = 0n;

const posted: { conversationId: number; content: string; private: boolean }[] =
  [];
let realFetch: typeof globalThis.fetch;

function installDouble(): void {
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), {
        status: s,
        headers: { "content-type": "application/json" },
      });
    const m = url.match(/\/conversations\/(\d+)\/messages$/);
    if (m && (init?.method ?? "GET") === "GET") return json({ payload: [] });
    if (m && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}"));
      posted.push({
        conversationId: Number(m[1]),
        content: String(body.content ?? ""),
        private: body.private === true,
      });
      return json({ id: 1 });
    }
    if (/\/contacts\/\d+$/.test(url))
      return json({ payload: { id: 1, identifier: null } });
    return json({}, 404);
  }) as typeof globalThis.fetch;
}

async function seedConv(convId: number, inbox: bigint): Promise<bigint> {
  const row = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inbox,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(Date.now() - 120_000),
      lastInboundAt: new Date(Date.now() - 180_000),
    },
    select: { id: true },
  });
  return row.id;
}

async function deliver(
  convId: number,
  chatwootInboxId: number | null,
  content: string,
  seq: number,
  botId = BOT,
  topLevelInboxId?: number,
) {
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: 9000 + seq,
    content,
    message_type: "incoming",
    private: false,
    ...(topLevelInboxId === undefined
      ? {}
      : { inbox: { id: topLevelInboxId, name: "Top" } }),
    conversation: {
      id: convId,
      ...(chatwootInboxId === null ? {} : { inbox_id: chatwootInboxId }),
      status: "pending",
      contact_inbox: { id: 90_000 + convId },
      meta: {
        assignee_type: null,
        assignee: null,
        sender: { id: 801, name: "Lead", phone_number: "+5511977770000" },
      },
      channel: "Channel::Whatsapp",
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
  if (!n) throw new Error("fixture");
  const d = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `r270-${process.pid}-${convId}-${seq}`,
      event: "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: d.id,
    agentBotId: botId,
    normalized: n,
    base: appDb,
  });
}

describe.skipIf(!dbUp)("control commands: one reading of the agent", () => {
  beforeAll(async () => {
    installDouble();
    const t = await suDb.tenant.create({
      data: { name: "R270", slug: `r270-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 12,
      baseUrl: BASE_URL,
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "k", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const base = {
      tenantId,
      systemPrompt: "p",
      mode: "test",
      modelConfig: {
        provider: "openai",
        model: "gpt-4o-mini",
        credentialRef: `vault:${key.id}`,
      },
    };
    const redirectAgent = await suDb.agent.create({
      data: {
        ...base,
        name: "Redirect ON",
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          channelRedirect: {
            enabled: true,
            entryInboxId: ENTRY,
            widgetInboxId: WIDGET,
            redirectMessage: "Fale comigo aqui: {link}",
          },
        },
      },
      select: { id: true },
    });
    const plainAgent = await suDb.agent.create({
      data: {
        ...base,
        name: "Redirect OFF",
        settings: { debounce: { enabled: false }, split: { enabled: false } },
      },
      select: { id: true },
    });
    for (const [agentId, botId] of [
      [redirectAgent.id, BOT],
      [plainAgent.id, BOT + 1],
    ] as const) {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
          chatwootAgentBotId: botId,
          accessToken: encryptJson("BOT-TOKEN"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `h-${process.pid}-${agentId}`,
          name: "bot",
        },
      });
    }
    const e = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: ENTRY,
        name: "Entrada",
        agentId: redirectAgent.id,
        channelType: "Channel::Whatsapp",
      },
      select: { id: true },
    });
    entryInboxId = e.id;
    const p = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: PLAIN,
        name: "Simples",
        agentId: plainAgent.id,
        channelType: "Channel::Whatsapp",
      },
      select: { id: true },
    });
    plainInboxId = p.id;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    if (tenantId) {
      for (const table of [
        "chatwoot_webhook_deliveries",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = $1`,
          tenantId,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = $1`,
        tenantId,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("/teste activates on a plain bound inbox (control)", async () => {
    const id = await seedConv(6001, plainInboxId);
    await deliver(6001, PLAIN, "/teste", 1, BOT + 1);
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true },
    });
    expect(
      posted.filter((p) => p.conversationId === 6001 && !p.private).length,
    ).toBeGreaterThan(0);
    expect(row?.testActivatedAt).not.toBeNull();
  });

  test("an inbox bound to no agent still says the command was dropped, and why", async () => {
    const orphan = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 774,
        name: "Órfã",
        channelType: "Channel::Whatsapp",
      },
      select: { id: true },
    });
    const id = await seedConv(6003, orphan.id);
    // NOTE: `mockRestore` also clears `mock.calls` in Bun, so the lines are copied out first.
    const info = spyOn(logger, "info");
    let lines: unknown[][] = [];
    try {
      await deliver(6003, 774, "/teste", 3);
      lines = info.mock.calls.map((c) => [...c]);
    } finally {
      info.mockRestore();
    }
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true },
    });
    // No agent on either reading, so the command genuinely cannot run — but it must not vanish. The
    // three values issue #270 asked for (the command, why it was inactive, the route it arrived on)
    // are the whole point of the line: without them this delivery is indistinguishable from a
    // customer who happened to type "/teste".
    expect(row?.testActivatedAt).toBeNull();
    expect(posted.filter((p) => p.conversationId === 6003)).toEqual([]);
    const line = lines.find((c) => String(c[0]).includes("not run"));
    expect(line).toBeDefined();
    expect(String(line?.[0])).toContain("agent mode=%s");
    expect(line?.slice(1)).toEqual([
      "teste",
      "6003",
      "unresolved",
      String(BOT),
    ]);
  });

  test("a delivery on another persona's bot route leaves the command to the inbox's own persona", async () => {
    const id = await seedConv(6004, entryInboxId);
    // A entrega chega na rota do bot da OUTRA persona, como o Chatwoot faz quando a conversa está
    // atribuída a ele: agentBotId != o bot da inbox.
    await deliver(6004, ENTRY, "/teste", 4, BOT + 1);
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true },
    });
    expect(row?.testActivatedAt).toBeNull();
    expect(posted.filter((p) => p.conversationId === 6004)).toEqual([]);
  });

  test("/teste still activates after the redirect link was already sent", async () => {
    const id = await seedConv(6005, entryInboxId);
    await suDb.conversation.update({
      where: { id },
      data: { redirectSentAt: new Date(Date.now() - 60_000), redirectCount: 1 },
    });
    await deliver(6005, ENTRY, "/teste", 5);
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true },
    });
    expect(row?.testActivatedAt).not.toBeNull();
    expect(
      posted.filter((p) => p.conversationId === 6005 && !p.private).length,
    ).toBeGreaterThan(0);
  });

  test("/teste activates on a conversation assigned to another AgentBot (ack goes private)", async () => {
    const id = await seedConv(6006, entryInboxId);
    await suDb.conversation.update({
      where: { id },
      data: { assigneeType: "AgentBot", assigneeId: BOT + 1 },
    });
    await deliver(6006, ENTRY, "/teste", 6);
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true },
    });
    expect(row?.testActivatedAt).not.toBeNull();
    expect(
      posted.filter((p) => p.conversationId === 6006).every((p) => p.private),
    ).toBe(true);
  });

  test("REFUTES #270: /teste activates on a redirect entry inbox with channelRedirect on", async () => {
    const id = await seedConv(6002, entryInboxId);
    await deliver(6002, ENTRY, "/teste", 2);
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true, redirectSentAt: true },
    });
    expect(
      posted.filter((p) => p.conversationId === 6002 && !p.private).length,
    ).toBeGreaterThan(0);
    expect(row?.testActivatedAt).not.toBeNull();
  });

  test("REGRESSION #270: /teste is honoured when only the mirrored conversation can name the agent", async () => {
    const id = await seedConv(6007, entryInboxId);
    // First message WITH inbox_id: mirrors the conversation, so the row can name the agent.
    await deliver(6007, ENTRY, "oi", 7);
    // The /teste arrives with no inbox_id: `rt` resolves from n.inboxId and finds nothing, while the
    // test-mode gate resolves from conv.inboxId and finds the test agent.
    await deliver(6007, null, "/teste", 8);
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true },
    });
    // The payload could not name the agent, so the ONLY row that can is the mirrored conversation —
    // the same row the test-mode gate reads. Before the fix the two disagreed and the operator got
    // the "send /teste" private note back in reply to a /teste.
    expect(row?.testActivatedAt).not.toBeNull();
    // The private "send /teste" note from the pre-activation "oi" is legitimate and stays; what must
    // NOT happen is the command itself being answered with that same instruction. The public ack is
    // the positive signal that the command ran.
    const after = posted.filter((p) => p.conversationId === 6007).slice(1);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((p) => !p.content.includes("Envie /teste"))).toBe(true);
  });

  test("a payload naming an UNKNOWN inbox does not borrow the conversation's previous agent", async () => {
    // The conversation is mirrored on the bound entry inbox, so the fallback would find a test-mode
    // agent — but the delivery arrived on an inbox that names no agent, and the mirror is about to
    // move the conversation there. Deciding the command against the old inbox would activate it for
    // an agent this delivery never reached, and the route check would then eat it without a word.
    const id = await seedConv(6008, entryInboxId);
    const info = spyOn(logger, "info");
    let lines: unknown[][] = [];
    try {
      await deliver(6008, 999, "/teste", 9);
      lines = info.mock.calls.map((c) => [...c]);
    } finally {
      info.mockRestore();
    }
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true },
    });
    expect(row?.testActivatedAt).toBeNull();
    const line = lines.find((c) => String(c[0]).includes("not run"));
    expect(line?.slice(1)).toEqual([
      "teste",
      "6008",
      "unresolved",
      String(BOT),
    ]);
  });

  test("the message's own top-level inbox is honoured before the mirrored conversation", async () => {
    // No `conversation.inbox_id`, but the message names its inbox at the top level. That is an
    // answer, so the command must be decided against THAT inbox — never against whatever inbox the
    // conversation happened to point at. Here the two disagree on purpose: the conversation sits on
    // the redirect entry inbox (persona BOT) and the message names the plain one (persona BOT+1),
    // so borrowing the conversation's agent would run the command on the wrong persona's route.
    const id = await seedConv(6009, entryInboxId);
    await deliver(6009, null, "/teste", 10, BOT + 1, PLAIN);
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true },
    });
    expect(row?.testActivatedAt).not.toBeNull();
    expect(
      posted.filter((p) => p.conversationId === 6009 && !p.private).length,
    ).toBeGreaterThan(0);
  });

  test("a sparse command on the losing route defers to the fence, it does not become customer text", async () => {
    // The payload names no inbox, so the mirrored conversation is the only thing that can name an
    // agent — and Chatwoot fans one command out to the inbox's persona AND to the conversation's
    // assigned bot, so two deliveries arrive carrying it. This is the losing one. It must reach
    // `commandBelongsHere` and be consumed there; deciding the route any earlier leaves it
    // `commandActive === false`, which walks past that fence and hands the agent "/teste" as
    // ordinary customer text.
    const id = await seedConv(6010, entryInboxId);
    const info = spyOn(logger, "info");
    let lines: unknown[][] = [];
    try {
      await deliver(6010, null, "/teste", 11, BOT + 1);
      lines = info.mock.calls.map((c) => [...c]);
    } finally {
      info.mockRestore();
    }
    const row = await suDb.conversation.findUnique({
      where: { id },
      select: { testActivatedAt: true },
    });
    expect(row?.testActivatedAt).toBeNull();
    expect(posted.filter((p) => p.conversationId === 6010)).toEqual([]);
    expect(lines.some((c) => String(c[0]).includes("not for this route"))).toBe(
      true,
    );
    expect(lines.some((c) => String(c[0]).includes("not run"))).toBe(false);
  });
});
