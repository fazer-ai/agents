import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { MemorySaver } from "@langchain/langgraph";
import config from "@/config";
import { callWithDeadline } from "@/graph/model-limit";
import type { ResolvedModelConfig } from "@/graph/models";
import { createChatModel } from "@/graph/models";
import { buildModelAndGraph } from "@/graph/prepare";
import { makeConfig } from "../utils/agent-config";
import { until } from "../utils/poll";

// With no fallback configured, the primary model call still has a deadline: without one a provider
// that accepts the connection and never answers holds the turn for as long as it likes. The deadline
// covers the whole call, retries included, and holds on a provider whose adapter ignores the abort
// signal (the Google one).

// The suite's DOM preload replaces the global `Response`, and Bun's socket layer does not
// recognise that one (it answers its own placeholder page). tests/dom-setup.ts keeps Bun's.
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
// And its `fetch` applies same-origin, so every call is preceded by a preflight that has to be
// answered, and every answer has to carry the headers, or the body never reaches the adapter.
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};
const preflight = (req: Request) =>
  req.method === "OPTIONS"
    ? new BunResponse(null, { status: 204, headers: CORS })
    : null;

// Pinned far below the default so a test cannot pass on the default by accident, and short because
// every test that reaches the deadline waits it out. A test about an answer that must arrive INSIDE
// the deadline sets its own, generous one: a budget the work has to fit in on a loaded machine, which
// a passing run never waits.
const DEADLINE_MS = 40;
const GENEROUS_DEADLINE_MS = 5_000;
let savedDeadline: number | undefined;
beforeEach(() => {
  savedDeadline = config.agent.modelCallTimeoutMs;
  config.agent.modelCallTimeoutMs = DEADLINE_MS;
});
afterEach(() => {
  if (savedDeadline !== undefined)
    config.agent.modelCallTimeoutMs = savedDeadline;
});

// The bound's timer is cleared once `p` settles, so a passing test leaves nothing to wait out.
async function within<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"pending">((r) => {
    timer = setTimeout(() => r("pending"), ms);
  });
  try {
    return await Promise.race([p, bound]);
  } finally {
    clearTimeout(timer);
  }
}

// Settles the graph invocation into a value, so a test can time it and read the error.
async function outcome(p: Promise<unknown>) {
  const t0 = performance.now();
  try {
    await p;
    return { ok: true as const, ms: performance.now() - t0 };
  } catch (err) {
    return { ok: false as const, ms: performance.now() - t0, err };
  }
}

// Every server here binds the address the client dials. Bun.serve's default binds the wildcard, and
// on macOS another process (a parallel test run) may then bind 127.0.0.1 on the same port and take
// every request to 127.0.0.1 from it: this test's request lands on a stranger that answers 404 or
// never answers.
const LOOPBACK = "127.0.0.1";

// An endpoint that accepts the connection and never answers, counting what reaches it.
function hangingEndpoint() {
  let hits = 0;
  let closedByClient = 0;
  const srv = Bun.serve({
    hostname: LOOPBACK,
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const pre = preflight(req);
      if (pre) return pre;
      hits++;
      // Never answers: the request is held until the client closes it, and only then let go.
      await new Promise<void>((closed) =>
        req.signal.addEventListener("abort", () => {
          closedByClient++;
          closed();
        }),
      );
      return new BunResponse("{}", { headers: CORS });
    },
  });
  return {
    baseURL: `http://${LOOPBACK}:${srv.port}/v1`,
    hits: () => hits,
    closedByClient: () => closedByClient,
    stop: () => srv.stop(true),
  };
}

