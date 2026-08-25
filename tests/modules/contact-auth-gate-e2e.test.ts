import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import {
  clearContactAuthState,
  contactAuthNoticeEntries,
} from "@/modules/contact-auth/state";
import { seedChatwootInstance } from "../utils/chatwoot";
import { PromptCapturingModel } from "../utils/scripted-models";

// The contact authorization gate, wired end to end through processChatwootDelivery: what a denied /
// failed / unidentified contact actually experiences, and what the operator sees. The unit decision
// table (contact-auth-check.test.ts) pins the RULE; these pin that the rule reaches the process
// boundary: the deny copy leaves as the persona, the conversation opens for humans, the model is
// never invoked, and the handled watermark still advances so no flush re-answers a refused backlog.

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

// TEST-NET-3: passes the SSRF check without a DNS lookup; the injected fetch answers before any
// socket could be opened.
const AUTH_URL = "https://203.0.113.9:9443/check";
const BOT_TOKEN = "CA-BOT-TOKEN";
const DENY_COPY = "Este canal atende apenas clientes cadastrados.";
const PHONE = "+5511977776666";
const INBOX_FULL = 771; // deny message + handoff to team 77
const INBOX_NO_COPY = 772; // denyMessage null, handoff on
const INBOX_UNLOCK = 773; // POST + includeMessageText, handoff off (the unlock flow)
const INBOX_FOREIGN_TEAM = 774; // handoff to a team pinned in ANOTHER Chatwoot account
const TEAM_ID = 77;
const UNLOCK_COPY = "Envie seu código de acesso para ser atendido.";

let tenantId = 0n;
let instanceId = 0n;
let inboxFullDbId = 0n;
let inboxNoCopyDbId = 0n;
let inboxUnlockDbId = 0n;
let inboxForeignTeamDbId = 0n;
let foreignTeamAgentId = 0n;

interface Sent {
  conversationId: number;
  content: string;
  private: boolean;
  token: string;
}

// Recording Chatwoot double, injected via deps.makeClient so neither the gate nor the turn ever
// reaches a socket. The factory captures the bot token each client was built with: the deny copy
// must leave as the PERSONA, not as a token-less client that a real Chatwoot would 401.
function stubChatwoot() {
  const sent: Sent[] = [];
  const statusToggles: Array<[number, string]> = [];
  const teamAssignments: Array<[number, number]> = [];
  let token = "";
  const client = {
    sendMessage: async (c: number, content: string) => {
      sent.push({
        conversationId: c,
        content,
        private: false,
        token,
      });
      return {};
    },
    sendPrivateNote: async (c: number, content: string) => {
      sent.push({ conversationId: c, content, private: true, token });
      return {};
    },
    toggleStatus: async (c: number, status: string) => {
      statusToggles.push([c, status]);
      return {};
    },
    assignTeam: async (c: number, teamId: number) => {
      teamAssignments.push([c, teamId]);
      return {};
    },
    toggleTyping: async () => ({}),
    getMessages: async () => ({ payload: [] }),
  } as unknown as ChatwootClient;
  return {
    sent,
    statusToggles,
    teamAssignments,
    makeClient: async (cfg: { botToken: string }) => {
      token = cfg.botToken;
      return client;
    },
    publicOn: (c: number) =>
      sent.filter((s) => s.conversationId === c && !s.private),
    notesOn: (c: number) =>
      sent.filter((s) => s.conversationId === c && s.private),
  };
}

// The authorization endpoint double: a FIFO of canned responses plus what it saw (URLs and, for
// POST, the parsed JSON bodies).
function authDouble(...responses: Array<() => Response | Promise<Response>>) {
  const calls: string[] = [];
  const bodies: Array<Record<string, unknown> | null> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    bodies.push(
      init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : null,
    );
    const next = responses.shift();
    if (!next) throw new Error("authDouble: no response queued");
    return next();
  }) as unknown as typeof fetch;
  return { calls, bodies, fetchImpl };
}

const authorized = () => new Response('{"authorized":true}', { status: 200 });
const denied = (reason?: string) =>
  new Response(
    JSON.stringify({ authorized: false, ...(reason ? { reason } : {}) }),
    {
      status: 200,
    },
  );
