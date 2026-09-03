import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
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
// A live agent whose operator flips it to monitoring INSIDE the nudge's model call (issue #209
// review): the config the nudge loaded still says production, and the fence has to ask again.
const CONV_FLIPPED = 943;
let flippedAgentId = 0n;
// Same flip, and the model answers with a TOOL CALL: the graph's own fence at the tool boundary has
// to carry the mode too, or the label is written for an agent that no longer acts.
const CONV_FLIPPED_TOOL = 944;
let flippedToolAgentId = 0n;
// The switch, not the mode: an agent switched OFF inside the model call. The reminder ladder retries
// "agent-unavailable" (the operator can switch it back on), and "stale" would end the episode.
const CONV_SWITCHED_OFF = 945;
let switchedOffAgentId = 0n;
// Switched off BEFORE the claim's own strict ask and after the pre-invoke ones: the model factory
// runs between them. The claim exit carried the literal "stale" (review round 13).
const CONV_SWITCHED_OFF_AT_CLAIM = 946;
let switchedOffAtClaimAgentId = 0n;

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
  const labels: string[][] = [];
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
    setConversationLabels: async (_c: number, next: string[]) => {
      labels.push(next);
      return {};
    },
    toggleStatus: async () => ({}),
    toggleTyping: async () => ({}),
    getMessages: async () => ({ payload: [] }),
    sendTemplate: async () => ({}),
  } as unknown as ChatwootClient;
  return { messages, notes, labels, makeClient: async () => client };
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
    const flipped = await suDb.agent.create({
      data: {
        tenantId,
        name: "Vai virar observadora",
        enabled: true,
        mode: "production",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id}`,
        },
      },
    });
    flippedAgentId = flipped.id;
    await seedInboxWithConversation({
      agentId: flipped.id,
      chatwootInboxId: 74,
      convId: CONV_FLIPPED,
    });
    const flippedTool = await suDb.agent.create({
      data: {
        tenantId,
        name: "Vai virar observadora (tool)",
        enabled: true,
        mode: "production",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id}`,
        },
      },
    });
    flippedToolAgentId = flippedTool.id;
    await seedInboxWithConversation({
      agentId: flippedTool.id,
      chatwootInboxId: 75,
      convId: CONV_FLIPPED_TOOL,
    });
    const switchedOff = await suDb.agent.create({
      data: {
        tenantId,
        name: "Vai ser desligada",
        enabled: true,
        mode: "production",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id}`,
        },
      },
    });
    switchedOffAgentId = switchedOff.id;
    await seedInboxWithConversation({
      agentId: switchedOff.id,
      chatwootInboxId: 76,
      convId: CONV_SWITCHED_OFF,
    });
    const offAtClaim = await suDb.agent.create({
      data: {
        tenantId,
        name: "Desligada antes do claim",
        enabled: true,
        mode: "production",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${vault.id}`,
        },
      },
    });
    switchedOffAtClaimAgentId = offAtClaim.id;
    await seedInboxWithConversation({
      agentId: offAtClaim.id,
      chatwootInboxId: 77,
      convId: CONV_SWITCHED_OFF_AT_CLAIM,
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

  const nudge = (
    convId: number,
    makeModel: () => FakeListChatModel = refuseModel(),
    checkpointer: MemorySaver = new MemorySaver(),
  ) => {
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
            makeModel,
            makeClient: s.makeClient,
            checkpointer,
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

  test("an agent flipped to monitoring while the nudge was generating posts nothing, and stands down", async () => {
    const flip = async () => {
      await suDb.agent.update({
        where: { id: flippedAgentId },
        data: { mode: "monitoring" },
      });
    };
    // Both entry points, and `bindTools`, for the reason tests/modules/chatwoot-monitoring-seam
    // gives: the fake answers it with a new instance of its own class.
    class FlippingModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(
        ...args: Parameters<FakeListChatModel["_generate"]>
      ): ReturnType<FakeListChatModel["_generate"]> {
        await flip();
        return super._generate(...args);
      }
      override async *_streamResponseChunks(
        ...args: Parameters<FakeListChatModel["_streamResponseChunks"]>
      ): ReturnType<FakeListChatModel["_streamResponseChunks"]> {
        await flip();
        yield* super._streamResponseChunks(...args);
      }
    }
    const { s, run } = nudge(
      CONV_FLIPPED,
      () => new FlippingModel({ responses: ["Oi! Ainda posso ajudar?"] }),
    );
    expect(await run()).toBe("agent-unavailable");
    expect(s.messages).toEqual([]);
    expect(s.notes).toEqual([]);
  });

  test("an agent flipped to monitoring while the nudge was generating runs none of the tools it asked for", async () => {
    const seen = { generations: 0 };
    class FlippingToolModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(
        ...args: Parameters<FakeListChatModel["_generate"]>
      ): ReturnType<FakeListChatModel["_generate"]> {
        seen.generations += 1;
        if (seen.generations === 1) {
          await suDb.agent.update({
            where: { id: flippedToolAgentId },
            data: { mode: "monitoring" },
          });
          const message = new AIMessage({
            content: "",
            tool_calls: [
              { name: "assign_label", args: { label: "sumiu" }, id: "call-1" },
            ],
          });
          return { generations: [{ text: "", message }] };
        }
        return super._generate(...args);
      }
    }
    const { s, run } = nudge(
      CONV_FLIPPED_TOOL,
      () => new FlippingToolModel({ responses: ["Marquei aqui."] }),
    );
    expect(await run()).toBe("agent-unavailable");
    expect(s.labels).toEqual([]);
    expect(s.messages).toEqual([]);
  });

  test("an agent switched off while the nudge was generating is unavailable, not stale: the ladder may retry it", async () => {
    class SwitchingOffModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
      override async _generate(
        ...args: Parameters<FakeListChatModel["_generate"]>
      ): ReturnType<FakeListChatModel["_generate"]> {
        await suDb.agent.update({
          where: { id: switchedOffAgentId },
          data: { enabled: false },
        });
        return super._generate(...args);
      }
    }
    const { s, run } = nudge(
      CONV_SWITCHED_OFF,
      () => new SwitchingOffModel({ responses: ["Oi! Ainda posso ajudar?"] }),
    );
    expect(await run()).toBe("agent-unavailable");
    expect(s.messages).toEqual([]);
    expect(s.notes).toEqual([]);
  });

  test("an agent switched off between the pre-invoke asks and the claim's strict ask is unavailable, not stale", async () => {
    // The thread state is read between the pre-invoke asks and the claim, so a switch flipped
    // inside that read is first seen by the claim's own strict ask.
    class SwitchingOffSaver extends MemorySaver {
      flipped = false;
      override async getTuple(
        ...args: Parameters<MemorySaver["getTuple"]>
      ): ReturnType<MemorySaver["getTuple"]> {
        if (!this.flipped) {
          this.flipped = true;
          await suDb.agent.update({
            where: { id: switchedOffAtClaimAgentId },
            data: { enabled: false },
          });
        }
        return super.getTuple(...args);
      }
    }
    class BoundModel extends FakeListChatModel {
      override bindTools(): this {
        return this;
      }
    }
    const { s, run } = nudge(
      CONV_SWITCHED_OFF_AT_CLAIM,
      () => new BoundModel({ responses: ["Oi! Ainda posso ajudar?"] }),
      new SwitchingOffSaver(),
    );
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
