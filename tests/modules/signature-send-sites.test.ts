import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentNudge } from "@/graph/nudge";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  runPlaygroundFollowup,
  runPlaygroundTurn,
} from "@/modules/playground/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// Where the signature is attached. The proactive message and both playground surfaces send ONE
// message, so a badge repeated on every balloon (`frequency: "all"`) still appears once in them; a
// re-split of their own text would repeat it inside one message, and the playground would preview
// what the customer never receives. `deliverReply`, the one send that splits, is split.test.ts.

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

// A reply the splitter would cut in two, and a badge that goes on every balloon.
const REPLY = "Primeiro.\n\nSegundo.";
const SIGNATURE = {
  enabled: true,
  text: "[Ana]",
  position: "top",
  frequency: "all",
  separator: "blank",
};
const SIGNED = "[Ana]\n\nPrimeiro.\n\nSegundo.";

let tenantId = 0n;
let instanceId = 0n;
let inboxDbId = 0n;
let agentId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const model = () => new FakeListChatModel({ responses: [REPLY] });

describe.skipIf(!dbUp)("a one-message send carries the badge once", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SIGSITES", slug: `sigsites-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 12,
      baseUrl: "https://chat.sigsites.example",
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
        name: "Ana",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id}`,
        },
        settings: { signature: SIGNATURE },
      },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId,
        chatwootAgentBotId: 12,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `sigsites-route-${process.pid}`,
        name: "Ana",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 12,
        name: "Suporte",
        agentId,
      },
    });
    inboxDbId = inbox.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "scheduler_jobs",
        "agent_turn_deliveries",
        "agent_threads",
        "playground_sessions",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => {});
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the proactive message", async () => {
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        inboxId: inboxDbId,
        chatwootConversationId: 1200,
        status: "pending",
        assigneeType: null,
        threadId: `${tenantId}:${instanceId}:1200`,
        lastEventAt: new Date(),
        lastInboundAt: new Date(),
      },
    });
    const messages: string[] = [];
    const client = {
      sendMessage: async (_c: number, text: string) => {
        messages.push(text);
        return {};
      },
      sendPrivateNote: async () => ({ id: 1 }),
      getConversationLabels: async () => [],
      setConversationLabels: async () => ({}),
      toggleStatus: async () => ({}),
      toggleTyping: async () => ({}),
    } as unknown as ChatwootClient;
    const outcome = await runAgentNudge({
      tenantId,
      threadId: `${tenantId}:${instanceId}:1200`,
      nudge: { source: "ASAAS", status: "paid", value: 100, currency: "BRL" },
      base: appDb,
      deps: {
        makeModel: model,
        makeClient: async () => client,
        checkpointer: new MemorySaver(),
        persistUsage: async () => {},
      },
    });
    expect(outcome).toBe("messaged");
    expect(messages).toEqual([SIGNED]);
  });

  test("the playground's reply preview", async () => {
    const r = await runPlaygroundTurn({
      ctx: ctx(),
      agentId,
      message: "oi",
      base: appDb,
      deps: { makeModel: model, checkpointer: new MemorySaver() },
    });
    expect(r.reply).toBe(SIGNED);
  });

  test("the playground's follow-up preview", async () => {
    const r = await runPlaygroundFollowup({
      ctx: ctx(),
      agentId,
      base: appDb,
      deps: { makeModel: model, checkpointer: new MemorySaver() },
    });
    expect(r.reply).toBe(SIGNED);
  });
});
