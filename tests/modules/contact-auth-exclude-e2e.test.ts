import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { normalizeChatwootEvent } from "@/modules/chatwoot/normalize";
import { processChatwootDelivery } from "@/modules/chatwoot/webhook";
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// ── A RECEPTION NUMBER THAT LEAVES THE STAFF TO THE TEAM, THROUGH THE WEBHOOK ──
//
// An exclusion list under the quiet refusal: a staff number gets no reply, no note, and the conversation opened for humans; everyone else is answered, a contact with no phone included. With an endpoint after the rule, a staff number never reaches it. Driven end to end through processChatwootDelivery, with a recording Chatwoot and a counting endpoint.

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

const AUTH_URL = "https://203.0.113.72:9443/check";
const STAFF_PHONES = ["+55 11 98888-7777", "+55 21 97777-6666"];
const INBOX_QUIET = 871; // exclusion list, quiet refusal
const INBOX_TWO_STAGES = 872; // exclusion list, then the endpoint

let tenantId = 0n;
let instanceId = 0n;
const inboxDbIds = new Map<number, bigint>();

function stubChatwoot() {
  const sent: Array<{ c: number; content: string; private: boolean }> = [];
  const statusToggles: Array<[number, string]> = [];
  const client = {
    sendMessage: async (c: number, content: string) => {
      sent.push({ c, content, private: false });
      return {};
    },
    sendPrivateNote: async (c: number, content: string) => {
      sent.push({ c, content, private: true });
      return {};
    },
    toggleStatus: async (c: number, status: string) => {
      statusToggles.push([c, status]);
      return {};
    },
    assignTeam: async () => ({}),
    toggleTyping: async () => ({}),
    getMessages: async () => ({ payload: [] }),
  } as unknown as ChatwootClient;
  return {
    statusToggles,
    makeClient: async () => client,
    publicOn: (c: number) =>
      sent.filter((s) => s.c === c && !s.private).map((s) => s.content),
    notesOn: (c: number) =>
      sent.filter((s) => s.c === c && s.private).map((s) => s.content),
  };
}

function countingEndpoint() {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ authorized: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
}

async function seedConversation(convId: number, inbox: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbIds.get(inbox) ?? null,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(Date.now() - 2 * 60_000),
      lastInboundAt: new Date(Date.now() - 3 * 60_000),
    },
  });
}

let seq = 0;
async function deliver(params: {
  convId: number;
  inbox: number;
  // null: a contact Chatwoot holds no phone for.
  phone: string | null;
  fetchImpl: typeof fetch;
  makeClient: () => Promise<ChatwootClient>;
  reply?: string;
}) {
  seq += 1;
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: 8700 + seq,
    content: "oi, tudo bem?",
    message_type: "incoming",
    private: false,
    conversation: {
      id: params.convId,
      inbox_id: params.inbox,
      status: "pending",
      group_type: "individual",
      labels: [],
      contact_inbox: { id: 93_000 + params.convId },
      meta: {
        assignee_type: null,
        assignee: null,
        sender: {
          id: 5100 + params.convId,
          name: "Contato",
          ...(params.phone === null ? {} : { phone_number: params.phone }),
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
      deliveryId: `caxe-${process.pid}-${params.convId}-${seq}`,
      event: "message_created",
      status: "PENDING",
    },
    select: { id: true },
  });
  await processChatwootDelivery({
    tenantId,
    instanceId,
    deliveryRowId: delivery.id,
    agentBotId: params.inbox - 800,
    normalized: n,
    base: appDb,
    deps: {
      makeClient: params.makeClient as never,
      makeModel: () => {
        if (!params.reply) {
          throw new Error("the model must not be invoked on a refused turn");
        }
        return new FakeListChatModel({ responses: [params.reply] });
      },
      checkpointer: new MemorySaver(),
      persistUsage: async () => {},
      contactAuthFetch: params.fetchImpl,
    },
  });
}

async function gateLines(convId: number) {
  const threadId = `${tenantId}:${instanceId}:${convId}`;
  for (let i = 0; i < 200; i++) {
    const rows = await flowLogRows(suDb, {
      where: { tenantId, threadId, stage: "contact_auth" },
      select: { detail: true },
      orderBy: { id: "asc" },
    });
    if (rows.length > 0) return rows.map((r) => r.detail);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`no contact_auth flow line for conv ${convId}`);
}

