import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  spyOn,
  test,
} from "bun:test";
import {
  EMBEDDING_DIM,
  type EmbeddingDeps,
  embedQuery,
  QUERY_BUDGET,
  setEmbeddingRetryDelaysForTest,
} from "@/modules/rag/embeddings";

// A query embedding is a customer waiting, so it does not wait as the ingest does (60 s per attempt
// on the compatible path, the OpenAI client's 10 minutes under LangChain's six retries on the SDK
// path), which lets a search take minutes. A stalled request here never answers until it is aborted.

const nativeGlobals = globalThis as unknown as { BunResponse: typeof Response };
const BunResponse = nativeGlobals.BunResponse;

const vec = (seed: number): number[] =>
  Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === seed ? 1 : 0));

const passThrough: EmbeddingDeps["assertSafe"] = async (u) => new URL(u);

// Short enough for a test, since every stalled attempt waits it out: the second pause (2 s) no longer
// fits the deadline, so a search that keeps stalling makes exactly two attempts. The deadline itself
// is never reached by a passing run; it only has to leave the two attempts room on a loaded machine.
const ATTEMPT_MS = 25;
const BUDGET = { attemptMs: ATTEMPT_MS, deadlineMs: 1_200 };

// The pauses between attempts while this file runs: the first shortened through the module's test
// seam, the second as shipped, which no budget here leaves room for.
const RETRY_DELAYS_MS = [10, 2_000];
beforeAll(() => setEmbeddingRetryDelaysForTest(RETRY_DELAYS_MS));
afterAll(() => setEmbeddingRetryDelaysForTest(undefined));
afterEach(() => {
  jest.useRealTimers();
});

// Lets every promise already queued run, without letting the clock move.
async function settleQueued(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

// Runs `call` on a fake clock, advanced in steps until it settles and then for `quietMs` more, so a
// retry anything left scheduled after it answered gets its turn without the test waiting for it.
async function onFakeClock(
  call: () => Promise<unknown>,
  quietMs: number,
): Promise<{ settled: boolean; elapsedMs: number }> {
  jest.useFakeTimers();
  try {
    const startedAt = Date.now();
    let settled = false;
    let elapsedMs = 0;
    call()
      .catch(() => undefined)
      .finally(() => {
        settled = true;
        elapsedMs = Date.now() - startedAt;
      });
    await settleQueued();
    for (let step = 0; step < 10_000 && !settled; step++) {
      jest.advanceTimersByTime(5);
      await settleQueued();
    }
    for (let left = quietMs; left > 0; left -= 100) {
      jest.advanceTimersByTime(100);
      await settleQueued();
    }
    return { settled, elapsedMs };
  } finally {
    jest.useRealTimers();
  }
}

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
  // The pauses a search that keeps stalling sleeps, read off the sleep itself, which answers at once.
  async function pausesSlept(): Promise<{ pauses: unknown[]; calls: number }> {
    const slept = spyOn(Bun, "sleep").mockResolvedValue(undefined as never);
    try {
      const p = provider(new Set(), () => ({}));
      await embedQuery("consulta", compatible, {
        fetchImpl: p.fetchImpl,
        assertSafe: passThrough,
        queryBudget: { attemptMs: 5, deadlineMs: 60_000 },
      }).catch(() => undefined);
      return { pauses: slept.mock.calls.map(([ms]) => ms), calls: p.calls() };
    } finally {
      slept.mockRestore();
    }
  }

  test("the shipped pauses between attempts are half a second, then two", async () => {
    setEmbeddingRetryDelaysForTest(undefined);
    try {
      expect(await pausesSlept()).toEqual({ pauses: [500, 2_000], calls: 3 });
    } finally {
      setEmbeddingRetryDelaysForTest(RETRY_DELAYS_MS);
    }
  });

  test("the shortened pauses are the ones the retry sleeps", async () => {
    expect(await pausesSlept()).toEqual({ pauses: RETRY_DELAYS_MS, calls: 3 });
  });

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
      // A minute of quiet after the answer: the SDK's own retries, were they on, come back within it.
      const run = await onFakeClock(
        () =>
          embedQuery("consulta", cfg, {
            fetchImpl: p.fetchImpl,
            assertSafe: passThrough,
            queryBudget: BUDGET,
          }),
        60_000,
      );
      expect(run.settled).toBe(true);
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
    // On the fake clock, with the shipped pause: 600 ms, a 500 ms pause, and then 200 ms left, so the
    // search ends at 1.3 s where a full second attempt would end at 1.7 s.
    setEmbeddingRetryDelaysForTest(undefined);
    try {
      const p = provider(new Set(), () => ({}));
      const run = await onFakeClock(
        () =>
          embedQuery("consulta", compatible, {
            fetchImpl: p.fetchImpl,
            assertSafe: passThrough,
            queryBudget: { attemptMs: 600, deadlineMs: 1_300 },
          }),
        0,
      );
      expect(run.settled).toBe(true);
      expect(p.calls()).toBe(2);
      expect(run.elapsedMs).toBeLessThan(1_400);
    } finally {
      setEmbeddingRetryDelaysForTest(RETRY_DELAYS_MS);
    }
  });

  // NOTE: the attempt's deadline has to cover what happens outside the request, too.
  test("a host check that stalls is bounded by the same deadline", async () => {
    const started = Date.now();
    const err = await embedQuery("consulta", compatible, {
      fetchImpl: provider(new Set([1, 2]), () => ({
        data: [{ embedding: vec(1) }],
      })).fetchImpl,
      assertSafe: () => new Promise<URL>(() => {}),
      queryBudget: { attemptMs: ATTEMPT_MS, deadlineMs: 400 },
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
      queryBudget: { attemptMs: ATTEMPT_MS, deadlineMs: 400 },
    }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("timeout");
    expect(Date.now() - started).toBeLessThan(400);
  });

  // NOTE: giving up on an attempt has to cancel it, not only stop waiting on it.
  test("a host check that answers after the deadline sends nothing", async () => {
    const p = provider(new Set([1, 2]), () => ({
      data: [{ embedding: vec(1) }],
    }));
    let answerNow: () => void = () => {};
    const answered = new Promise<void>((r) => {
      answerNow = r;
    });
    let checks = 0;
    await embedQuery("consulta", compatible, {
      fetchImpl: p.fetchImpl,
      assertSafe: async (u) => {
        checks += 1;
        await answered;
        return new URL(u);
      },
      queryBudget: { attemptMs: ATTEMPT_MS, deadlineMs: 400 },
    }).catch(() => undefined);
    // Every check answers now, after the search gave up on it, and what it would set off is let run.
    answerNow();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(checks).toBeGreaterThan(0);
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
