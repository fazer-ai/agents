import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import config from "@/config";
import { buildAgentGraph } from "@/graph/graph";
import { runModelCall } from "@/graph/model-limit";

// Issue #834: a job run whose deadline fired while it waited for a model permit stayed in the queue
// until a permit freed, and its row stayed in the running set until then, so the retry could not be
// claimed. The wait now takes the job's signal. Exercises the real process-wide semaphore: the
// permits are taken by calls that hang until the test lets them go.

const THRESHOLD_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let saved: number | undefined;
beforeEach(() => {
  saved = config.agent.capacityWaitAlertMs;
  config.agent.capacityWaitAlertMs = THRESHOLD_MS;
});

const held: Array<() => void> = [];
afterEach(async () => {
  for (const release of held.splice(0)) release();
  await sleep(0);
  if (saved !== undefined) config.agent.capacityWaitAlertMs = saved;
});

// Takes every permit and keeps them until released. Resolves once all of them are held.
async function holdEveryPermit(): Promise<() => void> {
  const cap = config.agent.modelConcurrency;
  const releases: Array<() => void> = [];
  let started = 0;
  for (let i = 0; i < cap; i++) {
    void runModelCall(
      () =>
        new Promise<void>((resolve) => {
          started++;
          releases.push(resolve);
        }),
    );
  }
  while (started < cap) await sleep(1);
  const release = () => {
    for (const r of releases.splice(0)) r();
  };
  held.push(release);
  return release;
}

const LABELS = { provider: "openai", model: "gpt-test" };
const DEADLINE = "deadline exceeded after 240s";

describe("a model call waiting for a permit when its job's deadline fires", () => {
  test("leaves the queue at once with the job's error, and never calls the model", async () => {
    await holdEveryPermit();
    const controller = new AbortController();
    let called = false;
    const call = runModelCall(
      async () => {
        called = true;
        return "ok";
      },
      { primary: LABELS, signal: controller.signal },
    ).then(
      () => "resolved",
      (err: Error) => err.message,
    );
    await sleep(20);
    const abortedAt = performance.now();
    controller.abort(new Error(DEADLINE));
    // Every permit is still held: the wait ended with the abort, not with a release.
    expect(await call).toBe(DEADLINE);
    expect(performance.now() - abortedAt).toBeLessThan(100);
    expect(called).toBe(false);
  });

  test("the permit it would have taken goes to the call queued behind it", async () => {
    const release = await holdEveryPermit();
    const controller = new AbortController();
    const leaving = runModelCall(async () => "left", {
      primary: LABELS,
      signal: controller.signal,
    }).catch(() => "aborted");
    const behind = runModelCall(async () => "behind");
    await sleep(20);
    controller.abort(new Error(DEADLINE));
    expect(await leaving).toBe("aborted");
    release();
    expect(await behind).toBe("behind");
  });

  test("a call that left before the threshold never reports a permit wait", async () => {
    await holdEveryPermit();
    const controller = new AbortController();
    const seen: unknown[] = [];
    const call = runModelCall(async () => "ok", {
      primary: LABELS,
      signal: controller.signal,
      onPermitWait: (info) => seen.push(info),
    }).catch(() => "aborted");
    await sleep(THRESHOLD_MS / 3);
    controller.abort(new Error(DEADLINE));
    expect(await call).toBe("aborted");
    await sleep(THRESHOLD_MS * 1.5);
    expect(seen).toEqual([]);
  });

  test("a call with no signal keeps waiting for its permit", async () => {
    const release = await holdEveryPermit();
    let settled = false;
    const call = runModelCall(async () => "ok", { primary: LABELS }).finally(
      () => {
        settled = true;
      },
    );
    await sleep(THRESHOLD_MS);
    expect(settled).toBe(false);
    release();
    expect(await call).toBe("ok");
  });

  test("a call whose deadline has not fired keeps waiting and calls the model when its turn comes", async () => {
    const release = await holdEveryPermit();
    const controller = new AbortController();
    let called = false;
    const call = runModelCall(
      async () => {
        called = true;
        return "ok";
      },
      { primary: LABELS, signal: controller.signal },
    );
    await sleep(50);
    expect(called).toBe(false);
    release();
    expect(await call).toBe("ok");
    expect(called).toBe(true);
    // An abort after the call is done changes nothing.
    controller.abort(new Error(DEADLINE));
  });
});

// Round 1 calls the writer; round 2 answers. `duringTool` runs while the tool is still running,
// which is where a test takes the permits and fires the deadline.
class CallsThenAnswers {
  rounds = 0;
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    return {
      async invoke() {
        self.rounds++;
        if (self.rounds === 1) {
          return new AIMessage({
            content: "",
            tool_calls: [{ name: "writer", args: { v: "sim" }, id: "c1" }],
          });
        }
        return new AIMessage("pronto");
      },
    };
  }
}

function gatedWriter(gate: Promise<void>, started: () => void) {
  return tool(
    async () => {
      started();
      await gate;
      return "wrote";
    },
    {
      name: "writer",
      description: "writes something to the world",
      schema: z.object({ v: z.string() }),
    },
  ) as unknown as StructuredToolInterface;
}

describe("the turn's model calls wait for a permit under the job's signal", () => {
  test("a deadline that fired during a tool ends the turn at once, with every permit still held", async () => {
    const controller = new AbortController();
    const model = new CallsThenAnswers();
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let toolStarted = false;
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [
        gatedWriter(gate, () => {
          toolStarted = true;
        }),
      ],
      signal: controller.signal,
    });
    const turn = graph
      .invoke(
        { messages: [new HumanMessage("marca como qualificado")] },
        { configurable: { thread_id: "permit-wait-after-tool" } },
      )
      .then(
        () => "resolved",
        (err: Error) => err.message,
      );
    while (!toolStarted) await sleep(1);
    await holdEveryPermit();
    controller.abort(new Error(DEADLINE));
    const toolDoneAt = performance.now();
    openGate();
    expect(await turn).toBe(DEADLINE);
    expect(performance.now() - toolDoneAt).toBeLessThan(500);
    expect(model.rounds).toBe(1);
  });

  test("the same holds for the fallback once it has the turn", async () => {
    const primary = {
      rounds: 0,
      async invoke() {
        primary.rounds++;
        throw Object.assign(new Error("service unavailable"), { status: 503 });
      },
      bindTools() {
        return primary;
      },
    };
    const fallback = new CallsThenAnswers();
    const controller = new AbortController();
    let openGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let toolStarted = false;
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: primary as unknown as BaseChatModel,
      fallback: {
        model: fallback as unknown as BaseChatModel,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [
        gatedWriter(gate, () => {
          toolStarted = true;
        }),
      ],
      signal: controller.signal,
    });
    const turn = graph
      .invoke(
        { messages: [new HumanMessage("marca como qualificado")] },
        { configurable: { thread_id: "permit-wait-fallback" } },
      )
      .then(
        () => "resolved",
        (err: Error) => err.message,
      );
    while (!toolStarted) await sleep(1);
    await holdEveryPermit();
    controller.abort(new Error(DEADLINE));
    const toolDoneAt = performance.now();
    openGate();
    expect(await turn).toBe(DEADLINE);
    expect(performance.now() - toolDoneAt).toBeLessThan(500);
    expect(fallback.rounds).toBe(1);
    expect(primary.rounds).toBe(1);
  });
});