describe.skipIf(!dbUp)("an exclusion list at the gate (webhook e2e)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAXE", slug: `caxe-${process.pid}` },
    });
    tenantId = t.id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 87,
        baseUrl: "https://203.0.113.87:9",
        adminToken: encryptJson("ADMIN"),
      })
    ).id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const plain = { debounce: { enabled: false }, split: { enabled: false } };
    const exclusion = {
      kind: "allowlist",
      phones: STAFF_PHONES,
      effect: "exclude",
    };
    const agents: Array<[number, Record<string, unknown>]> = [
      [
        INBOX_QUIET,
        {
          ...plain,
          contactAuth: {
            enabled: true,
            rule: exclusion,
            denyMessage: null,
            handoffEnabled: true,
            operatorNoteEnabled: false,
          },
        },
      ],
      [
        INBOX_TWO_STAGES,
        {
          ...plain,
          contactAuth: {
            enabled: true,
            rule: exclusion,
            askEndpointAfterRule: true,
            url: AUTH_URL,
            denyMessage: null,
            handoffEnabled: true,
            operatorNoteEnabled: false,
          },
        },
      ],
    ];
    for (const [inbox, settings] of agents) {
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: `caxe-${inbox}`,
          systemPrompt: "Você é prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: settings as never,
        },
        select: { id: true },
      });
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: inbox - 800,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("SECRET"),
          webhookRouteTokenHash: `caxe-${process.pid}-${inbox}`,
          name: "bot",
        },
      });
      const row = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: inbox,
          name: `caxe-${inbox}`,
          agentId: agent.id,
        },
        select: { id: true },
      });
      inboxDbIds.set(inbox, row.id);
    }
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
      "contact_auth_grants",
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

  test("a staff number, typed differently from the list: no reply, no note, opened for humans", async () => {
    const convId = 9711;
    await seedConversation(convId, INBOX_QUIET);
    const cw = stubChatwoot();
    const ep = countingEndpoint();
    await deliver({
      convId,
      inbox: INBOX_QUIET,
      phone: "+5521977776666",
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(cw.publicOn(convId)).toEqual([]);
    expect(cw.notesOn(convId)).toEqual([]);
    expect(cw.statusToggles).toEqual([[convId, "open"]]);
    expect(await gateLines(convId)).toEqual([
      expect.objectContaining({
        outcome: "denied",
        stage: "rule",
        reason: "rule_excluded",
      }),
    ]);
  });

  test("a new number: the agent answers", async () => {
    const convId = 9712;
    await seedConversation(convId, INBOX_QUIET);
    const cw = stubChatwoot();
    const ep = countingEndpoint();
    await deliver({
      convId,
      inbox: INBOX_QUIET,
      phone: "+5511912345678",
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
      reply: "Olá! Como posso ajudar?",
    });
    expect(cw.publicOn(convId)).toEqual(["Olá! Como posso ajudar?"]);
    expect(cw.statusToggles).toEqual([]);
    expect(await gateLines(convId)).toEqual([
      expect.objectContaining({ outcome: "allowed", stage: "rule" }),
    ]);
  });

  test("a contact with no phone and no identifier: the agent answers", async () => {
    const convId = 9713;
    await seedConversation(convId, INBOX_QUIET);
    const cw = stubChatwoot();
    const ep = countingEndpoint();
    await deliver({
      convId,
      inbox: INBOX_QUIET,
      phone: null,
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
      reply: "Oi!",
    });
    expect(cw.publicOn(convId)).toEqual(["Oi!"]);
    expect(cw.notesOn(convId)).toEqual([]);
    expect(await gateLines(convId)).toEqual([
      expect.objectContaining({ outcome: "allowed", stage: "rule" }),
    ]);
  });

  test("with the endpoint after the rule, a staff number never reaches it, and a new one does", async () => {
    const staff = 9714;
    await seedConversation(staff, INBOX_TWO_STAGES);
    const cw = stubChatwoot();
    const ep = countingEndpoint();
    await deliver({
      convId: staff,
      inbox: INBOX_TWO_STAGES,
      phone: "+55 (11) 98888-7777",
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(ep.calls()).toBe(0);
    expect(cw.publicOn(staff)).toEqual([]);
    expect(cw.statusToggles).toEqual([[staff, "open"]]);
    const lead = 9715;
    await seedConversation(lead, INBOX_TWO_STAGES);
    await deliver({
      convId: lead,
      inbox: INBOX_TWO_STAGES,
      phone: "+5511999990001",
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
      reply: "Posso ajudar!",
    });
    expect(ep.calls()).toBe(1);
    expect(cw.publicOn(lead)).toEqual(["Posso ajudar!"]);
  });
});
