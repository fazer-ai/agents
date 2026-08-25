import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import { isNudgeTurn } from "@/graph/markers";
import { runAgentNudge } from "@/graph/nudge";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { seedChatwootInstance } from "../utils/chatwoot";

// THE EFFECT, WHERE THE ISSUE SAYS IT IS: the memory thread, after a proactive turn was generated and
// then refused. `tests/graph/refused-turn.test.ts` proves the RULE; this proves the turn actually
// reaches it, through the real `runAgentNudge`, with a real checkpointer.
//
// Measured on `main`, with the job retired during generation. This is the state the file exists to end:
//
//   OUTCOME: stale   SENT TO CUSTOMER: []
//   channel: [human] An external system event just occurred…   [ai] Oi, ainda precisa de ajuda?
//
// Issue #251.

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
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;

// The retirement lands DURING generation, which is the only position that produces the defect: a
// `/reset` before the run starts never reaches the invoke, and one after the send is too late to
// suppress anything.
class RetiringModel extends BaseChatModel {
  constructor(
    private readonly retire: () => void,
    private readonly text: string,
  ) {
    super({});
  }
  _llmType() {
    return "retiring";
  }
  async _generate(): Promise<ChatResult> {
    this.retire();
    return {
      generations: [{ text: this.text, message: new AIMessage(this.text) }],
    };
  }
}

// The same retirement, on a turn that transferred the conversation first. The tool call is the whole
// point: it happened, to the outside world, and the history is the only record of it.
class RetiringHandoffModel {
  constructor(
    private readonly retire: () => void,
    private readonly reply: string,
  ) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        if (n === 1) {
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "handoff_to_human",
                args: { customerMessage: "Já te transfiro." },
                id: "call_handoff",
              },
            ],
          });
        }
        self.retire();
        return new AIMessage(self.reply);
      },
    };
  }
}

function stub() {
  const messages: Array<[number, string]> = [];
  const notes: Array<[number, string]> = [];
  const client = {
    sendMessage: async (c: number, t: string) => {
      messages.push([c, t]);
      return {};
    },
    sendPrivateNote: async (c: number, t: string) => {
      notes.push([c, t]);
      return {};
    },
    getConversationLabels: async () => [],
    setConversationLabels: async () => ({}),
    toggleStatus: async () => ({}),
    getConversation: async () => ({
      id: 1,
      status: "pending",
      meta: { assignee: null },
    }),
  } as unknown as ChatwootClient;
  return { messages, notes, client, makeClient: async () => client };
}

async function seedConv(convId: number, contactInboxId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inboxDbId,
      chatwootConversationId: convId,
      contactInboxId,
      status: "pending",
      assigneeType: null,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
      lastInboundAt: new Date(),
    },
  });
}

// The attendance that was already on the thread before the nudge fired. Every assertion below is
// about what SURVIVES as much as about what goes: a rollback that took the customer's own words with
// it would be a worse defect than the one it fixes.
async function seedHistory(
  checkpointer: MemorySaver,
  graphThreadId: string,
): Promise<void> {
  await buildThreadStateGraph(checkpointer).updateState(
    { configurable: { thread_id: graphThreadId } },
    {
      messages: [
        new HumanMessage({ id: "hist-1", content: "bom dia" }),
        new AIMessage({ id: "hist-2", content: "Bom dia! Como posso ajudar?" }),
      ],
    },
    THREAD_STATE_NODE,
  );
}

async function channel(
  checkpointer: MemorySaver,
  graphThreadId: string,
): Promise<BaseMessage[]> {
  const state = await buildThreadStateGraph(checkpointer).getState({
    configurable: { thread_id: graphThreadId },
  });
  return ((state.values as { messages?: BaseMessage[] } | undefined)
    ?.messages ?? []) as BaseMessage[];
}

const textOf = (m: BaseMessage): string =>
  typeof m.content === "string" ? m.content : JSON.stringify(m.content);

