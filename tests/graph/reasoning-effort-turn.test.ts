import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";

// Issue #74 end-to-end: the effort the operator saved on the agent has to survive the whole chain
// (agent row → loadAgentConfig → buildModelAndGraph → createChatModel → the wire) AND the answer
// that comes back over the other endpoint has to reach the customer. The unit tests in
// model-reasoning-effort cover which endpoint gets picked; this one covers that a real turn still
// works once it is picked, which is where a transport switch actually breaks: the Responses API
// answers with content BLOCKS (a reasoning block with no text, then the text one) rather than a
// plain string, so a reply extractor that only understood completions would post an empty message.

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

const REPLY = "Claro, já verifiquei e o pedido sai amanhã.";

let tenantId = 0n;
let instanceId = 0n;

// Personifies both OpenAI endpoints at the shape level: a reasoning block that carries no text
// followed by the answer, which is what /v1/responses actually returned in the live run.
function fakeOpenAI() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    calls.push({ url: String(url), body });
    if (String(url).includes("/responses")) {
      return Response.json({
        id: "resp_1",
        object: "response",
        created_at: 0,
        model: body.model,
        status: "completed",
        output: [
          {
            id: "rs_1",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "conferindo o pedido" }],
          },
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: REPLY, annotations: [] }],
          },
        ],
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      });
    }
    return Response.json({
      id: "chatcmpl-1",
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
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
  }) as unknown as typeof fetch;
  return {
    calls,
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
    content: "meu pedido sai quando?",
    messageType: "incoming",
    private: false,
  },
});

// Each test owns its own conversation id: a row seeded by an earlier test would put the turn on a
// different path than the one the test name describes.
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

async function setEffort(effort: string | null) {
  await suDb.agent.updateMany({
    where: { tenantId },
    data: {
      modelConfig: {
        provider: "openai",
        model: "gpt-5.6-luna",
        credentialRef: `vault:${llmKeyId}`,
        ...(effort ? { reasoningEffort: effort } : {}),
      },
    },
  });
}

let llmKeyId = 0n;

describe.skipIf(!dbUp)("a turn run at the effort the operator chose", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RE", slug: `re-${process.pid}` },
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
    llmKeyId = llmKey.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é uma secretária prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-5.6-luna",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: { split: { enabled: false } },
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
        webhookRouteTokenHash: `re-route-${process.pid}`,
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

  test("reaches the provider on the endpoint that accepts it, and the customer is answered", async () => {
    await setEffort("high");
    await seedConversation(701);
    const fake = fakeOpenAI();
    const sent: Array<[number, string]> = [];
    try {
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: incoming(701),
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
    // The whole point of the issue: the agent thinks at the chosen effort, on the endpoint that
    // allows it, without OpenAI keeping the conversation.
    expect(fake.calls[0]?.url).toContain("/v1/responses");
    expect(fake.calls[0]?.body.reasoning).toEqual({ effort: "high" });
    expect(fake.calls[0]?.body.store).toBe(false);
    // And the answer, which arrived as content blocks rather than a string, reached the customer
    // whole — no empty message, no reasoning text leaking into the reply.
    expect(sent).toEqual([[701, REPLY]]);
  });

  test("an agent that never chose one is left on the endpoint it uses today", async () => {
    await setEffort(null);
    await seedConversation(702);
    const fake = fakeOpenAI();
    const sent: Array<[number, string]> = [];
    try {
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: incoming(702),
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
    expect(fake.calls[0]?.url).toContain("/v1/chat/completions");
    expect(fake.calls[0]?.body).not.toHaveProperty("reasoning");
    expect(sent).toEqual([[702, REPLY]]);
  });
});