// A model that answers after `delay` (a duration, or a promise the test settles) and never looks at
// the abort signal, which is how the Google adapter behaves (neither `timeout` nor `signal` on invoke
// stops it). `answered` settles once it has returned its answer; `abortedAtStart` records, per call,
// whether the signal it was handed had already fired.
class DeafModel extends BaseChatModel {
  calls = 0;
  abortedAtStart: boolean[] = [];
  answered: Promise<void>;
  private markAnswered: () => void = () => {};
  constructor(
    private delay: number | Promise<void>,
    private text = "resposta",
  ) {
    super({});
    this.answered = new Promise<void>((r) => {
      this.markAnswered = r;
    });
  }
  _llmType() {
    return "deaf";
  }
  override bindTools() {
    return this;
  }
  async _generate(
    _messages: unknown,
    options: { signal?: AbortSignal },
  ): Promise<ChatResult> {
    this.calls++;
    this.abortedAtStart.push(options.signal?.aborted ?? false);
    await (typeof this.delay === "number" ? Bun.sleep(this.delay) : this.delay);
    queueMicrotask(this.markAnswered);
    return {
      generations: [{ text: this.text, message: new AIMessage(this.text) }],
    };
  }
}

async function graphOn(
  model: BaseChatModel,
  over: Parameters<typeof makeConfig>[0] = {},
  checkpointer = new MemorySaver(),
) {
  return buildModelAndGraph(makeConfig(over), [], {
    makeModel: () => model,
    checkpointer,
  });
}

const THREAD = { configurable: { thread_id: "t-809" } };

// A test that cuts a REAL request at DEADLINE_MS can only see the cut on the server if the request
// got there first, and on a loaded machine connection setup, the CORS preflight and (in a fresh
// process) loading the client can outlast 40 ms. An attempt whose request never arrived is an unmet
// precondition, not a product failure: `attempt` asserts the outcome every time, and only the
// observation of the server side waits for an attempt the request reached, each on a fresh endpoint
// so a late arrival from an earlier one cannot be counted. A deadline that never fires fails the
// first attempt, so the repetition cannot hide it.
const ARRIVAL_ATTEMPTS = 8;
async function attemptUntilArrival(
  attempt: (ep: ReturnType<typeof hangingEndpoint>) => Promise<void>,
) {
  for (let i = 1; ; i++) {
    const ep = hangingEndpoint();
    try {
      await attempt(ep);
    } catch (err) {
      ep.stop();
      throw err;
    }
    if (ep.hits() > 0 || i === ARRIVAL_ATTEMPTS) return ep;
    ep.stop();
  }
}

