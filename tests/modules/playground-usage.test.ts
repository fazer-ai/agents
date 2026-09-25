import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { emptyTurnUsage, sumTurnUsage, UsageCapture } from "@/graph/usage";
import type { TenantContext } from "@/lib/tenancy";
import {
  runPlaygroundExtract,
  runPlaygroundFileTurn,
  runPlaygroundFollowup,
  runPlaygroundTurn,
} from "@/modules/playground/service";
import {
  applyTurnNotes,
  attachTurnUsage,
  getPlaygroundSessionTurns,
  getPlaygroundSessionUsage,
  type RebuiltTurn,
  startPlaygroundThread,
} from "@/modules/playground/sessions";
import { isValidPlaygroundThread } from "@/modules/playground/thread";
import { clearFlowLog } from "../utils/flowlog";

// Issue #839: each playground turn says what it spent, over every model call it made, and the
// session says the running total. The live number is summed in process and the reopened one is
// read from the ledger, so the assertions here hold them to EACH OTHER and to the rows: a turn line
// that disagreed with the ledger would be a second, unaudited set of books.

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

const GUARD_MODEL = "guard-judge";

interface Spend {
  input: number;
  output: number;
  cached?: number;
  written?: number;
}

// A real BaseChatModel, so the turn's callbacks fire and `UsageCapture` writes the ledger row the
// way it does for a provider: the number under test comes from the same place in production.
class SpendingModel extends BaseChatModel {
  constructor(
    private readonly reply: string,
    private readonly spend: Spend,
  ) {
    super({});
  }
  _llmType(): string {
    return "spending-double";
  }
  override bindTools(): this {
    return this;
  }
  async _generate(
    _messages: BaseMessage[],
    _options: this["ParsedCallOptions"],
    _run?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    // Long enough to be measured, so the model time below is a number the call produced.
    await Bun.sleep(MODEL_MS);
    const s = this.spend;
    const message = new AIMessage({
      content: this.reply,
      usage_metadata: {
        input_tokens: s.input,
        output_tokens: s.output,
        total_tokens: s.input + s.output,
        input_token_details: {
          cache_read: s.cached ?? 0,
          cache_creation: s.written ?? 0,
        },
      },
    });
    return { generations: [{ text: this.reply, message }] };
  }
  // The guardrail asks for a structured verdict; answered through `invoke`, so it is billed like
  // any other call.
  override withStructuredOutput(): never {
    return {
      invoke: async (msgs: BaseMessage[], config?: object) => {
        const raw = await this.invoke(msgs, config);
        return { raw, parsed: JSON.parse(String(raw.content)) };
      },
    } as never;
  }
}

const MODEL_MS = 30;
const AGENT_SPEND: Spend = { input: 1200, output: 80, cached: 1024 };
const JUDGE_SPEND: Spend = { input: 300, output: 20, written: 256 };
const VERDICT = JSON.stringify({
  violated: false,
  categories: [],
  rationale: "",
  suggestedReply: null,
});

const makeModel = ((args: { model?: string }) =>
  args?.model === GUARD_MODEL
    ? new SpendingModel(VERDICT, JUDGE_SPEND)
    : new SpendingModel("Claro!", AGENT_SPEND)) as never;

let tenantId = 0n;
let agentId = 0n;
let visionAgentId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

async function ledger(threadId: string) {
  return suDb.llmUsage.findMany({
    where: { tenantId, threadId },
    select: {
      node: true,
      source: true,
      promptTokens: true,
      cachedReadTokens: true,
      cacheCreationTokens: true,
      completionTokens: true,
    },
  });
}

