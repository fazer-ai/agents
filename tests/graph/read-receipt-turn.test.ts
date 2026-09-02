import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runAgentTurn, runLoadedTurn } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  ChatwootApiError,
  type ChatwootClient,
} from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";

// The blue tick on the contact's phone, end to end. The client unit tests cover the request shape;
// only a real turn shows the two things that matter here.
//
// First, that a turn actually acknowledges the message it is answering. The receipt lives in
// `runTurnBody`, the tail BOTH entry points share, so proving it on the direct path proves it for
// the debounce flush too — and the flush's own contribution (the WHOLE burst, not just the newest
// id) is asserted separately below.
//
// Second, and this is the one that decides whether the feature is safe to ship: an instance whose
// Chatwoot predates the `read_receipt` endpoint answers 401 (its bot allowlist has no such action)
// or 404 (no route at all), and the turn must go through anyway. Every fazer.ai agents deployment
// talks to a Chatwoot the operator upgrades on their own schedule, so this is the ordinary case for
// a while, not an edge one.

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
let agentId = 0n;

const REPLY = "Claro, já verifico.";

class StubModel {
  async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
    return new AIMessage(REPLY);
  }
  bindTools(_tools: unknown) {
    return { invoke: (m: BaseMessage[]) => this.invoke(m) };
  }
}

interface Receipt {
  conversationId: number;
  messageIds: number[];
}

// Personifies the fork: `markRead` records what it was asked to acknowledge, and `failWith` makes it
// answer like an instance that does not have the endpoint. A stub that merely returned undefined
// would prove nothing about the failing case, which is the case this file exists for.
function stubClient(
  sent: number[],
  receipts: Receipt[],
  failWith?: number,
): () => Promise<ChatwootClient> {
  const client = {
    sendMessage: async (conversationId: number) => {
      sent.push(conversationId);
      return {};
    },
    markRead: async (conversationId: number, messageIds: number[]) => {
      receipts.push({ conversationId, messageIds });
      if (failWith !== undefined) {
        throw new ChatwootApiError(failWith, "read_receipt", "nope");
      }
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

const incoming = (
  conversationId: number,
  messageId: number,
  content: string,
): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId,
  inboxId: 7,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId: null,
  message: { id: messageId, content, messageType: "incoming", private: false },
});

async function seedConversation(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
}

describe.skipIf(!dbUp)("the WhatsApp read receipt of a turn", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RR", slug: `rr-${process.pid}` },
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
        systemPrompt: "Você é uma secretária prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-5.4-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: { split: { enabled: false } },
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
        webhookRouteTokenHash: `rr-route-${process.pid}`,
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

  test("a turn acknowledges the message it is answering", async () => {
    const convId = 8101;
    await seedConversation(convId);
    const sent: number[] = [];
    const receipts: Receipt[] = [];

    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming(convId, 5501, "oi, tudo bem?"),
      base: appDb,
      deps: {
        makeModel: () => new StubModel() as unknown as BaseChatModel,
        makeClient: stubClient(sent, receipts),
        checkpointer: new MemorySaver(),
      },
    });

    expect(outcome).toBe("posted");
    expect(receipts).toEqual([{ conversationId: convId, messageIds: [5501] }]);
  });

  // The playground runs turns against a dummy client on conversation 0. A receipt there would be a
  // request to `/conversations/0/read_receipt` on every operator test-drive.
  test("the playground sends no receipt", async () => {
    const sent: number[] = [];
    const receipts: Receipt[] = [];

    await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming(0, 5701, "teste do playground"),
      base: appDb,
      deps: {
        makeModel: () => new StubModel() as unknown as BaseChatModel,
        makeClient: stubClient(sent, receipts),
        checkpointer: new MemorySaver(),
      },
    });

    expect(receipts).toEqual([]);
  });

  // A debounce flush hands the WHOLE burst, and that is not the same set as the triggering id:
  // WhatsApp acknowledges the messages it is given, so passing only the newest leaves every earlier
  // message of the burst on grey ticks forever. Driven through `runLoadedTurn` because that is the
  // parameter the flush fills in.
  test("a burst acknowledges every message in it, not just the newest", async () => {
    const convId = 8104;
    await seedConversation(convId);
    const sent: number[] = [];
    const receipts: Receipt[] = [];
    const loadedConfig = await runScopedOn(
      appDb,
      { tenantId, userId: null, role: "TENANT_ADMIN" } as TenantContext,
      (db) =>
        loadAgentConfig(db, {
          tenantId,
          instanceId,
          conversationId: convId,
          agentId,
          threadId: `${tenantId}:${instanceId}:${convId}`,
        }),
    );
    if (!loadedConfig) throw new Error("agent config did not load");

    await runLoadedTurn({
      stillWanted: null,
      loaded: loadedConfig,
      authContext: null,
      tenantId,
      instanceId,
      conversationId: convId,
      agentBotId: 9,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      text: "oi\ntudo bem?\nvoce atende hoje?",
      messageId: 5803,
      readMessageIds: [5801, 5802, 5803],
      base: appDb,
      deps: {
        makeModel: () => new StubModel() as unknown as BaseChatModel,
        makeClient: stubClient(sent, receipts),
        checkpointer: new MemorySaver(),
      },
      claimReply: null,
    });

    expect(receipts).toEqual([
      { conversationId: convId, messageIds: [5801, 5802, 5803] },
    ]);
  });

  // The whole point of the feature surviving a version-skewed fleet. Asserting only that no
  // exception escaped would pass with the reply never sent, so the assertion is the REPLY.
  test.each([401, 404])(
    "a Chatwoot without the endpoint (%s) still gets its reply",
    async (status) => {
      const convId = 8102 + status;
      await seedConversation(convId);
      const sent: number[] = [];
      const receipts: Receipt[] = [];

      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: incoming(convId, 5601, "consegue me ajudar?"),
        base: appDb,
        deps: {
          makeModel: () => new StubModel() as unknown as BaseChatModel,
          makeClient: stubClient(sent, receipts, status),
          checkpointer: new MemorySaver(),
        },
      });

      // The receipt was attempted and it failed, which is what makes the next two lines mean
      // something: the turn went through DESPITE the failure, not because it never happened.
      expect(receipts).toHaveLength(1);
      expect(outcome).toBe("posted");
      expect(sent).toEqual([convId]);
    },
  );
});