describe("with no fallback, the primary model call has a deadline", () => {
  test("a provider that never answers fails the turn at the deadline, on the real transport", async () => {
    const ep = await attemptUntilArrival(async (ep) => {
      const graph = await buildModelAndGraph(
        makeConfig({
          mc: {
            provider: "openai-compatible",
            model: "probe",
            baseURL: ep.baseURL,
          },
        }),
        [],
        { checkpointer: new MemorySaver() },
      );
      const res = await within(
        outcome(graph.invoke({ messages: [new HumanMessage("oi")] }, THREAD)),
        DEADLINE_MS + 3_000,
      );
      expect(res).not.toBe("pending");
      if (res === "pending") return;
      expect(res.ok).toBe(false);
      // Cut by the deadline, not refused before it: the timer never fires early by more than rounding.
      expect(res.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 2);
      expect((res.err as Error).message).toBe("timeout");
    });
    try {
      // A hang is one attempt: nothing comes back to retry on.
      expect(ep.hits()).toBe(1);
      // And it is CANCELLED, not abandoned open: this adapter listens to the signal.
      await until("the hung request closed by the client", () =>
        ep.closedByClient(),
      );
      expect(ep.closedByClient()).toBe(1);
    } finally {
      ep.stop();
    }
  });

  test("an adapter that ignores the abort signal is still cut at the deadline", async () => {
    const model = new DeafModel(600_000);
    const graph = await graphOn(model);
    const res = await within(
      outcome(graph.invoke({ messages: [new HumanMessage("oi")] }, THREAD)),
      DEADLINE_MS + 3_000,
    );
    expect(res).not.toBe("pending");
    if (res === "pending") return;
    expect(res.ok).toBe(false);
    expect((res.err as Error).message).toBe("timeout");
  });

  test("a slow answer inside the deadline is delivered", async () => {
    config.agent.modelCallTimeoutMs = GENEROUS_DEADLINE_MS;
    // Slow enough to cross several turns of the event loop, which is all a deadline armed wrong (at
    // zero, or already expired) needs to cut it.
    const graph = await graphOn(new DeafModel(DEADLINE_MS, "chegou"));
    const out = await graph.invoke(
      { messages: [new HumanMessage("oi")] },
      THREAD,
    );
    const last = out.messages.at(-1);
    expect(String(last?.content)).toBe("chegou");
  });

  test("every call gets its own deadline, not one shared by the graph", async () => {
    // Two calls that each answer at once, the second started a whole deadline after the first ended:
    // a signal created once, when the graph is built or on the first call, has expired by then.
    const model = new DeafModel(Promise.resolve(), "ok");
    const graph = await graphOn(model);
    await graph.invoke({ messages: [new HumanMessage("um")] }, THREAD);
    await Bun.sleep(DEADLINE_MS + 5);
    const out = await graph.invoke(
      { messages: [new HumanMessage("dois")] },
      THREAD,
    );
    expect(String(out.messages.at(-1)?.content)).toBe("ok");
    // The second call was handed a live signal, not one whose time ran out before it began.
    expect(model.abortedAtStart).toEqual([false, false]);
  });

  test("an answer that arrives after the deadline never reaches the thread", async () => {
    const checkpointer = new MemorySaver();
    let answerNow: () => void = () => {};
    const model = new DeafModel(
      new Promise<void>((r) => {
        answerNow = r;
      }),
      "resposta-tardia",
    );
    const graph = await graphOn(model, {}, checkpointer);
    const res = await outcome(
      graph.invoke({ messages: [new HumanMessage("oi")] }, THREAD),
    );
    expect(res.ok).toBe(false);
    // The answer arrives now, after the turn failed, and everything it could set off is let run.
    answerNow();
    await model.answered;
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    const state = await graph.getState(THREAD);
    const texts = (state.values.messages ?? []).map((m: { content: unknown }) =>
      String(m.content),
    );
    expect(texts).not.toContain("resposta-tardia");
  });

  test("a provider that refuses at once fails at once, without waiting for the deadline", async () => {
    // A deadline far above what a refusal takes, so "at once" has room on a loaded machine; a passing
    // run never waits it.
    config.agent.modelCallTimeoutMs = 10_000;
    const srv = Bun.serve({
      hostname: LOOPBACK,
      port: 0,
      fetch: (req) =>
        preflight(req) ??
        new BunResponse(
          JSON.stringify({ error: { message: "bad key", type: "auth" } }),
          {
            status: 401,
            headers: { ...CORS, "content-type": "application/json" },
          },
        ),
    });
    try {
      const graph = await buildModelAndGraph(
        makeConfig({
          mc: {
            provider: "openai-compatible",
            model: "probe",
            baseURL: `http://${LOOPBACK}:${srv.port}/v1`,
          },
        }),
        [],
        { checkpointer: new MemorySaver() },
      );
      const res = await outcome(
        graph.invoke({ messages: [new HumanMessage("oi")] }, THREAD),
      );
      expect(res.ok).toBe(false);
      expect(res.ms).toBeLessThan(5_000);
    } finally {
      srv.stop(true);
    }
  });
});

