import { describe, expect, test } from "bun:test";
import config from "@/config";
import { runModelCall } from "@/graph/model-limit";
import { EmptyThenReplyModel } from "../utils/scripted-models";

// Exercises the real path (global singleton + config), not just the Semaphore class: proves the
// process-wide cap on concurrent model calls is config.agent.modelConcurrency.

describe("runModelCall", () => {
  test("caps concurrency at config.agent.modelConcurrency", async () => {
    const cap = config.agent.modelConcurrency;
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: cap + 5 }, () =>
        runModelCall(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 15));
          active -= 1;
        }),
      ),
    );
    expect(maxActive).toBe(cap);
    expect(active).toBe(0);
  });

  test("returns the wrapped call's value", async () => {
    expect(await runModelCall(() => Promise.resolve(42))).toBe(42);
  });
});

function failing(error: unknown) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: () => {
      calls += 1;
      return Promise.reject(error);
    },
  };
}

// A provider can answer 200 with no completion at all. LangChain's own retry never sees it (the HTTP
// call succeeded) and the failure only surfaces afterwards, inside BaseChatModel.invoke, reading
// `generations[0][0].message`. On a real inbox that ended the turn and the customer got no reply at
// all (issue #63).
describe("runModelCall recovery from an empty completion", () => {
  test("an intermittent empty completion is retried and the answer comes through", async () => {
    const model = new EmptyThenReplyModel("hi", 1);
    const retries: number[] = [];
    const reply = await runModelCall(
      () => model.invoke([{ role: "user", content: "oi" }]),
      ({ attempt }) => retries.push(attempt),
    );
    expect(reply.content).toBe("hi");
    expect(model.calls).toBe(2);
    expect(retries).toEqual([1]);
  });

  test("a provider 4xx is NOT retried", async () => {
    const rejected = failing(
      Object.assign(new Error("bad request"), { status: 400 }),
    );
    await expect(runModelCall(rejected.fn)).rejects.toThrow("bad request");
    expect(rejected.calls).toBe(1);
  });

  test("a timeout is NOT retried", async () => {
    const rejected = failing(
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
    );
    await expect(runModelCall(rejected.fn)).rejects.toThrow("timed out");
    expect(rejected.calls).toBe(1);
  });

  test("a persistent empty completion fails with a readable reason", async () => {
    const model = new EmptyThenReplyModel("hi", 2);
    // The operator reads this string on the conversation and in the flow log, so it must name what
    // happened instead of leaking `generations[0][0].message`.
    const err = (await runModelCall(() =>
      model.invoke([{ role: "user", content: "oi" }]),
    ).catch((e) => e)) as Error;
    expect(err.message).toContain("no completion");
    expect(err.message).not.toContain("generations[0][0]");
    expect((err.cause as Error).message).toContain("generations[0][0]");
    expect(model.calls).toBe(2);
  });

  // A TypeError from anywhere else inside `invoke` — a tracing callback, an adapter bug — fires
  // AFTER the provider answered and was billed. Retrying it would buy the same completion twice on
  // every turn until that code is fixed, so the fault has to be recognised, not the error class.
  test("a TypeError that is not an empty completion is neither retried nor renamed", async () => {
    const rejected = failing(new TypeError("undefined is not a function"));
    await expect(runModelCall(rejected.fn)).rejects.toThrow(
      "undefined is not a function",
    );
    expect(rejected.calls).toBe(1);
  });
});
