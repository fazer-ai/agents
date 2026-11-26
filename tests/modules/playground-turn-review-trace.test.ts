import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { runPlaygroundTurn } from "@/modules/playground/service";
import {
  applyTurnNotes,
  rebuildPlaygroundTurns,
} from "@/modules/playground/sessions";
import { listThreadTurnNotes } from "@/modules/playground/turn-notes";
import { dbProbeFailed } from "@/tests/db-gate";
import { guardrailModel } from "../utils/scripted-models";

// The turn review's call verdicts in the playground trace: each one beside the call it judged, live
// and when the saved session is rebuilt, so a veto and the retry read in the order they ran.

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

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

const GUARD_MODEL = "guard-judge";
let tenantId = 0n;
let agentId = 0n;
let agentFallback = 0n;

// The agent writes a note twice (the first vetoed, the retry approved, or with `alwaysFlagged` run
// past the attempts), then answers.
function models(alwaysFlagged = false) {
  let reviews = 0;
  let generations = 0;
  const make = ((args: { model?: string }) => {
    if (args?.model === GUARD_MODEL)
      return guardrailModel(async () => {
        reviews += 1;
        const violated = alwaysFlagged || reviews === 1;
        return {
          content: JSON.stringify({
            violated,
            categories: violated ? ["turn_review"] : [],
            rationale: violated ? "Pergunte antes." : "",
            suggestedReply: null,
          }),
        };
      });
    return {
      async invoke() {
        return new AIMessage("Anotado.");
      },
      bindTools() {
        let n = 0;
        return {
          async invoke() {
            n += 1;
            generations += 1;
            return n <= 2
              ? new AIMessage({
                  content: "",
                  tool_calls: [
                    {
                      name: "private_note",
                      args: { content: `NOTA-${n}` },
                      id: `nota-${n}`,
                    },
                  ],
                })
              : new AIMessage("Anotado.");
          },
        };
      },
    } as unknown as BaseChatModel;
  }) as never;
  return { make, generations: () => generations };
}

// Throws on the save that would record the second note's result, after the write ran.
class FailsAfterTheWrite extends MemorySaver {
  override async put(
    ...args: Parameters<MemorySaver["put"]>
  ): ReturnType<MemorySaver["put"]> {
    const msgs = (
      args[1].channel_values as { messages?: BaseMessage[] } | undefined
    )?.messages;
    if (
      msgs?.some(
        (m) =>
          m.getType() === "tool" &&
          (m as { tool_call_id?: string }).tool_call_id === "nota-2",
      )
    )
      throw new Error("checkpoint write failed");
    return super.put(...args);
  }
}

