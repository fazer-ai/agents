import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";
import { FailingModel, UsageReportingModel } from "../utils/scripted-models";

// WHAT THE CUSTOMER GETS WHEN THE AGENT'S PROVIDER CANNOT TAKE THE TURN (issue #143).
//
// The effect the issue names is the reply that never arrives, so that is what every test here reads:
// the text a stub Chatwoot client received, not the return value of a function. The two rows behind
// it are read from the real tables, because an answer the operator cannot account for is its own
// defect — a fallback turn billed to the primary's name makes the cost break-down wrong, and one
// with no line on the trail makes a provider that is down invisible on a turn that succeeded.

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
let contactId = 0n;
let inboxDbId = 0n;
let primaryAgentId = 0n;
let noFallbackAgentId = 0n;

// Named differently on purpose: the usage row has to name the model that ACTUALLY answered, and a
// shared name would let the wrong attribution pass.
const PRIMARY_MODEL = "primary-mini";
const FALLBACK_MODEL = "fallback-mini";
const REPLY = "Claro, posso agendar.";

function makeStub(rec: { text: string[] }) {
  const client = {
    sendMessage: async (_c: number, content: string) => {
      rec.text.push(content);
      return {};
    },
    toggleTyping: async () => ({}),
    sendPrivateNote: async () => ({}),
  } as unknown as ChatwootClient;
  return async () => client;
}

const textEvent = (convId: number): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId: convId,
  contactInboxId: null,
  inboxId: 7,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  message: {
    id: 1,
    content: "quero agendar",
    messageType: "incoming",
    private: false,
    attachments: [],
  },
});

async function seedConversation(convId: number, agentId: bigint) {
  const inbox = await suDb.inbox.update({
    where: { id: inboxDbId },
    data: { agentId },
    select: { id: true },
  });
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      contactId,
      inboxId: inbox.id,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
}

function usageRows(threadId: string) {
  return suDb.llmUsage.findMany({
    where: { tenantId, threadId },
    select: { node: true, model: true, promptTokens: true },
    orderBy: { id: "asc" },
  });
}

function generateRows(threadId: string) {
  return suDb.executionLog.findMany({
    where: { tenantId, threadId, stage: "generate" },
    select: { level: true, provider: true, model: true, detail: true },
    orderBy: { id: "asc" },
  });
}

// A 503 the vendor SDKs really produce: `statusOf` reads the numeric field, which is the only thing
// `provider-failure` will admit off a response.
const overloaded = () =>
  Object.assign(new Error("upstream overloaded"), { status: 503 });
// The credential case, which is the one the policy must NOT fall over on.
const badKey = () =>
  Object.assign(new Error("invalid api key"), { status: 401 });

