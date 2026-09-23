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

// Issue #809: with no fallback configured, the primary model call had no ceiling at all, so a
// provider that accepts the connection and never answers held the turn for as long as it liked
// (measured in #807: 5 min 36 s). The deadline covers the whole call, retries included, and holds on
// a provider whose adapter ignores the abort signal (the Google one, measured).

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// NOTE: the suite's DOM preload replaces the global `Response`, and Bun's socket layer does not
// recognise that one (it answers its own placeholder page). tests/dom-setup.ts keeps Bun's.
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
// NOTE: and its `fetch` applies same-origin, so every call is preceded by a preflight that has to be
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

// Pinned below the default so a test cannot pass on the default by accident, and short enough to
// keep the file fast.
const DEADLINE_MS = 1_500;
let savedDeadline: number | undefined;
beforeEach(() => {
  savedDeadline = config.agent.modelCallTimeoutMs;
  config.agent.modelCallTimeoutMs = DEADLINE_MS;
});
afterEach(() => {
  if (savedDeadline !== undefined)
    config.agent.modelCallTimeoutMs = savedDeadline;
});

function within<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([p, sleep(ms).then(() => "pending" as const)]);
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

// An endpoint that accepts the connection and never answers, counting what reaches it.
function hangingEndpoint() {
  let hits = 0;
  let closedByClient = 0;
  const srv = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: async (req) => {
      const pre = preflight(req);
      if (pre) return pre;
      hits++;
      req.signal.addEventListener("abort", () => {
        closedByClient++;
      });
      await sleep(600_000);
      return new BunResponse("{}", { headers: CORS });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${srv.port}/v1`,
    hits: () => hits,
    closedByClient: () => closedByClient,
    stop: () => srv.stop(true),
  };
}

// A model that answers after `delayMs` and never looks at the abort signal, which is how the Google
// adapter behaves (measured: neither `timeout` nor `signal` on invoke stops it).
class DeafModel extends BaseChatModel {
  calls = 0;
  constructor(
    private delayMs: number,
    private text = "resposta",
  ) {
    super({});
  }
  _llmType() {
    return "deaf";
  }
  override bindTools() {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    this.calls++;
    await sleep(this.delayMs);
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

describe("with no fallback, the primary model call has a deadline", () => {
  test("a provider that never answers fails the turn at the deadline, on the real transport", async () => {
    const ep = hangingEndpoint();
    try {
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
      expect(res.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 50);
      expect((res.err as Error).message).toBe("timeout");
      // A hang is one attempt: nothing comes back to retry on.
      expect(ep.hits()).toBe(1);
      // And it is CANCELLED, not abandoned open: this adapter listens to the signal.
      await sleep(200);
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
    const graph = await graphOn(new DeafModel(300, "chegou"));
    const out = await graph.invoke(
      { messages: [new HumanMessage("oi")] },
      THREAD,
    );
    const last = out.messages.at(-1);
    expect(String(last?.content)).toBe("chegou");
  });

  test("every call gets its own deadline, not one shared by the graph", async () => {
    // Two calls back to back, each taking most of the deadline: a signal created once, when the
    // graph is built, would expire during the second one.
    const graph = await graphOn(new DeafModel(DEADLINE_MS * 0.7, "ok"));
    await graph.invoke({ messages: [new HumanMessage("um")] }, THREAD);
    const out = await graph.invoke(
      { messages: [new HumanMessage("dois")] },
      THREAD,
    );
    expect(String(out.messages.at(-1)?.content)).toBe("ok");
  });

  test("an answer that arrives after the deadline never reaches the thread", async () => {
    const checkpointer = new MemorySaver();
    const graph = await graphOn(
      new DeafModel(DEADLINE_MS + 500, "resposta-tardia"),
      {},
      checkpointer,
    );
    const res = await outcome(
      graph.invoke({ messages: [new HumanMessage("oi")] }, THREAD),
    );
    expect(res.ok).toBe(false);
    await sleep(1_000);
    const state = await graph.getState(THREAD);
    const texts = (state.values.messages ?? []).map((m: { content: unknown }) =>
      String(m.content),
    );
    expect(texts).not.toContain("resposta-tardia");
  });

  test("a provider that refuses at once fails at once, without waiting for the deadline", async () => {
    const srv = Bun.serve({
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
            baseURL: `http://127.0.0.1:${srv.port}/v1`,
          },
        }),
        [],
        { checkpointer: new MemorySaver() },
      );
      const res = await outcome(
        graph.invoke({ messages: [new HumanMessage("oi")] }, THREAD),
      );
      expect(res.ok).toBe(false);
      expect(res.ms).toBeLessThan(DEADLINE_MS / 2);
    } finally {
      srv.stop(true);
    }
  });
});

describe("with a fallback, nothing about the primary changes", () => {
  test("the primary is not cut at this deadline: it has its own 45 s ceiling instead", async () => {
    const primary = new DeafModel(DEADLINE_MS + 1_500, "primario");
    const seen: ResolvedModelConfig[] = [];
    const graph = await buildModelAndGraph(
      makeConfig({
        modelFallback: {
          provider: "anthropic",
          model: "claude-haiku-4-5",
          credentialRef: "vault:9",
          baseURL: null,
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
});

describe("callWithDeadline, on its own", () => {
  test("the signal reaches the call: an adapter that listens cancels its request", async () => {
    // Outside a graph, where nothing else cancels it: inside one, LangGraph also aborts the children
    // of a node that failed, so this is the only place the helper's own signal is observable.
    const ep = hangingEndpoint();
    try {
      const model = createChatModel({
        provider: "openai-compatible",
        model: "probe",
        apiKey: "sk",
        baseURL: ep.baseURL,
        temperature: 0,
      });
      const res = await outcome(
        callWithDeadline(300, (signal) =>
          model.invoke([new HumanMessage("oi")], { signal }),
        ),
      );
      expect(res.ok).toBe(false);
      await sleep(200);
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
    const res = await outcome(
      callWithDeadline(1_000, () => {
        throw new Error("sync");
      }),
    );
    expect(res.ok).toBe(false);
  });
});
