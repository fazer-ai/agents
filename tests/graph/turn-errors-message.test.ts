import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentNudge } from "@/graph/nudge";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";
import { SlowFailingModel } from "../utils/scripted-models";

// A turn that survived an error says so in ONE message, through the real turn path (runAgentTurn and
// runAgentNudge → prepare → the tools → the message), in the format the agent asked for.

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

// Three tool calls in two rounds (one tool twice, one carrying an argument that must stay out of
// the note), then the reply. `withTools: false` replies at once.

// `react_to_message` fails without the network when the client cannot find the message (the stub
// below refuses the first `failFirst` lookups). Rounds: one call per round, then the reply.
class ScriptedModel {
  constructor(private calls: number) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage("Pronto!");
  }
  bindTools(_tools: unknown) {
    const calls = this.calls;
    let n = 0;
    return {
      async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
        n++;
        if (n > calls) return new AIMessage("Pronto!");
        return new AIMessage({
          content: "",
          tool_calls: [
            { name: "react_to_message", args: { emoji: "👍" }, id: `r${n}` },
          ],
        });
      },
    };
  }
}

type Sent = {
  conv: number;
  text: string;
  opts: Record<string, unknown>;
  id: number;
};

// A Chatwoot that keeps what was sent and lists it back, so a second turn can read the first one's
// message the way the real page does.
function chatwoot(failFirst: number, failAfter = Number.POSITIVE_INFINITY) {
  const sent: Sent[] = [];
  let id = 100;
  let lookups = 0;
  const send = async (
    conv: number,
    text: string,
    opts: Record<string, unknown> = {},
  ) => {
    const mid = id++;
    sent.push({ conv, text, opts, id: mid });
    return { id: mid };
  };
  const client = {
    sendMessage: send,
    sendPrivateNote: (conv: number, text: string, opts: object = {}) =>
      send(conv, text, { ...opts, private: true }),
    getLatestIncomingMessage: async () => {
      lookups++;
      if (lookups <= failFirst || lookups > failAfter)
        throw new Error("cliente Ana Souza não achado");
      return { id: 1, isReaction: false };
    },
    addMessageReaction: async () => ({}),
    toggleStatus: async () => ({}),
    toggleTyping: async () => ({}),
    getMessages: async () => ({
      payload: sent.map((s) => ({
        id: s.id,
        content: s.text,
        message_type: s.opts.messageType === "activity" ? 2 : 1,
        private: s.opts.private === true,
        content_attributes: {
          ...(s.opts.activityAttributes as object),
          ...(s.opts.activity ? { fazer_ai_activity: s.opts.activity } : {}),
        },
      })),
    }),
    getConversationLabels: async () => [],
    sendTemplate: async () => ({}),
  } as unknown as ChatwootClient;
  return { sent, makeClient: async () => client };
}

const errorsOf = (sent: Sent[]) =>
  sent.filter((s) => s.opts.activity === "errors");

const incoming = (
  conversationId: number,
  inboxId: number,
): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId,
  inboxId,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId: null,
  message: {
    id: 1,
    content: "reage aí",
    messageType: "incoming",
    private: false,
  },
});

const CONV_ACTIVITY = 1701;
const CONV_OFF = 1702;
const CONV_NUDGE = 1703;
const CONV_RECOVERED = 1704;
const CONV_NOTE = 1705;
const CONV_REPEAT = 1706;
const CONV_THROWS = 1707;
const CONV_FALLBACK = 1708;
const CONV_WORKED_THEN_FAILED = 1709;