describe.skipIf(!dbUp)("the turn review in the playground trace", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "PGTR", slug: `pgtr-${process.pid}` },
      })
    ).id;
    const key = async (name: string) =>
      `vault:${
        (
          await suDb.vaultEntry.create({
            data: { tenantId, name, secret: encryptJson("sk-test") },
            select: { id: true },
          })
        ).id
      }`;
    const llmRef = await key("llm-key");
    const guardRef = await key("guard-key");
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Revisado",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: llmRef,
          },
          settings: {
            guardrails: {
              enabled: true,
              provider: "openai",
              model: GUARD_MODEL,
              credentialRef: guardRef,
              input: { enabled: false },
              output: { enabled: false },
              turnReview: { enabled: true, action: "revise", maxAttempts: 2 },
            },
          } as never,
        },
      })
    ).id;
    agentFallback = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Fallback",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: llmRef,
          },
          settings: {
            guardrails: {
              enabled: true,
              provider: "openai",
              model: GUARD_MODEL,
              credentialRef: guardRef,
              input: { enabled: false },
              output: { enabled: false, templateMessage: "TEMPLATE-PG" },
              turnReview: {
                enabled: true,
                action: "revise",
                maxAttempts: 1,
                fallback: "template",
              },
            },
          } as never,
        },
      })
    ).id;
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agentFallback,
        source: "NATIVE",
        enabledTools: ["private_note"],
        knowledgeBaseIds: [],
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId,
        source: "NATIVE",
        enabledTools: ["private_note"],
        knowledgeBaseIds: [],
      },
    });
  });

  afterAll(async () => {
    if (dbUp && tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
    await app?.$disconnect();
    await su?.$disconnect();
  });

  // The bug it catches: both call verdicts rendered after both tool results, with nothing tying a
  // verdict to its call, so the veto read as a verdict on the retry.
  test("each call verdict sits right after its call, live and rebuilt", async () => {
    const cp = new MemorySaver();
    const r = await runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId,
      message: "anota aí",
      base: appDb,
      deps: { makeModel: models().make, checkpointer: cp },
    });
    const shape = (trace: readonly { type: string }[]) =>
      trace
        .map((e) => {
          const x = e as {
            type: string;
            id?: string | null;
            callId?: string;
            step?: string;
            outcome?: string;
          };
          if (x.type === "tool_call" || x.type === "tool_result")
            return `${x.type}:${x.id}`;
          if (x.type === "guardrail" && x.step === "call")
            return `verdict:${x.callId}:${x.outcome}`;
          return null;
        })
        .filter((s): s is string => s !== null);
    const expected = [
      "tool_call:nota-1",
      "verdict:nota-1:revised",
      "tool_result:nota-1",
      "tool_call:nota-2",
      "verdict:nota-2:clean",
      "tool_result:nota-2",
    ];
    expect(shape(r.trace ?? [])).toEqual(expected);
    const messages = (
      (await cp.getTuple({ configurable: { thread_id: r.threadId } }))
        ?.checkpoint?.channel_values as { messages?: BaseMessage[] }
    )?.messages as BaseMessage[];
    const turns = applyTurnNotes(
      rebuildPlaygroundTurns(messages),
      await listThreadTurnNotes(appDb, ctx(tenantId), r.threadId),
    );
    const reply = turns.find((t) => t.role === "assistant");
    expect(shape(reply?.trace ?? [])).toEqual(expected);
  });

  // The bug it catches: a write run past the attempts left the fallback waiting on another
  // generation, and a turn that failed there showed an error instead of the decided reply.
  for (const failing of [false, true])
    test(`a write past the attempts settles the fallback with no further generation${failing ? ", the graph failing after it" : ""}`, async () => {
      const m = models(true);
      const r = await runPlaygroundTurn({
        ctx: ctx(tenantId),
        agentId: agentFallback,
        message: "anota aí",
        base: appDb,
        deps: {
          makeModel: m.make,
          checkpointer: failing ? new FailsAfterTheWrite() : new MemorySaver(),
        },
      });
      expect([r.reply, m.generations()]).toEqual(["TEMPLATE-PG", 2]);
    });

  // The bug it catches: the reply recovered after a failed save was anchored on the session's
  // previous answer, so the verdict and the fallback landed on the first turn.
  test("a fallback settled after a failed save is anchored on its own turn", async () => {
    const cp = new FailsAfterTheWrite();
    const first = await runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId: agentFallback,
      message: "oi",
      base: appDb,
      deps: {
        makeModel: ((args: { model?: string }) =>
          args?.model === GUARD_MODEL
            ? guardrailModel(async () => ({
                content: JSON.stringify({
                  violated: false,
                  categories: [],
                  rationale: "",
                  suggestedReply: null,
                }),
              }))
            : ({
                async invoke() {
                  return new AIMessage("OLA-PRIMEIRO");
                },
                bindTools() {
                  return {
                    async invoke() {
                      return new AIMessage("OLA-PRIMEIRO");
                    },
                  };
                },
              } as unknown as BaseChatModel)) as never,
        checkpointer: cp,
      },
    });
    expect(first.reply).toBe("OLA-PRIMEIRO");
    const second = await runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId: agentFallback,
      threadId: first.threadId,
      message: "anota aí",
      base: appDb,
      deps: { makeModel: models(true).make, checkpointer: cp },
    });
    expect(second.reply).toBe("TEMPLATE-PG");
    const messages = (
      (await cp.getTuple({ configurable: { thread_id: first.threadId } }))
        ?.checkpoint?.channel_values as { messages?: BaseMessage[] }
    )?.messages as BaseMessage[];
    const turns = applyTurnNotes(
      rebuildPlaygroundTurns(messages),
      await listThreadTurnNotes(appDb, ctx(tenantId), first.threadId),
    );
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      "user:oi",
      "assistant:OLA-PRIMEIRO",
      "user:anota aí",
      "assistant:TEMPLATE-PG",
    ]);
  });
});
