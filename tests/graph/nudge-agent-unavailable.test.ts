import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentNudge } from "@/graph/nudge";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { seedChatwootInstance } from "../utils/chatwoot";

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

// The three states this file separates, each on its own inbox + conversation so no test has to
// mutate what another one reads.
const CONV_BROKEN_CREDENTIAL = 940;
const CONV_DISABLED = 941;
const CONV_NO_AGENT_BOUND = 942;

// Any invocation is a failure: every state here is decided before the model is reached, and the
// whole point of the outcome is that nothing was authored and nothing was spent.
function refuseModel() {
  return () => {
    throw new Error("the model must not be invoked");
  };
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
    sendTemplate: async () => ({}),
  } as unknown as ChatwootClient;
  return { messages, notes, makeClient: async () => client };
}

async function seedInboxWithConversation(args: {
  agentId: bigint | null;
  chatwootInboxId: number;
  convId: number;
}) {
  const inbox = await suDb.inbox.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootInboxId: args.chatwootInboxId,
      name: `Inbox ${args.chatwootInboxId}`,
      agentId: args.agentId,
      channelType: "Channel::Whatsapp",
      provider: "whatsapp_cloud",
    },
  });
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inbox.id,
      chatwootConversationId: args.convId,
      status: "pending",
      assigneeType: null,
      threadId: `${tenantId}:${instanceId}:${args.convId}`,
      lastEventAt: new Date(),
      lastInboundAt: new Date(),
    },
  });
}

describe.skipIf(!dbUp)("runAgentNudge: an agent that cannot author", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "NAU", slug: `nau-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 11,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const vault = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });

    // The state this issue is about: the agent is live and expected to answer, and its model
    // credential does not resolve. A vault id that was never created stands in for the three real
    // ways to reach it (deleted entry, still-pending entry, a bare name where a ref is required).
    const broken = await suDb.agent.create({
      data: {
        tenantId,
        name: "Credencial quebrada",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id + 100_000n}`,
        },
      },
    });
    const disabled = await suDb.agent.create({
      data: {
        tenantId,
        name: "Desligada",
        enabled: false,
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id}`,
        },
      },
    });

    await seedInboxWithConversation({
      agentId: broken.id,
      chatwootInboxId: 71,
      convId: CONV_BROKEN_CREDENTIAL,
    });
    await seedInboxWithConversation({
      agentId: disabled.id,
      chatwootInboxId: 72,
      convId: CONV_DISABLED,
    });
    await seedInboxWithConversation({
      agentId: null,
      chatwootInboxId: 73,
      convId: CONV_NO_AGENT_BOUND,
    });
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

  const nudge = (convId: number) => {
    const s = stub();
    return {
      s,
      run: () =>
        runAgentNudge({
          tenantId,
          threadId: `${tenantId}:${instanceId}:${convId}`,
          nudge: { source: "followup", kind: "inactivity", step: 1 },
          base: appDb,
          deps: {
            makeModel: refuseModel(),
            makeClient: s.makeClient,
            checkpointer: new MemorySaver(),
            persistUsage: async () => {},
          },
        }),
    };
  };

  test("an unresolvable model credential is reported as unavailable, not as a missing agent", async () => {
    const { s, run } = nudge(CONV_BROKEN_CREDENTIAL);
    expect(await run()).toBe("agent-unavailable");
    expect(s.messages).toEqual([]);
    expect(s.notes).toEqual([]);
  });

  test("a switched-off agent is unavailable too: the operator can switch it back on", async () => {
    const { s, run } = nudge(CONV_DISABLED);
    expect(await run()).toBe("agent-unavailable");
    expect(s.messages).toEqual([]);
  });

  // The negative case, and it is the design decision rather than an edge: an inbox with no agent
  // bound has no occasion to preserve, so it keeps the outcome that ends the episode. A change that
  // made every refusal "unavailable" would retry this one forever.
  test("an inbox with no agent bound is still no-agent", async () => {
    const { s, run } = nudge(CONV_NO_AGENT_BOUND);
    expect(await run()).toBe("no-agent");
    expect(s.messages).toEqual([]);
  });
});
