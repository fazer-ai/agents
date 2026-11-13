import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { contentToText } from "@/graph/message-text";
import { FOLLOWUP_SKIP_SENTINEL } from "@/graph/silence";
import type { TenantContext } from "@/lib/tenancy";
import { runPlaygroundTurn } from "@/modules/playground/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { guardrailModel } from "../utils/scripted-models";

// The factual-grounding check as the operator meets it in the playground: the verdict and its claims
// in the trace, and under `revise` the reply the customer would read is the agent's second answer.
// The source is the native calculator, named as the source tool: any tool works, and this one runs.

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

const ctx = (t: bigint): TenantContext => ({
  tenantId: t,
  userId: null,
  role: "TENANT_ADMIN",
});
const REVIEW_MODEL = "grounding-judge";
const DRAFT = "O resultado é 3.";
const REVISED = "O resultado é 2.";
let tenantId = 0n;
let agentObserve = 0n;
let agentRevise = 0n;
let agentReviseTools = 0n;
let agentTemplate = 0n;

// The agent calls the calculator, then answers; asked again (the revision) it answers the second
// line. The reviewer flags the first answer and sees whatever it is sent.
function models(rewrite = REVISED, clean = new Set<number>()) {
  const reviewed: string[] = [];
  let answers = 0;
  const make = ((args: { model?: string }) => {
    if (args?.model === REVIEW_MODEL)
      return guardrailModel(async (msgs) => {
        reviewed.push(contentToText((msgs.at(-1)?.content ?? "") as never));
        if (clean.has(reviewed.length))
          return {
            content: JSON.stringify({
              violated: false,
              claims: [],
              rationale: "",
            }),
          };
        return {
          content: JSON.stringify({
            violated: true,
            claims: [{ claim: "é 3", type: "contradiction", evidence: "2" }],
            rationale: "r",
          }),
        };
      });
    // The rewrite is asked without tools, through the raw `invoke`.
    return {
      async invoke() {
        return new AIMessage(rewrite);
      },
      bindTools() {
        return {
          async invoke(msgs: BaseMessage[]) {
            if (!msgs.some((m) => m.getType() === "tool"))
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "calculator", args: { expression: "1+1" }, id: "c1" },
                ],
              });
            answers += 1;
            return new AIMessage(answers === 1 ? DRAFT : REVISED);
          },
        };
      },
    } as unknown as BaseChatModel;
  }) as never;
  return { make, reviewed };
}

describe.skipIf(!dbUp)("factual grounding in the playground", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "PGF", slug: `pgf-${process.pid}` },
      })
    ).id;
    const ref = `vault:${
      (
        await suDb.vaultEntry.create({
          data: { tenantId, name: "k", secret: encryptJson("sk-test") },
          select: { id: true },
        })
      ).id
    }`;
    const mk = async (
      name: string,
      action: string,
      extra: Record<string, unknown> = {},
    ) => {
      const id = (
        await suDb.agent.create({
          data: {
            tenantId,
            name,
            systemPrompt: "SENTINELA-PROMPT",
            modelConfig: {
              provider: "openai",
              model: "gpt-4o-mini",
              credentialRef: ref,
            },
            settings: {
              observability: { logToolValues: true },
              guardrails: {
                enabled: true,
                provider: "openai",
                model: REVIEW_MODEL,
                credentialRef: ref,
                input: { enabled: false },
                output: { enabled: false, templateMessage: "TEMPLATE-PG" },
                factualGrounding: {
                  enabled: true,
                  sourceTools: ["calculator"],
                  action,
                  ...extra,
                },
              },
            } as never,
          },
        })
      ).id;
      await suDb.agentToolSelection.create({
        data: {
          tenantId,
          agentId: id,
          source: "NATIVE",
          enabledTools: ["calculator"],
          knowledgeBaseIds: [],
        },
      });
      return id;
    };
    agentObserve = await mk("Observe", "observe");
    agentRevise = await mk("Revise", "revise", { reviseWithTools: false });
    agentReviseTools = await mk("ReviseTools", "revise");
    agentTemplate = await mk("Template", "template");
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "playground_media",
        "playground_turn_notes",
        "llm_usage",
        "agent_tool_selections",
        "execution_logs",
        "agents",
        "vault_entries",
      ])
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("observe: the reply goes out as written, and the trace names the claim and its evidence", async () => {
    const m = models();
    const r = await runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId: agentObserve,
      message: "quanto é 1+1?",
      base: appDb,
      deps: { makeModel: m.make, checkpointer: new MemorySaver() },
    });
    expect(r.reply).toBe(DRAFT);
    const row = r.trace.find((e) => e.type === "guardrail");
    expect(row).toMatchObject({
      check: "factual_grounding",
      outcome: "observed",
      claims: [{ claim: "é 3", type: "contradiction", evidence: "2" }],
    });
    expect(m.reviewed[0]).toContain(
      '<tool_call name="calculator" source="yes">',
    );
    expect(m.reviewed[0]).toContain(DRAFT);
    expect(m.reviewed[0]).not.toContain("SENTINELA-PROMPT");
  });

  test("revise: the operator reads the second answer, and the trace says it was rewritten", async () => {
    const m = models();
    const r = await runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId: agentRevise,
      message: "quanto é 1+1?",
      base: appDb,
      deps: { makeModel: m.make, checkpointer: new MemorySaver() },
    });
    expect(r.reply).toBe(REVISED);
    const row = r.trace.find((e) => e.type === "guardrail");
    expect(row).toMatchObject({ outcome: "revised", action: "revise" });
    expect(m.reviewed).toHaveLength(1);
  });

  test("revise with the sources: the rewrite is reviewed again, and a clean one is what the operator reads", async () => {
    const m = models(REVISED, new Set([2]));
    const r = await runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId: agentReviseTools,
      message: "quanto é 1+1?",
      base: appDb,
      deps: { makeModel: m.make, checkpointer: new MemorySaver() },
    });
    expect(r.reply).toBe(REVISED);
    expect(m.reviewed).toHaveLength(2);
    expect(m.reviewed[1]).toContain(REVISED);
  });

  test("revise: a rewrite that is only the silence token shows the Output template, as the inbox sends", async () => {
    const m = models(FOLLOWUP_SKIP_SENTINEL);
    const r = await runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId: agentRevise,
      message: "quanto é 1+1?",
      base: appDb,
      deps: { makeModel: m.make, checkpointer: new MemorySaver() },
    });
    expect(r.reply).toBe("TEMPLATE-PG");
  });

  test("template: the operator reads the Output template in place of the reply", async () => {
    const m = models();
    const r = await runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId: agentTemplate,
      message: "quanto é 1+1?",
      base: appDb,
      deps: { makeModel: m.make, checkpointer: new MemorySaver() },
    });
    expect(r.reply).toBe("TEMPLATE-PG");
    expect(r.trace.find((e) => e.type === "guardrail")).toMatchObject({
      outcome: "replaced",
      action: "template",
    });
  });

  test("with guardrails off for the turn nothing is reviewed", async () => {
    const m = models();
    const r = await runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId: agentRevise,
      message: "quanto é 1+1?",
      base: appDb,
      guardrails: false,
      deps: { makeModel: m.make, checkpointer: new MemorySaver() },
    });
    expect(r.reply).toBe(DRAFT);
    expect(m.reviewed).toHaveLength(0);
  });
});