const failing = () => new Response("boom", { status: 500 });

async function seedConversation(convId: number, inboxDbId: bigint) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
    },
  });
}

let seq = 0;
async function deliverCustomerMessage(params: {
  convId: number;
  chatwootInboxId: number;
  senderId: number;
  phone: string | null;
  content?: string;
  fetchImpl: typeof fetch;
  makeClient: (cfg: { botToken: string }) => Promise<ChatwootClient>;
  makeModel?: () => BaseChatModel;
}): Promise<void> {
  seq += 1;
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: 7000 + seq,
    content: params.content ?? "olá, preciso de ajuda",
    message_type: "incoming",
    private: false,
    conversation: {
      id: params.convId,
      inbox_id: params.chatwootInboxId,
      status: "pending",
      contact_inbox: { id: 91_000 + params.convId },
      meta: {
        assignee_type: null,
        assignee: null,
        sender: {
          id: params.senderId,
          name: "Cliente",
          ...(params.phone ? { phone_number: params.phone } : {}),
        },
      },
      channel: "Channel::Api",
      last_activity_at: Math.floor(Date.now() / 1000),
    },
  });
  if (!n) throw new Error("unreachable: the fixture is a valid event");
  const delivery = await suDb.chatwootWebhookDelivery.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      deliveryId: `ca-${process.pid}-${params.convId}-${seq}`,
      event: "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: 21,
    normalized: n,
    base: appDb,
    deps: {
      makeClient: params.makeClient as never,
      makeModel:
        params.makeModel ??
        (() => {
          throw new Error("the model must not be invoked on a refused turn");
        }),
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
      contactAuthFetch: params.fetchImpl,
    },
  });
}

async function flowRows(convId: number) {
  const threadId = `${tenantId}:${instanceId}:${convId}`;
  for (let i = 0; i < 200; i++) {
    const rows = await suDb.executionLog.findMany({
      where: { tenantId, threadId, stage: "contact_auth" },
      select: { level: true, status: true, detail: true },
      orderBy: { id: "asc" },
    });
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no contact_auth flow line for conv ${convId}`);
}

// The gate line for a conversation, scoped by the INTERNAL id the Logs page filters on and polled,
// because the emit is fire-and-forget.
async function handoffDetail(convId: number): Promise<unknown> {
  const conv = await suDb.conversation.findFirstOrThrow({
    where: { tenantId, chatwootConversationId: convId },
    select: { id: true },
  });
  for (let i = 0; i < 200; i++) {
    const row = await suDb.executionLog.findFirst({
      where: { tenantId, stage: "handoff", conversationId: conv.id },
      select: { detail: true },
      orderBy: { id: "desc" },
    });
    if (row) return row.detail;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no handoff flow line for conv ${convId}`);
}

