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
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// ── THE GATE IN TWO STAGES, THROUGH THE WEBHOOK ──
//
// The rule decides first, before every gate that answers the customer, and a refusal there never
// reaches the endpoint; what it allows goes to the endpoint when the operator asked for both. A
// denial's private note is the operator's to switch off, and the quiet refusal (no copy, no note,
// handoff on) is what a gate used as a scope filter looks like. Driven end to end through
// processChatwootDelivery, with a recording Chatwoot and a counting endpoint.

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

const AUTH_URL = "https://203.0.113.19:9443/check";
const AWAY_COPY = "Estamos fora do horário.";
const DENY_COPY = "Este canal não atende esta conversa.";
const TZ = "America/Sao_Paulo";
// One agent per inbox, each a different shape of the gate.
const INBOX_TWO_STAGES = 881; // group rule, then the endpoint
const INBOX_QUIET = 882; // label rule, closed hours with an away copy, quiet refusal (note off)
const INBOX_NOTE_ON = 883; // the same, with the note left at its default
const INBOX_LEGACY_URL = 884; // a rule and a url left behind, without the flag: the rule alone
const INBOX_ENDPOINT_ONLY = 885; // no rule: the endpoint, after the closed hours, as always

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

function countingEndpoint(answer: "allow" | "deny") {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ authorized: answer === "allow" }), {
      status: 200,
    });
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
  groupType: "group" | "individual";
  labels?: string[];
  fetchImpl: typeof fetch;
  makeClient: () => Promise<ChatwootClient>;
  reply?: string;
}) {
  seq += 1;
  const n = normalizeChatwootEvent({
    event: "message_created",
    id: 8800 + seq,
    content: "olá, preciso de ajuda",
    message_type: "incoming",
    private: false,
    conversation: {
      id: params.convId,
      inbox_id: params.inbox,
      status: "pending",
      group_type: params.groupType,
      labels: params.labels ?? [],
      contact_inbox: { id: 92_000 + params.convId },
      meta: {
        assignee_type: null,
        assignee: null,
        sender: {
          id: 5000 + params.convId,
          name: "Cliente",
          phone_number: `+55119${String(70000000 + params.convId)}`,
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
      deliveryId: `cast-${process.pid}-${params.convId}-${seq}`,
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

function localDate(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

describe.skipIf(!dbUp)("the contact gate in two stages (webhook e2e)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAST", slug: `cast-${process.pid}` },
    });
    tenantId = t.id;
    instanceId = (
      await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 88,
        baseUrl: "https://203.0.113.88:9",
        adminToken: encryptJson("ADMIN"),
      })
    ).id;
    // Closed today and tomorrow by an exception, open all day otherwise: a closed reading can only
    // have come from the exception.
    const hours = await suDb.businessHours.create({
      data: {
        tenantId,
        name: "Atendimento",
        timezone: TZ,
        windows: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day,
          start: "00:00",
          end: "23:59",
        })),
        exceptions: [
          {
            date: localDate(0),
            dateEnd: localDate(1),
            label: "Recesso",
            ranges: [],
          },
        ],
      },
      select: { id: true },
    });
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
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
    const plain = { debounce: { enabled: false }, split: { enabled: false } };
    const closed = {
      ...plain,
      availability: { enabled: true, awayMessage: AWAY_COPY },
    };
    const agents: Array<[number, Record<string, unknown>, boolean]> = [
      [
        INBOX_TWO_STAGES,
        {
          ...plain,
          contactAuth: {
            enabled: true,
            rule: { kind: "conversation_type", type: "group" },
            askEndpointAfterRule: true,
            url: AUTH_URL,
            denyMessage: DENY_COPY,
            handoffEnabled: false,
          },
        },
        false,
      ],
      [
        INBOX_QUIET,
        {
          ...closed,
          contactAuth: {
            enabled: true,
            rule: { kind: "label", label: "suporte" },
            denyMessage: null,
            handoffEnabled: true,
            operatorNoteEnabled: false,
          },
        },
        true,
      ],
      [
        INBOX_NOTE_ON,
        {
          ...closed,
          contactAuth: {
            enabled: true,
            rule: { kind: "label", label: "suporte" },
            denyMessage: null,
            handoffEnabled: true,
          },
        },
        true,
      ],
      [
        INBOX_LEGACY_URL,
        {
          ...plain,
          contactAuth: {
            enabled: true,
            rule: { kind: "conversation_type", type: "group" },
            url: AUTH_URL,
            handoffEnabled: false,
          },
        },
        false,
      ],
      [
        INBOX_ENDPOINT_ONLY,
        {
          ...closed,
          contactAuth: {
            enabled: true,
            url: AUTH_URL,
            denyMessage: DENY_COPY,
            handoffEnabled: false,
          },
        },
        true,
      ],
    ];
    for (const [inbox, settings, withHours] of agents) {
      const agent = await suDb.agent.create({
        data: {
          ...baseAgent,
          name: `cast-${inbox}`,
          ...(withHours ? { businessHoursId: hours.id } : {}),
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
          webhookRouteTokenHash: `cast-${process.pid}-${inbox}`,
          name: "bot",
        },
      });
      const row = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: inbox,
          name: `cast-${inbox}`,
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
      "business_hours",
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

  test("the rule refuses: the endpoint is never asked, and the refusal is the rule's", async () => {
    const convId = 9811;
    await seedConversation(convId, INBOX_TWO_STAGES);
    const cw = stubChatwoot();
    const ep = countingEndpoint("allow");
    await deliver({
      convId,
      inbox: INBOX_TWO_STAGES,
      groupType: "individual",
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(ep.calls()).toBe(0);
    expect(cw.publicOn(convId)).toEqual([DENY_COPY]);
    expect(await gateLines(convId)).toEqual([
      expect.objectContaining({
        outcome: "denied",
        stage: "rule",
        reason: "rule_conversation_type",
      }),
    ]);
  });

  test("the rule allows: the endpoint decides, and allows the turn", async () => {
    const convId = 9812;
    await seedConversation(convId, INBOX_TWO_STAGES);
    const cw = stubChatwoot();
    const ep = countingEndpoint("allow");
    await deliver({
      convId,
      inbox: INBOX_TWO_STAGES,
      groupType: "group",
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
      reply: "Posso ajudar!",
    });
    expect(ep.calls()).toBe(1);
    expect(cw.publicOn(convId)).toEqual(["Posso ajudar!"]);
    // One line per message: the endpoint's, since the rule's allow was not the answer.
    expect(await gateLines(convId)).toEqual([
      expect.objectContaining({ outcome: "allowed", stage: "endpoint" }),
    ]);
  });

  test("the rule allows and the endpoint denies: the endpoint's refusal stands", async () => {
    const convId = 9813;
    await seedConversation(convId, INBOX_TWO_STAGES);
    const cw = stubChatwoot();
    const ep = countingEndpoint("deny");
    await deliver({
      convId,
      inbox: INBOX_TWO_STAGES,
      groupType: "group",
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(ep.calls()).toBe(1);
    expect(cw.publicOn(convId)).toEqual([DENY_COPY]);
    expect(await gateLines(convId)).toEqual([
      expect.objectContaining({ outcome: "denied", stage: "endpoint" }),
    ]);
  });

  test("a url left beside a rule without the flag is not asked", async () => {
    const convId = 9814;
    await seedConversation(convId, INBOX_LEGACY_URL);
    const cw = stubChatwoot();
    const ep = countingEndpoint("deny");
    await deliver({
      convId,
      inbox: INBOX_LEGACY_URL,
      groupType: "group",
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
      reply: "Oi!",
    });
    expect(ep.calls()).toBe(0);
    expect(cw.publicOn(convId)).toEqual(["Oi!"]);
  });

  test("the quiet refusal comes before the away message: no copy, no note, opened for humans", async () => {
    const convId = 9815;
    await seedConversation(convId, INBOX_QUIET);
    const cw = stubChatwoot();
    const ep = countingEndpoint("allow");
    await deliver({
      convId,
      inbox: INBOX_QUIET,
      groupType: "individual",
      labels: ["vendas"],
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(cw.publicOn(convId)).toEqual([]);
    expect(cw.notesOn(convId)).toEqual([]);
    expect(cw.statusToggles).toEqual([[convId, "open"]]);
    const conv = await suDb.conversation.findFirstOrThrow({
      where: { tenantId, chatwootConversationId: convId },
      select: { awayMessageSentAt: true, outOfHoursNoticeSentAt: true },
    });
    expect(conv.awayMessageSentAt).toBeNull();
    expect(conv.outOfHoursNoticeSentAt).toBeNull();
    expect(await gateLines(convId)).toEqual([
      expect.objectContaining({
        outcome: "denied",
        stage: "rule",
        reason: "rule_label",
      }),
    ]);
  });

  test("with the note at its default, the same refusal writes it", async () => {
    const convId = 9816;
    await seedConversation(convId, INBOX_NOTE_ON);
    const cw = stubChatwoot();
    const ep = countingEndpoint("allow");
    await deliver({
      convId,
      inbox: INBOX_NOTE_ON,
      groupType: "individual",
      labels: [],
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(cw.publicOn(convId)).toEqual([]);
    expect(cw.notesOn(convId)).toHaveLength(1);
    expect(cw.statusToggles).toEqual([[convId, "open"]]);
  });

  test("an allowed conversation still meets the closed hours after the rule", async () => {
    const convId = 9817;
    await seedConversation(convId, INBOX_QUIET);
    const cw = stubChatwoot();
    const ep = countingEndpoint("allow");
    await deliver({
      convId,
      inbox: INBOX_QUIET,
      groupType: "individual",
      labels: ["suporte"],
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(cw.publicOn(convId)).toEqual([AWAY_COPY]);
    expect(cw.statusToggles).toEqual([]);
  });

  test("with no rule the endpoint stays last: a closed inbox costs no call", async () => {
    const convId = 9818;
    await seedConversation(convId, INBOX_ENDPOINT_ONLY);
    const cw = stubChatwoot();
    const ep = countingEndpoint("deny");
    await deliver({
      convId,
      inbox: INBOX_ENDPOINT_ONLY,
      groupType: "individual",
      fetchImpl: ep.fetchImpl,
      makeClient: cw.makeClient,
    });
    expect(ep.calls()).toBe(0);
    expect(cw.publicOn(convId)).toEqual([AWAY_COPY]);
  });
});
