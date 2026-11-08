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

// A turn that called tools leaves ONE private note naming them, through the real turn path
// (runAgentTurn and runAgentNudge → prepare → the tools → the note), and only for an agent that asked.

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

const EXPRESSION = "48213*7";

// Three tool calls in two rounds (one tool twice, one carrying an argument that must stay out of
// the note), then the reply. `withTools: false` replies at once.
class ScriptedModel {
  constructor(private withTools: boolean) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage("Pronto!");
  }
  bindTools(_tools: unknown) {
    const withTools = this.withTools;
    let n = 0;
    return {
      async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
        n++;
        if (!withTools || n > 2) return new AIMessage("Pronto!");
        return new AIMessage({
          content: "",
          tool_calls:
            n === 1
              ? [
                  { name: "get_current_time", args: {}, id: `c${n}a` },
                  {
                    name: "calculator",
                    args: { expression: EXPRESSION },
                    id: `c${n}b`,
                  },
                ]
              : [{ name: "get_current_time", args: {}, id: `c${n}a` }],
        });
      },
    };
  }
}

type Sent = {
  conv: number;
  text: string;
  opts: unknown;
  private: boolean;
  id: number;
};

function chatwoot() {
  const sent: Sent[] = [];
  let id = 100;
  const client = {
    sendMessage: async (
      conv: number,
      text: string,
      opts: { private?: boolean } = {},
    ) => {
      const mid = id++;
      sent.push({ conv, text, opts, private: opts.private === true, id: mid });
      return { id: mid };
    },
    sendPrivateNote: async (conv: number, text: string, opts: unknown) => {
      const mid = id++;
      sent.push({ conv, text, opts, private: true, id: mid });
      return { id: mid };
    },
    toggleStatus: async () => ({}),
    toggleTyping: async () => ({}),
    getMessages: async () => ({ payload: [] }),
    getConversationLabels: async () => [],
    sendTemplate: async () => ({}),
  } as unknown as ChatwootClient;
  return { sent, makeClient: async () => client };
}

const notesOf = (sent: Sent[]) => sent.filter((s) => s.private);

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
    content: "que horas são?",
    messageType: "incoming",
    private: false,
  },
});

const CONV_ON = 1601;
const CONV_OFF = 1602;
const CONV_NUDGE = 1603;
const CONV_NO_TOOL = 1604;

describe.skipIf(!dbUp)("the tools-used note", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "TUN", slug: `tun-${process.pid}` },
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
    const on = await agentWith("Com nota", {
      conversationNotes: { toolsUsed: true },
    });
    const off = await agentWith("Sem nota", {});
    for (const [agent, botId] of [
      [on, 30],
      [off, 31],
    ] as const) {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: botId,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `rt-tun-${process.pid}-${botId}`,
          name: agent.name,
        },
      });
    }
    for (const [agent, inboxId, conv] of [
      [on, 61, CONV_ON],
      [off, 62, CONV_OFF],
      [on, 63, CONV_NUDGE],
      [on, 64, CONV_NO_TOOL],
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

  const turn = (conv: number, inboxId: number, withTools: boolean) => {
    const cw = chatwoot();
    return {
      cw,
      run: () =>
        runAgentTurn({
          tenantId,
          instanceId,
          agentBotId: null,
          event: incoming(conv, inboxId),
          base: appDb,
          deps: {
            makeModel: () => new ScriptedModel(withTools) as never,
            makeClient: cw.makeClient,
            checkpointer: new MemorySaver(),
          },
        }),
    };
  };

  test("a turn of three calls posts one note, after the reply, with the names and no argument", async () => {
    const { cw, run } = turn(CONV_ON, 61, true);
    expect(await run()).toBe("posted");
    const notes = notesOf(cw.sent);
    expect(notes).toHaveLength(1);
    const note = notes[0] as Sent;
    expect(note.conv).toBe(CONV_ON);
    expect(note.text).toBe(
      "Ferramentas usadas pelo agente neste turno: get_current_time (2x), calculator.",
    );
    expect(note.text).not.toContain(EXPRESSION);
    expect(note.opts).toEqual({ activity: "tools" });
    // NOTE: The reply first, so the note reads below it in the timeline.
    expect(cw.sent.map((s) => s.private)).toEqual([false, true]);
  });

  test("a turn that called no tool posts no note", async () => {
    const { cw, run } = turn(CONV_NO_TOOL, 64, false);
    expect(await run()).toBe("posted");
    expect(notesOf(cw.sent)).toHaveLength(0);
    expect(cw.sent).toHaveLength(1);
  });

  test("an agent that never asked posts no note", async () => {
    const { cw, run } = turn(CONV_OFF, 62, true);
    expect(await run()).toBe("posted");
    expect(notesOf(cw.sent)).toHaveLength(0);
  });

  test("a proactive turn posts its note too", async () => {
    const cw = chatwoot();
    await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:${CONV_NUDGE}`,
      nudge: { source: "followup", kind: "inactivity", step: 1 },
      base: appDb,
      deps: {
        makeModel: () => new ScriptedModel(true) as never,
        makeClient: cw.makeClient,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    });
    const notes = notesOf(cw.sent);
    expect(notes).toHaveLength(1);
    expect((notes[0] as Sent).text).toContain("get_current_time (2x)");
    expect((notes[0] as Sent).opts).toEqual({ activity: "tools" });
    expect(cw.sent.at(-1)?.private).toBe(true);
    // The outcome line closes the turn AFTER the note, so the note is one of the messages it
    // names (what the conversation screen hangs the turn's usage on).
    const rows = await flowLogRows(suDb, {
      orderBy: { id: "asc" },
      where: {
        tenantId,
        stage: "generate",
        threadId: `${tenantId}:${instanceId}:${CONV_NUDGE}`,
      },
      select: { detail: true },
    });
    const outcomeLines = rows
      .map((r) => r.detail as Record<string, unknown> | null)
      .filter((d) => typeof d?.outcome === "string");
    expect(outcomeLines).toHaveLength(1);
    const noteId = (notes[0] as Sent).id;
    expect(cw.sent.at(-1)?.id).toBe(noteId);
    expect(outcomeLines[0]?.sentMessageIds).toEqual(cw.sent.map((s) => s.id));
  });
});