// The audited prompt of the turn that ran, from the row the Logs page serves.
async function auditedPrompt(convId: number): Promise<string> {
  const threadId = `${tenantId}:${instanceId}:${convId}`;
  for (let i = 0; i < 200; i++) {
    const row = await suDb.executionLog.findFirst({
      where: { tenantId, threadId, stage: "generate" },
      select: { detail: true },
      orderBy: { id: "asc" },
    });
    const detail = row?.detail as { systemPrompt?: string } | null;
    if (detail?.systemPrompt) return detail.systemPrompt;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no generate flow line for conv ${convId}`);
}

describe.skipIf(!dbUp)("contact authorization gate (webhook e2e)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAUTH", slug: `cauth-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 41,
      baseUrl: "https://203.0.113.22:9",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const authKey = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "auth-key",
        kind: "bearer_token",
        secret: encryptJson("AUTH-SECRET"),
      },
      select: { id: true },
    });
    const baseAgent = {
      tenantId,
      systemPrompt: "Você é prestativa.",
      modelConfig: {
        provider: "openai",
        model: "gpt-4o-mini",
        credentialRef: `vault:${llmKey.id}`,
      },
    };
    const contactAuthBase = {
      enabled: true,
      url: AUTH_URL,
      credentialRef: `vault:${authKey.id}`,
      noticeCooldownSeconds: 300,
    };
    const full = await suDb.agent.create({
      data: {
        ...baseAgent,
        name: "Com recusa",
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          contactAuth: {
            ...contactAuthBase,
            denyMessage: DENY_COPY,
            handoffEnabled: true,
            handoffTeamId: TEAM_ID,
            handoffTeamInstanceId: Number(instanceId),
          },
        },
      },
      select: { id: true },
    });
    const noCopy = await suDb.agent.create({
      data: {
        ...baseAgent,
        name: "Sem recusa",
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          contactAuth: {
            ...contactAuthBase,
            denyMessage: null,
            handoffEnabled: true,
            handoffTeamId: null,
          },
        },
      },
      select: { id: true },
    });
    const unlock = await suDb.agent.create({
      data: {
        ...baseAgent,
        name: "Destravável",
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          contactAuth: {
            ...contactAuthBase,
            includeMessageText: true,
            denyMessage: UNLOCK_COPY,
            handoffEnabled: false,
          },
        },
      },
      select: { id: true },
    });
    // Same team NUMBER, recorded against a Chatwoot account this conversation is not in. The shape an
    // agent MOVED between accounts ends up in: one account again, and the id belongs to the old one.
    const foreignTeam = await suDb.agent.create({
      data: {
        ...baseAgent,
        name: "Time de outra conta",
        settings: {
          debounce: { enabled: false },
          split: { enabled: false },
          contactAuth: {
            ...contactAuthBase,
            denyMessage: DENY_COPY,
            handoffEnabled: true,
            handoffTeamId: TEAM_ID,
            handoffTeamInstanceId: Number(instanceId) + 1000,
          },
        },
      },
      select: { id: true },
    });
    foreignTeamAgentId = foreignTeam.id;
    for (const [agentId, botId] of [
      [full.id, 21],
      [noCopy.id, 22],
      [unlock.id, 23],
      [foreignTeam.id, 24],
    ] as const) {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
          chatwootAgentBotId: botId,
          accessToken: encryptJson(BOT_TOKEN),
          webhookSecret: encryptJson("SECRET"),
          webhookRouteTokenHash: `cauth-${process.pid}-${botId}`,
          name: "bot",
        },
      });
    }
    const a = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_FULL,
        name: "Com recusa",
        agentId: full.id,
      },
      select: { id: true },
    });
    inboxFullDbId = a.id;
    const b = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_NO_COPY,
        name: "Sem recusa",
        agentId: noCopy.id,
      },
      select: { id: true },
    });
    inboxNoCopyDbId = b.id;
    const c = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_UNLOCK,
        name: "Destravável",
        agentId: unlock.id,
      },
      select: { id: true },
    });
    inboxUnlockDbId = c.id;
    const d = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: INBOX_FOREIGN_TEAM,
        name: "Time de outra conta",
        agentId: foreignTeam.id,
      },
      select: { id: true },
    });
    inboxForeignTeamDbId = d.id;
  });

  beforeEach(() => {
    clearContactAuthState();
  });

  afterAll(async () => {
    if (!dbUp || !tenantId) return;
    for (const table of [
      "scheduler_jobs",
      "llm_usage",
      "execution_logs",
      "agent_threads",
      "conversations",
      "contacts",
      "chatwoot_webhook_deliveries",
      "inboxes",
      "chatwoot_agent_bots",
      "agents",
      "vault_entries",
      "chatwoot_instances",
    ]) {
      await suDb
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${tenantId}`)
        .catch(() => {});
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("denied: deny copy as the persona, open + team, note, no model, watermark advanced", async () => {
    const convId = 9301;
    await seedConversation(convId, inboxFullDbId);
    const cw = stubChatwoot();
    const auth = authDouble(() => denied("not_customer"));
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FULL,
      senderId: 801,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
    });

    // The endpoint was asked with the mirrored identity, not with anything typed.
    expect(auth.calls).toHaveLength(1);
    expect(auth.bodies[0]).toMatchObject({ contact: { phone: PHONE } });
    // The customer got exactly the operator's copy, as the persona bot.
    expect(cw.publicOn(convId)).toEqual([
      {
        conversationId: convId,
        content: DENY_COPY,
        private: false,
        token: BOT_TOKEN,
      },
    ]);
    // Handoff: open + the configured team.
    expect(cw.statusToggles).toEqual([[convId, "open"]]);
    expect(cw.teamAssignments).toEqual([[convId, TEAM_ID]]);
    // The operator's note names the reason code, never the phone.
    const notes = cw.notesOn(convId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("não autorizado");
    expect(notes[0]?.content).toContain("not_customer");
    expect(notes[0]?.content).not.toContain(PHONE);
    // The message is consumed: the watermark advanced so no later flush re-answers it.
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastHandledMessageId: true },
    });
    expect(conv.lastHandledMessageId).toBe(7000 + seq);
    // Flow line: denied is ordinary operation (info), and what the ENDPOINT called it is not in it.
    // The slug guard checks the shape of that value, and a phone number is slug-shaped, so it goes
    // to the operator note (in their own Chatwoot) and never to a detail alert channels read.
    const rows = await flowRows(convId);
    expect(rows[0]?.level).toBe("info");
    expect(rows[0]?.detail).toMatchObject({
      outcome: "denied",
      shared: false,
      status: 200,
    });
    expect(JSON.stringify(rows[0]?.detail)).not.toContain("not_customer");
    // The notice cooldown remembers ids and timestamps, never the phone.
    expect(JSON.stringify(contactAuthNoticeEntries())).not.toContain(
      PHONE.slice(1),
    );
  });

  test("authorized: the turn runs and the model's reply reaches the customer", async () => {
    const convId = 9302;
    await seedConversation(convId, inboxFullDbId);
    const cw = stubChatwoot();
    const auth = authDouble(authorized);
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FULL,
      senderId: 802,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
      makeModel: () => new FakeListChatModel({ responses: ["Posso ajudar!"] }),
    });
    expect(auth.calls).toHaveLength(1);
    expect(cw.publicOn(convId).map((s) => s.content)).toEqual([
      "Posso ajudar!",
    ]);
    expect(cw.statusToggles).toEqual([]);
    const rows = await flowRows(convId);
    expect(rows[0]?.detail).toMatchObject({ outcome: "allowed" });
  });

  // The window this gate OPENS. The attribution gate runs before the authorization call, and that
  // call is a round-trip to somebody else's endpoint with a ten-second ceiling; a human taking the
  // conversation inside it used to find the agent's turn running on it, because runAgentTurn only
  // re-checks ownership after the model has answered — which withholds the reply and nothing else,
  // long after the tools have written their labels, cards and attributes.
  test("a human taking over during the authorization call stops the turn before the model", async () => {
    const convId = 9313;
    await seedConversation(convId, inboxFullDbId);
    const cw = stubChatwoot();
    let modelBuilds = 0;
    // The takeover lands WHILE the endpoint is being asked, so the verdict is answering about a
    // conversation that changed hands after the gate above it said yes.
    const auth = authDouble(async () => {
      await suDb.conversation.updateMany({
        where: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: convId,
        },
        data: { assigneeType: "User", assigneeId: 44, status: "open" },
      });
      return authorized();
    });
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FULL,
      senderId: 812,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
      makeModel: () => {
        modelBuilds += 1;
        return new FakeListChatModel({ responses: ["não devia sair"] });
      },
    });
    // The endpoint WAS asked (the gate before it was still open when the delivery arrived), and the
    // turn is what does not happen. Nothing is said to the customer and nothing is toggled: the
    // conversation is the human's now, and this path has no business touching it.
    expect(auth.calls).toHaveLength(1);
    expect(modelBuilds).toBe(0);
    expect(cw.publicOn(convId)).toEqual([]);
    expect(cw.statusToggles).toEqual([]);
    // And it SAYS so: the fence that stopped the turn leaves the same line every other ownership
    // gate leaves, so the silence has something behind it in the operator's log (issue #271).
    expect(await handoffDetail(convId)).toEqual({ outcome: "taken_over" });
  });

  test("endpoint failure: silence to the customer, no handoff, note + warn line", async () => {
    const convId = 9303;
    await seedConversation(convId, inboxFullDbId);
    const cw = stubChatwoot();
    const auth = authDouble(failing);
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FULL,
      senderId: 803,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(cw.publicOn(convId)).toEqual([]);
    expect(cw.statusToggles).toEqual([]);
    const notes = cw.notesOn(convId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("HTTP 500");
    const rows = await flowRows(convId);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.status).toBe("error");
    expect(rows[0]?.detail).toMatchObject({ outcome: "error", status: 500 });
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { lastHandledMessageId: true },
    });
    expect(conv.lastHandledMessageId).toBe(7000 + seq);
  });

  test("two refused messages cost TWO requests but voice ONE notice (the cooldown)", async () => {
    const convId = 9304;
    await seedConversation(convId, inboxFullDbId);
    const cw = stubChatwoot();
    const auth = authDouble(
      () => denied(),
      () => denied(),
    );
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FULL,
      senderId: 804,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
    });
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FULL,
      senderId: 804,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
    });
    // No verdict cache: every message re-asks the endpoint (this is what makes revocation and the
    // unlock instantaneous)...
    expect(auth.calls).toHaveLength(2);
    // ...but the cooldown keeps the burst from being answered twice with the same copy.
    expect(cw.publicOn(convId)).toHaveLength(1);
    expect(cw.notesOn(convId)).toHaveLength(1);
    // The handoff is NOT behind the cooldown: a failed open must be retried, so each fresh denial
    // attempts it again (idempotent on Chatwoot's side).
    expect(cw.statusToggles).toEqual([
      [convId, "open"],
      [convId, "open"],
    ]);
    // Both verdicts were fresh: sequential messages never coalesce.
    const rows = await flowRows(convId);
    expect(rows.map((r) => (r.detail as { shared: boolean }).shared)).toEqual([
      false,
      false,
    ]);
  });

  test("the unlock flow: denied without the code, authorized on the message that carries it", async () => {
    const convId = 9307;
    await seedConversation(convId, inboxUnlockDbId);
    const cw = stubChatwoot();
    const auth = authDouble(() => denied("code_required"), authorized);
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_UNLOCK,
      senderId: 807,
      phone: PHONE,
      content: "olá, preciso de ajuda",
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
    });
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_UNLOCK,
      senderId: 807,
      phone: PHONE,
      content: "meu código é ABC-123",
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
      makeModel: () => new FakeListChatModel({ responses: ["Bem-vindo!"] }),
    });
    // Two checks, one per message, each carrying ITS message under `message` and the mirrored
    // identity under `contact` (the separation is the contract).
    expect(auth.calls).toHaveLength(2);
    interface SeenBody {
      contact: { phone: string };
      message: { text: string };
    }
    const first = auth.bodies[0] as unknown as SeenBody;
    const second = auth.bodies[1] as unknown as SeenBody;
    expect(first.message.text).toBe("olá, preciso de ajuda");
    expect(first.contact.phone).toBe(PHONE);
    expect(second.message.text).toBe("meu código é ABC-123");
    expect(JSON.stringify(second.contact)).not.toContain("ABC-123");
    // The customer heard the unlock instruction once, then the agent's own reply.
    expect(cw.publicOn(convId).map((s) => s.content)).toEqual([
      UNLOCK_COPY,
      "Bem-vindo!",
    ]);
    // Handoff off: the conversation stayed with the bot the whole way.
    expect(cw.statusToggles).toEqual([]);
    const rows = await flowRows(convId);
    expect(rows.map((r) => (r.detail as { outcome: string }).outcome)).toEqual([
      "denied",
      "allowed",
    ]);
  });

  // The context bag: the endpoint already resolved WHO this contact is to answer the question, so a
  // turn that starts right after it should not have to ask the same system the same thing again.
  // Asserted on the message the model received, not on the builder: this path is the one the
  // compiler cannot force (`runAgentTurn` carries the context as an optional param, because making
  // it required would edit 81 test call sites), so what proves the wiring is the effect.
  test("an authorized contact's facts reach the model, and only their size reaches the log", async () => {
    const convId = 9314;
    await seedConversation(convId, inboxFullDbId);
    const cw = stubChatwoot();
    const auth = authDouble(
      () =>
        new Response(
          JSON.stringify({
            authorized: true,
            context: { plan: "premium", account_id: "AC-8821" },
          }),
          { status: 200 },
        ),
    );
    const model = new PromptCapturingModel("Claro, posso ajudar!");
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FULL,
      senderId: 813,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
      makeModel: () => model,
    });
    expect(cw.publicOn(convId).map((m) => m.content)).toEqual([
      "Claro, posso ajudar!",
    ]);
    const prompt = model.systemPrompts[0] ?? "";
    expect(prompt).toContain('<campo chave="plan" valor="premium"/>');
    expect(prompt).toContain('<campo chave="account_id" valor="AC-8821"/>');
    // The operator's own text still opens the prompt: the block is appended, never interpolated,
    // so a value that reads like a placeholder stays literal.
    expect(prompt.startsWith("Você é prestativa.")).toBe(true);
    // `execution_logs.detail` is promised free of customer data and is served to alert channels.
    const audited = await auditedPrompt(convId);
    expect(audited).toContain("<autorizacao chars=");
    expect(audited).not.toContain("premium");
    expect(audited).not.toContain("AC-8821");
  });

  test("a contact with no identifiers is refused with its own reason, no copy, still handed off", async () => {
    const convId = 9305;
    await seedConversation(convId, inboxFullDbId);
    const cw = stubChatwoot();
    const auth = authDouble(); // must never be called
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FULL,
      senderId: 805,
      phone: null,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(auth.calls).toEqual([]);
    expect(cw.publicOn(convId)).toEqual([]);
    expect(cw.statusToggles).toEqual([[convId, "open"]]);
    const notes = cw.notesOn(convId);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("identificador");
    const rows = await flowRows(convId);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.detail).toMatchObject({
      outcome: "no_identity",
      reason: "no_identifiers",
    });
  });

  test("no deny copy configured: the customer hears nothing, the handoff still happens", async () => {
    const convId = 9306;
    await seedConversation(convId, inboxNoCopyDbId);
    const cw = stubChatwoot();
    const auth = authDouble(() => denied());
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_NO_COPY,
      senderId: 806,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(cw.publicOn(convId)).toEqual([]);
    expect(cw.statusToggles).toEqual([[convId, "open"]]);
    // No team configured: open only, Chatwoot routes.
    expect(cw.teamAssignments).toEqual([]);
    expect(cw.notesOn(convId)).toHaveLength(1);
  });

  // A Chatwoot team id belongs to ONE account. The editor cannot warn about an agent MOVED to
  // another one — it sees a single account again — so the account the team was picked from is
  // recorded with it, and that is what decides.
  test("a team pinned in another account is not assigned; the open still happens", async () => {
    const convId = 9311;
    await seedConversation(convId, inboxForeignTeamDbId);
    const cw = stubChatwoot();
    const auth = authDouble(() => denied());
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FOREIGN_TEAM,
      senderId: 807,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
    });
    // Refused and handed over, but routed by the inbox rather than to whatever team 77 is here.
    expect(cw.statusToggles).toEqual([[convId, "open"]]);
    expect(cw.teamAssignments).toEqual([]);
    expect(cw.publicOn(convId)).toHaveLength(1);
  });

  // A value stored before the account was recorded alongside it. Nothing can say which account it
  // came from, so it falls back to the older question: does this agent serve more than one?
  test("a legacy target with no recorded account is still applied on a single-account agent", async () => {
    const stored = await suDb.agent.findUniqueOrThrow({
      where: { id: foreignTeamAgentId },
      select: { settings: true },
    });
    const bag = stored.settings as Record<string, unknown>;
    await suDb.agent.update({
      where: { id: foreignTeamAgentId },
      data: {
        settings: {
          ...bag,
          contactAuth: {
            ...(bag.contactAuth as Record<string, unknown>),
            handoffTeamInstanceId: null,
          },
        },
      },
    });
    const convId = 9312;
    await seedConversation(convId, inboxForeignTeamDbId);
    const cw = stubChatwoot();
    const auth = authDouble(() => denied());
    await deliverCustomerMessage({
      convId,
      chatwootInboxId: INBOX_FOREIGN_TEAM,
      senderId: 808,
      phone: PHONE,
      fetchImpl: auth.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(cw.teamAssignments).toEqual([[convId, TEAM_ID]]);
  });
});
