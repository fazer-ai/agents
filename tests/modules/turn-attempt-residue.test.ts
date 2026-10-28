import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
} from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { getCheckpointer } from "@/graph/checkpointer";
import {
  conversationStamp,
  isNudgeTurn,
  nudgeMessage,
  sentAtStamp,
  stampedSource,
} from "@/graph/markers";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// What a failed attempt leaves in the thread, on the reactive flush with the real checkpointer: the
// customer's message must reach the retry once, a tool that already ran must not run again, and a
// thread carrying the residue of failed follow-ups is healed by the next turn that loads it.
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

let phantomJobId = 0n;
let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
const threads: string[] = [];

type Step = "tool" | "fail" | "text";

// The provider as far as these tests go: each call takes the next step of the script, records what it
// was sent, and a failure is the 429 an exhausted account answers with.
class ScriptedProvider extends BaseChatModel {
  seen: BaseMessage[][] = [];
  constructor(private steps: Step[]) {
    super({});
  }
  _llmType() {
    return "scripted";
  }
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    this.seen.push(messages);
    const step = this.steps.shift() ?? "text";
    if (step === "fail") {
      const err = new Error("429 You have no credits remaining") as Error & {
        status: number;
      };
      err.status = 429;
      throw err;
    }
    const message =
      step === "tool"
        ? new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "get_current_time",
                args: {},
                id: `call_${this.seen.length}`,
                type: "tool_call",
              },
            ],
          })
        : new AIMessage("Resposta");
    return { generations: [{ text: "", message }] };
  }
}

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

async function seedConversation(convId: number) {
  threads.push(threadOf(convId));
  const row = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

function client(pages: Array<{ id: number; content: string }>, sent: string[]) {
  return {
    getMessages: async () => ({
      payload: pages.map((m) => ({
        id: m.id,
        content: m.content,
        message_type: 0,
        private: false,
        created_at: 1_793_000_000 + m.id,
      })),
    }),
    sendMessage: async (_c: number, content: string) => {
      sent.push(content);
      return {};
    },
    sendPrivateNote: async () => ({}),
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
}

function jobFor(convId: number, attempts: number): ClaimedJob {
  return {
    id: phantomJobId,
    tenantId,
    kind: "DEBOUNCE",
    payload: { threadId: threadOf(convId), agentBotId: 9, burstStartedAt: 1 },
    attempts,
    claimSeq: 0,
  };
}

// The job as the scheduler runs it: a throw is a failed attempt, and the next one is the retry.
async function attempt(
  convId: number,
  n: number,
  model: ScriptedProvider,
  pages: Array<{ id: number; content: string }>,
  sent: string[],
): Promise<string> {
  try {
    const out = await flushDebounceJob({
      job: jobFor(convId, n),
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        makeClient: async () => client(pages, sent),
        checkpointer: await getCheckpointer(),
      },
    });
    return out.outcome;
  } catch {
    return "threw";
  }
}

async function storedMessages(convId: number): Promise<BaseMessage[]> {
  const cp = await (await getCheckpointer()).get({
    configurable: { thread_id: threadOf(convId) },
  });
  return ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
    []) as BaseMessage[];
}

// The model sees each customer line dated ("[26/10/2026 04:33] oi"); the date is rendered per call.
function contents(messages: BaseMessage[], type: string): string[] {
  return messages
    .filter((m) => m.getType() === type && !isNudgeTurn(m))
    .map((m) => String(m.content).replace(/^\[[^\]]+\] /, ""));
}

function directiveWithId(id: string, convId: number): HumanMessage {
  return new HumanMessage({
    id,
    content: "Faça o follow-up com o cliente.",
    additional_kwargs: nudgeMessage("", convId).additional_kwargs,
  });
}

