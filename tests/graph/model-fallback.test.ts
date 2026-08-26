import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";
import {
  isFallbackWorthy,
  PRIMARY_MAX_RETRIES,
  PRIMARY_TIMEOUT_MS,
} from "@/graph/model-fallback";
import { runModelCall } from "@/graph/model-limit";
import {
  EmptyThenReplyModel,
  FailingModel,
  ToolRecordingModel,
} from "../utils/scripted-models";

// WHICH failures are worth asking a DIFFERENT provider, as a table.
//
// The rows are the shapes measured against the real SDK stack (issue #143): a local
// openai-compatible endpoint answering each status, plus a hang and a refused connection, driven
// through `createChatModel` + `runModelCall`. The `status` column is what `statusOf` read off the
// error the SDK raised, so every row here is a shape production can actually produce.
const TABLE: Array<{
  name: string;
  err: unknown;
  worthy: boolean;
  why: string;
}> = [
  // ── the endpoint's own momentary state: another provider is not having it ──
  {
    name: "408 request timeout",
    err: Object.assign(new Error("x"), { status: 408 }),
    worthy: true,
    why: "the hop's own timeout",
  },
  {
    name: "429 rate limited",
    err: Object.assign(new Error("x"), { status: 429 }),
    worthy: true,
    why: "the rate is per account, and the fallback's account is another one",
  },
  {
    name: "500 internal",
    err: Object.assign(new Error("x"), { status: 500 }),
    worthy: true,
    why: "the vendor broke on a request another vendor may take",
  },
  {
    name: "502 bad gateway",
    err: Object.assign(new Error("x"), { status: 502 }),
    worthy: true,
    why: "the vendor's own edge",
  },
  {
    name: "503 service unavailable",
    err: Object.assign(new Error("x"), { status: 503 }),
    worthy: true,
    why: "the literal case in the issue title",
  },
  {
    name: "504 gateway timeout",
    err: Object.assign(new Error("x"), { status: 504 }),
    worthy: true,
    why: "the hop gave up waiting",
  },
  // Cloudflare's own 5xx, and they are not exotic: `openai-compatible` accepts an arbitrary server
  // and a great many sit behind that proxy, where an origin that is down never gets to answer 503
  // itself. Read off Cloudflare's documentation rather than assumed.
  {
    name: "520 origin returned an unknown error",
    err: Object.assign(new Error("x"), { status: 520 }),
    worthy: true,
    why: "the origin failed, and Cloudflare is reporting it on its behalf",
  },
  {
    name: "521 origin is down",
    err: Object.assign(new Error("x"), { status: 521 }),
    worthy: true,
    why: "the literal 'unavailable' of the issue title, one hop out",
  },
  {
    name: "522 connection timed out",
    err: Object.assign(new Error("x"), { status: 522 }),
    worthy: true,
    why: "the proxy could not reach the origin",
  },
  {
    name: "523 origin is unreachable",
    err: Object.assign(new Error("x"), { status: 523 }),
    worthy: true,
    why: "same, named differently",
  },
  {
    name: "524 a timeout occurred",
    err: Object.assign(new Error("x"), { status: 524 }),
    worthy: true,
    why: "the origin accepted and did not finish",
  },
  {
    name: "529 overloaded",
    err: Object.assign(new Error("x"), { status: 529 }),
    worthy: true,
    why: "Anthropic's spelling of 503",
  },
  {
    name: "our own AbortSignal fired",
    err: Object.assign(new Error("x"), { name: "TimeoutError" }),
    worthy: true,
    why: "we stopped waiting on THIS endpoint; another one has its own latency",
  },
  {
    name: "the SDK's timeout class",
    err: Object.assign(
      new (class APIConnectionTimeoutError extends Error {})("x"),
    ),
    worthy: true,
    why: "both vendor SDKs raise a class and leave name at Error (measured, #319)",
  },

  // ── about what WE sent, or about THIS credential: another provider answers the same, or worse,
  //    answers fine forever and hides a primary that is permanently broken ──
  {
    name: "400 bad request",
    err: Object.assign(new Error("x"), { status: 400 }),
    worthy: false,
    why: "the next vendor rejects the same payload",
  },
  {
    name: "401 unauthorized",
    err: Object.assign(new Error("x"), { status: 401 }),
    worthy: false,
    why: "the fallback WOULD answer, forever, and the operator never learns the primary key is dead",
  },
  {
    name: "403 forbidden",
    err: Object.assign(new Error("x"), { status: 403 }),
    worthy: false,
    why: "same masking, one permission away",
  },
  {
    name: "404 model not found",
    err: Object.assign(new Error("x"), { status: 404 }),
    worthy: false,
    why: "a typo'd model id would silently run every turn on the fallback",
  },
  {
    name: "413 payload too large",
    err: Object.assign(new Error("x"), { status: 413 }),
    worthy: false,
    why: "the payload is ours and does not shrink on the way to another vendor",
  },
  {
    name: "422 unprocessable",
    err: Object.assign(new Error("x"), { status: 422 }),
    worthy: false,
    why: "about what we sent",
  },
  {
    name: "a connection that never opened",
    err: Object.assign(new Error("fetch failed"), {
      name: "APIConnectionError",
    }),
    worthy: false,
    why: "far more often a wrong address than a down vendor, and a wrong address is PERMANENT; a vendor that is actually down answers 503",
  },
  {
    name: "525 SSL handshake failed",
    err: Object.assign(new Error("x"), { status: 525 }),
    worthy: false,
    why: "configuration, not weather: it answers identically every time, and a fallback would cover a broken endpoint forever",
  },
  {
    name: "526 invalid SSL certificate",
    err: Object.assign(new Error("x"), { status: 526 }),
    worthy: false,
    why: "the same line that keeps 401 out, on the transport instead of the credential",
  },
  {
    name: "not an Error at all",
    err: "just a string",
    worthy: false,
    why: "nothing to read a status off",
  },
];

