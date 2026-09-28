import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";
import { flowLogRows } from "../utils/flowlog";

// The unit tests cover the rule; this covers what only a real turn shows. First, the ceiling on the
// agent row reaches the model call (agent.settings.limits → loadAgentConfig → buildModelAndGraph →
// the agent node): a knob that never arrives fails unnoticed. Second, the trim LEAVES A TRACE, since
// from the operator's chair a silent trim and an agent that forgot look identical. The line is INFO,
// because warn/error fan out to the alert channels and a working ceiling trims on nearly every turn
// of a long thread, and it carries counts only, never a fragment of what was dropped.

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

// Distinctive enough that finding it anywhere is proof, and never a substring of anything else.
const FIRST_QUESTION = "MARCADOR-PRIMEIRA-PERGUNTA";
// Long replies so a handful of turns is enough to blow past the ceiling, the way a real thread
// spanning several attendances does over weeks. At 604 tokens each, six turns put ~3k of history in
// front of a 2k ceiling, so the oldest attendance has to go.
const REPLY = `Claro. ${"palavra ".repeat(600)}`;

// Records every message list handed to the model, so the test can assert what the model SAW rather
// than trusting the log line to describe it.
class RecordingModel {
  seen: BaseMessage[][] = [];
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.seen.push(messages);
    return new AIMessage(REPLY);
  }
  bindTools(_tools: unknown) {
    return { invoke: (messages: BaseMessage[]) => this.invoke(messages) };
  }
}

function stubClient(sent: number[]) {
  const client = {
    sendMessage: async (conversationId: number) => {
      sent.push(conversationId);
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

async function setCeiling(maxHistoryTokens: number | null) {
  await suDb.agent.updateMany({
    where: { tenantId },
    data: {
      settings: {
        split: { enabled: false },
        ...(maxHistoryTokens === null ? {} : { limits: { maxHistoryTokens } }),
      },
    },
  });
}

// The `generate` lines of ONE thread, scoped so neither test below can answer with the other's rows:
// both run in the same tenant and one asserts that NO trim line exists, which read across the tenant
// would be a claim about its neighbour and would depend on declaration order.
async function generateLines(convId: number) {
  return flowLogRows(suDb, {
    where: {
      tenantId,
      stage: "generate",
      level: "info",
      threadId: `${tenantId}:${instanceId}:${convId}`,
    },
    select: { detail: true, level: true },
  });
}

const isTrim = (r: { detail: unknown }) =>
  typeof (r.detail as Record<string, unknown> | null)?.historyDropped ===
  "number";

// The two questions this file asks of the trail need different readers. A trimmed turn writes TWO
// `generate`/`info` rows, its ordinary one and one for the trim (`onHistoryTrim` is its own
// `emitFlowEvent` in src/graph/runtime.ts), so a reader waiting on the TOTAL count is satisfied by
// the ordinary rows while the trim writes are still in flight, and intermittently reads none.

// "Did this thread trim?" — poll until a trim row lands. The line is what is being asserted, so
// waiting for it is the whole job.
async function waitForTrimLines(convId: number) {
  let trims: Awaited<ReturnType<typeof generateLines>> = [];
  for (let i = 0; i < 30 && trims.length === 0; i++) {
    trims = (await generateLines(convId)).filter(isTrim);
    if (trims.length === 0) await new Promise((r) => setTimeout(r, 100));
  }
  return trims;
}

// "Did this thread trim NOTHING?" Waits on the count of NON-trim rows: polling for a trim that must
// never arrive would only spend the whole timeout and agree with itself. `emitFlowEvent` offers no
// barrier, so this composes two: a turn's ordinary row is dispatched after any trim row of that turn
// (`onHistoryTrim` runs while the window is built, before the model call), so `turns` ordinary rows
// means every owed trim write was dispatched; the settle re-read covers two transactions landing out
// of order on a pool. Neither is a lock, so the regression is ALSO caught one assertion earlier: a
// trim fires only when the window dropped something, so the model no longer saw all 12 messages.
async function trimLinesAfterTurns(convId: number, turns: number) {
  let rows: Awaited<ReturnType<typeof generateLines>> = [];
  for (let i = 0; i < 30; i++) {
    rows = await generateLines(convId);
    if (rows.filter((r) => !isTrim(r)).length >= turns) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 100));
  return (await generateLines(convId)).filter(isTrim);
}

describe.skipIf(!dbUp)("a turn under the agent's history ceiling", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "HC", slug: `hc-${process.pid}` },
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
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `hc-route-${process.pid}`,
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

  // Six turns on one thread, which is what a contact who keeps coming back produces: the checkpointer
  // thread spans every conversation they ever had on the channel and nothing prunes it.
  async function runThread(convId: number, model: RecordingModel) {
    const checkpointer = new MemorySaver();
    const sent: number[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: incoming(
          convId,
          turn + 1,
          turn === 0 ? FIRST_QUESTION : `pergunta ${turn}`,
        ),
        base: appDb,
        deps: {
          makeModel: () => model as unknown as BaseChatModel,
          makeClient: stubClient(sent),
          checkpointer,
        },
      });
      expect(outcome).toBe("posted");
    }
    return sent;
  }

  test("without a ceiling the thread keeps growing, and the trail says nothing", async () => {
    await setCeiling(null);
    await seedConversation(980);
    const model = new RecordingModel();
    const sent = await runThread(980, model);

    expect(sent).toHaveLength(6);
    const last = model.seen.at(-1);
    expect(last).toBeDefined();
    if (!last) return;
    // Every turn is still there on the last call: 1 system + 6 questions + 5 previous answers.
    expect(last).toHaveLength(12);
    expect(last.some((m) => String(m.content).includes(FIRST_QUESTION))).toBe(
      true,
    );
    // Six turns ran, so six lines are owed; among them, none may carry a trim.
    expect(await trimLinesAfterTurns(980, 6)).toHaveLength(0);
  });

  test("with a ceiling the oldest turns stop travelling, and the trail records it", async () => {
    await setCeiling(2_000);
    await seedConversation(981);
    const model = new RecordingModel();
    const sent = await runThread(981, model);

    expect(sent).toHaveLength(6);
    const last = model.seen.at(-1);
    expect(last).toBeDefined();
    if (!last) return;

    // NOTE: The effect under test: the first attendance no longer rides on every turn.
    expect(last.some((m) => String(m.content).includes(FIRST_QUESTION))).toBe(
      false,
    );
    expect(last.length).toBeLessThan(12);
    // The turn being answered survived, and the window still opens on the customer.
    expect(String(last.at(-1)?.content)).toBe("pergunta 5");
    expect(last[0]?.getType()).toBe("system");
    expect(last[1]?.getType()).toBe("human");

    const lines = await waitForTrimLines(981);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // INFO, never warn: warn fans out to the alert channels, and a working ceiling trims on
      // nearly every turn of a long thread — that would page the operator forever.
      expect(line.level).toBe("info");
      const detail = line.detail as Record<string, unknown>;
      expect(detail.historyDropped as number).toBeGreaterThan(0);
      expect(detail.historyKept as number).toBeGreaterThan(0);
      expect(detail.historyTokens as number).toBeGreaterThan(0);
      // The detail column promises ids/counts/enums and no message text. A trim line is the easy
      // place to break that promise, because what it is reporting on IS the text.
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain(FIRST_QUESTION);
      expect(serialized).not.toContain("palavra");
      expect(serialized).not.toContain("pergunta");
    }
  });
});