describe.skipIf(!dbUp)(
  "what a failed turn attempt leaves in the thread",
  () => {
    beforeAll(async () => {
      phantomJobId = await burnSchedulerJobId(suDb);
      tenantId = (
        await suDb.tenant.create({
          data: { name: "Residue", slug: `residue-${process.pid}` },
        })
      ).id;
      instanceId = (
        await seedChatwootInstance(suDb, {
          tenantId,
          accountId: 9,
          baseUrl: "https://chat.example.com",
          adminToken: encryptJson("ADMIN"),
        })
      ).id;
      const key = await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
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
            credentialRef: `vault:${key.id}`,
          },
          settings: {
            debounce: { enabled: true, windowSeconds: 15 },
            split: { enabled: false },
          },
        },
      });
      await suDb.agentToolSelection.create({
        data: {
          tenantId,
          agentId: agent.id,
          source: "NATIVE",
          enabledTools: ["get_current_time"],
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
          webhookRouteTokenHash: `residue-route-${process.pid}`,
          name: "Atendente",
        },
      });
      inboxDbId = (
        await suDb.inbox.create({
          data: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootInboxId: 7,
            name: "Suporte",
            agentId: agent.id,
          },
        })
      ).id;
    });

    afterAll(async () => {
      const checkpointer = await getCheckpointer();
      for (const thread of threads) await checkpointer.deleteThread(thread);
      if (tenantId) {
        await clearFlowLog(suDb, { tenantId });
        for (const table of [
          "scheduler_jobs",
          "llm_usage",
          "agent_threads",
          "conversations",
          "chatwoot_agent_bots",
          "inboxes",
          "agent_tool_selections",
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

    test("a reply retried after the provider refused carries the customer's message once", async () => {
      const convId = 16_621;
      await seedConversation(convId);
      const model = new ScriptedProvider(["fail", "fail", "fail", "text"]);
      const sent: string[] = [];
      const pages = [{ id: 1, content: "qual o horário?" }];
      const outcomes: string[] = [];
      for (let n = 0; n < 4; n++)
        outcomes.push(await attempt(convId, n, model, pages, sent));

      expect(outcomes).toEqual(["threw", "threw", "threw", "done"]);
      expect(sent).toEqual(["Resposta"]);
      const answered = model.seen.at(-1) ?? [];
      expect(contents(answered, "human")).toEqual(["qual o horário?"]);
      const stored = await storedMessages(convId);
      expect(contents(stored, "human")).toEqual(["qual o horário?"]);
      expect(
        stored.filter((m) => m.getType() === "human").map(stampedSource),
      ).toEqual(["message:1"]);
    });

    test("a tool that ran before the failure stays in the thread for the retry", async () => {
      const convId = 16_622;
      await seedConversation(convId);
      const model = new ScriptedProvider(["tool", "fail", "text"]);
      const sent: string[] = [];
      const pages = [{ id: 1, content: "que horas são?" }];
      expect(await attempt(convId, 0, model, pages, sent)).toBe("threw");
      expect(await attempt(convId, 1, model, pages, sent)).toBe("done");

      expect(model.seen).toHaveLength(3);
      const answered = model.seen.at(-1) ?? [];
      expect(answered.filter((m) => m.getType() === "tool")).toHaveLength(1);
    });

    test("a reply that keeps failing stores the customer's message once after every attempt", async () => {
      const convId = 16_625;
      await seedConversation(convId);
      const model = new ScriptedProvider(["fail", "fail", "fail", "text"]);
      const sent: string[] = [];
      const pages = [{ id: 1, content: "ainda tem vaga?" }];
      const stored: number[] = [];
      for (let n = 0; n < 4; n++) {
        await attempt(convId, n, model, pages, sent);
        stored.push(contents(await storedMessages(convId), "human").length);
      }
      expect(stored).toEqual([1, 1, 1, 1]);
      expect(sent).toEqual(["Resposta"]);
    });

    test("a reply retried after its tool ran carries the customer's message once", async () => {
      const convId = 16_626;
      await seedConversation(convId);
      const model = new ScriptedProvider(["tool", "fail", "text"]);
      const sent: string[] = [];
      const pages = [{ id: 1, content: "cadê meu pedido?" }];
      expect(await attempt(convId, 0, model, pages, sent)).toBe("threw");
      expect(await attempt(convId, 1, model, pages, sent)).toBe("done");

      const answered = model.seen.at(-1) ?? [];
      expect(contents(answered, "human")).toEqual(["cadê meu pedido?"]);
      expect(answered.filter((m) => m.getType() === "tool")).toHaveLength(1);
      const stored = await storedMessages(convId);
      expect(contents(stored, "human")).toEqual(["cadê meu pedido?"]);
      expect(stored.filter((m) => m.getType() === "tool")).toHaveLength(1);
    });

    test("a thread carrying the residue of failed follow-ups is healed by the next turn", async () => {
      const convId = 16_623;
      const conversationId = await seedConversation(convId);
      const at = new Date("2026-10-20T12:00:00Z");
      const residue = [1, 2, 3].map((n) =>
        directiveWithId(`residue-${n}`, convId),
      );
      const answered = directiveWithId("answered-directive", convId);
      await buildThreadStateGraph(await getCheckpointer()).updateState(
        { configurable: { thread_id: threadOf(convId) } },
        {
          messages: [
            new HumanMessage({
              id: "h1",
              content: "quero um orçamento",
              additional_kwargs: {
                ...conversationStamp(convId),
                ...sentAtStamp(at),
              },
            }),
            new AIMessage({
              id: "a1",
              content: "Claro, me passa os detalhes.",
            }),
            answered,
            new AIMessage({ id: "a2", content: "Ainda tem interesse?" }),
            ...residue,
          ],
        },
        THREAD_STATE_NODE,
      );
      const model = new ScriptedProvider(["text"]);
      const sent: string[] = [];
      expect(
        await attempt(convId, 0, model, [{ id: 5, content: "voltei" }], sent),
      ).toBe("done");

      const input = model.seen[0] ?? [];
      // NOTE: the model is sent rendered copies (dated, renamed), so the ids are asserted on the thread.
      expect(input.filter(isNudgeTurn)).toHaveLength(2);
      expect(contents(input, "human")).toEqual([
        "quero um orçamento",
        "voltei",
      ]);
      expect(contents(input, "ai")).toEqual([
        "Claro, me passa os detalhes.",
        "Ainda tem interesse?",
      ]);
      const stored = await storedMessages(convId);
      expect(stored.filter(isNudgeTurn).map((m) => m.id)).toEqual([
        "answered-directive",
        "residue-3",
      ]);
      expect(contents(stored, "human")).toEqual([
        "quero um orçamento",
        "voltei",
      ]);
      const lines = (
        await flowLogRows(suDb, {
          orderBy: { id: "asc" },
          where: { tenantId, conversationId, stage: "memory" },
          select: { detail: true },
        })
      ).filter(
        (r) =>
          (r.detail as { reason?: unknown } | null)?.reason ===
          "repaired_unanswered_inputs",
      );
      expect(lines.map((r) => r.detail)).toEqual([
        { reason: "repaired_unanswered_inputs", directives: 2, duplicates: 0 },
      ]);
    });
  },
);
