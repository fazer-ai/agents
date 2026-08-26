import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";

// A support report, end to end: a Calendar integration with ONE allowed calendar, and the agent
// calling availability with `calendarId` filled with something that is not a calendar (the model has
// no valid value in sight, because the block that lists the calendars is suppressed when there is
// nothing to choose). The tool refused, and the operator only got it working by telling the agent not
// to send the arg.
//
// The unit suite covers the resolver. This one covers the two things only a real turn can show: what
// the toolset ACTUALLY hands the provider after loadAgentConfig → buildToolpackTools (the arg must not
// be on the wire at all), and that a model which sends it anyway still gets slots and the customer
// still gets an answer.
//
// Asked of EVERY argument a conditional schema removes, not just calendarId: the integration here also
// pins the slot grid (1h visits on the half hour), which is the second instance of the same question —
// a model sending granularityMinutes: 15 got 14:15 back, a real, bookable slot the business does not
// sell. Same turn, same wire, one more pair of args.
//
// NOTE: the turn's SSRF guard is not injectable (prepare.ts builds the toolpack ctx without one), so
// this test resolves www.googleapis.com for real. Every HTTP response is stubbed; only DNS is live.

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

const LLM_BASE = "https://llm.example.com/v1";
const PINNED = "clinic@group.calendar.google.com";
// What a model fills an optional arg with when nothing tells it a valid value.
const INVENTED = "My Calendar Integration";
const REPLY = "Tenho horários livres nesse dia, qual prefere?";

let tenantId = 0n;
let instanceId = 0n;

interface Call {
  url: string;
  body: Record<string, unknown>;
}

// Personifies both hosts the turn talks to: the OpenAI-shaped provider (tool call first, answer
// second) and Google Calendar's freeBusy (a day with nothing busy).
function fakeHosts() {
  const llm: Call[] = [];
  const google: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const href = String(url instanceof Request ? url.url : url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    if (href.includes("googleapis.com")) {
      google.push({ url: href, body });
      return Response.json({ calendars: { [PINNED]: { busy: [] } } });
    }
    llm.push({ url: href, body });
    if (llm.length === 1) {
      return Response.json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_avail",
                  type: "function",
                  function: {
                    name: "calendar_check_availability",
                    arguments: JSON.stringify({
                      timeMin: "2099-06-22T00:00:00-03:00",
                      timeMax: "2099-06-22T23:00:00-03:00",
                      calendarId: INVENTED,
                      // The school's case: a grid the operator pinned, redefined per call. Sent
                      // from a stale tool definition, since neither arg is on the wire any more.
                      slotDurationMinutes: 15,
                      granularityMinutes: 15,
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      });
    }
    return Response.json({
      id: "chatcmpl-2",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: REPLY },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    });
  }) as unknown as typeof fetch;
  return {
    llm,
    google,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function stubClient(sent: Array<[number, string]>) {
  const client = {
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

const incoming = (conversationId: number): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId,
  inboxId: 7,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId: null,
  message: {
    id: 1,
    content: "quais horários vocês têm amanhã?",
    messageType: "incoming",
    private: false,
  },
});

// The availability tool as the provider received it, by name.
function toolOnTheWire(call: Call | undefined): Record<string, unknown> | null {
  const tools = (call?.body.tools ?? []) as Array<Record<string, unknown>>;
  const match = tools.find(
    (t) =>
      (t.function as { name?: string } | undefined)?.name ===
      "calendar_check_availability",
  );
  return (match?.function as Record<string, unknown>) ?? null;
}

describe.skipIf(!dbUp)("a turn on an integration with one calendar", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PC", slug: `pc-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    // A connected Google credential whose access token is still fresh, so the turn never attempts a
    // refresh (that path is a network call of its own).
    const gcalKey = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "gcal-cred",
        kind: "google_oauth",
        secret: encryptJson({
          clientId: "cid",
          clientSecret: "csecret",
          accessToken: "gcal-access",
          refreshToken: "gcal-refresh",
          expiresAt: Date.now() + 3_600_000,
        }),
      },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você agenda consultas.",
        modelConfig: {
          provider: "openai-compatible",
          model: "local-model",
          baseURL: LLM_BASE,
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: { split: { enabled: false } },
      },
    });
    const integration = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "GOOGLE_CALENDAR",
        name: "Agenda",
        credentialRef: `vault:${gcalKey.id}`,
        config: {
          calendarIds: [PINNED],
          calendarLabels: { [PINNED]: "Clinic" },
          // 1h appointments on the half hour, the configuration the report came from.
          slotDurationMinutes: 60,
          slotGranularityMinutes: 30,
        },
      },
      select: { id: true },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "INTEGRATION",
        integrationInstanceId: integration.id,
        enabledTools: ["calendar_check_availability"],
        knowledgeBaseIds: [],
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `pc-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: 801,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:801`,
        lastEventAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "agent_threads",
        "conversations",
        "contacts",
        "inboxes",
        "chatwoot_agent_bots",
        "agent_tool_selections",
        "integration_instances",
        "agents",
        "vault_entries",
        "chatwoot_instances",
        "chatwoot_deployments",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the arg never reaches the provider, and an invented one still books nothing but answers", async () => {
    const fake = fakeHosts();
    const sent: Array<[number, string]> = [];
    try {
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: incoming(801),
        base: appDb,
        deps: {
          makeClient: stubClient(sent),
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("posted");
    } finally {
      fake.restore();
    }

    // 1. The model sent a calendarId that is not a calendar, and the pinned one was queried anyway.
    expect(fake.google).toHaveLength(1);
    expect(fake.google[0]?.url).toContain("/freeBusy");
    expect(fake.google[0]?.body).toMatchObject({ items: [{ id: PINNED }] });

    // 2. What the model read back is availability, not a refusal.
    const followUp = fake.llm[1]?.body.messages as Array<
      Record<string, unknown>
    >;
    const toolReply = followUp?.find((m) => m.role === "tool");
    expect(String(toolReply?.content)).toContain("slots");
    expect(String(toolReply?.content)).not.toContain("not allowed");

    // 3. The customer got the answer.
    expect(sent).toEqual([[801, REPLY]]);

    // 4. And no argument the operator's configuration decides was on the wire to begin with.
    const fn = toolOnTheWire(fake.llm[0]);
    expect(fn).not.toBeNull();
    const params = fn?.parameters as { properties?: Record<string, unknown> };
    const onTheWire = Object.keys(params?.properties ?? {});
    expect(onTheWire).not.toContain("calendarId");
    expect(onTheWire).not.toContain("slotDurationMinutes");
    expect(onTheWire).not.toContain("granularityMinutes");
    expect(onTheWire).toContain("timeMin");

    // 5. The observable effect, which is the whole point: the start times the model read back sit on
    // the operator's grid, not on the 15-minute one it asked for. A `:15` here is the slot a family
    // would have shown up for.
    const slots = (
      JSON.parse(String(toolReply?.content)) as {
        slots: { start: string; end: string }[];
      }
    ).slots;
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(new Date(slot.start).getUTCMinutes() % 30).toBe(0);
      // 60 minutes long, the pinned duration — not the 15 the model sent.
      expect(Date.parse(slot.end) - Date.parse(slot.start)).toBe(3_600_000);
    }
  });
});
