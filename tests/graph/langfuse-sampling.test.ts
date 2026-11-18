import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { type RunnableConfig, RunnableLambda } from "@langchain/core/runnables";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { traceIdForTurn, traceSampled } from "@/graph/langfuse-otel";
import {
  buildLangfuseHandler,
  type LangfuseConfig,
  recordDirectGeneration,
  setLangfuseDeliveryRetryForTest,
  shutdownLangfuseClients,
  type TraceContext,
} from "@/graph/observability";
import {
  type FlatSpan,
  LANGFUSE_OTLP_PATH,
  otlpBodyText,
  otlpSpans,
} from "../utils/otlp-capture";

// Each turn here runs the way the runtime runs one (a chain over a chat model, a secondary call under
// the same turn, a generation written by hand), against a stubbed `fetch`; what reaches the stub after
// `shutdownLangfuseClients()` drains is what Langfuse would have received.

const posted: { url: string; body: string }[] = [];
const realFetch = globalThis.fetch;

beforeAll(() => {
  setLangfuseDeliveryRetryForTest({ fetchRetryCount: 0, fetchRetryDelay: 1 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("http://lf-")) return realFetch(input, init);
    posted.push({ url, body: otlpBodyText(init?.body) });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(async () => {
  await shutdownLangfuseClients();
  posted.length = 0;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  setLangfuseDeliveryRetryForTest(undefined);
});

function cfg(tenant: string, sampleRate?: number): LangfuseConfig {
  return {
    publicKey: `pk-lf-${tenant}`,
    secretKey: `sk-lf-${tenant}`,
    baseUrl: `http://lf-${tenant}.test`,
    sendContent: true,
    tenantSlug: `slug-${tenant}`,
    ...(sampleRate === undefined ? {} : { sampleRate }),
  };
}

function spansAt(tenant: string): FlatSpan[] {
  return otlpSpans(
    posted
      .filter((p) => p.url === `http://lf-${tenant}.test${LANGFUSE_OTLP_PATH}`)
      .map((p) => p.body),
  );
}

/**
 * One whole turn: a secondary call that starts before the turn's root exists (parentless in the same
 * trace), the root chain over a model, a secondary call after it, and a generation written by hand.
 */
async function runWholeTurn(
  c: LangfuseConfig,
  tenantId: bigint,
  turnId: string,
): Promise<void> {
  const ctx: TraceContext = {
    tenantId,
    threadId: `${tenantId}:1:1`,
    turnId,
  };
  const secondary = async (prompt: string) => {
    const h = buildLangfuseHandler(c, { ...ctx, updateRoot: false });
    await new FakeListChatModel({ responses: ["ok"] }).invoke(prompt, {
      callbacks: [h as never],
    });
  };
  await secondary("before the root");
  const handler = buildLangfuseHandler(c, ctx);
  const model = new FakeListChatModel({ responses: ["reply"] });
  await RunnableLambda.from(
    async (input: { content: string }, runConfig?: RunnableConfig) =>
      (await model.invoke(input.content, runConfig)).content,
  )
    .withConfig({ runName: "agent-turn" })
    .invoke({ content: "hello" }, { callbacks: [handler as never] });
  await secondary("after the root");
  recordDirectGeneration(
    c,
    { tenantId, turnId },
    {
      name: "vision",
      model: "gpt-4o-mini",
      promptTokens: 10,
      completionTokens: 2,
    },
  );
  // NOTE: LangChain runs callbacks in the background; a span is only ended once they have run.
  await awaitAllCallbacks();
}

const turnIds = (n: number, salt: string) =>
  Array.from(
    { length: n },
    (_, i) =>
      `${salt}${i.toString(16).padStart(4, "0")}-0000-4000-8000-${(i * 7919).toString(16).padStart(12, "0")}`,
  );

describe("the sampling decision", () => {
  test("0 keeps no trace and 1 keeps every trace", () => {
    for (let i = 0; i < 200; i++) {
      const id = traceIdForTurn(crypto.randomUUID());
      expect(traceSampled(id, 0)).toBe(false);
      expect(traceSampled(id, 1)).toBe(true);
    }
  });

  test("a fraction keeps about that share of turns, and the same turn always gets the same answer", () => {
    const ids = Array.from({ length: 4000 }, () =>
      traceIdForTurn(crypto.randomUUID()),
    );
    for (const rate of [0.1, 0.5, 0.9]) {
      const kept = ids.filter((id) => traceSampled(id, rate)).length;
      expect(Math.abs(kept / ids.length - rate)).toBeLessThan(0.03);
    }
    for (const id of ids.slice(0, 50)) {
      expect(traceSampled(id, 0.5)).toBe(traceSampled(id, 0.5));
    }
  });

  test("a turn kept at a rate is kept at every higher rate", () => {
    const ids = Array.from({ length: 500 }, () =>
      traceIdForTurn(crypto.randomUUID()),
    );
    for (const id of ids) {
      if (traceSampled(id, 0.2)) expect(traceSampled(id, 0.6)).toBe(true);
    }
  });
});

describe("sampled export", () => {
  test("a rate of 0 sends no span, with content on", async () => {
    for (const id of turnIds(5, "a0")) await runWholeTurn(cfg("z", 0), 31n, id);
    await shutdownLangfuseClients();
    expect(spansAt("z")).toEqual([]);
    expect(posted).toEqual([]);
  });

  test("a rate of 1 sends every span of every turn, the same as no rate at all", async () => {
    const ids = turnIds(5, "b1");
    for (const id of ids) await runWholeTurn(cfg("one", 1), 32n, id);
    for (const id of ids) await runWholeTurn(cfg("none"), 33n, id);
    await shutdownLangfuseClients();
    const one = spansAt("one");
    const none = spansAt("none");
    expect(none.length).toBeGreaterThan(0);
    expect(one.length).toBe(none.length);
    expect(new Set(one.map((s) => s.traceId))).toEqual(
      new Set(ids.map(traceIdForTurn)),
    );
  });

  test("at a fraction, a kept turn arrives whole and a dropped turn sends nothing", async () => {
    const ids = turnIds(40, "c5");
    await runWholeTurn(cfg("full", 1), 34n, ids[0] as string);
    await shutdownLangfuseClients();
    const perTurn = spansAt("full").length;
    expect(perTurn).toBeGreaterThanOrEqual(5);
    posted.length = 0;

    await Promise.all(ids.map((id) => runWholeTurn(cfg("half", 0.5), 35n, id)));
    await shutdownLangfuseClients();
    const byTrace = new Map<string, number>();
    for (const s of spansAt("half")) {
      byTrace.set(s.traceId, (byTrace.get(s.traceId) ?? 0) + 1);
    }
    const kept = ids.filter((id) => traceSampled(traceIdForTurn(id), 0.5));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(ids.length);
    expect(new Set(byTrace.keys())).toEqual(new Set(kept.map(traceIdForTurn)));
    for (const count of byTrace.values()) expect(count).toBe(perTurn);
  });

  test("each tenant's rate applies to its own turns only", async () => {
    const ids = turnIds(4, "d7");
    await Promise.all(
      ids.flatMap((id) => [
        runWholeTurn(cfg("off", 0), 36n, id),
        runWholeTurn(cfg("on", 1), 37n, id),
      ]),
    );
    await shutdownLangfuseClients();
    expect(spansAt("off")).toEqual([]);
    expect(new Set(spansAt("on").map((s) => s.traceId)).size).toBe(4);
  });
});