describe.skipIf(!dbUp)("playground usage (issue #839)", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "PGU", slug: `pgu-839-${process.pid}` },
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
    const checks = {
      toxicity: false,
      unsafeContent: false,
      competitorMentions: true,
      promptAdherence: false,
      answerRelevance: false,
    };
    const dir = (enabled: boolean) => ({
      enabled,
      action: "template",
      templateMessage: "[bloqueado]",
      checks,
    });
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Uso",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: await key("llm"),
          },
          settings: {
            guardrails: {
              enabled: true,
              provider: "openai",
              model: GUARD_MODEL,
              credentialRef: await key("guard"),
              competitors: ["Concorrente"],
              input: dir(false),
              output: dir(true),
            },
          } as never,
        },
      })
    ).id;
    visionAgentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Visão",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: await key("llm-v"),
          },
          settings: {
            vision: {
              enabled: true,
              provider: "openai",
              model: "gpt-4o-mini",
              credentialRef: await key("vision"),
            },
          } as never,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (su && tenantId) {
      await clearFlowLog(su, { tenantId });
      await su.tenant.delete({ where: { id: tenantId } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a turn reports every call it made, the guardrail's too, and the ledger holds the same numbers", async () => {
    const r = await runPlaygroundTurn({
      ctx: ctx(),
      agentId,
      message: "oi",
      base: appDb,
      deps: { makeModel, checkpointer: new MemorySaver() },
    });
    const rows = await ledger(r.threadId);
    // (0) the fixture really billed two calls, on two nodes, on this thread
    expect(rows.map((x) => x.node).sort()).toEqual(["agent", "guardrail"]);
    expect(rows.every((x) => x.source === "playground")).toBe(true);

    expect(r.usage).toEqual({
      calls: 2,
      promptTokens: AGENT_SPEND.input + JUDGE_SPEND.input,
      cachedReadTokens: 1024,
      cacheCreationTokens: 256,
      completionTokens: AGENT_SPEND.output + JUDGE_SPEND.output,
      // Issue #858: which step made each call.
      byNode: { agent: 1, guardrail: 1 },
      // Issue #863: the agent's call at gpt-4o-mini's published rates ($0.15 input, $0.075 cached,
      // $0.60 output per million), the cached share at the cache rate and only the rest at the full
      // one. The judge's model is made up, so the table cannot price it, and it is counted, not zeroed.
      costUsd: expect.closeTo((176 * 0.15 + 1024 * 0.075 + 80 * 0.6) / 1e6, 12),
      unpricedCalls: 1,
    });
    // The cached share is a PART of the input, not added to it.
    expect(r.usage.promptTokens).toBe(1500);
    // Two calls of at least MODEL_MS each were waited on, inside a turn that took longer still.
    expect(r.timing.modelMs).toBeGreaterThanOrEqual(2 * MODEL_MS - 2);
    expect(r.timing.turnMs).toBeGreaterThanOrEqual(r.timing.modelMs);
  });

  test("the reopened session's total is the ledger's, and equals the live turns summed", async () => {
    const deps = { makeModel, checkpointer: new MemorySaver() };
    const first = await runPlaygroundTurn({
      ctx: ctx(),
      agentId,
      message: "oi",
      base: appDb,
      deps,
    });
    const second = await runPlaygroundTurn({
      ctx: ctx(),
      agentId,
      message: "e agora?",
      threadId: first.threadId,
      guardrails: false,
      base: appDb,
      deps,
    });
    expect(second.threadId).toBe(first.threadId);
    // Screening off: the agent's own call only.
    expect(second.usage.calls).toBe(1);

    const total = await getPlaygroundSessionUsage(
      ctx(),
      agentId,
      first.threadId,
      appDb,
    );
    expect(total).toEqual({
      calls: first.usage.calls + second.usage.calls,
      promptTokens: first.usage.promptTokens + second.usage.promptTokens,
      cachedReadTokens:
        first.usage.cachedReadTokens + second.usage.cachedReadTokens,
      cacheCreationTokens:
        first.usage.cacheCreationTokens + second.usage.cacheCreationTokens,
      completionTokens:
        first.usage.completionTokens + second.usage.completionTokens,
      byNode: { agent: 2, guardrail: 1 },
      costUsd: first.usage.costUsd + second.usage.costUsd,
      unpricedCalls: first.usage.unpricedCalls + second.usage.unpricedCalls,
    });
  });

  // The file read is billed like any call, and to the session it was sent into: the console reads the
  // file in a step of its own before the turn, so that step names the thread (minting one for a new
  // session) and the turn after it runs on the same one.
  test("reading a file is billed to the session, and the turn that follows runs on the same thread", async () => {
    const vision = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Uma nota fiscal." } }],
          usage: {
            prompt_tokens: 400,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const PNG = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const file = new File([PNG], "nota.png", { type: "image/png" });

    const read = await runPlaygroundExtract({
      ctx: ctx(),
      agentId: visionAgentId,
      file,
      base: appDb,
      visionDeps: { fetchImpl: vision },
    });
    expect(read.usage).toEqual({
      calls: 1,
      promptTokens: 400,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
      completionTokens: 30,
      byNode: { vision: 1 },
      // The image read is written outside the model callbacks and is priced all the same (#863).
      costUsd: expect.closeTo((400 * 0.15 + 30 * 0.6) / 1e6, 12),
      unpricedCalls: 0,
    });
    expect((await ledger(read.threadId)).map((x) => x.node)).toEqual([
      "vision",
    ]);

    const turn = await runPlaygroundFileTurn({
      ctx: ctx(),
      agentId: visionAgentId,
      file,
      threadId: read.threadId,
      kind: read.kind,
      extracted: read.extracted,
      base: appDb,
      deps: { makeModel, checkpointer: new MemorySaver() },
    });
    expect(turn.threadId).toBe(read.threadId);
    // The extraction was handed back, so the turn read nothing again: the agent's call only.
    expect(turn.usage.calls).toBe(1);

    const total = await getPlaygroundSessionUsage(
      ctx(),
      visionAgentId,
      read.threadId,
      appDb,
    );
    expect(total.calls).toBe(read.usage.calls + turn.usage.calls);
    expect(total.promptTokens).toBe(
      read.usage.promptTokens + turn.usage.promptTokens,
    );

    // With no extraction handed in, the turn reads the file itself, and counts that read.
    const inline = await runPlaygroundFileTurn({
      ctx: ctx(),
      agentId: visionAgentId,
      file,
      base: appDb,
      visionDeps: { fetchImpl: vision },
      deps: { makeModel, checkpointer: new MemorySaver() },
    });
    expect(inline.usage.calls).toBe(2);
    expect((await ledger(inline.threadId)).map((x) => x.node).sort()).toEqual([
      "agent",
      "vision",
    ]);
  });

  // Reload (the operator's report on PR #840): the lines were in the browser only, so a refresh kept
  // the total and dropped every turn's line. Through the REAL checkpointer, since the reopened
  // transcript is read from it and the per-turn usage joins on the ids it stored.
  test("a reopened session gives each reply the line its turn had live, a follow-up's included", async () => {
    const first = await runPlaygroundTurn({
      ctx: ctx(),
      agentId,
      message: "oi",
      base: appDb,
      deps: { makeModel },
    });
    const second = await runPlaygroundTurn({
      ctx: ctx(),
      agentId,
      message: "e agora?",
      threadId: first.threadId,
      guardrails: false,
      base: appDb,
      deps: { makeModel },
    });
    const nudge = await runPlaygroundFollowup({
      ctx: ctx(),
      agentId,
      threadId: first.threadId,
      guardrails: false,
      base: appDb,
      deps: { makeModel },
    });
    // (0) three turns that spent differently, so a line landing on the wrong reply shows
    expect(first.usage.calls).toBe(2);
    expect(second.usage.calls).toBe(1);
    expect(nudge.silent).toBe(false);

    const turns = await getPlaygroundSessionTurns(
      ctx(),
      agentId,
      first.threadId,
      appDb,
    );
    const replies = turns.filter((t) => t.role === "assistant");
    expect(replies.map((t) => t.usage)).toEqual([
      first.usage,
      second.usage,
      nudge.usage,
    ]);
    // The line is the reply's, never the user's bubble.
    expect(turns.filter((t) => t.role === "user").map((t) => t.usage)).toEqual([
      undefined,
      undefined,
    ]);
  });

  test("a turn that replied nothing comes back as the same empty reply, with its line", async () => {
    const quiet = (() => new SpendingModel("", AGENT_SPEND)) as never;
    const r = await runPlaygroundTurn({
      ctx: ctx(),
      agentId,
      message: "obrigado",
      guardrails: false,
      base: appDb,
      deps: { makeModel: quiet },
    });
    // (0) the turn really billed a call and answered nothing
    expect(r.reply).toBe("");
    expect(r.usage.calls).toBe(1);
    const turns = await getPlaygroundSessionTurns(
      ctx(),
      agentId,
      r.threadId,
      appDb,
    );
    expect(turns.map((t) => `${t.role}:${t.text}`)).toEqual([
      "user:obrigado",
      "assistant:",
    ]);
    expect(turns[1]?.usage).toEqual(r.usage);
  });

  test("a reopened file turn shows its read and its reply on one line, and a replayed read id is refused", async () => {
    const vision = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Uma nota fiscal." } }],
          usage: { prompt_tokens: 400, completion_tokens: 30 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const PNG = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const file = new File([PNG], "nota.png", { type: "image/png" });
    const read = await runPlaygroundExtract({
      ctx: ctx(),
      agentId: visionAgentId,
      file,
      base: appDb,
      visionDeps: { fetchImpl: vision },
    });
    const turn = await runPlaygroundFileTurn({
      ctx: ctx(),
      agentId: visionAgentId,
      file,
      threadId: read.threadId,
      kind: read.kind,
      extracted: read.extracted,
      turnId: read.turnId,
      base: appDb,
      deps: { makeModel },
    });
    // The same id a second time, as a replayed request would send it. Taken as the turn's id, it
    // would name the first turn's human message and the reducer would overwrite that message.
    const replay = await runPlaygroundFileTurn({
      ctx: ctx(),
      agentId: visionAgentId,
      file,
      threadId: read.threadId,
      kind: read.kind,
      extracted: read.extracted,
      turnId: read.turnId,
      base: appDb,
      deps: { makeModel },
    });

    const turns = await getPlaygroundSessionTurns(
      ctx(),
      visionAgentId,
      read.threadId,
      appDb,
    );
    // Both user turns survived: the replay did not overwrite the first.
    expect(turns.filter((t) => t.role === "user")).toHaveLength(2);
    const [one, two] = turns.filter((t) => t.role === "assistant");
    expect(one?.usage).toEqual({
      calls: read.usage.calls + turn.usage.calls,
      promptTokens: read.usage.promptTokens + turn.usage.promptTokens,
      cachedReadTokens:
        read.usage.cachedReadTokens + turn.usage.cachedReadTokens,
      cacheCreationTokens:
        read.usage.cacheCreationTokens + turn.usage.cacheCreationTokens,
      completionTokens:
        read.usage.completionTokens + turn.usage.completionTokens,
      byNode: { vision: 1, agent: 1 },
      costUsd: read.usage.costUsd + turn.usage.costUsd,
      unpricedCalls: read.usage.unpricedCalls + turn.usage.unpricedCalls,
    });
    expect(two?.usage).toEqual(replay.usage);
  });

  test("a new session's thread is handed out for the caller's own agent only", async () => {
    const tid = await startPlaygroundThread(ctx(), agentId, appDb);
    expect(isValidPlaygroundThread(tid, tenantId, agentId)).toBe(true);
    // A turn run on it keeps it, so the first call is billed where the console already looks.
    const r = await runPlaygroundTurn({
      ctx: ctx(),
      agentId,
      message: "oi",
      threadId: tid,
      guardrails: false,
      base: appDb,
      deps: { makeModel, checkpointer: new MemorySaver() },
    });
    expect(r.threadId).toBe(tid);
    await expect(
      startPlaygroundThread(
        { tenantId: tenantId + 999_999n, userId: null, role: "TENANT_ADMIN" },
        agentId,
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  test("a thread outside the fence has no total to read", async () => {
    await expect(
      getPlaygroundSessionUsage(
        ctx(),
        agentId,
        `${tenantId + 1n}:playground:${agentId}:x`,
        appDb,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("attachTurnUsage", () => {
  const U = { ...emptyTurnUsage(), calls: 1, promptTokens: 10 };
  const turn = (role: "user" | "assistant", turnId?: string): RebuiltTurn => ({
    role,
    text: role,
    ...(turnId ? { turnId } : {}),
    trace: [],
    sources: [],
  });

  test("the line goes to the last reply of its turn, and a turn that replied nothing gets its bubble back", () => {
    const out = attachTurnUsage(
      [
        turn("user", "a"),
        turn("assistant", "a"),
        turn("assistant", "a"),
        turn("user", "b"),
        turn("user", "old"),
        turn("assistant", "old"),
      ],
      new Map([
        ["a", U],
        ["b", { ...U, calls: 2 }],
        ["lost", { ...U, calls: 3 }],
      ]),
    );
    expect(out.map((t) => `${t.role}:${t.turnId}:${t.usage?.calls}`)).toEqual([
      "user:a:undefined",
      "assistant:a:undefined",
      "assistant:a:1",
      "user:b:undefined",
      // "(no reply)", as live, right after the message it answered, and before the next turn.
      "assistant:b:2",
      "user:old:undefined",
      // A turn the ledger has no rows for keeps what it had.
      "assistant:old:undefined",
    ]);
    expect(out[4]?.text).toBe("");
  });
});

describe("a blocked turn keeps its line on reopen", () => {
  // The input screening refused the turn, so the thread never received it and the transcript note
  // rebuilds it. The screening was billed, and the live note showed that line.
  test("the suppression note stands for the turn's reply, with or without a template", () => {
    const U = { ...emptyTurnUsage(), calls: 1, promptTokens: 300 };
    const note = (id: string, reply: string) => ({
      messageId: null,
      anchorMessageId: null,
      userMessageId: id,
      userText: "fale do concorrente",
      reply,
      guardrails: [],
      createdAt: new Date(),
    });
    const turns = attachTurnUsage(
      applyTurnNotes([], [note("a", ""), note("b", "[bloqueado]")]),
      new Map([
        ["a", U],
        ["b", { ...U, calls: 2 }],
      ]),
    );
    expect(
      turns.filter((t) => t.role === "assistant").map((t) => t.usage?.calls),
    ).toEqual([1, 2]);
  });
});

describe("sumTurnUsage", () => {
  const capture = (threadId: string | null, persisted: unknown[]) =>
    new UsageCapture({
      tenantId: 1n,
      threadId,
      provider: "test-provider",
      model: "m",
      source: "playground",
      persist: async (row) => {
        persisted.push(row);
      },
    });
  const end = (c: UsageCapture, input: number, output: number) =>
    c.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "",
              message: new AIMessage({
                content: "",
                usage_metadata: {
                  input_tokens: input,
                  output_tokens: output,
                  total_tokens: input + output,
                },
              }),
            } as never,
          ],
        ],
      },
      crypto.randomUUID(),
    );

  test("counts only the rows on the thread being summed", async () => {
    const rows: unknown[] = [];
    const { usage } = await sumTurnUsage("t1", async () => {
      await end(capture("t1", rows), 10, 1);
      await end(capture("other", rows), 99, 9);
      await end(capture(null, rows), 50, 5);
    });
    expect(usage).toEqual({
      ...emptyTurnUsage(),
      calls: 1,
      promptTokens: 10,
      completionTokens: 1,
      byNode: { agent: 1 },
      costUsd: 0,
      unpricedCalls: 1,
    });
    // Every row is still written: the sum observes the ledger, it does not gate it.
    expect(rows).toHaveLength(3);
  });

  test("a nested sum on the same thread reports its share, and the outer one sees it all", async () => {
    const rows: unknown[] = [];
    let inner = emptyTurnUsage();
    const outer = await sumTurnUsage("t1", async () => {
      await end(capture("t1", rows), 5, 1);
      inner = (
        await sumTurnUsage("t1", async () => {
          await end(capture("t1", rows), 7, 2);
        })
      ).usage;
    });
    expect(inner).toEqual({
      ...emptyTurnUsage(),
      calls: 1,
      promptTokens: 7,
      completionTokens: 2,
      // The inner sum's share of the steps too, not the outer counter's.
      byNode: { agent: 1 },
      costUsd: 0,
      unpricedCalls: 1,
    });
    expect(outer.usage).toEqual({
      ...emptyTurnUsage(),
      calls: 2,
      promptTokens: 12,
      completionTokens: 3,
      byNode: { agent: 2 },
      costUsd: 0,
      unpricedCalls: 2,
    });
  });

  test("outside any sum nothing is counted and the row is written as before", async () => {
    const rows: unknown[] = [];
    await end(capture("t1", rows), 10, 1);
    expect(rows).toHaveLength(1);
  });
});
