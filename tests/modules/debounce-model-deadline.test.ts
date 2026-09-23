import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { claimDueDebounceJobs, enqueueJob } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #809, at the effect the customer feels: with no fallback configured, a primary model call
// that never returns used to hold the flush for as long as the provider liked. Now the turn fails at
// the deadline and leaves through the failed-turn path the platform already has: the error on the
// conversation, the job failed for a retry, and nothing sent to the contact. Real flush
// (flushDebounceJob → graph → runModelCall) on a real DEBOUNCE row, a stub Chatwoot client and a model
// that ignores the abort signal, which is the adapter shape the deadline has to hold against.

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

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;

const CHATWOOT_INBOX_ID = 7;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

// One new incoming message per conversation; sendMessage records the post. Shared across turns —
// getMessages keys off conversationId, so each turn sees its own message.
function parallelStub(sent: Array<[number, string]>) {
  const client = {
    getMessages: async (conversationId: number) => ({
      payload: [
        {
          id: 100,
          content: `oi da conversa ${conversationId}`,
          message_type: 0,
          private: false,
        },
      ],
    }),
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
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

const CONV = 3001;
const DEADLINE_MS = 1_500;

// Never answers and never looks at the abort signal, like the Google adapter (measured).
class DeafModel extends BaseChatModel {
  constructor() {
    super({});
  }
  _llmType() {
    return "deaf";
  }
  override bindTools() {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    await sleep(600_000);
    return {
      generations: [{ text: "tarde", message: new AIMessage("tarde") }],
    };
  }
}
const deaf = new DeafModel();

describe.skipIf(!dbUp)(
  "debounce flush: a primary model call past its deadline",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "DMD", slug: `dmd-${process.pid}` },
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
          webhookRouteTokenHash: `dmd-route-${process.pid}`,
          name: "Atendente",
        },
      });
      const inbox = await suDb.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: CHATWOOT_INBOX_ID,
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
          "llm_usage",
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

    test("the turn fails at the deadline through the failed-turn path, and nothing reaches the contact", async () => {
      const saved = config.agent.modelCallTimeoutMs;
      config.agent.modelCallTimeoutMs = DEADLINE_MS;
      try {
        await seedConversation(CONV);
        await enqueueJob({
          base: appDb,
          tenantId,
          kind: "DEBOUNCE",
          dedupeKey: `debounce:${threadOf(CONV)}`,
          runAt: new Date(Date.now() - 1_000),
          payload: {
            threadId: threadOf(CONV),
            agentBotId: 9,
            burstStartedAt: 1,
          },
          rearm: "new-work",
        });
        const [job] = await claimDueDebounceJobs(
          1,
          appDb,
          new Date(),
          tenantId,
        );
        expect(job).toBeDefined();
        if (!job) return;

        const sent: Array<[number, string]> = [];
        const t0 = performance.now();
        const settled = await Promise.race([
          flushDebounceJob({
            job,
            base: appDb,
            deps: {
              makeModel: () => deaf,
              makeClient: parallelStub(sent),
              checkpointer: new MemorySaver(),
            },
          }).then(
            () => "resolved" as const,
            (e: Error) => e,
          ),
          sleep(DEADLINE_MS + 5_000).then(() => "pending" as const),
        ]);
        const elapsed = performance.now() - t0;

        expect(settled).not.toBe("pending");
        expect(settled).toBeInstanceOf(Error);
        expect((settled as Error).message).toBe("timeout");
        expect(elapsed).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
        expect(sent).toEqual([]);
        const conv = await suDb.conversation.findFirstOrThrow({
          where: { tenantId, chatwootConversationId: CONV },
          select: { lastError: true },
        });
        expect(conv.lastError).toBe("timeout");
      } finally {
        config.agent.modelCallTimeoutMs = saved;
      }
    });
  },
);
