import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import config from "@/config";
import { buildAgentGraph } from "@/graph/graph";
import { runModelCall } from "@/graph/model-limit";

// Issue #819: #809 gave the no-fallback primary a deadline that holds on an adapter deaf to the abort
// signal (the Google one, measured). Every other call through `runModelCall` still trusted the signal
// or had nothing: the guardrail, the memory summary, the speech normalization, the fallback, and the
// primary WITH a fallback. The deadline now lives in `runModelCall` itself, per attempt, so these
// tests drive it there and through the graph, with a model that never looks at the signal.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEADLINE_MS = 300;

async function outcome(p: Promise<unknown>) {
  const t0 = performance.now();
  try {
    const value = await p;
    return { ok: true as const, ms: performance.now() - t0, value };
  } catch (err) {
    return { ok: false as const, ms: performance.now() - t0, err };
  }
}

// Answers after `delayMs` and never reads the signal, which is how the Google adapter behaves.
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

describe("every call through runModelCall ends at its deadline", () => {
  test("a call deaf to the signal is cut at the deadline it was given", async () => {
    const res = await outcome(
      runModelCall(() => new Promise<never>(() => {}), {
        deadlineMs: DEADLINE_MS,
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.ms).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
    expect(res.ms).toBeLessThan(DEADLINE_MS + 1_000);
    expect((res as { err: Error }).err.message).toBe("timeout");
  });

  test("the call is handed the signal, and it fires at the deadline", async () => {
    let seen: AbortSignal | undefined;
    await outcome(
      runModelCall(
        (signal) => {
          seen = signal;
          return new Promise<never>(() => {});
        },
        { deadlineMs: DEADLINE_MS },
      ),
    );
    expect(seen?.aborted).toBe(true);
  });

  describe("a caller that names no deadline", () => {
    let saved: number;
    beforeEach(() => {
      saved = config.agent.modelCallTimeoutMs;
      config.agent.modelCallTimeoutMs = DEADLINE_MS;
    });
    afterEach(() => {
      config.agent.modelCallTimeoutMs = saved;
    });

    test("gets the agent's modelCallTimeoutMs, never none", async () => {
      const res = await outcome(
        runModelCall(() => new Promise<never>(() => {})),
      );
      expect(res.ok).toBe(false);
      expect(res.ms).toBeLessThan(DEADLINE_MS + 1_000);
      expect((res as { err: Error }).err.message).toBe("timeout");
    });
  });

  test("the fallback is cut at its own deadline, not the primary's", async () => {
    const res = await outcome(
      runModelCall(
        () =>
          Promise.reject(
            Object.assign(new Error("overloaded"), { status: 503 }),
          ),
        {
          deadlineMs: 60_000,
          primary: { provider: "openai", model: "p" },
          fallback: {
            labels: { provider: "google", model: "f" },
            deadlineMs: DEADLINE_MS,
            run: () => new Promise<never>(() => {}),
          },
        },
      ),
    );
    expect(res.ok).toBe(false);
    expect(res.ms).toBeLessThan(DEADLINE_MS + 1_000);
    expect((res as { err: Error }).err.message).toBe("timeout");
  });

  // The permit is what a hung call really holds: every other turn on the instance queues behind it.
  test("a hung call gives its permit back at the deadline, and only once", async () => {
    const cap = config.agent.modelConcurrency;
    const late = Array.from({ length: cap }, () =>
      outcome(
        runModelCall(() => sleep(DEADLINE_MS * 3).then(() => "late"), {
          deadlineMs: DEADLINE_MS,
        }),
      ),
    );
    const t0 = performance.now();
    const queued = await runModelCall(() => Promise.resolve("next"), {
      deadlineMs: DEADLINE_MS,
    });
    const waited = performance.now() - t0;
    expect(queued).toBe("next");
    expect(waited).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
    expect(waited).toBeLessThan(DEADLINE_MS * 3);
    for (const r of await Promise.all(late)) expect(r.ok).toBe(false);
    // The late answers land now. A permit returned twice would let more than `cap` run at once.
    await sleep(DEADLINE_MS * 3);
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: cap + 3 }, () =>
        runModelCall(
          async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await sleep(15);
            active -= 1;
          },
          { deadlineMs: DEADLINE_MS },
        ),
      ),
    );
    expect(maxActive).toBe(cap);
  });
});

describe("the agent turn bounds both models, fallback or not", () => {
  const PRIMARY = { provider: "google", model: "gemini-test" };

  test("a hung primary WITH a fallback is cut, and the fallback answers", async () => {
    const primary = new DeafModel(600_000);
    const graph = buildAgentGraph({
      model: primary,
      systemPrompt: "s",
      primary: PRIMARY,
      primaryDeadlineMs: DEADLINE_MS,
      fallback: {
        model: new DeafModel(10, "do fallback"),
        provider: "openai",
        modelId: "gpt-test",
      },
    });
    const res = await outcome(
      graph.invoke({ messages: [new HumanMessage("oi")] }),
    );
    expect(res.ok).toBe(true);
    expect(res.ms).toBeLessThan(DEADLINE_MS + 1_000);
    const out = (res as { value: { messages: AIMessage[] } }).value;
    expect(String(out.messages.at(-1)?.content)).toBe("do fallback");
    expect(primary.calls).toBe(1);
  });

  test("a hung fallback ends the turn at its deadline", async () => {
    const graph = buildAgentGraph({
      model: new DeafModel(600_000),
      systemPrompt: "s",
      primary: PRIMARY,
      primaryDeadlineMs: DEADLINE_MS,
      fallback: {
        model: new DeafModel(600_000),
        provider: "google",
        modelId: "gemini-fallback",
        deadlineMs: DEADLINE_MS,
      },
    });
    const res = await outcome(
      graph.invoke({ messages: [new HumanMessage("oi")] }),
    );
    expect(res.ok).toBe(false);
    expect(res.ms).toBeLessThan(DEADLINE_MS * 2 + 1_000);
    expect((res as { err: Error }).err.message).toBe("timeout");
  });
});