describe("with a fallback, nothing about the primary changes", () => {
  test("the primary is not cut at this deadline: it has its own 45 s ceiling instead", async () => {
    // Answers after the no-fallback deadline would have fired: that timer, armed first and set to
    // expire first, would always win the race.
    const primary = new DeafModel(DEADLINE_MS + 5, "primario");
    const seen: ResolvedModelConfig[] = [];
    const graph = await buildModelAndGraph(
      makeConfig({
        modelFallback: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          credentialRef: "vault:9",
          baseURL: null,
          timeoutMs: null,
        },
        modelFallbackApiKey: "sk-fallback",
      }),
      [],
      {
        makeModel: (mc: ResolvedModelConfig) => {
          seen.push(mc);
          return mc.provider === "anthropic"
            ? new DeafModel(0, "fallback")
            : primary;
        },
        checkpointer: new MemorySaver(),
      },
    );
    const out = await graph.invoke(
      { messages: [new HumanMessage("oi")] },
      THREAD,
    );
    // Answered by the primary after the no-fallback deadline had passed: the deadline did not apply.
    expect(String(out.messages.at(-1)?.content)).toBe("primario");
    expect(seen.find((m) => m.provider !== "anthropic")?.timeoutMs).toBe(
      45_000,
    );
  });

  // The agent's own ceiling replaces the 45 s: the primary is cut at it and the fallback answers,
  // and both models are built with it.
  test("the agent's fallback timeout cuts the primary and hands the turn over", async () => {
    const seen: ResolvedModelConfig[] = [];
    const graph = await buildModelAndGraph(
      makeConfig({
        modelFallback: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          credentialRef: "vault:9",
          baseURL: null,
          timeoutMs: DEADLINE_MS,
        },
        modelFallbackApiKey: "sk-fallback",
      }),
      [],
      {
        makeModel: (mc: ResolvedModelConfig) => {
          seen.push(mc);
          return mc.provider === "anthropic"
            ? new DeafModel(0, "fallback")
            : new DeafModel(new Promise<void>(() => {}), "primario");
        },
        checkpointer: new MemorySaver(),
      },
    );
    const out = await graph.invoke(
      { messages: [new HumanMessage("oi")] },
      THREAD,
    );
    expect(String(out.messages.at(-1)?.content)).toBe("fallback");
    expect(seen.map((m) => m.timeoutMs)).toEqual([DEADLINE_MS, DEADLINE_MS]);
  });

  // The fallback is held to the same ceiling by the race, not by its SDK alone: a fallback that
  // hangs too ends the turn at twice the agent's timeout, never at the 45 s default.
  test("a fallback that hangs too is cut at the agent's timeout", async () => {
    const graph = await buildModelAndGraph(
      makeConfig({
        modelFallback: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          credentialRef: "vault:9",
          baseURL: null,
          timeoutMs: DEADLINE_MS,
        },
        modelFallbackApiKey: "sk-fallback",
      }),
      [],
      {
        makeModel: (mc: ResolvedModelConfig) =>
          new DeafModel(new Promise<void>(() => {}), mc.provider),
        checkpointer: new MemorySaver(),
      },
    );
    const res = await within(
      outcome(graph.invoke({ messages: [new HumanMessage("oi")] }, THREAD)),
      GENEROUS_DEADLINE_MS,
    );
    expect(res).not.toBe("pending");
    expect(res !== "pending" && res.ok).toBe(false);
  });
});

describe("callWithDeadline, on its own", () => {
  test("the signal reaches the call: an adapter that listens cancels its request", async () => {
    // Outside a graph, where nothing else cancels it: inside one, LangGraph also aborts the children
    // of a node that failed, so this is the only place the helper's own signal is observable.
    const ep = await attemptUntilArrival(async (ep) => {
      const model = createChatModel({
        provider: "openai-compatible",
        model: "probe",
        apiKey: "sk",
        baseURL: ep.baseURL,
        temperature: 0,
      });
      const res = await within(
        outcome(
          callWithDeadline(DEADLINE_MS, (signal) =>
            model.invoke([new HumanMessage("oi")], { signal }),
          ),
        ),
        DEADLINE_MS + 3_000,
      );
      expect(res).not.toBe("pending");
      if (res === "pending") return;
      expect(res.ok).toBe(false);
      expect((res.err as Error).name).toBe("TimeoutError");
    });
    try {
      expect(ep.hits()).toBe(1);
      await until("the hung request closed by the client", () =>
        ep.closedByClient(),
      );
      expect(ep.closedByClient()).toBe(1);
    } finally {
      ep.stop();
    }
  });

  test("a call that settles in time is passed through, value and error alike", async () => {
    expect(await callWithDeadline(1_000, async () => "ok")).toBe("ok");
    const boom = new Error("boom");
    const res = await outcome(
      callWithDeadline(1_000, async () => {
        throw boom;
      }),
    );
    expect(res.ok ? null : res.err).toBe(boom);
  });

  test("a run that throws before returning a promise is a rejection, not a throw", async () => {
    const sync = new Error("sync");
    let settled: unknown = "pending";
    // NOTE: a deadline far past the test, so only the run's own error can settle it.
    void callWithDeadline(60_000, () => {
      throw sync;
    }).then(
      () => {
        settled = "resolved";
      },
      (e: unknown) => {
        settled = e;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(sync);
  });
});
