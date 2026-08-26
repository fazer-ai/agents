import { describe, expect, test } from "bun:test";
import { MODEL_PROVIDERS } from "@/graph/model-config";
import { createChatModel } from "@/graph/models";

// THE BOUNDS AS THE ADAPTER ACTUALLY APPLIES THEM, asked of the built instance over a real socket
// rather than of the object handed to the factory.
//
// The two are different questions and only one of them is the feature. `model-fallback-build` proves
// `buildModelAndGraph` COMPUTES the bounds; nothing there notices if `createChatModel` drops them on
// the floor, and mutation showed exactly that — deleting the spread in `models.ts` left every other
// test green. What would ship is a fallback that only gets its turn after LangChain has spent
// 77-99s on the provider that already said it was overloaded (measured, issue #143), which is the
// state this whole change exists to leave.
//
// Counted in REQUESTS, because that is the only thing the retry budget is observable as.

async function requestsUntilFailure(
  maxRetries: number | undefined,
): Promise<number> {
  let hits = 0;
  const srv = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: () => {
      hits++;
      return new Response(
        JSON.stringify({
          error: { message: "overloaded", type: "server_error" },
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      );
    },
  });
  const model = createChatModel({
    provider: "openai-compatible",
    model: "probe",
    apiKey: "sk-probe",
    baseURL: `http://127.0.0.1:${srv.port}/v1`,
    temperature: 0,
    ...(maxRetries === undefined ? {} : { maxRetries }),
  });
  try {
    await model.invoke([{ role: "user", content: "oi" }] as never);
  } catch {
    // The failure is the point; what is read is how many times it asked.
  }
  srv.stop(true);
  return hits;
}

describe("the retry budget reaches the transport", () => {
  test("maxRetries 0 spends exactly one request on a 503", async () => {
    expect(await requestsUntilFailure(0)).toBe(1);
  });

  // The second arm, and it is what makes the first one mean something: a field the adapter ignored
  // would answer 1 to both, and the test above alone would pass with the bound deleted.
  test("maxRetries 1 spends exactly two", async () => {
    expect(await requestsUntilFailure(1)).toBe(2);
  });
});

// THE CEILING'S BEHAVIOUR IS MEASURED, AND NOT FROM HERE. A hung endpoint against a model built by
// this factory is abandoned in 2.003ms with `timeoutMs: 2_000`, raising a `TimeoutError`; the same
// call under this suite's `tests/dom-setup.ts` preload runs the server's full 30.017ms sleep and
// never aborts, because happy-dom replaces `fetch` and the SDK's abort never fires. So the arm that
// proves the ceiling STOPS a call lives outside the harness, and what is asserted below is the
// thing this suite can honestly answer: that the value reaches the adapter at all, in the spelling
// that adapter reads. Deleting the spread in `models.ts` is what those catch.

// WHERE each adapter parks the two bounds, asked of the built instances. The spellings are not
// uniform and the option TYPES do not tell them apart: Anthropic accepts a plain `timeout` at the
// type level and the built client leaves it undefined, which is how the first version of this
// shipped wrong. Google takes no ceiling in either spelling.
describe("which adapters carry the two bounds", () => {
  for (const provider of MODEL_PROVIDERS) {
    test(`${provider} carries the retry budget`, () => {
      const m = createChatModel({
        provider,
        model: "m",
        apiKey: "sk",
        baseURL: "https://probe.example.com/v1",
        temperature: 0,
        maxRetries: 3,
      }) as unknown as { caller?: { maxRetries?: number } };
      // On the AsyncCaller, which is the object that actually spends the budget; none of the six
      // adapters exposes it as a own field of its own.
      expect(m.caller?.maxRetries).toBe(3);
    });
  }

  const CEILING_FIELD: Record<string, "timeout" | "clientOptions" | "none"> = {
    openai: "timeout",
    "openai-compatible": "timeout",
    openrouter: "timeout",
    deepseek: "timeout",
    anthropic: "clientOptions",
    google: "none",
  };

  for (const provider of MODEL_PROVIDERS) {
    const where = CEILING_FIELD[provider];
    test(`${provider} carries the attempt ceiling on ${where}`, () => {
      const m = createChatModel({
        provider,
        model: "m",
        apiKey: "sk",
        baseURL: "https://probe.example.com/v1",
        temperature: 0,
        timeoutMs: 1234,
      }) as unknown as {
        timeout?: number;
        clientOptions?: { timeout?: number };
      };
      expect(m.timeout).toBe(where === "timeout" ? 1234 : undefined);
      expect(m.clientOptions?.timeout).toBe(
        where === "clientOptions" ? 1234 : undefined,
      );
    });
  }

  // Named as its own case rather than left implicit in the table: it is a real gap, not a detail.
  // A hung Gemini endpoint carries no status, so the retry budget cannot act on it and there is no
  // ceiling to abandon it — the turn waits, and the fallback never gets it.
  test("a hung Google endpoint has no bound at all, which is the one gap left open", () => {
    const m = createChatModel({
      provider: "google",
      model: "gemini-x",
      apiKey: "sk",
      temperature: 0,
      maxRetries: 0,
      timeoutMs: 1_000,
    }) as unknown as {
      timeout?: number;
      clientOptions?: { timeout?: number };
      caller?: { maxRetries?: number };
    };
    expect(m.caller?.maxRetries).toBe(0);
    expect(m.timeout).toBeUndefined();
    expect(m.clientOptions?.timeout).toBeUndefined();
  });
});
