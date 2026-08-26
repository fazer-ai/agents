import { describe, expect, test } from "bun:test";
import logger from "@/api/lib/logger";
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
      {
        primary: { provider: "openai", model: "gpt-test" },
        onRetry: ({ attempt }) => retries.push(attempt),
      },
    );
    expect(reply.content).toBe("hi");
    expect(model.calls).toBe(2);
    expect(retries).toEqual([1]);
  });

  // Two claims per case now, and the second is why this boundary exists: the call is not retried,
  // AND what escapes it is a word of ours. The request carried the whole conversation, so the
  // provider's own sentence may be the customer's coming back — see @/lib/provider-failure.
  test("a provider 4xx is NOT retried, and reports its status without its prose", async () => {
    const original = Object.assign(new Error("bad request"), { status: 400 });
    const rejected = failing(original);
    const err = (await runModelCall(rejected.fn).catch((e) => e)) as Error;
    expect(err.message).toBe("HTTP 400");
    expect(err.message).not.toContain("bad request");
    expect(err.cause).toBe(original);
    expect(rejected.calls).toBe(1);
  });

  test("a timeout is NOT retried, and is named as one", async () => {
    const original = Object.assign(new Error("timed out"), {
      name: "TimeoutError",
    });
    const rejected = failing(original);
    const err = (await runModelCall(rejected.fn).catch((e) => e)) as Error;
    expect(err.message).toBe("timeout");
    expect(err.cause).toBe(original);
    expect(rejected.calls).toBe(1);
  });

  test("a persistent empty completion fails with a readable reason", async () => {
    const model = new EmptyThenReplyModel("hi", 2);
    // The operator reads this string on the conversation and in the flow log, so it must name what
    // happened instead of leaking `generations[0][0].message`.
    const warned: Array<{ err?: Error }> = [];
    const realWarn = logger.warn;
    (logger as { warn: unknown }).warn = (...args: unknown[]) => {
      warned.push(args[0] as { err?: Error });
    };
    const err = (await runModelCall(() =>
      model.invoke([{ role: "user", content: "oi" }]),
    )
      .catch((e) => e)
      .finally(() => {
        (logger as { warn: unknown }).warn = realWarn;
      })) as Error;
    expect(err.message).toContain("no completion");
    expect(err.message).not.toContain("generations[0][0]");
    expect((err.cause as Error).message).toContain("generations[0][0]");
    expect(model.calls).toBe(2);
    // Same rule as every other replacement this boundary makes: `cause` is not where a reader looks,
    // so the failing expression has to reach the process log on its own. Asserted here because the
    // one replacement written by hand is exactly the one that can be forgotten (mutation found it).
    expect(
      warned.map((w) => String(w?.err?.message ?? "")).join(" "),
    ).toContain("generations[0][0]");
  });

  // A TypeError from anywhere else inside `invoke` — a tracing callback, an adapter bug — fires
  // AFTER the provider answered and was billed. Retrying it would buy the same completion twice on
  // every turn until that code is fixed, so the fault has to be recognised, not the error class.
  // The claim the substitution rests on: the vendor's words are RELOCATED, not deleted. `cause` alone
  // does not carry that claim — it is only true for a reader that serializes the chain, and the two
  // paths that catch this error read `.message` off it (the direct webhook logs printf-style, the
  // playground extracts a detail out of the text). So the boundary logs the original itself, and the
  // assertion is on the process log rather than on the wrapper's `cause`.
  test("the original reaches the process log, where no PII promise applies", async () => {
    const marker = "carambola-com-manjericao-8812";
    const seen: unknown[] = [];
    const realWarn = logger.warn;
    (logger as { warn: unknown }).warn = (...args: unknown[]) => {
      seen.push(args[0]);
    };
    try {
      const rejected = failing(
        Object.assign(new Error(`400 Invalid prompt: "${marker}"`), {
          status: 400,
        }),
      );
      const err = (await runModelCall(rejected.fn).catch((e) => e)) as Error;
      expect(err.message).toBe("HTTP 400");
    } finally {
      (logger as { warn: unknown }).warn = realWarn;
    }
    const logged = seen
      .map((o) => String((o as { err?: Error })?.err?.message ?? ""))
      .join(" ");
    expect(logged).toContain(marker);
  });

  // It is renamed now, like everything else crossing this boundary — but NOT into the empty-completion
  // sentence, which is the confusion this test exists to prevent. The two are told apart by the fault,
  // not by the error class, and the original survives as `cause` either way.
  test("a TypeError that is not an empty completion is not retried, and is not called one", async () => {
    const original = new TypeError("undefined is not a function");
    const rejected = failing(original);
    const err = (await runModelCall(rejected.fn).catch((e) => e)) as Error;
    expect(err.message).toBe("provider error");
    expect(err.message).not.toContain("no completion");
    expect(err.cause).toBe(original);
    expect(rejected.calls).toBe(1);
  });
});
