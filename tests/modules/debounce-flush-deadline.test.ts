import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { burnSchedulerJobId } from "../utils/scheduler";

// Issue #811, the half of a job's deadline that reaches the flush. The scheduler ends the RUN at the
// deadline whatever the handler does; what the flush owes is to stop the WORK: the job's signal goes
// into the turn, reaches the model call even where #809's own deadline hands the call a signal of
// its own, and a turn that gets past its model call anyway sends nothing, because the run it
// belonged to was already failed and its retry answers the burst. Real flush, real graph, a fake
// model and a Chatwoot stub.

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

// Burned from `scheduler_jobs_id_seq`, never a literal: tests/utils/scheduler.ts says why.
let phantomJobId = 0n;
let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentId = 0n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

// A model that answers after `delayMs`. `listens` decides whether it honors the signal it is handed;
// `saw` records whether that signal aborted while it waited.
function slowModel(delayMs: number, listens: boolean, saw: { abort: boolean }) {
  const model = {
    bindTools() {
      return model;
    },
    async invoke(_messages: BaseMessage[], opts?: { signal?: AbortSignal }) {
      const signal = opts?.signal;
      // Only an abort while the call is still waiting counts: the signal it was handed can abort later.
      let waiting = true;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
          if (!waiting) return;
          saw.abort = true;
          if (!listens) return;
          clearTimeout(timer);
          reject(signal.reason);
        });
      }).finally(() => {
        waiting = false;
      });
      return new AIMessage("Claro, posso ajudar!");
    },
  };
  return model as unknown as BaseChatModel;
}

// A model that answers with nothing, which the turn reads as a decided silence.
function silentModel() {
  const model = {
    bindTools() {
      return model;
    },
    async invoke() {
      return new AIMessage("");
    },
  };
  return model as unknown as BaseChatModel;
}

// `onRead(n)` runs on the n-th read of the conversation's messages. The flush reads them twice by
// design: once to build the burst, and again just before sending (the post-response supersede).
function stub(
  sent: string[],
  onRead: (n: number) => void = () => {},
  onSend: (n: number) => void = () => {},
) {
  let reads = 0;
  const client = {
    getMessages: async (conversationId: number) => {
      onRead(++reads);
      return {
        payload: [
          {
            id: 100,
            content: `oi da conversa ${conversationId}`,
            message_type: 0,
            private: false,
          },
        ],
      };
    },
    sendMessage: async (_conversationId: number, content: string) => {
      sent.push(content);
      onSend(sent.length);
      return {};
    },
    toggleTyping: async () => ({}),
  } as unknown as ChatwootClient;
  return async () => client;
}

async function seedConversation(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      inboxId: inboxDbId,
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastHandledMessageId: null,
    },
  });
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

// The flush under a signal that aborts after `abortAfterMs`, as the job's deadline would, or on the
// read of the messages named by `abortOnRead`.
async function flushUnderDeadline(
  convId: number,
  model: BaseChatModel,
  abortAfterMs: number,
  abortOnRead?: number,
) {
  const sent: string[] = [];
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("deadline exceeded"));
  const timer = setTimeout(abort, abortAfterMs);
  try {
    await flushDebounceJob({
      job: jobFor(convId),
      base: appDb,
      signal: controller.signal,
      deps: {
        makeModel: () => model,
        makeClient: stub(sent, (n) => {
          if (n === abortOnRead) abort();
        }),
        checkpointer: new MemorySaver(),
      },
    }).catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
  return sent;
}

