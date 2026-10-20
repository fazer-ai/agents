import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { runClientTurn } from "@/modules/client-channel/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { guardrailModel } from "../utils/scripted-models";

// The client channel screens like the inbox and the playground: the user's message on the way in,
// before the graph, and the reply on the way out, before it is returned. What a browser sends back
// from its tools is a tool result, not the user's words, and is not screened on the way in.

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

const RAW_REPLY = "Nosso concorrente resolve isso melhor.";
const TEMPLATE = "[bloqueado pela política do canal]";
const GUARD_MODEL = "guard-judge";
const SPECS = [
  {
    name: "ler_tela",
    description: "lê a tela",
    parameters: { type: "object", properties: {} },
  },
];

let tenantId = 0n;
let agentOutput = 0n;
let agentInput = 0n;
let agentRelevance = 0n;
let agentHandoff = 0n;
let agentHold = 0n;
let agentExternal = 0n;
let agentExternalHandoff = 0n;
let agentExternalHold = 0n;
let ctx: TenantContext;

const HOOK = "https://check.example.com/hook";

// The operator's endpoint, answering every request with `answer` (or failing with `status`), and
// what it was asked.
function endpoint(answer: Record<string, unknown> | null, status = 200) {
  const asked: { candidate: { text: string }; toolCalls: unknown[] }[] = [];
  return {
    asked,
    deps: {
      assertSafe: async (u: string) => new URL(u),
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const b = JSON.parse(String(init.body)) as {
          candidateId: string;
          candidate: { text: string };
          toolCalls: unknown[];
        };
        asked.push(b);
        return new Response(
          JSON.stringify(
            answer ? { ...answer, candidateId: b.candidateId } : {},
          ),
          { status },
        );
      }) as unknown as typeof fetch,
    },
  };
}

// The guardrails agent's model answers the verdict; the agent's own model answers the turn. When
// `readsTheScreen`, the agent first asks the browser for the screen and answers after the result.
function models(opts: {
  violated: boolean;
  readsTheScreen?: boolean;
  judgeFails?: boolean;
}) {
  let judgeCalls = 0;
  let agentInvokes = 0;
  const judged: string[] = [];
  const make = ((args: { model?: string }) => {
    if (args?.model === GUARD_MODEL)
      return guardrailModel(async (messages: { content: unknown }[]) => {
        judgeCalls += 1;
        judged.push(messages.map((m) => String(m.content ?? "")).join("\n"));
        if (opts.judgeFails) throw new Error("classifier down");
        return {
          content: JSON.stringify({
            violated: opts.violated,
            categories: opts.violated ? ["competitor_mentions"] : [],
            rationale: opts.violated ? "names a competitor" : "",
            suggestedReply: null,
          }),
        };
      });
    return {
      async invoke() {
        return new AIMessage(RAW_REPLY);
      },
      bindTools() {
        return {
          async invoke(messages: BaseMessage[]) {
            agentInvokes += 1;
            if (opts.readsTheScreen && messages.at(-1)?.getType() === "human")
              return new AIMessage({
                content: "",
                tool_calls: [{ id: "c1", name: "ler_tela", args: {} }],
              });
            return new AIMessage(RAW_REPLY);
          },
        };
      },
    } as unknown as BaseChatModel;
  }) as never;
  return {
    make,
    judgeCalls: () => judgeCalls,
    agentInvokes: () => agentInvokes,
    judged,
  };
}

function turn(
  agentId: bigint,
  m: ReturnType<typeof models>,
  saver: MemorySaver,
  over: {
    message?: string;
    threadId?: string;
    answers?: Record<string, unknown>;
  },
  external?: ReturnType<typeof endpoint>,
) {
  return runClientTurn({
    ctx,
    agentId,
    user: { id: "ana" },
    clientTools: SPECS,
    base: appDb,
    deps: {
      makeModel: m.make,
      checkpointer: saver,
      externalCheck: external?.deps,
    },
    ...(over as object),
  });
}