describe("isFallbackWorthy", () => {
  for (const row of TABLE) {
    test(`${row.name} → ${row.worthy ? "falls over" : "stays"} (${row.why})`, () => {
      expect(isFallbackWorthy(row.err)).toBe(row.worthy);
    });
  }

  // The bound the whole design rests on. Measured against the real stack: with LangChain's default
  // AsyncCaller a 503 takes SEVEN requests and 77s to surface, a 502 99s. A fallback behind that
  // arrives after the customer is gone, so the primary gets exactly one attempt when there is
  // something behind it.
  test("the primary gets one attempt, not LangChain's six retries", () => {
    expect(PRIMARY_MAX_RETRIES).toBe(0);
  });

  test("the primary's attempt is bounded, because a hang has no status to read", () => {
    expect(PRIMARY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PRIMARY_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
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

describe("runModelCall with something behind the primary", () => {
  test("a 503 primary hands the turn to the fallback, and the answer comes through", async () => {
    const primary = failing(
      Object.assign(new Error("overloaded"), { status: 503 }),
    );
    const fallback = { calls: 0 };
    const seen: unknown[] = [];
    const reply = await runModelCall<string>(primary.fn, undefined, {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      run: () => {
        fallback.calls += 1;
        return Promise.resolve("from the fallback");
      },
      onFallback: ({ reason }) => seen.push(reason),
    });
    expect(reply).toBe("from the fallback");
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
    // Already the redacted word: this reason reaches the flow log and the alert channel.
    expect(seen).toEqual(["HTTP 503"]);
  });

  test("a 401 primary does NOT hand over: the operator has to learn the key is dead", async () => {
    const primary = failing(
      Object.assign(new Error("bad key"), { status: 401 }),
    );
    let fallbackCalls = 0;
    const err = (await runModelCall<string>(primary.fn, undefined, {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      run: () => {
        fallbackCalls += 1;
        return Promise.resolve("from the fallback");
      },
    }).catch((e) => e)) as Error;
    expect(fallbackCalls).toBe(0);
    expect(err.message).toBe("HTTP 401");
  });

  test("with no fallback configured, a 503 fails exactly as it does today", async () => {
    const primary = failing(
      Object.assign(new Error("overloaded"), { status: 503 }),
    );
    const err = (await runModelCall(primary.fn).catch((e) => e)) as Error;
    expect(err.message).toBe("HTTP 503");
    expect(primary.calls).toBe(1);
  });

  // The fault the same-model retry already owns. It is a PROVIDER fault (200 with no completion),
  // so once the second attempt on the same model has also failed, another provider is exactly what
  // is left — and this is the one path where the fallback runs after a retry, not instead of one.
  test("an empty completion that survives its own retry falls over", async () => {
    const model = new EmptyThenReplyModel("never reached", 99);
    let fallbackCalls = 0;
    const reply = await runModelCall(
      () => model.invoke([{ role: "user", content: "oi" }]),
      undefined,
      {
        // The SAME return type as the primary, which is the type system holding the design: the
        // fallback answers the customer, so whatever it returns has to be a reply the turn can post.
        provider: "anthropic",
        model: "claude-haiku-4-5",
        run: () => {
          fallbackCalls += 1;
          return Promise.resolve(new AIMessage("from the fallback"));
        },
      },
    );
    expect(model.calls).toBe(2);
    expect(fallbackCalls).toBe(1);
    expect(reply.content).toBe("from the fallback");
  });

  // The fallback answers the customer in the primary's place, so it inherits the primary's one
  // recovery too. Review found this: the fallback was invoked BARE, so a 200 carrying no completion
  // — measured at 1 in 184 on one install (issue #63) — cost the turn on the very call that exists
  // because the turn was already about to be lost.
  test("an empty completion FROM THE FALLBACK is retried too", async () => {
    const primary = failing(
      Object.assign(new Error("overloaded"), { status: 503 }),
    );
    const fallbackModel = new EmptyThenReplyModel("from the fallback", 1);
    const retries: Array<{ provider?: string; model?: string }> = [];
    const reply = await runModelCall(
      primary.fn,
      ({ provider, model }) => retries.push({ provider, model }),
      {
        provider: "anthropic",
        model: "claude-haiku-4-5",
        run: () => fallbackModel.invoke([{ role: "user", content: "oi" }]),
      },
    );
    expect(fallbackModel.calls).toBe(2);
    expect(reply.content).toBe("from the fallback");
    // And the trail names the model that actually made the retry, or an operator reads the rate
    // against a provider that never saw the call.
    expect(retries).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ]);
  });

  // The primary's own retry keeps naming nothing, which is what every existing caller reads as
  // "the configured model". Asserted so the field's absence stays a decision.
  test("a retry on the PRIMARY names no model, as it always did", async () => {
    const model = new EmptyThenReplyModel("hi", 1);
    const retries: Array<{ provider?: string; model?: string }> = [];
    await runModelCall(
      () => model.invoke([{ role: "user", content: "oi" }]),
      ({ provider, model: m }) => retries.push({ provider, model: m }),
    );
    expect(retries).toEqual([{ provider: undefined, model: undefined }]);
  });

  // The fallback is the last thing there is. What it throws is what the turn reports, and it must
  // still leave through the closed vocabulary rather than carrying the second vendor's prose.
  test("when the fallback fails too, the turn reports the FALLBACK's failure, redacted", async () => {
    const primary = failing(
      Object.assign(new Error("overloaded"), { status: 503 }),
    );
    const err = (await runModelCall<string>(primary.fn, undefined, {
      provider: "anthropic",
      model: "claude-haiku-4-5",
      run: () =>
        Promise.reject(
          Object.assign(new Error("the second vendor's own prose"), {
            status: 500,
          }),
        ),
    }).catch((e) => e)) as Error;
    expect(err.message).toBe("HTTP 500");
    expect(err.message).not.toContain("prose");
  });
});

// The fallback answers the customer in the primary's place, so it has to be able to do what the
// primary could. A fallback invoked BARE looks identical from the outside — a reply arrives, the
// turn posts — and the agent has silently lost every tool for that turn: no calendar, no handoff,
// no document. Mutation found this one: unbinding the fallback's tools left every other test green.
describe("the fallback is asked the same question the primary was", () => {
  test("it is bound to the same toolset", async () => {
    const tool = new DynamicStructuredTool({
      name: "check_slots",
      description: "check availability",
      schema: z.object({}),
      func: async () => "free",
    });
    const primary = new FailingModel(
      Object.assign(new Error("overloaded"), { status: 503 }),
    );
    const fallback = new ToolRecordingModel("ok");
    const graph = buildAgentGraph({
      model: primary,
      systemPrompt: "s",
      tools: [tool],
      fallback: {
        model: fallback,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
    });
    await graph.invoke({ messages: [new HumanMessage("oi")] });
    expect(primary.calls).toBeGreaterThan(0);
    expect(fallback.boundToolNames).toEqual(["check_slots"]);
  });
});
