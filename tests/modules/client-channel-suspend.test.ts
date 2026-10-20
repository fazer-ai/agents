import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import { buildClientToolStubs } from "@/graph/client-tools";
import { loadDetachedConfig } from "@/graph/detached-turn";
import { buildModelAndGraph } from "@/graph/prepare";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  handOverAnonymousThreads,
  isThreadSuspended,
  leaseClientThread,
} from "@/modules/client-channel/identity";
import {
  type ClientTurnParams,
  runClientTurn,
} from "@/modules/client-channel/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { until } from "../utils/poll";

// A client turn suspended on the browser's tools has a deadline. Before it, a new message is refused
// (the browser may still answer); past it, the new message closes the old turn with every pending
// call answered as unanswered and starts its own. One round-trip holds the thread at a time, which
// is what settles the race between a late answer and the new message.

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

// After a human message it asks the browser to read the screen; after a tool result it answers.
// Records what each round saw, and can be slowed down so two round-trips overlap.
// When the thread's claim lapses, as the database holds it.
async function claimOf(threadId: string): Promise<number | null> {
  const row = await suDb.detachedThread.findUnique({
    where: { threadId },
    select: { activeUntil: true },
  });
  return row?.activeUntil?.getTime() ?? null;
}

class ReadsTheScreenThenAnswers {
  rounds = 0;
  seen: BaseMessage[][] = [];
  constructor(
    private readonly delayMs = 0,
    // A server tool to call instead of the browser's, and a model that does not stop on the signal:
    // what reaches the tool boundary after the claim was lost.
    // `besideCall`: text written in the message that asks for the screen. `thenSilent`: the answer
    // after the tool result says nothing.
    // `holdFrom`: from that round on, a call waits, instead of a delay, until the test calls
    // `release()` or the call's signal ends it (with `ignoreSignal`, the end lets the call finish: a
    // model that answers after the claim is gone).
    private readonly opts: {
      serverTool?: string;
      ignoreSignal?: boolean;
      besideCall?: string;
      thenSilent?: boolean;
      holdFrom?: number;
    } = {},
  ) {}
  private releaseHeld: () => void = () => {};
  release() {
    this.releaseHeld();
  }
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    return {
      async invoke(
        messages: BaseMessage[],
        options?: { signal?: AbortSignal },
      ) {
        self.rounds++;
        self.seen.push(messages);
        // NOTE: like a real adapter, the call ends when its signal does.
        if (
          self.opts.holdFrom !== undefined &&
          self.rounds >= self.opts.holdFrom
        )
          await new Promise<void>((resolve, reject) => {
            self.releaseHeld = resolve;
            const signal = options?.signal;
            const end = () =>
              self.opts.ignoreSignal
                ? resolve()
                : reject(signal?.reason ?? new Error("aborted"));
            if (signal?.aborted) end();
            else signal?.addEventListener("abort", end);
          });
        else if (self.delayMs)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, self.delayMs);
            if (self.opts.ignoreSignal) return;
            options?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(options.signal?.reason ?? new Error("aborted"));
            });
          });
        const last = messages.at(-1);
        if (last?.getType() === "human")
          return new AIMessage({
            content: self.opts.besideCall ?? "",
            tool_calls: [
              {
                id: `c${self.rounds}`,
                name: self.opts.serverTool ?? "ler_tela",
                args: self.opts.serverTool ? { expression: "1+1" } : {},
              },
            ],
          });
        return new AIMessage(
          self.opts.thenSilent ? "" : `resposta ${self.rounds}`,
        );
      },
    };
  }
}

const SPECS = [
  {
    name: "ler_tela",
    description: "lê a tela",
    parameters: { type: "object", properties: {} },
  },
];

let tenantId = 0n;
let agentId = 0n;
let ctx: TenantContext;

function turn(
  model: ReadsTheScreenThenAnswers,
  checkpointer: MemorySaver,
  over: Partial<ClientTurnParams>,
) {
  return runClientTurn({
    ctx,
    agentId,
    user: { id: "ana", scope: "org-1" },
    clientTools: SPECS,
    base: appDb,
    deps: {
      makeModel: () => model as unknown as BaseChatModel,
      checkpointer,
    },
    ...over,
  });
}

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { status: e.statusCode, key: e.translationKey ?? e.message };
  }
}

const later = (ms: number) => new Date(Date.now() + ms);
const PAST_DEADLINE = config.agent.clientTurnSuspendTimeoutMs + 1_000;

