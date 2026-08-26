import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  hasModelFallback,
  readModelFallbackConfig,
} from "@/graph/fallback-settings";
import { buildAgentGraph, lastAssistantText } from "@/graph/graph";
import {
  modelOptionalFor,
  PROVIDER_DEFAULT_MODEL,
} from "@/graph/model-defaults";
import {
  isFallbackWorthy,
  PRIMARY_MAX_RETRIES,
  PRIMARY_TIMEOUT_MS,
} from "@/graph/model-fallback";
import { runModelCall } from "@/graph/model-limit";
import {
  assertSettingsModelFallback,
  type SettingsWriteMode,
} from "@/modules/agents/service";
import {
  EmptyThenReplyModel,
  FailingModel,
  SlowFailingModel,
  ToolLoopModel,
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

const PRIMARY = { provider: "openai", model: "primary-mini" };
const FALLBACK_LABELS = { provider: "anthropic", model: "claude-haiku-4-5" };

describe("runModelCall with something behind the primary", () => {
  test("a 503 primary hands the turn to the fallback, and the answer comes through", async () => {
    const primary = failing(
      Object.assign(new Error("overloaded"), { status: 503 }),
    );
    let fallbackCalls = 0;
    const seen: string[] = [];
    const reply = await runModelCall<string>(primary.fn, {
      primary: PRIMARY,
      fallback: {
        labels: FALLBACK_LABELS,
        run: () => {
          fallbackCalls += 1;
          return Promise.resolve("from the fallback");
        },
        onFallback: ({ reason }) => seen.push(reason),
      },
    });
    expect(reply).toBe("from the fallback");
    expect(primary.calls).toBe(1);
    expect(fallbackCalls).toBe(1);
    // Already the redacted word: this reason reaches the flow log and the alert channel.
    expect(seen).toEqual(["HTTP 503"]);
  });

  test("a 401 primary does NOT hand over: the operator has to learn the key is dead", async () => {
    const primary = failing(
      Object.assign(new Error("bad key"), { status: 401 }),
    );
    let fallbackCalls = 0;
    const err = (await runModelCall<string>(primary.fn, {
      primary: PRIMARY,
      fallback: {
        labels: FALLBACK_LABELS,
        run: () => {
          fallbackCalls += 1;
          return Promise.resolve("from the fallback");
        },
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
      {
        primary: PRIMARY,
        fallback: {
          labels: FALLBACK_LABELS,
          // The SAME return type as the primary, which is the type system holding the design: the
          // fallback answers the customer, so whatever it returns has to be a reply the turn can post.
          run: () => {
            fallbackCalls += 1;
            return Promise.resolve(new AIMessage("from the fallback"));
          },
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
    const retries: Array<{ provider: string; model: string }> = [];
    const reply = await runModelCall(primary.fn, {
      primary: PRIMARY,
      onRetry: ({ provider, model }) => retries.push({ provider, model }),
      fallback: {
        labels: FALLBACK_LABELS,
        run: () => fallbackModel.invoke([{ role: "user", content: "oi" }]),
      },
    });
    expect(fallbackModel.calls).toBe(2);
    expect(reply.content).toBe("from the fallback");
    // And the trail names the model that actually made the retry, or an operator reads the rate
    // against a provider that never saw the call.
    expect(retries).toEqual([FALLBACK_LABELS]);
  });

  // The primary's retry names the primary, and it is not optional: the labels ride on every event,
  // so no emitter has a default to get wrong.
  test("a retry on the PRIMARY names the primary", async () => {
    const model = new EmptyThenReplyModel("hi", 1);
    const retries: Array<{ provider: string; model: string }> = [];
    await runModelCall(() => model.invoke([{ role: "user", content: "oi" }]), {
      primary: PRIMARY,
      onRetry: ({ provider, model: m }) => retries.push({ provider, model: m }),
    });
    expect(retries).toEqual([PRIMARY]);
  });

  // The turn's real ending, and its own line. The `generate` stage wrapping the call is labelled
  // with the primary by construction, so without this an operator reads "the fallback took the turn
  // (ok)" followed by an error attributed to the model that never made the second call.
  test("when the fallback fails too, that failure is reported under the FALLBACK", async () => {
    const primary = failing(
      Object.assign(new Error("overloaded"), { status: 503 }),
    );
    const took: string[] = [];
    const died: string[] = [];
    const err = (await runModelCall<string>(primary.fn, {
      primary: PRIMARY,
      fallback: {
        labels: FALLBACK_LABELS,
        run: () =>
          Promise.reject(
            Object.assign(new Error("the second vendor's own prose"), {
              status: 500,
            }),
          ),
        onFallback: ({ reason }) => took.push(reason),
        onFallbackFailed: ({ reason }) => died.push(reason),
      },
    }).catch((e) => e)) as Error;
    expect(took).toEqual(["HTTP 503"]);
    expect(died).toEqual(["HTTP 500"]);
    // What the turn reports is still the fallback's failure, redacted the same way.
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
      primary: PRIMARY,
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

// ONCE THE FALLBACK HAS THE TURN, IT KEEPS IT.
//
// A tool call routes back through the agent node, so a turn with tools runs that node once per
// round. Without this, each round asks the dead primary again before failing over again, and the
// cost is the failure's own latency multiplied by the rounds — which is the budget this whole change
// exists to remove, reappearing inside a single turn.
//
// Measured on the three-round turn below (two tool calls, then the answer), with the primary failing
// in 200ms: 3 primary calls, 3 "the fallback took the turn" warns for ONE failover, 609.3ms. After:
// 1, 1, 204.8ms. At the 45s ceiling instead of 200ms those 3 calls are 135s of dead waiting.
describe("the fallback keeps the turn once it has it", () => {
  const peek = () =>
    new DynamicStructuredTool({
      name: "peek",
      description: "look something up",
      schema: z.object({}),
      func: async () => "ok",
    });

  test("a dead primary is asked ONCE, however many tool rounds the turn takes", async () => {
    const primary = new SlowFailingModel(
      Object.assign(new Error("overloaded"), { status: 503 }),
      0,
    );
    const fallback = new ToolLoopModel("peek", 2);
    const took: string[] = [];
    const graph = buildAgentGraph({
      model: primary,
      systemPrompt: "s",
      tools: [peek()],
      primary: PRIMARY,
      fallback: {
        model: fallback,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
      onModelFallback: ({ reason }) => took.push(reason),
    });
    const out = await graph.invoke({ messages: [new HumanMessage("oi")] });

    // The node ran three times: two tool rounds and the answer.
    expect(fallback.calls).toBe(3);
    // ...and the primary was asked on the first of them only.
    expect(primary.calls).toBe(1);
    // One failover, so one line on the trail. Three would read as three separate outages.
    expect(took).toEqual(["HTTP 503"]);
    expect(lastAssistantText(out.messages)).toBe("pronto");
  });

  // The cost, not just the count, because the count alone cannot say whether it mattered. The
  // primary is given a measurable failure here for the same reason production's worst case is a
  // hang: an instant failure makes every version of this code look identical.
  test("and the turn does not pay that failure once per round", async () => {
    const primary = new SlowFailingModel(
      Object.assign(new Error("overloaded"), { status: 503 }),
      120,
    );
    const fallback = new ToolLoopModel("peek", 2);
    const graph = buildAgentGraph({
      model: primary,
      systemPrompt: "s",
      tools: [peek()],
      primary: PRIMARY,
      fallback: {
        model: fallback,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
    });
    const started = performance.now();
    await graph.invoke({ messages: [new HumanMessage("oi")] });
    const elapsed = performance.now() - started;
    // One 120ms failure, not three. The bound is deliberately loose (a third round would put this
    // past 360ms); what it asserts is that the failure is paid ONCE.
    expect(elapsed).toBeLessThan(240);
    expect(primary.calls).toBe(1);
  });

  // The demotion is not free: it costs the primary the rest of the turn. So it may only happen when
  // the primary actually failed, and a healthy one has to keep every round.
  test("a healthy primary keeps all of them", async () => {
    const primary = new ToolLoopModel("peek", 2);
    const fallback = new ToolLoopModel("peek", 2, "nunca");
    const took: string[] = [];
    const graph = buildAgentGraph({
      model: primary,
      systemPrompt: "s",
      tools: [peek()],
      primary: PRIMARY,
      fallback: {
        model: fallback,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
      onModelFallback: ({ reason }) => took.push(reason),
    });
    const out = await graph.invoke({ messages: [new HumanMessage("oi")] });
    expect(primary.calls).toBe(3);
    expect(fallback.calls).toBe(0);
    expect(took).toEqual([]);
    expect(lastAssistantText(out.messages)).toBe("pronto");
  });

  // And the demotion dies with the turn. The graph is built inside the turn and invoked once, which
  // is what makes a closure the right scope; a NEW graph over the same models starts at the primary
  // again, the way the next turn on that conversation will.
  test("the next turn starts at the primary again", async () => {
    const err = Object.assign(new Error("overloaded"), { status: 503 });
    const build = (primary: SlowFailingModel, fallback: ToolLoopModel) =>
      buildAgentGraph({
        model: primary,
        systemPrompt: "s",
        tools: [peek()],
        primary: PRIMARY,
        fallback: {
          model: fallback,
          provider: "anthropic",
          modelId: "claude-haiku-4-5",
        },
      });
    const first = new SlowFailingModel(err, 0);
    await build(first, new ToolLoopModel("peek", 1)).invoke({
      messages: [new HumanMessage("oi")],
    });
    expect(first.calls).toBe(1);
    const second = new SlowFailingModel(err, 0);
    await build(second, new ToolLoopModel("peek", 1)).invoke({
      messages: [new HumanMessage("de novo")],
    });
    expect(second.calls).toBe(1);
  });

  // The last resort has no resort of its own: once it owns the turn, its failure is the turn's, and
  // it is reported as ITS failure rather than as a second failover nobody caused.
  test("when the fallback itself dies on a later round, it is named as the one that died", async () => {
    const primary = new SlowFailingModel(
      Object.assign(new Error("overloaded"), { status: 503 }),
      0,
    );
    // Answers the first round with a tool call, then dies on the round after it.
    let round = 0;
    const fallback = new ToolLoopModel("peek", 1);
    const original = fallback._generate.bind(fallback);
    fallback._generate = async () => {
      round += 1;
      if (round === 2) {
        throw Object.assign(new Error("gone"), { status: 500 });
      }
      return original();
    };
    const took: string[] = [];
    const died: string[] = [];
    const graph = buildAgentGraph({
      model: primary,
      systemPrompt: "s",
      tools: [peek()],
      primary: PRIMARY,
      fallback: {
        model: fallback,
        provider: "anthropic",
        modelId: "claude-haiku-4-5",
      },
      onModelFallback: ({ reason }) => took.push(reason),
      onModelFallbackFailed: ({ provider, reason }) =>
        died.push(`${provider}:${reason}`),
    });
    const err = (await graph
      .invoke({ messages: [new HumanMessage("oi")] })
      .catch((e) => e)) as Error;
    expect(took).toEqual(["HTTP 503"]);
    expect(died).toEqual(["anthropic:HTTP 500"]);
    expect(err.message).toBe("HTTP 500");
    // The primary was NOT asked again on that round, which is the point of the demotion.
    expect(primary.calls).toBe(1);
  });
});

// THE WRITE BOUNDARY: A FALLBACK IS A PROVIDER AND A MODEL, OR IT IS NOTHING.
//
// The runtime half of this was already written and tested when review asked what happens to a bag
// that names only one of the two. Measured on the stored bag: it persists as
// `{provider: "openai", model: null}`, `hasModelFallback` answers false, and `modelFallbackToForm`
// maps it back to "No fallback" — so the operator's provider is gone on the next load with nothing
// on screen to say why, and the same bag reaches the MCP patch as a diff showing `provider: openai`
// for a fallback that does not exist.
//
// Refused rather than repaired, because repairing means choosing which half to throw away. And
// refused at the WRITE rather than in the editor alone: the editor is one of three transports that
// reach this bag (REST create, REST update, MCP patch), and the save gate only covers the first
// operator who meets it.
describe("hasModelFallback reads the repo's own model rule", () => {
  const cfg = (provider: string | null, model: string | null) =>
    readModelFallbackConfig({
      modelFallback: { provider, model, credentialRef: null, baseURL: null },
    } as never);

  test("a provider is what names a destination, so absent means no fallback", () => {
    expect(hasModelFallback(cfg(null, null))).toBe(false);
    expect(hasModelFallback(cfg(null, "gpt-5.4-mini"))).toBe(false);
  });

  test("openai-compatible needs no model: the server picks", () => {
    expect(hasModelFallback(cfg("openai-compatible", null))).toBe(true);
    expect(modelOptionalFor("openai-compatible")).toBe(true);
  });

  test("every other provider does", () => {
    for (const p of [
      "openai",
      "anthropic",
      "google",
      "deepseek",
      "openrouter",
    ]) {
      expect(modelOptionalFor(p)).toBe(false);
      expect(hasModelFallback(cfg(p, null))).toBe(false);
      expect(hasModelFallback(cfg(p, "some-model"))).toBe(true);
    }
  });

  // The predicate and the default-model table answer the same question and must not drift: an empty
  // default is exactly the provider where empty is a real choice, which is why they live together.
  test("the predicate agrees with the default-model table", () => {
    for (const [provider, def] of Object.entries(PROVIDER_DEFAULT_MODEL)) {
      expect(modelOptionalFor(provider)).toBe(def === "");
    }
  });
});

describe("assertSettingsModelFallback", () => {
  const bag = (over: Record<string, unknown> | undefined) =>
    over === undefined ? { stt: {} } : { modelFallback: over };
  const refusesOn =
    (mode: SettingsWriteMode) =>
    (next: unknown, stored: unknown): string | null => {
      try {
        assertSettingsModelFallback(next, stored, mode);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    };
  // The editor's transport, which REPLACES the settings column with the bag it was handed.
  const refuses = refusesOn("replace");
  // The MCP patch, which merges the block one level deep before storing it.
  const merged = refusesOn("merge");

  test("a whole fallback is stored", () => {
    expect(
      refuses(bag({ provider: "openai", model: "gpt-5.4-mini" }), {}),
    ).toBeNull();
  });

  test("neither half named is no fallback, which is a valid thing to store", () => {
    expect(refuses(bag({ provider: null, model: null }), {})).toBeNull();
  });

  test("a write that does not touch the block says nothing about it", () => {
    expect(refuses(bag(undefined), {})).toBeNull();
  });

  test("a provider with no model is refused, naming the half that is missing", () => {
    expect(refuses(bag({ provider: "openai", model: null }), {})).toContain(
      "model is missing",
    );
  });

  test("a model with no provider is refused the same way", () => {
    expect(
      refuses(bag({ provider: null, model: "gpt-5.4-mini" }), {}),
    ).toContain("provider is missing");
  });

  // THE MODEL IS NOT REQUIRED FOR EVERY PROVIDER, and this rule is not this block's to invent. An
  // `openai-compatible` endpoint that serves a single model discards the name it is sent, which is
  // why `modelConfigSchema` lets the PRIMARY through empty there and `createChatModel` sends
  // "default". Asking for both halves unconditionally made an operator's own llama.cpp server
  // impossible to name as a fallback without inventing a model id for it — refused by the write
  // boundary and by the save gate at once. Review found it; there is one predicate now
  // (`modelOptionalFor`), read here, by the schema and by the editor's save guard.
  test("openai-compatible with no model is a whole fallback, not half of one", () => {
    expect(
      refuses(
        bag({
          provider: "openai-compatible",
          model: null,
          baseURL: "https://llama.internal/v1",
        }),
        {},
      ),
    ).toBeNull();
  });

  test("and every other provider still needs one", () => {
    for (const provider of [
      "openai",
      "anthropic",
      "google",
      "deepseek",
      "openrouter",
    ]) {
      expect(refuses(bag({ provider, model: null }), {})).toContain(
        "model is missing",
      );
    }
  });

  // The exemption is about the MODEL, not about the pair: a model with no provider is still no
  // destination, whichever provider would have been named.
  test("a model with no provider is refused on that path too", () => {
    expect(refuses(bag({ provider: null, model: "llama-3" }), {})).toContain(
      "provider is missing",
    );
  });

  // Whitespace is not a name, and this is the one the editor's own trim already agreed with.
  test("a blank string does not count as named", () => {
    expect(refuses(bag({ provider: "openai", model: "   " }), {})).toContain(
      "model is missing",
    );
  });

  // PER FIELD, because mergeBehaviorSettings merges a block one level deep: the MCP patch sends the
  // fields it means to change, and a patch naming only the model is a complete statement when the
  // stored block already names a provider.
  test("a patch naming only the model is whole against a stored provider", () => {
    expect(
      merged(bag({ model: "other" }), {
        modelFallback: { provider: "openai", model: "gpt-5.4-mini" },
      }),
    ).toBeNull();
  });

  test("a patch naming only the provider is still half a fallback", () => {
    expect(merged(bag({ provider: "openai" }), {})).toContain(
      "model is missing",
    );
  });

  // THE TWO TRANSPORTS DISAGREE, AND THE MODE IS WHY THIS TAKES AN ARGUMENT. The same body is a
  // complete statement to the MCP patch, which merges it, and a half-named row to REST, which
  // replaces the column with it. Asking the merge question on the replace path is how a bag that
  // stores no provider at all passes by borrowing one it is about to discard.
  test("the same body that merges cleanly is refused when it REPLACES", () => {
    const stored = { modelFallback: { provider: "openai", model: "gpt" } };
    expect(merged(bag({ model: "other" }), stored)).toBeNull();
    expect(refuses(bag({ model: "other" }), stored)).toContain(
      "provider is missing",
    );
  });

  // Clearing one half is how a half-named block gets made from a whole one, and it is the shape a
  // patch reaches for when it means to turn the fallback off.
  test("clearing the provider while the model stays is refused", () => {
    expect(
      merged(bag({ provider: null }), {
        modelFallback: { provider: "openai", model: "gpt-5.4-mini" },
      }),
    ).toContain("provider is missing");
  });

  // ONLY WHAT THE WRITE CHANGES. A bag that already holds a half-named block — written before this
  // rule, or by a path that predates it — is re-sent untouched by every save that edits some other
  // section, and refusing those would freeze the agent on a field the operator is not editing.
  test("a stored half-block re-sent unchanged does not block an unrelated save", () => {
    const legacy = { modelFallback: { provider: "openai", model: null } };
    expect(
      refuses(bag({ provider: "openai", model: null }), legacy),
    ).toBeNull();
  });

  test("and it can still be repaired, or emptied", () => {
    const legacy = { modelFallback: { provider: "openai", model: null } };
    expect(
      refuses(bag({ provider: "openai", model: "gpt-5.4-mini" }), legacy),
    ).toBeNull();
    expect(refuses(bag({ provider: null, model: null }), legacy)).toBeNull();
  });

  // BY VALUE, not by which half is filled. Swapping the provider of a broken pair for a different
  // provider edits the pair and leaves it just as broken; a "same shape" exemption waves that
  // through, which is a write this rule exists to refuse arriving under the exemption for writes
  // that change nothing.
  test("editing a stored half-block into a different half-block is refused", () => {
    const legacy = { modelFallback: { provider: "openai", model: null } };
    expect(
      refuses(bag({ provider: "anthropic", model: null }), legacy),
    ).toContain("model is missing");
  });

  // And the same rule on the other half: the model changes, the provider is still absent.
  test("editing the named half of a half-block is refused too", () => {
    const legacy = { modelFallback: { provider: null, model: "gpt" } };
    expect(
      refuses(bag({ provider: null, model: "gpt-5.4-mini" }), legacy),
    ).toContain("provider is missing");
  });

  // Whitespace is not an edit either: the editor trims before it stores, so a blank added around a
  // stored value has to land on the SAME side of this rule as the value it decorates.
  test("whitespace around an unchanged value is still unchanged", () => {
    const legacy = { modelFallback: { provider: "openai", model: null } };
    expect(
      refuses(bag({ provider: " openai ", model: "  " }), legacy),
    ).toBeNull();
  });
});
