import { describe, expect, test } from "bun:test";
import {
  EMBEDDING_DIM,
  type EmbeddingDeps,
  embedQuery,
  QUERY_BUDGET,
} from "@/modules/rag/embeddings";

// Issue #844: a query embedding is a customer waiting. Measured in production: searches of 139 s
// and 158 s that returned normally, because the query waited as the ingest does (60 s per attempt on
// the compatible path, the OpenAI client's 10 minutes under LangChain's six retries on the SDK
// path). A stalled request here is one that never answers until it is aborted.

const nativeGlobals = globalThis as unknown as { BunResponse: typeof Response };
const BunResponse = nativeGlobals.BunResponse;

const vec = (seed: number): number[] =>
  Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === seed ? 1 : 0));

const passThrough: EmbeddingDeps["assertSafe"] = async (u) => new URL(u);

// Short enough for a test and in the same proportions as the real one: the second pause (2 s) no
// longer fits, so a search that keeps stalling makes exactly two attempts.
const BUDGET = { attemptMs: 60, deadlineMs: 1_200 };

// Answers only when told to; otherwise holds the request until its signal aborts it, as a stalled
// connection does.
function provider(answerOn: Set<number>, body: (n: number) => unknown) {
  let calls = 0;
  let aborted = 0;
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    calls += 1;
    const n = calls;
    if (answerOn.has(n))
      return new BunResponse(JSON.stringify(body(n)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal;
      const abort = () => {
        aborted += 1;
        reject(
          signal?.reason ??
            Object.assign(new Error("aborted"), { name: "AbortError" }),
        );
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort);
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls, aborted: () => aborted };
}

const compatible = {
  model: "text-embedding-3-small",
  apiKey: "sk-probe",
  baseURL: "https://embedding.internal/v1/",
};
const openai = { model: "text-embedding-3-small", apiKey: "sk-probe" };
const sdkBody = () => ({
  data: [
    {
      index: 0,
      embedding: Buffer.from(new Float32Array(vec(2)).buffer).toString(
        "base64",
      ),
    },
  ],
});

describe("a query embedding gives up on a stalled request quickly (issue #844)", () => {
  test("the shipped deadlines are seconds, and the whole search stays under the turn's", () => {
    // The turn's own model deadline is 45 s (PRIMARY_TIMEOUT_MS); the search has to leave it time.
    expect(QUERY_BUDGET.attemptMs).toBeLessThanOrEqual(10_000);
    expect(QUERY_BUDGET.deadlineMs).toBeLessThanOrEqual(30_000);
    expect(QUERY_BUDGET.deadlineMs).toBeGreaterThan(QUERY_BUDGET.attemptMs);
  });

  for (const [path, cfg, body] of [
    ["compatible", compatible, () => ({ data: [{ embedding: vec(2) }] })],
    ["OpenAI SDK", openai, sdkBody],
  ] as const) {
    test(`${path}: a request that keeps stalling ends at the deadline, as a timeout`, async () => {
      const p = provider(new Set(), body);
      const retries: unknown[] = [];
      const started = Date.now();
      const err = await embedQuery("consulta", cfg, {
        fetchImpl: p.fetchImpl,
        assertSafe: passThrough,
        queryBudget: BUDGET,
        onRetry: (e) => retries.push(e),
      }).catch((e: unknown) => e);
      const elapsed = Date.now() - started;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("timeout");
      // Asked twice: the SDK's own retries are off, and the second pause would cross the deadline.
      expect(p.calls()).toBe(2);
      expect(retries).toHaveLength(1);
      expect(elapsed).toBeLessThan(BUDGET.deadlineMs);
    });

    // Giving up on the wait is not enough: the request left behind has to be closed, and nothing may
    // go on asking the provider after the search has answered (the SDK's own retries would).
    test(`${path}: an attempt given up on is closed, and nothing keeps calling`, async () => {
      const p = provider(new Set(), body);
      await embedQuery("consulta", cfg, {
        fetchImpl: p.fetchImpl,
        assertSafe: passThrough,
        queryBudget: BUDGET,
      }).catch(() => undefined);
      await Bun.sleep(1_500);
      expect(p.calls()).toBe(2);
      expect(p.aborted()).toBe(2);
    });

    test(`${path}: a stalled attempt is abandoned and the next one answers`, async () => {
      const p = provider(new Set([2]), body);
      let retried = 0;
      const out = await embedQuery("consulta", cfg, {
        fetchImpl: p.fetchImpl,
        assertSafe: passThrough,
        queryBudget: BUDGET,
        onRetry: () => {
          retried += 1;
        },
      });
      expect(out).toEqual(vec(2));
      expect(p.calls()).toBe(2);
      expect(retried).toBe(1);
    });
  }

  test("the last attempt gets only what the deadline leaves, not a full attempt", async () => {
    // 600 ms, a 500 ms pause, and then 200 ms left: a full second attempt would end at 1.7 s.
    const p = provider(new Set(), () => ({}));
    const started = Date.now();
    await embedQuery("consulta", compatible, {
      fetchImpl: p.fetchImpl,
      assertSafe: passThrough,
      queryBudget: { attemptMs: 600, deadlineMs: 1_300 },
    }).catch(() => undefined);
    expect(p.calls()).toBe(2);
    expect(Date.now() - started).toBeLessThan(1_550);
  });

  // Review round 1: the attempt's deadline has to cover what happens outside the request, too.
  test("a host check that stalls is bounded by the same deadline", async () => {
    const started = Date.now();
    const err = await embedQuery("consulta", compatible, {
      fetchImpl: provider(new Set([1, 2]), () => ({
        data: [{ embedding: vec(1) }],
      })).fetchImpl,
      assertSafe: () => new Promise<URL>(() => {}),
      queryBudget: { attemptMs: 60, deadlineMs: 400 },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("timeout");
    expect(Date.now() - started).toBeLessThan(400);
  });

  test("an error body the SDK reads with no timer of its own is bounded too", async () => {
    const fetchImpl = (async () =>
      new BunResponse(
        new ReadableStream({
          start() {
            // Headers arrive with a 503; the body never finishes.
          },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const started = Date.now();
    const err = await embedQuery("consulta", openai, {
      fetchImpl,
      queryBudget: { attemptMs: 60, deadlineMs: 400 },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("timeout");
    expect(Date.now() - started).toBeLessThan(400);
  });

  // Review round 2: giving up on an attempt has to cancel it, not only stop waiting on it.
  test("a host check that answers after the deadline sends nothing", async () => {
    const p = provider(new Set([1, 2]), () => ({
      data: [{ embedding: vec(1) }],
    }));
    await embedQuery("consulta", compatible, {
      fetchImpl: p.fetchImpl,
      assertSafe: async (u) => {
        await Bun.sleep(250);
        return new URL(u);
      },
      queryBudget: { attemptMs: 60, deadlineMs: 400 },
    }).catch(() => undefined);
    await Bun.sleep(500);
    expect(p.calls()).toBe(0);
  });

  test("an error body left hanging is closed when the attempt is given up on", async () => {
    let signals: (AbortSignal | undefined)[] = [];
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      signals = [...signals, init?.signal ?? undefined];
      return new BunResponse(new ReadableStream({ start() {} }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await embedQuery("consulta", openai, {
      fetchImpl,
      queryBudget: BUDGET,
    }).catch(() => undefined);
    expect(signals).toHaveLength(2);
    expect(signals.every((sig) => sig?.aborted === true)).toBe(true);
  });

  test("an answer on the first attempt reports no retry", async () => {
    const p = provider(new Set([1]), () => ({ data: [{ embedding: vec(1) }] }));
    let retried = 0;
    await embedQuery("consulta", compatible, {
      fetchImpl: p.fetchImpl,
      assertSafe: passThrough,
      queryBudget: BUDGET,
      onRetry: () => {
        retried += 1;
      },
    });
    expect(retried).toBe(0);
  });
});