describe.skipIf(!dbUp)("client channel guardrails", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CCG", slug: `ccg-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
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
    const checks = {
      toxicity: false,
      unsafeContent: false,
      competitorMentions: true,
      promptAdherence: false,
      answerRelevance: false,
    };
    const dir = (enabled: boolean, over: object = {}) => ({
      enabled,
      action: "template",
      templateMessage: TEMPLATE,
      checks,
      ...over,
    });
    const mk = (
      name: string,
      input: boolean,
      output: boolean,
      outputOver: object = {},
      top: object = {},
    ) =>
      suDb.agent
        .create({
          data: {
            tenantId,
            name,
            systemPrompt: "x",
            modelConfig: {
              provider: "openai",
              model: "gpt-6-luna",
              credentialRef: llmRef,
            },
            settings: {
              guardrails: {
                enabled: true,
                provider: "openai",
                model: GUARD_MODEL,
                credentialRef: guardRef,
                competitors: ["Concorrente"],
                input: dir(input),
                output: dir(output, outputOver),
                ...top,
              },
            } as never,
          },
        })
        .then((a) => a.id);
    agentOutput = await mk("saída", false, true);
    agentInput = await mk("entrada", true, false);
    agentRelevance = await mk("relevância", false, true, {
      checks: { ...checks, competitorMentions: false, answerRelevance: true },
    });
    agentHandoff = await mk("transferência", false, true, {
      action: "handoff",
      handoffMessage: "Uma pessoa da equipe vai continuar daqui.",
    });
    agentHold = await mk(
      "retenção",
      false,
      true,
      { handoffMessage: "Uma pessoa da equipe vai continuar daqui." },
      { onFailure: "hold" },
    );
    agentExternal = await mk(
      "externa",
      false,
      false,
      {},
      {
        external: { url: HOOK },
      },
    );
    agentExternalHandoff = await mk(
      "externa-transferência",
      false,
      false,
      {
        action: "handoff",
        handoffMessage: "Uma pessoa da equipe vai continuar daqui.",
      },
      { external: { url: HOOK } },
    );
    agentExternalHold = await mk(
      "externa-retenção",
      false,
      false,
      { handoffMessage: "Uma pessoa da equipe vai continuar daqui." },
      { onFailure: "hold", external: { url: HOOK } },
    );
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.tenant.deleteMany({ where: { id: tenantId } });
    }
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("a reply that violates the output policy is returned as the template", async () => {
    const m = models({ violated: true });
    const r = await turn(agentOutput, m, new MemorySaver(), { message: "oi" });
    expect(r).toMatchObject({ status: "done", reply: TEMPLATE });
    expect(m.judgeCalls()).toBe(1);
    const lines = await flowLogRows(suDb, {
      where: { tenantId, threadId: r.threadId, stage: "guardrail" },
      select: { detail: true },
    });
    expect(
      lines.map((l) => (l.detail as { direction?: string }).direction),
    ).toContain("output");
  });

  test("a clean verdict leaves the reply as the agent wrote it", async () => {
    const m = models({ violated: false });
    const r = await turn(agentOutput, m, new MemorySaver(), { message: "oi" });
    expect(r).toMatchObject({ status: "done", reply: RAW_REPLY });
    expect(m.judgeCalls()).toBe(1);
  });

  test("a message that violates the input policy never reaches the agent", async () => {
    const m = models({ violated: true });
    const r = await turn(agentInput, m, new MemorySaver(), {
      message: "o Concorrente é melhor?",
    });
    expect(r).toMatchObject({ status: "done", reply: TEMPLATE });
    expect(m.agentInvokes()).toBe(0);
  });

  test("the browser's tool answers are not screened as the user's words", async () => {
    const m = models({ violated: false, readsTheScreen: true });
    const saver = new MemorySaver();
    const first = await turn(agentInput, m, saver, { message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    expect(m.judgeCalls()).toBe(1);
    const done = await turn(agentInput, m, saver, {
      threadId: first.threadId,
      answers: { c1: { ok: true, result: { tela: "Concorrente S.A." } } },
    });
    expect(done.status).toBe("done");
    // Only the user's message was judged on the way in.
    expect(m.judgeCalls()).toBe(1);
    expect(m.judged.join("\n")).not.toContain("Concorrente S.A.");
  });

  test("a reply after the browser's answers is still judged against what the user asked", async () => {
    const m = models({ violated: false, readsTheScreen: true });
    const saver = new MemorySaver();
    const first = await turn(agentRelevance, m, saver, {
      message: "pergunta-marcador sobre a nota",
    });
    if (first.status !== "pending") throw new Error("expected pending");
    const before = m.judgeCalls();
    await turn(agentRelevance, m, saver, {
      threadId: first.threadId,
      answers: { c1: { ok: true, result: { tela: "nota" } } },
    });
    expect(m.judgeCalls()).toBeGreaterThan(before);
    expect(m.judged.slice(before).join("\n")).toContain("pergunta-marcador");
  });

  test("a handoff action says the refusal, not a transfer this channel cannot make", async () => {
    const m = models({ violated: true });
    const r = await turn(agentHandoff, m, new MemorySaver(), { message: "oi" });
    expect(r).toMatchObject({ status: "done", reply: TEMPLATE });
    // The record names what was done, not the transfer the policy asked for.
    const lines = await flowLogRows(suDb, {
      where: { tenantId, threadId: r.threadId, stage: "guardrail" },
      select: { detail: true },
    });
    const actions = lines.map((l) => (l.detail as { action?: string }).action);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions).not.toContain("handoff");
  });

  test("a screening held because the check could not run says the refusal, not a transfer", async () => {
    const m = models({ violated: false, judgeFails: true });
    const r = await turn(agentHold, m, new MemorySaver(), { message: "oi" });
    expect(m.judgeCalls()).toBeGreaterThan(0);
    expect(r).toMatchObject({ status: "done", reply: TEMPLATE });
  });

  test("the operator's external check judges the reply: a block returns the refusal", async () => {
    const m = models({ violated: false });
    const hook = endpoint({ decision: "block", reason: "fora da política" });
    const r = await turn(
      agentExternal,
      m,
      new MemorySaver(),
      { message: "oi" },
      hook,
    );
    expect({ r, asked: hook.asked.map((b) => b.candidate.text) }).toMatchObject(
      { r: { status: "done", reply: TEMPLATE }, asked: [RAW_REPLY] },
    );
    const lines = await flowLogRows(suDb, {
      where: { tenantId, threadId: r.threadId, stage: "guardrail" },
      select: { detail: true },
    });
    expect(lines.map((l) => l.detail)).toContainEqual(
      expect.objectContaining({ check: "external", decision: "block" }),
    );
  });

  test("the external check's replacement is what the user gets, and it sees the browser's tool calls", async () => {
    const m = models({ violated: false, readsTheScreen: true });
    const hook = endpoint({ decision: "replace", text: "Texto do operador." });
    const saver = new MemorySaver();
    const first = await turn(agentExternal, m, saver, { message: "oi" }, hook);
    if (first.status !== "pending") throw new Error("expected pending");
    const done = await turn(
      agentExternal,
      m,
      saver,
      {
        threadId: first.threadId,
        answers: { c1: { ok: true, result: { tela: "nota" } } },
      },
      hook,
    );
    expect({
      done,
      tools: hook.asked.map((b) =>
        b.toolCalls.map((t) => (t as { name: string }).name),
      ),
    }).toMatchObject({
      done: { status: "done", reply: "Texto do operador." },
      tools: [["ler_tela"]],
    });
  });

  // What reopening the conversation shows is what the user was shown: the reply as the screenings
  // left it, never the draft they replaced.
  const transcript = async (threadId: string) =>
    (
      await suDb.clientThreadMessage.findMany({
        where: { threadId },
        orderBy: { id: "asc" },
        select: { role: true, text: true },
      })
    ).map((m) => [m.role, m.text]);

  test("the transcript keeps a reply the output policy replaced as the template", async () => {
    const r = await turn(
      agentOutput,
      models({ violated: true }),
      new MemorySaver(),
      {
        message: "oi",
      },
    );
    expect(await transcript(r.threadId)).toEqual([
      ["user", "oi"],
      ["agent", TEMPLATE],
    ]);
  });

  test("the transcript keeps a message the input policy refused, and the refusal it got", async () => {
    const r = await turn(
      agentInput,
      models({ violated: true }),
      new MemorySaver(),
      {
        message: "o Concorrente é melhor?",
      },
    );
    expect(await transcript(r.threadId)).toEqual([
      ["user", "o Concorrente é melhor?"],
      ["agent", TEMPLATE],
    ]);
  });

  test("the transcript keeps the external check's replacement, once, after the browser's answers", async () => {
    const m = models({ violated: false, readsTheScreen: true });
    const hook = endpoint({ decision: "replace", text: "Texto do operador." });
    const saver = new MemorySaver();
    const first = await turn(agentExternal, m, saver, { message: "oi" }, hook);
    if (first.status !== "pending") throw new Error("expected pending");
    await turn(
      agentExternal,
      m,
      saver,
      {
        threadId: first.threadId,
        answers: { c1: { ok: true, result: { tela: "nota" } } },
      },
      hook,
    );
    expect(await transcript(first.threadId)).toEqual([
      ["user", "oi"],
      ["agent", "Texto do operador."],
    ]);
  });

  test("an external block under a handoff action says the refusal, not a transfer", async () => {
    const m = models({ violated: false });
    const r = await turn(
      agentExternalHandoff,
      m,
      new MemorySaver(),
      { message: "oi" },
      endpoint({ decision: "block" }),
    );
    expect(r).toMatchObject({ status: "done", reply: TEMPLATE });
  });

  test("an external check that fails under hold withholds the reply and says the refusal", async () => {
    const m = models({ violated: false });
    const r = await turn(
      agentExternalHold,
      m,
      new MemorySaver(),
      { message: "oi" },
      endpoint(null, 500),
    );
    expect(r).toMatchObject({ status: "done", reply: TEMPLATE });
  });
});