describe.skipIf(!dbUp)(
  "a refused proactive turn leaves no trace in memory",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "RB", slug: `rb-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 9,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const vault = await suDb.vaultEntry.create({
        data: { tenantId, name: "k", secret: encryptJson("sk") },
        select: { id: true },
      });
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${vault.id}`,
          },
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
          webhookRouteTokenHash: `rb-route-${process.pid}`,
          name: "Atendente",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: 7,
          name: "Suporte",
          agentId: agent.id,
          channelType: "Channel::Whatsapp",
          provider: "whatsapp_cloud",
        },
      });
      inboxDbId = inbox.id;
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "llm_usage",
          "scheduler_jobs",
          "agent_threads",
          "conversations",
          "inboxes",
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

    test("a job retired during generation takes its turn back out of the history", async () => {
      const contactInboxId = 7251;
      await seedConv(9251, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const checkpointer = new MemorySaver();
      await seedHistory(checkpointer, graphThreadId);
      const s = stub();
      let wanted = true;
      const outcome = await runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:9251`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        stillWanted: async () => wanted,
        base: appDb,
        deps: {
          makeModel: () =>
            new RetiringModel(() => {
              wanted = false;
            }, "Oi, ainda precisa de ajuda?"),
          makeClient: s.makeClient,
          checkpointer,
          persistUsage: async () => {},
        },
      });

      expect(outcome).toBe("stale");
      expect(s.messages).toEqual([]);
      expect(s.notes).toEqual([]);
      const after = await channel(checkpointer, graphThreadId);
      // The turn is gone…
      expect(after.some((m) => isNudgeTurn(m))).toBe(false);
      expect(after.map(textOf).join("\n")).not.toContain(
        "ainda precisa de ajuda",
      );
      // …and the attendance it fired on top of is untouched.
      expect(after.map((m) => m.id)).toEqual(["hist-1", "hist-2"]);
    });

    test("a turn that transferred the conversation keeps its history, refused or not", async () => {
      const contactInboxId = 7252;
      await seedConv(9252, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const checkpointer = new MemorySaver();
      await seedHistory(checkpointer, graphThreadId);
      const s = stub();
      let wanted = true;
      const outcome = await runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:9252`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        stillWanted: async () => wanted,
        base: appDb,
        deps: {
          makeModel: () =>
            new RetiringHandoffModel(() => {
              wanted = false;
            }, "Vou te transferir para um atendente.") as never,
          makeClient: s.makeClient,
          checkpointer,
          persistUsage: async () => {},
        },
      });

      expect(outcome).toBe("stale");
      const after = await channel(checkpointer, graphThreadId);
      // The transfer ran inside the graph and this fence never could reverse it, so the record of it
      // stays: erasing the turn would erase the only account of an act that really happened.
      expect(after.some((m) => isNudgeTurn(m))).toBe(true);
      expect(
        after.some((m) => ((m as AIMessage).tool_calls?.length ?? 0) > 0),
      ).toBe(true);
    });

    // The hazard `src/graph/inflight.ts` exists for, asked from this side: a reactive turn invoking on
    // this same memory thread is a read-modify-write of the whole channel, so it will save back
    // whatever it loaded. A removal written underneath it is undone the moment it finishes, and the
    // history ends up exactly where it started with a checkpoint claiming otherwise. Standing down is
    // the honest answer, and this pins that it stands down rather than writing that checkpoint.
    test("another invoke holding the thread defers the rollback instead of racing it", async () => {
      const contactInboxId = 7254;
      await seedConv(9254, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const checkpointer = new MemorySaver();
      await seedHistory(checkpointer, graphThreadId);
      const s = stub();
      let wanted = true;
      // A reactive turn that started before this nudge and has not finished. Released in the finally,
      // or every later test on this thread would inherit the claim.
      markTurnInFlight(graphThreadId);
      let outcome: string;
      try {
        outcome = await runAgentNudge({
          tenantId,
          threadId: `${tenantId}:${instanceId}:9254`,
          nudge: { source: "followup", kind: "inactivity", step: 1 },
          stillWanted: async () => wanted,
          base: appDb,
          deps: {
            makeModel: () =>
              new RetiringModel(() => {
                wanted = false;
              }, "Oi, ainda precisa de ajuda?"),
            makeClient: s.makeClient,
            checkpointer,
            persistUsage: async () => {},
          },
        });
      } finally {
        clearTurnInFlight(graphThreadId);
      }

      expect(outcome).toBe("stale");
      expect(s.messages).toEqual([]);
      const after = await channel(checkpointer, graphThreadId);
      expect(after.some((m) => isNudgeTurn(m))).toBe(true);
      expect(after.map(textOf).join("\n")).toContain("ainda precisa de ajuda");
    });

    test("a turn that reached the customer stays in the history, where it belongs", async () => {
      const contactInboxId = 7253;
      await seedConv(9253, contactInboxId);
      const graphThreadId = contactInboxThreadId(
        tenantId,
        instanceId,
        contactInboxId,
      );
      const checkpointer = new MemorySaver();
      await seedHistory(checkpointer, graphThreadId);
      const s = stub();
      const outcome = await runAgentNudge({
        tenantId,
        threadId: `${tenantId}:${instanceId}:9253`,
        nudge: { source: "followup", kind: "inactivity", step: 1 },
        stillWanted: async () => true,
        base: appDb,
        deps: {
          makeModel: () =>
            new RetiringModel(() => {}, "Oi, ainda precisa de ajuda?"),
          makeClient: s.makeClient,
          checkpointer,
          persistUsage: async () => {},
        },
      });

      expect(outcome).toBe("messaged");
      expect(s.messages).toEqual([[9253, "Oi, ainda precisa de ajuda?"]]);
      const after = await channel(checkpointer, graphThreadId);
      expect(after.some((m) => isNudgeTurn(m))).toBe(true);
      expect(after.map(textOf).join("\n")).toContain("ainda precisa de ajuda");
    });
  },
);