describe.skipIf(!dbUp)("the turn-errors message", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TEM", slug: `tem-${process.pid}` },
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
    const agentWith = async (name: string, settings: object) =>
      suDb.agent.create({
        data: {
          tenantId,
          name,
          systemPrompt: "Você é prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: { split: { enabled: false }, ...settings },
        },
      });
    const on = await agentWith("Atividade", {
      conversationNotes: { errors: "activity" },
    });
    const note = await agentWith("Nota", {
      conversationNotes: { errors: "note" },
    });
    const off = await agentWith("Desligado", {});
    const withFallback = await agentWith("Com fallback", {
      conversationNotes: { errors: "activity" },
      modelFallback: {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        credentialRef: `vault:${llmKey.id}`,
      },
    });
    for (const [agent, botId] of [
      [on, 40],
      [off, 41],
      [note, 42],
      [withFallback, 43],
    ] as const) {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: botId,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `rt-tem-${process.pid}-${botId}`,
          name: agent.name,
        },
      });
    }
    for (const [agent, inboxId, conv] of [
      [on, 71, CONV_ACTIVITY],
      [off, 72, CONV_OFF],
      [on, 73, CONV_NUDGE],
      [on, 74, CONV_RECOVERED],
      [note, 75, CONV_NOTE],
      [on, 76, CONV_REPEAT],
      [on, 77, CONV_THROWS],
      [withFallback, 78, CONV_FALLBACK],
      [on, 79, CONV_WORKED_THEN_FAILED],
    ] as const) {
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: inboxId,
          name: `Inbox ${inboxId}`,
          agentId: agent.id,
          channelType: "Channel::Whatsapp",
          provider: "whatsapp_cloud",
        },
      });
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          inboxId: inbox.id,
          chatwootConversationId: conv,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:${conv}`,
          lastEventAt: new Date(),
          lastInboundAt: new Date(),
        },
      });
    }
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "scheduler_jobs",
        "agent_threads",
        "conversations",
        "contacts",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "vault_entries",
        "chatwoot_instances",
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

  const turn = (
    conv: number,
    inboxId: number,
    cw: ReturnType<typeof chatwoot>,
    model: object,
  ) =>
    runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: null,
      event: incoming(conv, inboxId),
      base: appDb,
      deps: {
        makeModel: () => model as never,
        makeClient: cw.makeClient,
        checkpointer: new MemorySaver(),
      },
    });

  test("a tool that failed and the turn went on: one activity row, after the reply", async () => {
    const cw = chatwoot(Number.POSITIVE_INFINITY);
    expect(await turn(CONV_ACTIVITY, 71, cw, new ScriptedModel(2))).toBe(
      "posted",
    );
    const errs = errorsOf(cw.sent);
    expect(errs).toHaveLength(1);
    const msg = errs[0] as Sent;
    expect(msg.opts.messageType).toBe("activity");
    expect(msg.opts.private).toBeUndefined();
    expect(msg.text).toContain("react_to_message: falhou 2x (erro)");
    expect(msg.text).toContain("Não se recuperou");
    expect(msg.text).toMatch(
      new RegExp(`/logs\\?turnId=\\S+&switchTenant=${tenantId}$`),
    );
    expect(msg.text).not.toContain("Ana Souza");
    // NOTE: The reply first, so the message reads below it in the timeline.
    expect(cw.sent.at(-1)).toBe(msg);
  });

  test("a tool that failed and then worked says the turn recovered", async () => {
    const cw = chatwoot(1);
    await turn(CONV_RECOVERED, 74, cw, new ScriptedModel(2));
    const errs = errorsOf(cw.sent);
    expect(errs).toHaveLength(1);
    expect((errs[0] as Sent).text).toContain(
      "react_to_message: falhou (erro). Se recuperou",
    );
  });

  test("a tool that worked and then failed did not recover", async () => {
    const cw = chatwoot(0, 1);
    await turn(CONV_WORKED_THEN_FAILED, 79, cw, new ScriptedModel(2));
    const errs = errorsOf(cw.sent);
    expect(errs).toHaveLength(1);
    expect((errs[0] as Sent).text).toContain(
      "react_to_message: falhou (erro). Não se recuperou",
    );
  });

  test("the note format posts a private note instead", async () => {
    const cw = chatwoot(Number.POSITIVE_INFINITY);
    await turn(CONV_NOTE, 75, cw, new ScriptedModel(1));
    const errs = errorsOf(cw.sent);
    expect(errs).toHaveLength(1);
    expect((errs[0] as Sent).opts.private).toBe(true);
    expect((errs[0] as Sent).opts.messageType).toBeUndefined();
  });

  test("an agent that never asked says nothing", async () => {
    const cw = chatwoot(Number.POSITIVE_INFINITY);
    expect(await turn(CONV_OFF, 72, cw, new ScriptedModel(1))).toBe("posted");
    expect(errorsOf(cw.sent)).toHaveLength(0);
  });

  test("the same failure on the next turn is not said again", async () => {
    const cw = chatwoot(Number.POSITIVE_INFINITY);
    await turn(CONV_REPEAT, 76, cw, new ScriptedModel(1));
    await turn(CONV_REPEAT, 76, cw, new ScriptedModel(1));
    expect(errorsOf(cw.sent)).toHaveLength(1);
  });

  test("a reply only the fallback wrote says the primary failed and the turn recovered", async () => {
    const cw = chatwoot(0);
    const primary = new SlowFailingModel(
      Object.assign(new Error("overloaded at http://10.0.0.9/v1"), {
        status: 503,
      }),
      0,
    );
    expect(
      await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: null,
        event: incoming(CONV_FALLBACK, 78),
        base: appDb,
        deps: {
          makeModel: (mc) =>
            (mc.provider === "anthropic"
              ? new ScriptedModel(0)
              : primary) as never,
          makeClient: cw.makeClient,
          checkpointer: new MemorySaver(),
        },
      }),
    ).toBe("posted");
    const errs = errorsOf(cw.sent);
    expect(errs).toHaveLength(1);
    const text = (errs[0] as Sent).text;
    expect(text).toContain(
      "Modelo principal: falhou (HTTP 503). Se recuperou: o modelo de fallback respondeu.",
    );
    expect(text).not.toContain("10.0.0.9");
  });

  test("a turn that throws says nothing: it is retried or lost", async () => {
    const cw = chatwoot(Number.POSITIVE_INFINITY);
    let n = 0;
    const model = {
      async invoke() {
        return new AIMessage("x");
      },
      bindTools() {
        return {
          async invoke() {
            n++;
            if (n === 1)
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "react_to_message", args: { emoji: "👍" }, id: "t1" },
                ],
              });
            throw new Error("provider down");
          },
        };
      },
    };
    await expect(turn(CONV_THROWS, 77, cw, model)).rejects.toThrow();
    expect(errorsOf(cw.sent)).toHaveLength(0);
  });

  test("a proactive turn posts it too, and its outcome line names it", async () => {
    const cw = chatwoot(Number.POSITIVE_INFINITY);
    await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:${CONV_NUDGE}`,
      nudge: { source: "followup", kind: "inactivity", step: 1 },
      base: appDb,
      deps: {
        makeModel: () => new ScriptedModel(1) as never,
        makeClient: cw.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    });
    const errs = errorsOf(cw.sent);
    expect(errs).toHaveLength(1);
    expect(cw.sent.at(-1)).toBe(errs[0]);
    const rows = await flowLogRows(suDb, {
      orderBy: { id: "asc" },
      where: {
        tenantId,
        stage: "generate",
        threadId: `${tenantId}:${instanceId}:${CONV_NUDGE}`,
      },
      select: { detail: true },
    });
    const outcome = rows
      .map((r) => r.detail as Record<string, unknown> | null)
      .find((d) => typeof d?.outcome === "string");
    expect(outcome?.sentMessageIds).toEqual(cw.sent.map((s) => s.id));
  });
});
