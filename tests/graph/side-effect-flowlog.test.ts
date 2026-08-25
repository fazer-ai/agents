import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { createAlertChannel } from "@/modules/flowlog/channels";
import { seedChatwootInstance } from "../utils/chatwoot";
import { outboundUrl } from "../utils/outbound";

// NOTE: Issue #46 end-to-end — a tool that SUCCEEDS for the model but whose side effect fails
// (here: handoff assignment) must land a warn `tool` line in the execution log AND produce an
// alert delivery for a minLevel:warn channel, through the REAL turn path (runAgentTurn → prepare →
// onSideEffectError binding → emitFlowEvent). Before the fix the failure was a stdout log only.

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

// NOTE: Scripted model: first call fires handoff_to_human, second call replies with text.
class HandoffThenReplyModel {
  constructor(private reply: string) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
        n++;
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                { name: "handoff_to_human", args: {}, id: "call_h1" },
              ],
            })
          : new AIMessage(self.reply);
      },
    };
  }
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
    content: "quero um humano",
    messageType: "incoming",
    private: false,
  },
});

type ToolRow = {
  level: string;
  status: string | null;
  errorMessage: string | null;
  detail: unknown;
};

async function pollToolRows(
  predicate: (rows: ToolRow[]) => boolean,
): Promise<ToolRow[]> {
  let rows: ToolRow[] = [];
  for (let i = 0; i < 50; i++) {
    rows = await suDb.executionLog.findMany({
      where: {
        tenantId,
        stage: "tool",
        threadId: `${tenantId}:${instanceId}:950`,
      },
      select: { level: true, status: true, errorMessage: true, detail: true },
    });
    if (predicate(rows)) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows;
}

describe.skipIf(!dbUp)(
  "side-effect failures reach the flow log (issue #46)",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "SEF", slug: `sef-${process.pid}` },
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
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
          settings: {
            split: { enabled: false },
            // Pinned target so the handoff tool attempts the assignment (which the stub client fails).
            handoff: { mode: "pinned", targetAgentId: 7 },
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
          webhookRouteTokenHash: `rt-sef-${process.pid}`,
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
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 950,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:950`,
          lastEventAt: new Date(),
        },
      });
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "alert_deliveries",
          "alert_channels",
          "execution_logs",
          "llm_usage",
          "agent_threads",
          "conversations",
          "contacts",
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

    test("a failed handoff assignment lands a warn tool line and an alert delivery; the tool line itself stays ok", async () => {
      const ctx: TenantContext = {
        tenantId,
        userId: null,
        role: "TENANT_ADMIN",
      };
      const channel = await createAlertChannel(
        ctx,
        {
          name: "Ops",
          type: "webhook",
          url: outboundUrl("/hooks/side-effects"),
          minLevel: "warn",
        },
        appDb,
      );

      const client = {
        sendMessage: async () => ({}),
        sendPrivateNote: async () => ({}),
        toggleStatus: async () => ({}),
        assignToAgent: async () => {
          throw new Error("Chatwoot rejected the assignment (HTTP 500)");
        },
      } as unknown as ChatwootClient;

      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: incoming(950),
        base: appDb,
        deps: {
          makeModel: () => new HandoffThenReplyModel("Transferido!") as never,
          makeClient: async () => client,
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("posted");

      const isSideEffect = (r: ToolRow) =>
        (r.detail as { phase?: string } | null)?.phase === "assign";
      const rows = await pollToolRows((rs) => rs.some(isSideEffect));

      // The handoff tool call itself succeeded → its own line is info/ok.
      const okLine = rows.find(
        (r) =>
          (r.detail as { tool?: string } | null)?.tool === "handoff_to_human" &&
          r.status === "ok",
      );
      expect(okLine).toBeDefined();
      expect(okLine?.level).toBe("info");

      // The swallowed assignment failure became its OWN warn line, named after the tool.
      const warnLine = rows.find(isSideEffect);
      expect(warnLine).toBeDefined();
      expect(warnLine?.level).toBe("warn");
      expect(warnLine?.status).toBe("error");
      expect(warnLine?.errorMessage).toContain("assignment");
      expect((warnLine?.detail as { tool?: string } | null)?.tool).toBe(
        "handoff_to_human",
      );

      // And it paged the minLevel:warn channel — the invisible-failure complaint of the issue.
      let delivery: { level: string | null } | null = null;
      for (let i = 0; i < 50 && !delivery; i++) {
        delivery = await suDb.alertDelivery.findFirst({
          where: { tenantId, channelId: BigInt(channel.id), stage: "tool" },
          select: { level: true },
        });
        if (!delivery) await new Promise((r) => setTimeout(r, 100));
      }
      expect(delivery).not.toBeNull();
      expect(delivery?.level).toBe("warn");
    });
  },
);