describe.skipIf(!dbUp)("a provider that cannot take the turn", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "FALLBACK", slug: `fallback-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const primaryKey = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "primary-key",
        secret: encryptJson("sk-primary"),
      },
      select: { id: true },
    });
    // The fallback's OWN credential, which is the whole point of it being another vendor: the
    // agent's key belongs to the provider that just failed and may not travel.
    const fallbackKey = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "fallback-key",
        secret: encryptJson("sk-fallback"),
      },
      select: { id: true },
    });
    const withFallback = await suDb.agent.create({
      data: {
        tenantId,
        name: "Com fallback",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: PRIMARY_MODEL,
          credentialRef: `vault:${primaryKey.id}`,
        },
        settings: {
          split: { enabled: false },
          modelFallback: {
            provider: "anthropic",
            model: FALLBACK_MODEL,
            credentialRef: `vault:${fallbackKey.id}`,
          },
        },
      },
      select: { id: true },
    });
    primaryAgentId = withFallback.id;
    // The same agent minus the fallback block. It is what proves the fix buys something: the two
    // differ in one setting and in nothing else.
    const without = await suDb.agent.create({
      data: {
        tenantId,
        name: "Sem fallback",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: PRIMARY_MODEL,
          credentialRef: `vault:${primaryKey.id}`,
        },
        settings: { split: { enabled: false } },
      },
      select: { id: true },
    });
    noFallbackAgentId = without.id;
    for (const [agentId, botId] of [
      [withFallback.id, 9],
      [without.id, 10],
    ] as const) {
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
          chatwootAgentBotId: botId,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `fallback-route-${botId}-${process.pid}`,
          name: "Atendente",
        },
      });
    }
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: withFallback.id,
      },
      select: { id: true },
    });
    inboxDbId = inbox.id;
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instanceId,
        tenantId,
        name: "Cliente",
        chatwootContactId: 1,
      },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "contacts",
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

  // THE HALF THE ISSUE REPORTS. One setting apart from the test below it, and the difference is a
  // customer who is answered versus one who is not.
  test("with nothing behind it, a 503 costs the customer the reply", async () => {
    await seedConversation(9401, noFallbackAgentId);
    const rec = { text: [] as string[] };
    const primary = new FailingModel(overloaded());
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 10,
      event: textEvent(9401),
      base: appDb,
      deps: {
        makeModel: (() => primary) as unknown as never,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
      },
    }).catch(() => "threw" as const);
    expect(primary.calls).toBeGreaterThan(0);
    expect(rec.text).toEqual([]);
    expect(outcome).not.toBe("posted");
  });

  test("with a second provider configured, the customer is answered by it", async () => {
    await seedConversation(9402, primaryAgentId);
    const rec = { text: [] as string[] };
    const primary = new FailingModel(overloaded());
    const fallback = new UsageReportingModel([REPLY]);
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: textEvent(9402),
      base: appDb,
      deps: {
        makeModel: ((args: { model: string }) =>
          args.model === FALLBACK_MODEL
            ? fallback
            : primary) as unknown as never,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
      },
    });
    expect(outcome).toBe("posted");
    // The primary was really asked, so this is a fallback and not a test that skipped a step.
    expect(primary.calls).toBeGreaterThan(0);
    expect(fallback.calls.length).toBe(1);
    // THE EFFECT: the customer received the answer.
    expect(rec.text).toEqual([REPLY]);
  });

  test("the usage row names the model that answered, not the one configured", async () => {
    await seedConversation(9403, primaryAgentId);
    const rec = { text: [] as string[] };
    const primary = new FailingModel(overloaded());
    const fallback = new UsageReportingModel([REPLY]);
    await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: textEvent(9403),
      base: appDb,
      deps: {
        makeModel: ((args: { model: string }) =>
          args.model === FALLBACK_MODEL
            ? fallback
            : primary) as unknown as never,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
      },
    });
    const usage = await usageRows(`${tenantId}:${instanceId}:9403`);
    expect(usage).toHaveLength(1);
    // Billed to the fallback. Under the configured name this row would tell an operator their
    // primary model cost them money on a turn it refused to take.
    expect(usage[0]?.model).toBe(FALLBACK_MODEL);
    expect(usage[0]?.node).toBe("agent");
    expect(usage[0]?.promptTokens).toBeGreaterThan(0);
  });

  test("the trail says the fallback took the turn, and why", async () => {
    await seedConversation(9404, primaryAgentId);
    const rec = { text: [] as string[] };
    const primary = new FailingModel(overloaded());
    const fallback = new UsageReportingModel([REPLY]);
    await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: textEvent(9404),
      base: appDb,
      deps: {
        makeModel: ((args: { model: string }) =>
          args.model === FALLBACK_MODEL
            ? fallback
            : primary) as unknown as never,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
      },
    });
    const rows = await generateRows(`${tenantId}:${instanceId}:9404`);
    const line = rows.find(
      (r) => (r.detail as Record<string, unknown> | null)?.fallbackReason,
    );
    // Without this the turn reads as clean: it succeeded, the customer was served, and a provider
    // the operator pays for took none of their traffic.
    expect(line).toBeDefined();
    expect(line?.level).toBe("warn");
    expect(line?.model).toBe(FALLBACK_MODEL);
    expect(line?.provider).toBe("anthropic");
    // The redacted word, never the vendor's own sentence: this row is exported and POSTed to the
    // operator's alert channel, and the request that failed carried the whole conversation.
    expect(
      (line?.detail as Record<string, unknown> | undefined)?.fallbackReason,
    ).toBe("HTTP 503");
    expect(JSON.stringify(line?.detail)).not.toContain("overloaded");
  });

  // The masking rule, at the level where it costs money. A dead primary key answered by the fallback
  // is a turn that succeeds forever while the operator is billed twice and told nothing.
  test("a 401 is not fallen over: the operator has to learn the key is dead", async () => {
    await seedConversation(9405, primaryAgentId);
    const rec = { text: [] as string[] };
    const primary = new FailingModel(badKey());
    const fallback = new UsageReportingModel([REPLY]);
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: textEvent(9405),
      base: appDb,
      deps: {
        makeModel: ((args: { model: string }) =>
          args.model === FALLBACK_MODEL
            ? fallback
            : primary) as unknown as never,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
      },
    }).catch(() => "threw" as const);
    expect(primary.calls).toBeGreaterThan(0);
    expect(fallback.calls.length).toBe(0);
    expect(rec.text).toEqual([]);
    expect(outcome).not.toBe("posted");
  });
});
