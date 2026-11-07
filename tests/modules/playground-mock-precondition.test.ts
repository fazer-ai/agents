import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import { runPlaygroundTurn } from "@/modules/playground/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog } from "../utils/flowlog";

// The playground is where an operator tests a tool's preconditions, so a mocked tool has to be refused
// by the same rules the real one is: a canned result that runs past the rule would show the operator
// an agent that, in production, never gets that far.
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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const MOCK = "transferido (simulado)";

// Calls `handoff_to_human` once and records every tool result it is handed. Its plain `invoke` (what
// the customer_choice judge calls) answers with nothing, which the judge reads as a NO.
class Scripted {
  readonly answers: string[] = [];
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        for (const m of messages)
          if (m.getType() === "tool") self.answers.push(String(m.content));
        n += 1;
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "handoff_to_human",
                  args: {
                    reason: "pediu um humano",
                    customerMessage: "Vou te passar para a equipe.",
                  },
                  id: "call_1",
                  type: "tool_call" as const,
                },
              ],
            })
          : new AIMessage("");
      },
    };
  }
}

let tenantId = 0n;
const agents = new Map<string, bigint>();

describe.skipIf(!dbUp)("a mocked tool in the playground", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "T1679", slug: `t1679-mock-${process.pid}` },
    });
    tenantId = t.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    for (const [label, rule] of [
      ["attribute", { kind: "attribute", scope: "contact", key: "cpf" }],
      ["customer_choice", { kind: "customer_choice" }],
      ["none", null],
    ] as const) {
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: `Atendente ${label}`,
          systemPrompt: "Você é uma secretária prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${key.id}`,
          },
          settings: {
            split: { enabled: false },
            ...(rule ? { toolPreconditions: { handoff_to_human: rule } } : {}),
          },
        },
        select: { id: true },
      });
      agents.set(label, agent.id);
    }
  });

  afterAll(async () => {
    await settleFlowEvents();
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      for (const table of [
        "llm_usage",
        "agent_threads",
        "agents",
        "vault_entries",
      ]) {
        await suDb
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => 0);
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
  });

  async function turn(label: string): Promise<string[]> {
    const model = new Scripted();
    const ctx: TenantContext = { tenantId, userId: null, role: "TENANT_ADMIN" };
    await runPlaygroundTurn({
      ctx,
      agentId: agents.get(label) as bigint,
      message: "quero falar com alguém",
      base: appDb,
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
      },
      overrides: { toolMocks: { handoff_to_human: MOCK } },
    });
    return model.answers;
  }

  test.each([
    ["attribute", "the contact attribute `cpf` to be set"],
    ["customer_choice", "the customer to have chosen every value"],
  ])(
    "is refused by a %s rule on that tool, and its canned result never comes back",
    async (label, why) => {
      const answers = await turn(label);
      expect(answers).toHaveLength(1);
      expect(answers[0]).toContain("`handoff_to_human` was not run");
      expect(answers[0]).toContain(why);
      expect(answers[0]).not.toContain(MOCK);
    },
  );

  test("with no rule on the tool, the mock answers", async () => {
    expect(await turn("none")).toEqual([MOCK]);
  });
});
