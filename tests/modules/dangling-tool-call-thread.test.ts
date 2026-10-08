import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { getCheckpointer } from "@/graph/checkpointer";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "@/graph/thread-state";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { reengageConversation } from "@/modules/conversations/reengage";
import { flushDebounceJob } from "@/modules/debounce/handler";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";
import {
  assistantCalling,
  orphansIn,
  StrictProvider,
} from "@/tests/utils/strict-provider";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// A THREAD THE CHECKPOINTER WROTE, NOT ONE THE TEST HANDED THE GRAPH. The defect lives in what a
// killed turn left in Postgres and what the next turn loads back from it: `MemorySaver` keeps the
// object graph in memory and proves nothing about the serde, which is what rebuilds `tool_calls` and
// `response_metadata.output` for the replay. Both entry points that load a thread are driven: the
// reactive flush and the operator's re-engage.
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

let phantomJobId = 0n;
let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
const threads: string[] = [];

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

async function seedConversation(convId: number) {
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

// What a turn killed between checkpointing the calls and running them leaves behind.
async function seedInterruptedThread(convId: number, messages: BaseMessage[]) {
  const thread = threadOf(convId);
  threads.push(thread);
  const checkpointer = await getCheckpointer();
  await buildThreadStateGraph(checkpointer).updateState(
    { configurable: { thread_id: thread } },
    { messages },
    THREAD_STATE_NODE,
  );
  return checkpointer;
}

async function storedMessages(convId: number): Promise<BaseMessage[]> {
  const checkpointer = await getCheckpointer();
  const cp = await checkpointer.get({
    configurable: { thread_id: threadOf(convId) },
  });
  return ((cp?.channel_values as { messages?: BaseMessage[] })?.messages ??
    []) as BaseMessage[];
}

function client(
  pages: Array<{ id: number; content: string }>,
  sent: Array<[number, string]>,
) {
  return {
    getMessages: async () => ({
      payload: pages.map((m) => ({
        id: m.id,
        content: m.content,
        message_type: 0,
        private: false,
      })),
    }),
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
    sendPrivateNote: async () => ({}),
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
}

function jobFor(convId: number): ClaimedJob {
  return {
    id: phantomJobId,
    tenantId,
    kind: "DEBOUNCE",
    payload: { threadId: threadOf(convId), agentBotId: 9, burstStartedAt: 1 },
    attempts: 0,
    claimSeq: 0,
  };
}

async function repairLines(conversationId: bigint) {
  const rows = await flowLogRows(suDb, {
    where: { tenantId, conversationId, stage: "memory" },
    select: { level: true, detail: true },
  });
  return rows.filter(
    (r) =>
      (r.detail as { reason?: unknown } | null)?.reason ===
      "repaired_dangling_tool_call",
  );
}

// The Responses API as far as this defect goes, behind the real `@langchain/openai` adapter, so the
// assertion is on what the adapter SERIALIZES from the stored thread, not on the message objects: a
// `function_call` input item needs its `function_call_output`, and a `reasoning` item cannot be the
// last thing before the next turn. Refused the way OpenAI refuses it, with the same 400.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
type InputItem = { type?: string; call_id?: string; role?: string };
const responsesRequests: InputItem[][] = [];
const responsesServer = Bun.serve({
  port: 0,
  async fetch(req) {
    if (req.method === "OPTIONS")
      return new BunResponse(null, { status: 204, headers: CORS });
    const body = (await req.json()) as { input?: InputItem[] };
    const input = body.input ?? [];
    responsesRequests.push(input);
    const outputs = new Set(
      input
        .filter((i) => i.type === "function_call_output")
        .map((i) => i.call_id),
    );
    const orphan = input.find(
      (i) => i.type === "function_call" && !outputs.has(i.call_id),
    );
    const loneReasoning = input.findIndex(
      (i, n) =>
        i.type === "reasoning" &&
        input[n + 1]?.type !== "function_call" &&
        input[n + 1]?.role !== "assistant" &&
        input[n + 1]?.type !== "message",
    );
    const refusal = orphan
      ? `No tool output found for function call ${orphan.call_id}.`
      : loneReasoning >= 0
        ? "Item of type 'reasoning' was provided without its required following item."
        : null;
    if (refusal)
      return BunResponse.json(
        {
          error: {
            message: refusal,
            type: "invalid_request_error",
            param: "input",
            code: null,
          },
        },
        { status: 400, headers: CORS },
      );
    return BunResponse.json(
      {
        id: "resp_1",
        object: "response",
        created_at: 1,
        status: "completed",
        model: "gpt-5.6-luna",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            status: "completed",
            content: [
              {
                type: "output_text",
                text: "Resposta pelo fio",
                annotations: [],
              },
            ],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
      { headers: CORS },
    );
  },
});

function responsesModel() {
  return new ChatOpenAI({
    model: "gpt-5.6-luna",
    apiKey: "sk-test",
    useResponsesApi: true,
    maxRetries: 0,
    configuration: { baseURL: `http://localhost:${responsesServer.port}/v1` },
  });
}

describe.skipIf(!dbUp)(
  "a thread left with an unanswered tool call in Postgres",
  () => {
    beforeAll(async () => {
      phantomJobId = await burnSchedulerJobId(suDb);
      const t = await suDb.tenant.create({
        data: { name: "DTC", slug: `dtc-${process.pid}` },
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
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: {
            debounce: { enabled: true, windowSeconds: 15 },
            split: { enabled: false },
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
          webhookRouteTokenHash: `dtc-route-${process.pid}`,
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
        },
      });
      inboxDbId = inbox.id;
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
      responsesServer.stop(true);
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("the customer's next message is answered and the repair is logged once", async () => {
      const convId = 1166;
      const conversationId = await seedConversation(convId);
      const checkpointer = await seedInterruptedThread(convId, [
        new HumanMessage({ id: "h1", content: "qual o horário do show?" }),
        assistantCalling("ai1", ["call_interrompida"]),
      ]);
      const model = new StrictProvider("Resposta recuperada");
      const sent: Array<[number, string]> = [];
      const pages = [
        { id: 1, content: "qual o horário do show?" },
        { id: 2, content: "pode responder agora?" },
      ];

      const out = await flushDebounceJob({
        job: jobFor(convId),
        base: appDb,
        deps: {
          makeModel: () => model as unknown as BaseChatModel,
          makeClient: async () => client(pages, sent),
          checkpointer,
        },
      });

      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([[convId, "Resposta recuperada"]]);
      expect(model.seen.length).toBeGreaterThan(0);
      for (const request of model.seen) expect(orphansIn(request)).toEqual([]);
      const stored = await storedMessages(convId);
      expect(orphansIn(stored)).toEqual([]);
      expect(stored.map((m) => m.content)).toContain("qual o horário do show?");
      expect(await repairLines(conversationId)).toHaveLength(1);

      // The next turn loads the repaired thread: it answers and logs nothing more.
      const next = new StrictProvider("Segunda resposta");
      await flushDebounceJob({
        job: jobFor(convId),
        base: appDb,
        deps: {
          makeModel: () => next as unknown as BaseChatModel,
          makeClient: async () =>
            client([...pages, { id: 3, content: "e o estacionamento?" }], sent),
          checkpointer: await getCheckpointer(),
        },
      });
      expect(sent.at(-1)).toEqual([convId, "Segunda resposta"]);
      for (const request of next.seen) expect(orphansIn(request)).toEqual([]);
      expect(await repairLines(conversationId)).toHaveLength(1);
    });

    test("the operator's re-engage answers a thread that ends on the unanswered call", async () => {
      const convId = 1167;
      const conversationId = await seedConversation(convId);
      const checkpointer = await seedInterruptedThread(convId, [
        new HumanMessage({
          id: "h1",
          content: "o ingresso dá direito a tudo?",
        }),
        assistantCalling("ai1", ["call_parcial_a", "call_reengage"]),
      ]);
      const model = new StrictProvider("Resposta do re-engage");
      const sent: Array<[number, string]> = [];

      const clicked = await reengageConversation(
        { tenantId, userId: null, role: "TENANT_ADMIN" },
        conversationId,
        {
          makeModel: () => model as unknown as BaseChatModel,
          makeClient: async () =>
            client([{ id: 1, content: "o ingresso dá direito a tudo?" }], sent),
          checkpointer,
        },
        appDb,
      );

      expect(clicked.outcome).toBe("posted");
      expect(sent).toEqual([[convId, "Resposta do re-engage"]]);
      for (const request of model.seen) expect(orphansIn(request)).toEqual([]);
      expect(orphansIn(await storedMessages(convId))).toEqual([]);
      const lines = await repairLines(conversationId);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.detail).toEqual({
        reason: "repaired_dangling_tool_call",
        calls: 2,
      });
    });

    test("what the OpenAI adapter puts on the wire carries no call without its output", async () => {
      const convId = 1168;
      const conversationId = await seedConversation(convId);
      const checkpointer = await seedInterruptedThread(convId, [
        new HumanMessage({ id: "h1", content: "qual o horário do show?" }),
        assistantCalling("ai1", ["call_fio"]),
      ]);
      const sent: Array<[number, string]> = [];
      const before = responsesRequests.length;

      const out = await flushDebounceJob({
        job: jobFor(convId),
        base: appDb,
        deps: {
          makeModel: () => responsesModel() as unknown as BaseChatModel,
          makeClient: async () =>
            client(
              [
                { id: 1, content: "qual o horário do show?" },
                { id: 2, content: "pode responder agora?" },
              ],
              sent,
            ),
          checkpointer,
        },
      });

      expect(out).toEqual({ outcome: "done" });
      expect(sent).toEqual([[convId, "Resposta pelo fio"]]);
      const requests = responsesRequests.slice(before);
      expect(requests.length).toBeGreaterThan(0);
      for (const input of requests) {
        expect(input.some((i) => i.call_id === "call_fio")).toBe(false);
        expect(JSON.stringify(input)).toContain("pode responder agora?");
      }
      expect(await repairLines(conversationId)).toHaveLength(1);
    });
  },
);
