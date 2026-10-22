import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { runPlaygroundTurn } from "@/modules/playground/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { guardrailModel } from "../utils/scripted-models";

// The playground's input screening reads the session's own thread as context: what the judge
// receives on a later turn holds the earlier turns, labeled, and never a turn the check stopped.

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

const GUARD_MODEL = "guard-judge";
const TEMPLATE = "[bloqueado]";
let tenantId = 0n;
let agentWindow = 0n;
let agentNoWindow = 0n;

// The judge sees every screening's messages and trips only on BAD; the agent answers in order.
function models(replies: string[]) {
  const judged: string[][] = [];
  const make = ((args: { model?: string }) => {
    if (args?.model === GUARD_MODEL)
      return guardrailModel(async (msgs) => {
        const texts = msgs.map((m) => String(m.content));
        judged.push(texts);
        const bad = texts[texts.length - 1]?.includes("BAD") ?? false;
        return {
          content: JSON.stringify({
            violated: bad,
            categories: bad ? ["unsafe_content"] : [],
            rationale: bad ? "r" : "",
            suggestedReply: null,
          }),
        };
      });
    const model = new FakeListChatModel({ responses: replies });
    return new Proxy(model, {
      get(t, prop, recv) {
        if (prop === "bindTools") return () => model;
        return Reflect.get(t, prop, recv);
      },
    });
  }) as never;
  return { make, judged };
}

describe.skipIf(!dbUp)("playground guardrail context", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PGC", slug: `pgc-${process.pid}` },
    });
    tenantId = t.id;
    const ref = async (name: string) =>
      `vault:${
        (
          await suDb.vaultEntry.create({
            data: { tenantId, name, secret: encryptJson("sk-test") },
            select: { id: true },
          })
        ).id
      }`;
    const llmRef = await ref("llm-key");
    const guardRef = await ref("guard-key");
    const settings = (contextMessages: number) => ({
      guardrails: {
        enabled: true,
        provider: "openai",
        model: GUARD_MODEL,
        credentialRef: guardRef,
        input: {
          enabled: true,
          action: "template",
          templateMessage: TEMPLATE,
          checks: {
            toxicity: false,
            unsafeContent: true,
            competitorMentions: false,
          },
          contextMessages,
        },
        output: { enabled: false },
      },
    });
    const mk = (name: string, contextMessages: number) =>
      suDb.agent
        .create({
          data: {
            tenantId,
            name,
            systemPrompt: "x",
            modelConfig: {
              provider: "openai",
              model: "gpt-4o-mini",
              credentialRef: llmRef,
            },
            settings: settings(contextMessages) as never,
          },
        })
        .then((a) => a.id);
    agentWindow = await mk("Window", 4);
    agentNoWindow = await mk("NoWindow", 0);
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "playground_media",
        "playground_turn_notes",
        "playground_sessions",
        "llm_usage",
        "execution_logs",
        "agents",
        "vault_entries",
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

  const turn = async (
    agentId: bigint,
    m: ReturnType<typeof models>,
    checkpointer: MemorySaver,
    message: string,
    threadId?: string,
  ) =>
    runPlaygroundTurn({
      ctx: ctx(tenantId),
      agentId,
      message,
      ...(threadId ? { threadId } : {}),
      base: appDb,
      deps: { makeModel: m.make, checkpointer },
    });

  test("a later turn is judged with the earlier ones as context, and only itself", async () => {
    const m = models(["R1 qual evento?", "R2 pista ou vip?"]);
    const cp = new MemorySaver();
    const first = await turn(agentWindow, m, cp, "C1 quero ingresso");
    expect(m.judged[0]).toHaveLength(2);
    await turn(agentWindow, m, cp, "C2 show de sábado", first.threadId);
    const second = m.judged[1] ?? [];
    expect(second).toHaveLength(3);
    expect(second[1]).toMatch(/customer: C1 quero ingresso/);
    expect(second[1]).toMatch(/assistant: R1 qual evento\?/);
    expect(second[1]).not.toMatch(/C2/);
    expect(second[2]).toBe("C2 show de sábado");
  });

  test("a turn the check stopped never comes back as context", async () => {
    const m = models(["R1 claro", "R3 ok"]);
    const cp = new MemorySaver();
    const first = await turn(agentWindow, m, cp, "C1 horário?");
    const blocked = await turn(agentWindow, m, cp, "BAD", first.threadId);
    expect(blocked.reply).toBe(TEMPLATE);
    await turn(agentWindow, m, cp, "C3 estacionamento?", first.threadId);
    const third = m.judged[2] ?? [];
    expect(third.join("\n")).not.toMatch(/BAD/);
    expect(third[1]).toMatch(/customer: C1 horário\?/);
  });

  test("with the window at 0 the judge reads the message alone", async () => {
    const m = models(["R1 ok", "R2 ok"]);
    const cp = new MemorySaver();
    const first = await turn(agentNoWindow, m, cp, "C1 oi");
    await turn(agentNoWindow, m, cp, "C2 tudo bem?", first.threadId);
    expect(m.judged[1]).toHaveLength(2);
    expect(m.judged[1]?.join("\n")).not.toMatch(/C1 oi/);
  });
});