describe.skipIf(!dbUp)("client channel: a suspended turn's deadline", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CCS", slug: `ccs-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "copiloto",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-6-luna",
            credentialRef: `vault:${key.id}`,
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.tenant.deleteMany({ where: { id: tenantId } });
    }
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("before the deadline a new message is refused, and the browser can still answer", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    expect(first.status).toBe("pending");
    expect(
      await refusal(() =>
        turn(model, saver, { threadId: first.threadId, message: "e aí?" }),
      ),
    ).toEqual({ status: 409, key: "errors.clientTurnAwaitingAnswers" });
    if (first.status !== "pending") return;
    const done = await turn(model, saver, {
      threadId: first.threadId,
      answers: {
        [first.calls[0]?.toolCallId as string]: {
          ok: true,
          result: { tela: "nota" },
        },
      },
    });
    expect(done).toMatchObject({ status: "done", reply: "resposta 2" });
  });

  // The resume value is checkpointed before the node clips it for the model, so the turn has to bound
  // it first, or a page's megabyte is stored whole, once per write, for a message the model reads cut.
  test("a huge browser answer is stored at the size the model reads, not whole", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    const done = await turn(model, saver, {
      threadId: first.threadId,
      answers: {
        [first.calls[0]?.toolCallId as string]: {
          ok: true,
          result: { tela: "x".repeat(1_000_000) },
        },
      },
    });
    const bytes = (v: unknown): number =>
      v instanceof Uint8Array
        ? v.byteLength
        : typeof v === "string"
          ? v.length
          : v && typeof v === "object"
            ? Object.values(v).reduce((n: number, x) => n + bytes(x), 0)
            : 0;
    const stored =
      bytes((saver as unknown as { storage: unknown }).storage) +
      bytes((saver as unknown as { writes: unknown }).writes);
    const read = model.seen.at(-1)?.at(-1);
    expect({
      status: done.status,
      read: String(read?.content).endsWith("[cut at 20000 characters]"),
      under: stored < 200_000,
    }).toEqual({ status: "done", read: true, under: true });
  });

  test("past the deadline the new message closes the old turn and starts its own", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    expect(first.status).toBe("pending");
    const next = await turn(model, saver, {
      threadId: first.threadId,
      message: "ainda está aí?",
      now: later(PAST_DEADLINE),
    });
    // The new message's own turn suspends on its own call: it ran, with nothing in its way.
    expect(next.status).toBe("pending");
    // No model call was spent replying to the abandoned turn: the second round is the new message's.
    expect(model.rounds).toBe(2);
    const second = model.seen[1] ?? [];
    const closed = second.find(
      (m) =>
        m.getType() === "tool" &&
        (m as unknown as { tool_call_id: string }).tool_call_id === "c1",
    );
    expect(String(closed?.content)).toBe(
      "The application returned no result for this call.",
    );
    expect(second.at(-1)?.getType()).toBe("human");
    expect(String(second.at(-1)?.content)).toContain("ainda está aí?");

    const lines = await flowLogRows(suDb, {
      where: { tenantId, threadId: first.threadId, stage: "tool" },
      select: { detail: true, level: true },
    });
    expect(lines.map((l) => l.detail)).toContainEqual({
      phase: "client_timeout",
      calls: 1,
    });
  });

  test("the browser's answers arriving after the turn was closed are refused", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    const next = await turn(model, saver, {
      threadId: first.threadId,
      message: "oi de novo",
      now: later(PAST_DEADLINE),
    });
    if (next.status !== "pending") throw new Error("expected pending");
    // The late answer names the OLD call, which nothing waits for any more.
    expect(
      await refusal(() =>
        turn(model, saver, {
          threadId: first.threadId,
          answers: { c1: { ok: true, result: "tarde demais" } },
        }),
      ),
    ).toEqual({ status: 400, key: "errors.clientTurnUnknownCall" });
  });

  test("a held thread refuses every other round-trip until the claim expires", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    expect(
      await leaseClientThread({
        ctx,
        threadId: first.threadId,
        turnId: "someone-else",
        base: appDb,
        leaseMs: 60_000,
      }),
    ).toBe(true);
    const busy = { status: 409, key: "errors.clientTurnInProgress" };
    expect(
      await refusal(() =>
        turn(model, saver, {
          threadId: first.threadId,
          message: "oi",
          now: later(PAST_DEADLINE),
        }),
      ),
    ).toEqual(busy);
    if (first.status !== "pending") return;
    expect(
      await refusal(() =>
        turn(model, saver, {
          threadId: first.threadId,
          answers: {
            [first.calls[0]?.toolCallId as string]: { ok: true, result: 1 },
          },
        }),
      ),
    ).toEqual(busy);
    // The refused round-trips did not release a claim that was never theirs.
    const row = await suDb.detachedThread.findUnique({
      where: { threadId: first.threadId },
    });
    expect(row?.activeTurnId).toBe("someone-else");
    // An expired claim is taken over.
    await suDb.detachedThread.update({
      where: { threadId: first.threadId },
      data: { activeUntil: new Date(Date.now() - 1_000) },
    });
    const done = await turn(model, saver, {
      threadId: first.threadId,
      answers: {
        [first.calls[0]?.toolCallId as string]: { ok: true, result: 1 },
      },
    });
    expect(done.status).toBe("done");
  });

  test("a round-trip gives the thread back when it ends, refused or not", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    const held = () =>
      suDb.detachedThread
        .findUnique({ where: { threadId: first.threadId } })
        .then((r) => r?.activeTurnId ?? null);
    expect(await held()).toBeNull();
    expect(
      await refusal(() =>
        turn(model, saver, {
          threadId: first.threadId,
          message: "cedo demais",
        }),
      ),
    ).toEqual({ status: 409, key: "errors.clientTurnAwaitingAnswers" });
    expect(await held()).toBeNull();
  });

  test("the late answer and the new message racing: exactly one acts on the turn", async () => {
    const model = new ReadsTheScreenThenAnswers(300);
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    const callId = first.calls[0]?.toolCallId as string;
    const outcomes = await Promise.all([
      turn(model, saver, {
        threadId: first.threadId,
        answers: { [callId]: { ok: true, result: { tela: "nota" } } },
      }).then(
        (r) => r.status,
        (e: AppError) => e.translationKey ?? e.message,
      ),
      turn(model, saver, {
        threadId: first.threadId,
        message: "alô?",
        now: later(PAST_DEADLINE),
      }).then(
        (r) => r.status,
        (e: AppError) => e.translationKey ?? e.message,
      ),
    ]);
    expect(
      outcomes.filter((o) => o === "errors.clientTurnInProgress"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((o) => o === "done" || o === "pending"),
    ).toHaveLength(1);
    // Every call the model ever made is answered exactly once in the thread.
    const last = model.seen.at(-1) ?? [];
    const answers = last.filter(
      (m) =>
        m.getType() === "tool" &&
        (m as unknown as { tool_call_id: string }).tool_call_id === callId,
    );
    expect(answers).toHaveLength(1);
  });
  test("a round-trip that outlives the claim keeps it, because it renews it while running", async () => {
    // A claim of 300 ms renewed every 100 ms, on a round-trip whose model takes 900 ms: without the
    // renewal the claim is gone a third of the way in and the second request would take it over.
    const slow = new ReadsTheScreenThenAnswers(0, { holdFrom: 2 });
    const saver = new MemorySaver();
    const lease = { ms: 300, renewEveryMs: 100 };
    const first = await runClientTurn({
      ctx,
      agentId,
      user: { id: "ana", scope: "org-1" },
      clientTools: SPECS,
      base: appDb,
      message: "oi",
      deps: {
        makeModel: () => slow as unknown as BaseChatModel,
        checkpointer: saver,
        lease,
      },
    });
    if (first.status !== "pending") throw new Error("expected pending");
    const callId = first.calls[0]?.toolCallId as string;
    const running = runClientTurn({
      ctx,
      agentId,
      user: { id: "ana", scope: "org-1" },
      clientTools: SPECS,
      base: appDb,
      threadId: first.threadId,
      answers: { [callId]: { ok: true, result: 1 } },
      deps: {
        makeModel: () => slow as unknown as BaseChatModel,
        checkpointer: saver,
        lease,
      },
    });
    // NOTE: the model is thinking, and the claim outlived the expiry it was taken with: renewed.
    await until("the model to be called", () => slow.rounds >= 2);
    const taken = await claimOf(first.threadId);
    // NOTE: held until the expiry it was taken with has passed, so the turn is still running on a
    // claim only the renewals kept: an original lapse left armed would have stopped it by now.
    await until(
      "the original expiry to pass under a renewed claim",
      async () =>
        Date.now() > (taken ?? 0) + lease.renewEveryMs &&
        ((await claimOf(first.threadId)) ?? 0) > (taken ?? 0),
    );
    expect(
      await refusal(() =>
        turn(slow, saver, {
          threadId: first.threadId,
          message: "alô?",
          now: later(PAST_DEADLINE),
        }),
      ),
    ).toEqual({ status: 409, key: "errors.clientTurnInProgress" });
    slow.release();
    expect((await running).status).toBe("done");
  });
  test("a round-trip that lost its claim is stopped instead of running beside the new owner", async () => {
    const slow = new ReadsTheScreenThenAnswers(0, { holdFrom: 2 });
    const saver = new MemorySaver();
    const lease = { ms: 300, renewEveryMs: 100 };
    const deps = {
      makeModel: () => slow as unknown as BaseChatModel,
      checkpointer: saver,
      lease,
    };
    const first = await runClientTurn({
      ctx,
      agentId,
      user: { id: "ana", scope: "org-1" },
      clientTools: SPECS,
      base: appDb,
      message: "oi",
      deps,
    });
    if (first.status !== "pending") throw new Error("expected pending");
    const callId = first.calls[0]?.toolCallId as string;
    const running = refusal(() =>
      runClientTurn({
        ctx,
        agentId,
        user: { id: "ana", scope: "org-1" },
        clientTools: SPECS,
        base: appDb,
        threadId: first.threadId,
        answers: { [callId]: { ok: true, result: 1 } },
        deps,
      }),
    );
    // Another request takes the thread while the model is still thinking.
    await until("the model to be called", () => slow.rounds >= 2);
    await suDb.detachedThread.update({
      where: { threadId: first.threadId },
      data: {
        activeTurnId: "thief",
        activeUntil: new Date(Date.now() + 60_000),
      },
    });
    expect(await running).toEqual({
      status: 409,
      key: "errors.clientTurnClaimLost",
    });
    // The stopped round-trip did not give back a claim that is now someone else's.
    const row = await suDb.detachedThread.findUnique({
      where: { threadId: first.threadId },
    });
    expect(row?.activeTurnId).toBe("thief");
    // And it stopped at a point the thread can continue from: once the thief is gone, the next
    // message runs, and every call the model ever made has its answer in what it is shown.
    await suDb.detachedThread.update({
      where: { threadId: first.threadId },
      data: { activeTurnId: null, activeUntil: null },
    });
    const fresh = new ReadsTheScreenThenAnswers();
    await turn(fresh, saver, {
      threadId: first.threadId,
      message: "e agora?",
      now: later(PAST_DEADLINE),
    });
    const shown = fresh.seen[0] ?? [];
    const asked = shown.flatMap(
      (m) =>
        (m as unknown as { tool_calls?: { id: string }[] }).tool_calls ?? [],
    );
    const answered = new Set(
      shown
        .filter((m) => m.getType() === "tool")
        .map((m) => (m as unknown as { tool_call_id: string }).tool_call_id),
    );
    expect(asked.length).toBeGreaterThan(0);
    for (const c of asked) expect(answered.has(c.id)).toBe(true);
  });

  test("renewals that keep failing stop the round-trip before its claim lapses", async () => {
    const slow = new ReadsTheScreenThenAnswers(0, { holdFrom: 2 });
    const saver = new MemorySaver();
    const lease = { ms: 300, renewEveryMs: 100 };
    const first = await turn(slow, saver, { message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    // Every renewal fails; claiming and releasing still work.
    const noRenewals = appDb.$extends({
      query: {
        detachedThread: {
          async updateMany({ args, query }) {
            const data = args.data as Record<string, unknown>;
            if (!("activeTurnId" in data) && "activeUntil" in data)
              throw new Error("connection reset");
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    expect(
      await refusal(() =>
        runClientTurn({
          ctx,
          agentId,
          user: { id: "ana", scope: "org-1" },
          clientTools: SPECS,
          base: noRenewals,
          threadId: first.threadId,
          answers: {
            [first.calls[0]?.toolCallId as string]: { ok: true, result: 1 },
          },
          deps: {
            makeModel: () => slow as unknown as BaseChatModel,
            checkpointer: saver,
            lease,
          },
        }),
      ),
    ).toEqual({ status: 409, key: "errors.clientTurnClaimLost" });
  });

  test("a release that fails does not throw away the turn's result", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const failingRelease = appDb.$extends({
      query: {
        detachedThread: {
          async updateMany({ args, query }) {
            const data = args.data as { activeTurnId?: unknown };
            if ("activeTurnId" in data && data.activeTurnId === null)
              throw new Error("pool exhausted");
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const result = await runClientTurn({
      ctx,
      agentId,
      user: { id: "ana", scope: "org-1" },
      clientTools: SPECS,
      base: failingRelease,
      message: "oi",
      deps: {
        makeModel: () => model as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
      },
    });
    expect(result.status).toBe("pending");
    expect(result.threadId).toBeTruthy();
  });
  async function loseClaimMidTurn(scope: string, saver: MemorySaver) {
    // The model finishes its call (it ignores the signal) after the claim is gone, so the graph meets
    // the cancellation at the tool boundary.
    const model = new ReadsTheScreenThenAnswers(0, {
      serverTool: "calculator",
      ignoreSignal: true,
      holdFrom: 1,
    });
    const running = refusal(() =>
      runClientTurn({
        ctx,
        agentId,
        user: { id: "ana", scope },
        clientTools: SPECS,
        base: appDb,
        message: "quanto é 1+1?",
        deps: {
          makeModel: () => model as unknown as BaseChatModel,
          checkpointer: saver,
          lease: { ms: 300, renewEveryMs: 100 },
        },
      }),
    );
    await until("the model to be called", () => model.rounds >= 1);
    const row = await suDb.detachedThread.findFirst({
      where: { tenantId, scope },
      orderBy: { createdAt: "desc" },
    });
    const threadId = row?.threadId as string;
    await suDb.detachedThread.update({
      where: { threadId },
      data: {
        activeTurnId: "thief",
        activeUntil: new Date(Date.now() + 60_000),
      },
    });
    return { threadId, outcome: await running };
  }

  test("a graph stopped at the tool boundary after the claim was lost answers 409, not a reply", async () => {
    const { outcome } = await loseClaimMidTurn("org-2", new MemorySaver());
    expect(outcome).toEqual({ status: 409, key: "errors.clientTurnClaimLost" });
  });

  test("a lost claim mid-turn writes nothing after it, so the thread stays consistent", async () => {
    const saver = new MemorySaver();
    const { threadId } = await loseClaimMidTurn("org-3", saver);
    await suDb.detachedThread.update({
      where: { threadId },
      data: { activeTurnId: null, activeUntil: null },
    });
    const fresh = new ReadsTheScreenThenAnswers();
    await turn(fresh, saver, {
      threadId,
      user: { id: "ana", scope: "org-3" },
      message: "e então?",
    });
    // The call the model decided on after the claim was gone never reached the checkpoint.
    const shown = fresh.seen[0] ?? [];
    expect(
      shown.some(
        (m) =>
          ((m as unknown as { tool_calls?: unknown[] }).tool_calls ?? [])
            .length > 0,
      ),
    ).toBe(false);
  });

  test("a call a dead round-trip left unanswered is closed before the next one runs", async () => {
    const saver = new MemorySaver();
    const first = await turn(new ReadsTheScreenThenAnswers(), saver, {
      user: { id: "ana", scope: "org-4" },
      message: "oi",
    });
    if (first.status !== "pending") throw new Error("expected pending");
    await turn(new ReadsTheScreenThenAnswers(), saver, {
      threadId: first.threadId,
      user: { id: "ana", scope: "org-4" },
      answers: {
        [first.calls[0]?.toolCallId as string]: { ok: true, result: 1 },
      },
    });
    // What a process that died inside a server tool leaves: the call checkpointed, no answer.
    const loaded = await loadDetachedConfig({
      ctx,
      agentId,
      threadId: first.threadId,
      base: appDb,
    });
    const graph = await buildModelAndGraph(
      loaded,
      buildClientToolStubs(SPECS),
      {
        makeModel: () =>
          new ReadsTheScreenThenAnswers() as unknown as BaseChatModel,
        checkpointer: saver,
        clientToolNames: new Set(SPECS.map((t) => t.name)),
      },
    );
    await graph.updateState(
      { configurable: { thread_id: first.threadId } },
      {
        messages: [
          new AIMessage({
            content: "",
            tool_calls: [
              { id: "orphan", name: "calculator", args: { expression: "2+2" } },
            ],
          }),
        ],
      },
      "agent",
    );
    const fresh = new ReadsTheScreenThenAnswers();
    await turn(fresh, saver, {
      threadId: first.threadId,
      user: { id: "ana", scope: "org-4" },
      message: "e então?",
    });
    const closed = (fresh.seen[0] ?? []).find(
      (m) =>
        m.getType() === "tool" &&
        (m as unknown as { tool_call_id: string }).tool_call_id === "orphan",
    );
    expect(String(closed?.content)).toBe(
      "This call was interrupted before it finished; its result is unknown.",
    );
  });
  test("answers to a turn that already finished are refused: nothing waits for them", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    const answers = {
      [first.calls[0]?.toolCallId as string]: { ok: true as const, result: 1 },
    };
    const done = await turn(model, saver, {
      threadId: first.threadId,
      answers,
    });
    expect(done.status).toBe("done");
    expect(
      await refusal(() =>
        turn(model, saver, { threadId: first.threadId, answers }),
      ),
    ).toEqual({ status: 409, key: "errors.clientTurnNothingWaiting" });
  });
  test("answers sent without declaring the pending call's tool are refused, and the turn keeps waiting", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    const answers = {
      [first.calls[0]?.toolCallId as string]: { ok: true as const, result: 1 },
    };
    expect(
      await refusal(() =>
        turn(model, saver, {
          threadId: first.threadId,
          clientTools: [],
          answers,
        }),
      ),
    ).toEqual({ status: 400, key: "errors.clientTurnUndeclaredTool" });
    // Still waiting: the same answers with the tool declared resume it.
    const done = await turn(model, saver, {
      threadId: first.threadId,
      answers,
    });
    expect(done.status).toBe("done");
  });

  // A model can write its whole answer beside the call and close on an empty message. The inbox
  // takes that text as the reply; the client turn must too, or the user gets an empty answer.
  test("a reply written beside the browser's call is the reply when the turn ends saying nothing", async () => {
    const model = new ReadsTheScreenThenAnswers(0, {
      besideCall: "A nota foi rejeitada pelo GTIN.",
      thenSilent: true,
    });
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "por que rejeitou?" });
    if (first.status !== "pending") throw new Error("expected pending");
    const done = await turn(model, saver, {
      threadId: first.threadId,
      answers: {
        [first.calls[0]?.toolCallId as string]: { ok: true, result: 1 },
      },
    });
    expect(done).toMatchObject({
      status: "done",
      reply: "A nota foi rejeitada pelo GTIN.",
    });
  });

  // Dated like a customer message on the inbox, so a thread resumed days later tells "today" then
  // from today now.
  test("the user's message is stamped with when it was sent", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const first = await turn(model, saver, { message: "oi" });
    const state = await saver.getTuple({
      configurable: { thread_id: first.threadId },
    });
    const messages = (state?.checkpoint.channel_values.messages ??
      []) as BaseMessage[];
    const human = messages.find((m) => m.getType() === "human");
    expect(typeof human?.additional_kwargs?.fazerSentAt).toBe("string");
  });

  test("an anonymous visitor who signs in takes the conversations along, except a suspended or held one", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const anon = { id: "anon:1:AAAAAAAAAAAAAAAAAAAAAA" };
    const asAnon = (over: Partial<ClientTurnParams>) =>
      turn(model, saver, { user: anon, ...over });
    const answered = await asAnon({ message: "oi" });
    if (answered.status !== "pending") throw new Error("expected pending");
    await asAnon({
      threadId: answered.threadId,
      answers: {
        [answered.calls[0]?.toolCallId as string]: { ok: true, result: {} },
      },
    });
    const waiting = await asAnon({ message: "outra" });
    const held = await asAnon({ message: "terceira" });
    if (held.status !== "pending") throw new Error("expected pending");
    await asAnon({
      threadId: held.threadId,
      answers: {
        [held.calls[0]?.toolCallId as string]: { ok: true, result: {} },
      },
    });
    await leaseClientThread({
      ctx,
      threadId: held.threadId,
      turnId: "outro-turno",
      base: appDb,
      leaseMs: 60_000,
    });
    const signedIn = { id: "app:1:42", scope: "org-9" };
    const hand = () =>
      handOverAnonymousThreads({
        ctx,
        agentId,
        from: anon.id,
        to: signedIn,
        base: appDb,
        checkpointer: saver,
      });
    const moved = await hand();
    const again = await hand();
    const suspended = [
      await isThreadSuspended(saver, answered.threadId),
      await isThreadSuspended(saver, waiting.threadId),
    ];
    const asUser = await turn(model, saver, {
      user: signedIn,
      threadId: answered.threadId,
      message: "entrei",
    });
    expect({
      moved,
      again,
      suspended,
      userResumes: asUser.threadId,
      anonRefused: await refusal(() =>
        asAnon({ threadId: answered.threadId, message: "ainda sou eu" }),
      ),
    }).toEqual({
      moved: [answered.threadId],
      again: [],
      suspended: [false, true],
      userResumes: answered.threadId,
      anonRefused: { status: 404, key: "errors.threadNotFound" },
    });
  });

  test("a turn the hand-over lets in late is refused: the hand-over holds the thread, and the lease checks its owner", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const anon = { id: "anon:1:BBBBBBBBBBBBBBBBBBBBBB" };
    const asAnon = (over: Partial<ClientTurnParams>) =>
      turn(model, saver, { user: anon, ...over });
    const first = await asAnon({ message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    await asAnon({
      threadId: first.threadId,
      answers: {
        [first.calls[0]?.toolCallId as string]: { ok: true, result: {} },
      },
    });
    let duringRead: unknown;
    const watching = {
      getTuple: async (cfg: Parameters<MemorySaver["getTuple"]>[0]) => {
        duringRead = await refusal(() =>
          asAnon({
            threadId: first.threadId,
            message: "entre a leitura e a troca",
          }),
        );
        return saver.getTuple(cfg);
      },
    } as unknown as MemorySaver;
    const moved = await handOverAnonymousThreads({
      ctx,
      agentId,
      from: anon.id,
      to: { id: "app:1:77" },
      base: appDb,
      checkpointer: watching,
    });
    const anonUser = await suDb.externalUser.findFirstOrThrow({
      where: { tenantId, externalId: anon.id },
      select: { id: true },
    });
    expect({
      moved,
      duringRead,
      lateLease: await refusal(() =>
        leaseClientThread({
          ctx,
          threadId: first.threadId,
          turnId: "admitido-antes",
          base: appDb,
          leaseMs: 60_000,
          owner: { externalUserId: anonUser.id, scope: null },
        }),
      ),
    }).toEqual({
      moved: [first.threadId],
      duringRead: { status: 409, key: "errors.clientTurnInProgress" },
      lateLease: { status: 404, key: "errors.threadNotFound" },
    });
  });

  test("a turn whose owner check passed just before the hand-over does not run on the thread after it", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const anon = { id: "anon:1:CCCCCCCCCCCCCCCCCCCCCC" };
    const first = await turn(model, saver, { user: anon, message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    await turn(model, saver, {
      user: anon,
      threadId: first.threadId,
      answers: {
        [first.calls[0]?.toolCallId as string]: { ok: true, result: {} },
      },
    });
    let handed = null as string[] | null;
    // The hand-over lands after the turn's owner check has committed and just before the
    // turn's own claim on the thread is written.
    const between = appDb.$extends({
      query: {
        detachedThread: {
          async updateMany({ args, query }) {
            const turnId = (args.data as { activeTurnId?: unknown })
              .activeTurnId;
            if (handed === null && typeof turnId === "string")
              handed = await handOverAnonymousThreads({
                ctx,
                agentId,
                from: anon.id,
                to: { id: "app:1:88" },
                base: appDb,
                checkpointer: saver,
              });
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const late = await refusal(() =>
      turn(model, saver, {
        user: anon,
        threadId: first.threadId,
        message: "admitido antes da troca",
        base: between,
      }),
    );
    expect({ handed, late }).toEqual({
      handed: [first.threadId],
      late: { status: 404, key: "errors.threadNotFound" },
    });
  });

  test("a checkpoint that cannot be read fails the hand-over and lets the thread go, so it can be tried again", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const anon = { id: "anon:1:DDDDDDDDDDDDDDDDDDDDDD" };
    const first = await turn(model, saver, { user: anon, message: "oi" });
    if (first.status !== "pending") throw new Error("expected pending");
    await turn(model, saver, {
      user: anon,
      threadId: first.threadId,
      answers: {
        [first.calls[0]?.toolCallId as string]: { ok: true, result: {} },
      },
    });
    const hand = (checkpointer: MemorySaver) =>
      handOverAnonymousThreads({
        ctx,
        agentId,
        from: anon.id,
        to: { id: "app:1:99" },
        base: appDb,
        checkpointer,
      });
    const broken = {
      getTuple: async () => {
        throw new Error("checkpoint database down");
      },
    } as unknown as MemorySaver;
    const failed = await hand(broken).then(
      () => "handed",
      (e: Error) => e.message,
    );
    const row = await suDb.detachedThread.findUniqueOrThrow({
      where: { threadId: first.threadId },
      select: { activeTurnId: true },
    });
    expect({
      failed,
      released: row.activeTurnId,
      retried: await hand(saver),
    }).toEqual({
      failed: "checkpoint database down",
      released: null,
      retried: [first.threadId],
    });
  });

  test("a hand-over of several threads moves all of them or none, and lets every claim go when it fails", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const anon = { id: "anon:1:EEEEEEEEEEEEEEEEEEEEEE" };
    const answeredThread = async (message: string) => {
      const r = await turn(model, saver, { user: anon, message });
      if (r.status !== "pending") throw new Error("expected pending");
      await turn(model, saver, {
        user: anon,
        threadId: r.threadId,
        answers: {
          [r.calls[0]?.toolCallId as string]: { ok: true, result: {} },
        },
      });
      return r.threadId;
    };
    const older = await answeredThread("primeira");
    const newer = await answeredThread("segunda");
    let reads = 0;
    const failsOnSecond = {
      getTuple: async (cfg: Parameters<MemorySaver["getTuple"]>[0]) => {
        reads++;
        if (reads === 2) throw new Error("checkpoint database down");
        return saver.getTuple(cfg);
      },
    } as unknown as MemorySaver;
    let writes = 0;
    const failsOnMove = appDb.$extends({
      query: {
        detachedThread: {
          async updateMany({ args, query }) {
            if (
              (args.data as { externalUserId?: unknown }).externalUserId &&
              writes++ === 0
            )
              throw new Error("connection reset");
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    const hand = (checkpointer: MemorySaver, base: PrismaClient = appDb) =>
      handOverAnonymousThreads({
        ctx,
        agentId,
        from: anon.id,
        to: { id: "app:1:111" },
        base,
        checkpointer,
      }).then(
        (moved) => moved,
        (e: Error) => e.message,
      );
    const owners = async () =>
      (
        await suDb.detachedThread.findMany({
          where: { threadId: { in: [older, newer] } },
          select: {
            activeTurnId: true,
            externalUser: { select: { externalId: true } },
          },
        })
      ).map((t) => [t.externalUser?.externalId, t.activeTurnId]);
    const afterRead = [await hand(failsOnSecond), await owners()];
    const afterWrite = [await hand(saver, failsOnMove), await owners()];
    expect({
      afterRead,
      afterWrite,
      retried: await hand(saver),
    }).toEqual({
      afterRead: [
        "checkpoint database down",
        [
          [anon.id, null],
          [anon.id, null],
        ],
      ],
      afterWrite: [
        "connection reset",
        [
          [anon.id, null],
          [anon.id, null],
        ],
      ],
      retried: [newer, older],
    });
  });

  test("each thread's claim is dated when it is taken, and a claim a turn took over fails the whole hand-over", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const anon = { id: "anon:1:FFFFFFFFFFFFFFFFFFFFFF" };
    const answeredThread = async (message: string) => {
      const r = await turn(model, saver, { user: anon, message });
      if (r.status !== "pending") throw new Error("expected pending");
      await turn(model, saver, {
        user: anon,
        threadId: r.threadId,
        answers: {
          [r.calls[0]?.toolCallId as string]: { ok: true, result: {} },
        },
      });
      return r.threadId;
    };
    const older = await answeredThread("primeira");
    const newer = await answeredThread("segunda");
    let clock = Date.now();
    const tick = () => {
      clock += 40_000;
      return new Date(clock);
    };
    const until: Record<string, number> = {};
    let reads = 0;
    const takenOver = {
      getTuple: async (cfg: { configurable: { thread_id: string } }) => {
        const threadId = cfg.configurable.thread_id;
        const row = await suDb.detachedThread.findUniqueOrThrow({
          where: { threadId },
          select: { activeUntil: true },
        });
        until[threadId] = row.activeUntil?.getTime() ?? 0;
        if (++reads === 2)
          await suDb.detachedThread.update({
            where: { threadId },
            data: {
              activeTurnId: "um-turno",
              activeUntil: new Date(clock + 600_000),
            },
          });
        return saver.getTuple(cfg as Parameters<MemorySaver["getTuple"]>[0]);
      },
    } as unknown as MemorySaver;
    const failed = await handOverAnonymousThreads({
      ctx,
      agentId,
      from: anon.id,
      to: { id: "app:1:222" },
      base: appDb,
      checkpointer: takenOver,
      now: tick,
    }).then(
      () => "handed",
      (e: AppError) => e.statusCode,
    );
    const rows = await suDb.detachedThread.findMany({
      where: { threadId: { in: [newer, older] } },
      select: {
        threadId: true,
        activeTurnId: true,
        externalUser: { select: { externalId: true } },
      },
      orderBy: { threadId: "asc" },
    });
    expect({
      failed,
      gap: (until[older] ?? 0) - (until[newer] ?? 0),
      owners: rows.map((r) => r.externalUser?.externalId),
      keptByTurn: rows.find((r) => r.threadId === older)?.activeTurnId,
    }).toEqual({
      failed: 409,
      gap: 40_000,
      owners: [anon.id, anon.id],
      keptByTurn: "um-turno",
    });
  });

  test("a hand-over that moved its threads answers them even when letting go of its claims fails", async () => {
    const model = new ReadsTheScreenThenAnswers();
    const saver = new MemorySaver();
    const anon = { id: "anon:1:GGGGGGGGGGGGGGGGGGGGGG" };
    const r = await turn(model, saver, { user: anon, message: "oi" });
    if (r.status !== "pending") throw new Error("expected pending");
    await turn(model, saver, {
      user: anon,
      threadId: r.threadId,
      answers: { [r.calls[0]?.toolCallId as string]: { ok: true, result: {} } },
    });
    const releaseFails = appDb.$extends({
      query: {
        detachedThread: {
          async updateMany({ args, query }) {
            const data = args.data as {
              activeTurnId?: unknown;
              externalUserId?: unknown;
            };
            if (data.activeTurnId === null && data.externalUserId === undefined)
              throw new Error("connection reset");
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    expect(
      await handOverAnonymousThreads({
        ctx,
        agentId,
        from: anon.id,
        to: { id: "app:1:333" },
        base: releaseFails,
        checkpointer: saver,
      }),
    ).toEqual([r.threadId]);
  });
});