describe.skipIf(!dbUp)(
  "the flush stops when its job's deadline fires (issue #811)",
  () => {
    beforeAll(async () => {
      phantomJobId = await burnSchedulerJobId(suDb);
      const t = await suDb.tenant.create({
        data: { name: "DFD", slug: `dfd-${process.pid}` },
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
      agentId = agent.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId: agent.id,
          chatwootAgentBotId: 9,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `dfd-route-${process.pid}`,
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
      if (tenantId) {
        for (const table of [
          "scheduler_jobs",
          "execution_logs",
          "llm_usage",
          "conversations",
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

    test("the deadline reaches the model call, and nothing is sent", async () => {
      await seedConversation(2001);
      const saw = { abort: false };
      const t = performance.now();
      const sent = await flushUnderDeadline(
        2001,
        slowModel(5_000, true, saw),
        300,
      );
      expect(saw.abort).toBe(true);
      expect(performance.now() - t).toBeLessThan(4_000);
      expect(sent).toEqual([]);
    });

    test("a model call that ignores the signal and answers late still sends nothing", async () => {
      await seedConversation(2002);
      const saw = { abort: false };
      const sent = await flushUnderDeadline(
        2002,
        slowModel(800, false, saw),
        300,
      );
      // Give the ignored call time to answer and the turn time to try to send it.
      await sleep(1_200);
      expect(sent).toEqual([]);
    });

    test("a deadline that fires after the model answered, just before the send, sends nothing", async () => {
      await seedConversation(2004);
      const saw = { abort: false };
      const sent = await flushUnderDeadline(
        2004,
        slowModel(50, true, saw),
        10_000,
        2,
      );
      expect(saw.abort).toBe(false);
      expect(sent).toEqual([]);
    });

    test("the conversation shows the turn failed on its deadline", async () => {
      await seedConversation(2005);
      const saw = { abort: false };
      await flushUnderDeadline(2005, slowModel(5_000, true, saw), 300);
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 2005 },
        select: { lastError: true },
      });
      expect(conv.lastError).toContain("deadline");
    });

    // A turn that ends without sending also settles the burst: a silence marks its messages handled,
    // and a retry would then find nothing to answer. Past the deadline that settling is the retry's,
    // so the run stands down instead and leaves the burst to it.
    test("a turn that ends silent after the deadline leaves the burst to the retry", async () => {
      await seedConversation(2006);
      const sent = await flushUnderDeadline(2006, silentModel(), 10_000, 2);
      expect(sent).toEqual([]);
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 2006 },
        select: { lastHandledMessageId: true },
      });
      expect(conv.lastHandledMessageId).toBeNull();
    });

    // Its control: the same silence inside the deadline does settle the burst, which is what makes the
    // one above a refusal and not a silence that never marks anything.
    test("a turn that ends silent inside its deadline settles the burst", async () => {
      await seedConversation(2007);
      const sent = await flushUnderDeadline(2007, silentModel(), 10_000);
      expect(sent).toEqual([]);
      const conv = await suDb.conversation.findFirstOrThrow({
        where: { tenantId, chatwootConversationId: 2007 },
        select: { lastHandledMessageId: true },
      });
      expect(conv.lastHandledMessageId).not.toBeNull();
    });

    // A reply already on its way when the deadline fires is not cut midway: once the first balloon's
    // claim is won the burst is this turn's, its retry finds it claimed, and a half-sent answer is
    // one no retry can complete without repeating what already went out.
    test("a split reply the deadline reaches after its first balloon is delivered whole", async () => {
      await seedConversation(2008);
      const agent = await suDb.agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      });
      await suDb.agent.update({
        where: { id: agentId },
        data: {
          settings: {
            ...(agent.settings as Record<string, unknown>),
            split: { enabled: true, minDelayMs: 0, maxDelayMs: 0 },
          },
        },
      });
      const sent: string[] = [];
      const controller = new AbortController();
      const twoParts = {
        bindTools() {
          return twoParts;
        },
        async invoke() {
          return new AIMessage(
            "Primeira parte da resposta.\n\nSegunda parte da resposta.",
          );
        },
      } as unknown as BaseChatModel;
      try {
        await flushDebounceJob({
          job: jobFor(2008),
          base: appDb,
          signal: controller.signal,
          deps: {
            makeModel: () => twoParts,
            makeClient: stub(sent, undefined, (n) => {
              if (n === 1) controller.abort(new Error("deadline exceeded"));
            }),
            checkpointer: new MemorySaver(),
          },
        }).catch(() => undefined);
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { settings: agent.settings as object },
        });
      }
      expect(controller.signal.aborted).toBe(true);
      expect(sent).toEqual([
        "Primeira parte da resposta.",
        "Segunda parte da resposta.",
      ]);
    });

    test("a flush whose deadline never fires still answers", async () => {
      await seedConversation(2003);
      const saw = { abort: false };
      const sent = await flushUnderDeadline(
        2003,
        slowModel(50, true, saw),
        10_000,
      );
      expect(saw.abort).toBe(false);
      expect(sent).toEqual(["Claro, posso ajudar!"]);
    });
  },
);
