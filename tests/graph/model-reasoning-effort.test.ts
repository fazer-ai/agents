import { afterEach, describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import type { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { parseModelConfig } from "@/graph/model-config";
import { createChatModel } from "@/graph/models";
import {
  planOpenAITransport,
  type ReasoningEffort,
} from "@/graph/openai-reasoning";

// Every turn of a gpt-5.6 agent that has tools died on an OpenAI 400 (issue #66). We never send a
// reasoning effort, so what collides with the tools is the provider's own default: measured against
// the live API, `gpt-5.6-luna` with tools and no effort answers 400, and the same call with
// `reasoning_effort: "none"` answers 200 with the tool call. gpt-5.5 and older are unaffected.

interface FakeOpenAI {
  requests: Record<string, unknown>[];
  urls: string[];
  restore: () => void;
}

// Stands in for BOTH OpenAI endpoints. The rules below are transcribed from what the live API did,
// NOT imported from src — a fake that reuses the implementation's idea of the rule cannot catch
// that idea being wrong.
//
// Measured on 2026-08-15 with one function tool attached, on gpt-5.6-luna, gpt-5.6-sol,
// gpt-5.4-mini and gpt-5.5: /v1/chat/completions answers 400 for EVERY effort above "none",
// on every one of those models, and answers 400 for an ABSENT effort only on the gpt-5.6 family
// (whose server-side default is not "none"). /v1/responses answers 200 for every effort on every
// one of them. So the ceiling belongs to the endpoint, not to the family.
function completionsRejects(model: string, body: Record<string, unknown>) {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (!hasTools) return false;
  const effort = body.reasoning_effort;
  if (effort === "none") return false;
  if (effort === undefined)
    return /^(?:[\w.-]+\/)?gpt-5\.6(?:-|$)/i.test(model);
  return true;
}

const TOOL_CALL_ARGS = '{"timezone":"America/Sao_Paulo"}';

function fakeOpenAI(): FakeOpenAI {
  const requests: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    requests.push(body);
    urls.push(String(url));
    const model = String(body.model ?? "");
    if (String(url).includes("/responses")) {
      // Measured: a model with no reasoning to constrain refuses the parameter by name
      // ("Unsupported parameter: 'reasoning.effort' is not supported with this model." on gpt-4o).
      // The fake rejects it too, so a test can tell "the operator was told" apart from "the
      // parameter never left".
      // Measured: the endpoint rejects the completions spelling by name, and says where it moved.
      // This is what a model the ADAPTER routes here would have hit.
      if (body.reasoning_effort !== undefined) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'reasoning_effort'. In the Responses API, this parameter has moved to 'reasoning.effort'.",
              type: "invalid_request_error",
              param: "reasoning_effort",
              code: "unsupported_parameter",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      if (body.reasoning !== undefined && /^gpt-4o/.test(model)) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
              type: "invalid_request_error",
              param: "reasoning.effort",
              code: "unsupported_parameter",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "resp_test",
          object: "response",
          created_at: 0,
          model,
          status: "completed",
          output: [
            {
              id: "fc_1",
              call_id: "call_1",
              type: "function_call",
              name: "get_current_time",
              arguments: TOOL_CALL_ARGS,
              status: "completed",
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (completionsRejects(model, body)) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Function tools with reasoning_effort are not supported for ${model} in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.`,
            type: "invalid_request_error",
            param: "reasoning_effort",
            code: null,
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_current_time",
                    arguments: TOOL_CALL_ARGS,
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return {
    requests,
    urls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const getCurrentTime = tool(async () => "10:00", {
  name: "get_current_time",
  description: "Current time in a timezone",
  schema: z.object({ timezone: z.string() }),
});

let fake: FakeOpenAI | null = null;
afterEach(() => {
  fake?.restore();
  fake = null;
});

async function turn(
  model: string,
  provider: "openai" | "openrouter" = "openai",
  reasoningEffort?: ReasoningEffort,
) {
  fake = fakeOpenAI();
  const chat = createChatModel({
    provider,
    model,
    apiKey: "test",
    temperature: 0.3,
    reasoningEffort,
  });
  const bound = chat.bindTools?.([getCurrentTime]) ?? chat;
  const reply = await bound.invoke([
    { role: "user", content: "que horas são?" },
  ]);
  return { reply, sent: fake.requests[0] ?? {}, url: fake.urls[0] ?? "" };
}

describe("the fake API rejects what OpenAI rejects", () => {
  test("a gpt-5.6 turn carrying tools and no effort", async () => {
    fake = fakeOpenAI();
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        tools: [{ type: "function" }],
      }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain(
      "Function tools with reasoning_effort are not supported",
    );
  });

  test("the same turn on gpt-5.4 is accepted", async () => {
    fake = fakeOpenAI();
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        tools: [{ type: "function" }],
      }),
    });
    expect(res.status).toBe(200);
  });
});

describe("createChatModel on the gpt-5.6 family", () => {
  test("a turn with tools is answered instead of rejected", async () => {
    const { reply, sent } = await turn("gpt-5.6-luna");
    expect(sent.reasoning_effort).toBe("none");
    expect(reply.tool_calls?.[0]?.name).toBe("get_current_time");
  });

  test("every model of the family carries it", async () => {
    for (const model of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]) {
      const { sent } = await turn(model);
      expect(sent.reasoning_effort).toBe("none");
      fake?.restore();
    }
  });

  // The typed `reasoning` field would be dropped here: @langchain/openai gates it on its own
  // isReasoningModel(), which tests model.startsWith("gpt-5") and so misses a routed id.
  test("a routed OpenRouter id carries it too", async () => {
    const { sent } = await turn("openai/gpt-5.6-luna", "openrouter");
    expect(sent.reasoning_effort).toBe("none");
  });

  // Only the rejection's own precondition (tools) may disable reasoning. graph.ts invokes the RAW
  // instance once the tool budget runs out — `hardLimit ? model : llm` — and THAT call writes the
  // final answer to the customer. The guardrail pass, the TTS normalization and an agent with no
  // grants never bind tools either. All of them are accepted at the provider's default effort.
  test("a call with no tools keeps the provider's own default", async () => {
    fake = fakeOpenAI();
    const chat = createChatModel({
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "test",
      temperature: 0.3,
    });
    await chat.invoke([{ role: "user", content: "oi" }]);
    expect(fake.requests[0]).not.toHaveProperty("reasoning_effort");
  });

  test("binding tools does not contaminate the raw instance behind it", async () => {
    fake = fakeOpenAI();
    const chat = createChatModel({
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "test",
      temperature: 0.3,
    });
    const bound = chat.bindTools?.([getCurrentTime]) ?? chat;
    await bound.invoke([{ role: "user", content: "oi" }]);
    await chat.invoke([{ role: "user", content: "oi" }]);
    expect(fake.requests[0]?.reasoning_effort).toBe("none");
    expect(fake.requests[1]).not.toHaveProperty("reasoning_effort");
  });
});

// The carve-out must not spread: gpt-5.5 and older answered 200 with tools and no effort, and
// gpt-5.4-mini accepts "none" as well — so sending it there would silently drop the reasoning those
// agents run with today, trading one regression for another.
describe("createChatModel leaves every other model alone", () => {
  test("the generations that already work send no effort at all", async () => {
    for (const model of [
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.2",
      "gpt-5-mini",
      "gpt-5",
      "o4-mini",
      "gpt-4o",
    ]) {
      const { sent } = await turn(model);
      expect(sent).not.toHaveProperty("reasoning_effort");
      fake?.restore();
    }
  });

  // "gpt-5.6" must match the family, not any id that merely contains it.
  test("a model that only looks like the family is untouched", async () => {
    for (const model of ["gpt-5.60", "gpt-5.6x", "not-gpt-5.6-luna"]) {
      const { sent } = await turn(model);
      expect(sent).not.toHaveProperty("reasoning_effort");
      fake?.restore();
    }
  });

  test("temperature stays dropped for the family, as for every reasoning model", () => {
    const chat = createChatModel({
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "test",
      temperature: 0.3,
    }) as ChatOpenAI;
    expect(chat.temperature).toBeUndefined();
  });
});

// Issue #74: the operator picks the effort per agent. The measurement that shapes this is that
// /v1/chat/completions refuses EVERY effort above "none" alongside function tools, on every
// reasoning model tried — so an explicit effort is a transport decision, not a family carve-out.

describe("the fake API accepts what OpenAI accepts", () => {
  test("completions rejects an effort above none even on the older families", async () => {
    fake = fakeOpenAI();
    for (const model of ["gpt-5.4-mini", "gpt-5.5", "gpt-5.6-luna"]) {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model,
          tools: [{ type: "function" }],
          reasoning_effort: "low",
        }),
      });
      expect(res.status).toBe(400);
    }
  });

  test("responses accepts every effort, on every family", async () => {
    fake = fakeOpenAI();
    for (const model of ["gpt-5.4-mini", "gpt-5.6-luna"]) {
      for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
        const res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({
            model,
            tools: [{ type: "function" }],
            reasoning: { effort },
          }),
        });
        expect(res.status).toBe(200);
      }
    }
  });
});

describe("planOpenAITransport", () => {
  test("no choice keeps every model exactly where it is today", () => {
    expect(planOpenAITransport("gpt-5.4-mini", undefined)).toEqual({
      responses: false,
    });
    expect(planOpenAITransport("gpt-4o", undefined)).toEqual({
      responses: false,
    });
  });

  test("no choice still pins the family whose own default breaks tools", () => {
    expect(planOpenAITransport("gpt-5.6-luna", undefined)).toEqual({
      responses: false,
      toolEffort: "none",
    });
  });

  // "none" is a choice like any other, so it takes the same endpoint. The parameter is spelled
  // differently on each one (`reasoning_effort` vs `reasoning.effort`, and neither endpoint accepts
  // the other's spelling), and the adapter routes some models to /v1/responses on its own — so a
  // plan that kept "none" on completions would have to PREDICT the endpoint to pick the spelling.
  // One endpoint for every explicit choice removes the prediction entirely.
  test("an explicit none is a choice of endpoint too", () => {
    expect(planOpenAITransport("gpt-5.6-luna", "none")).toEqual({
      responses: true,
      effort: "none",
    });
    expect(planOpenAITransport("gpt-5.4-mini", "none")).toEqual({
      responses: true,
      effort: "none",
    });
  });

  // The one that catches a family-scoped implementation: gpt-5.4-mini works fine with tools today,
  // yet it too rejects an effort on completions, so it needs the same transport.
  test("every effort moves to responses, whatever the family", () => {
    for (const model of ["gpt-5.6-luna", "gpt-5.4-mini", "gpt-5.5", "gpt-4o"]) {
      for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
        expect(planOpenAITransport(model, effort)).toEqual({
          responses: true,
          effort,
        });
      }
    }
  });
});

describe("createChatModel with an explicit effort", () => {
  test("a gpt-5.6 turn with tools is answered on the responses endpoint", async () => {
    const { reply, sent, url } = await turn("gpt-5.6-luna", "openai", "high");
    expect(url).toContain("/responses");
    expect(sent.reasoning).toEqual({ effort: "high" });
    expect(reply.tool_calls?.[0]?.name).toBe("get_current_time");
  });

  test("an older family moves too, because completions refuses it as well", async () => {
    const { reply, sent, url } = await turn("gpt-5.4-mini", "openai", "medium");
    expect(url).toContain("/responses");
    expect(sent.reasoning).toEqual({ effort: "medium" });
    expect(reply.tool_calls?.[0]?.name).toBe("get_current_time");
  });

  test("every effort above none reaches the provider as asked", async () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const { sent, url } = await turn("gpt-5.6-luna", "openai", effort);
      expect(url).toContain("/responses");
      expect(sent.reasoning).toEqual({ effort });
      fake?.restore();
    }
  });

  // Switching endpoint must not switch what OpenAI keeps. Chat Completions stores nothing unless
  // asked; the Responses API stores by default (30 days). Sending store:false is what keeps the
  // knob about reasoning instead of quietly changing retention for a product that carries customer
  // conversations. Measured: the two-turn tool round-trip still works with storage off.
  test("the responses endpoint is told not to store the conversation", async () => {
    const { sent } = await turn("gpt-5.6-luna", "openai", "low");
    expect(sent.store).toBe(false);
  });

  test("an explicit none travels in the endpoint's own spelling", async () => {
    const { reply, sent, url } = await turn("gpt-5.6-luna", "openai", "none");
    expect(url).toContain("/responses");
    expect(sent.reasoning).toEqual({ effort: "none" });
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(reply.tool_calls?.[0]?.name).toBe("get_current_time");
  });

  // gpt-5.2-pro, gpt-5.4-pro, gpt-5.5-pro and any id containing "codex" are routed to
  // /v1/responses by @langchain/openai itself (_modelPrefersResponsesAPI), whatever we ask for.
  // A plan that sent the completions spelling for "none" would 400 every turn of those agents.
  test("a model the adapter routes on its own gets the right spelling", async () => {
    for (const model of ["gpt-5.4-pro", "gpt-5.5-pro", "gpt-5.2-pro"]) {
      const { sent, url } = await turn(model, "openai", "none");
      expect(url).toContain("/responses");
      expect(sent.reasoning).toEqual({ effort: "none" });
      expect(sent).not.toHaveProperty("reasoning_effort");
      fake?.restore();
    }
  });

  // The issue #66 pin exists only because nobody chose an effort. Once the operator does choose,
  // the pin must not survive and silently cap the choice at "none".
  test("the choice overrides the pin the family carries by default", async () => {
    const { sent, url } = await turn("gpt-5.6-luna", "openai", "high");
    expect(url).toContain("/responses");
    expect(sent).not.toHaveProperty("reasoning_effort");
  });

  // Unlike the pin, an explicit choice is about the agent, so it also covers the calls that carry
  // no tools: the answer written after the tool budget runs out (`hardLimit ? model : llm` in
  // graph.ts) and an agent with no grants at all.
  test("the choice reaches a call that binds no tools", async () => {
    fake = fakeOpenAI();
    const chat = createChatModel({
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "test",
      temperature: 0.3,
      reasoningEffort: "high",
    });
    await chat.invoke([{ role: "user", content: "oi" }]);
    expect(fake.urls[0]).toContain("/responses");
    expect(fake.requests[0]?.reasoning).toEqual({ effort: "high" });
  });

  test("an explicit none reaches a call that binds no tools too", async () => {
    fake = fakeOpenAI();
    const chat = createChatModel({
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "test",
      temperature: 0.3,
      reasoningEffort: "none",
    });
    await chat.invoke([{ role: "user", content: "oi" }]);
    expect(fake.requests[0]?.reasoning).toEqual({ effort: "none" });
  });
});

// The knob is offered only where a working combination was measured AND where we control the
// endpoint. OpenRouter and openai-compatible servers mostly do not implement /v1/responses, so
// there the effort could only ride on completions — the one place it is refused alongside tools.
describe("the config schema fences the knob to the provider that has the endpoint", () => {
  test("openai takes it", () => {
    expect(
      parseModelConfig({
        provider: "openai",
        model: "gpt-5.6-luna",
        reasoningEffort: "high",
      }).reasoningEffort,
    ).toBe("high");
  });

  test("every other provider refuses it, naming the field", () => {
    for (const provider of [
      "openrouter",
      "openai-compatible",
      "anthropic",
      "google",
      "deepseek",
    ]) {
      expect(() =>
        parseModelConfig({
          provider,
          model: "some-model",
          baseURL: "https://example.com/v1",
          reasoningEffort: "high",
        }),
      ).toThrow(/reasoningEffort/);
    }
  });

  test("those providers are untouched when the field is absent", () => {
    expect(
      parseModelConfig({ provider: "openrouter", model: "openai/gpt-5.6-luna" })
        .reasoningEffort,
    ).toBeUndefined();
  });

  // Measured: every model tried rejects "minimal", so offering it would be a control with a
  // position that always fails.
  test("minimal is not part of the vocabulary", () => {
    expect(() =>
      parseModelConfig({
        provider: "openai",
        model: "gpt-5.6-luna",
        reasoningEffort: "minimal",
      }),
    ).toThrow();
  });
});

// @langchain/openai decides whether to send the typed `reasoning` field by testing the model NAME
// (isReasoningModel: /^o\d/ or startsWith("gpt-5") minus gpt-5-chat). Anything it does not
// recognise loses the field, so the turn would still move to /v1/responses and arrive with no
// effort at all: the operator's choice silently discarded, which is the one outcome worse than a
// rejection. A fine-tuned id of a model that DOES reason is the case that makes this concrete —
// "ft:gpt-5.6-luna:…" is a legitimate choice and the name test drops it. Carrying the effort in
// modelKwargs, which is spread into the request unconditionally, is the same fix the completions
// branch already needed for routed OpenRouter ids, and for the same reason.
describe("the chosen effort is not silently dropped by a name test", () => {
  test("a fine-tuned id of a reasoning model still carries it", async () => {
    const { sent, url } = await turn(
      "ft:gpt-5.6-luna:acme::x1",
      "openai",
      "high",
    );
    expect(url).toContain("/responses");
    expect(sent.reasoning).toEqual({ effort: "high" });
  });

  test("a model the adapter does not classify still carries it", async () => {
    for (const model of ["gpt-5-chat-latest", "my-org/custom-reasoner"]) {
      const { sent } = await turn(model, "openai", "medium");
      expect(sent.reasoning).toEqual({ effort: "medium" });
      fake?.restore();
    }
  });

  // The observable difference: the operator learns the model refuses the setting, instead of
  // reading "saved" and getting no reasoning forever.
  test("a model with no reasoning to constrain answers with a legible rejection", async () => {
    await expect(turn("gpt-4o", "openai", "high")).rejects.toThrow(
      /reasoning\.effort/,
    );
  });
});

// Same blind spot on the other rule: a fine-tune of gpt-5.6 inherits the server-side default that
// breaks function tools, so it needs the issue #66 pin just as much as the bare id does.
describe("a fine-tuned id is read through to its base model", () => {
  test("the pin follows the base family", () => {
    expect(planOpenAITransport("ft:gpt-5.6-luna:acme::x1", undefined)).toEqual({
      responses: false,
      toolEffort: "none",
    });
  });

  test("and does not spread to a fine-tune of anything else", () => {
    expect(planOpenAITransport("ft:gpt-5.4-mini:acme::x1", undefined)).toEqual({
      responses: false,
    });
  });
});

// @langchain/openai routes some ids to /v1/responses on its own, whatever we ask
// (_modelPrefersResponsesAPI). The issue #66 pin is spelled for completions, so it must not fire
// on those — and the ft: match added above is what makes the overlap reachable, because the last
// segments of "ft:<base>:<org>:<name>:<id>" are free text the operator writes: a support agent
// fine-tuned as "codex-support" contains "codex" and gets routed away.
describe("the completions-spelled pin follows the endpoint, not a guess about it", () => {
  // The endpoint is not settled at construction: @langchain/openai also switches to Responses when
  // the CALL carries an OpenAI built-in tool or a Responses-only option. A gpt-5.6 model that stays
  // on completions bare is routed away the moment such a tool is bound, so the pin has to be
  // decided where the tools are, not where the client is built.
  test("a built-in tool bound later moves the turn, and the pin does not follow", async () => {
    fake = fakeOpenAI();
    const chat = createChatModel({
      provider: "openai",
      model: "gpt-5.6-luna",
      apiKey: "test",
    });
    await chat
      .bindTools?.([getCurrentTime, { type: "web_search_preview" } as never])
      .invoke([{ role: "user", content: "oi" }])
      .catch(() => undefined);
    expect(fake.urls[0]).toContain("/responses");
    expect(fake.requests[0]).not.toHaveProperty("reasoning_effort");
  });

  test("and plain function tools on the same model keep it", async () => {
    const { sent, url } = await turn("gpt-5.6-luna");
    expect(url).toContain("/chat/completions");
    expect(sent.reasoning_effort).toBe("none");
  });

  // Lowercase suffix: the adapter routes it away, so the pin must not travel.
  test("a fine-tuned gpt-5.6 the adapter routes away carries no pin", async () => {
    const { sent, url } = await turn("ft:gpt-5.6-luna:acme:codex-support:x1");
    expect(url).toContain("/responses");
    expect(sent).not.toHaveProperty("reasoning_effort");
  });

  // Uppercase suffix: `_modelPrefersResponsesAPI` uses case-SENSITIVE `includes`, so the very same
  // agent stays on completions — where dropping the pin is the issue #66 400 all over again.
  test.each([
    "ft:gpt-5.6-luna:acme:Codex-support:x1",
    "ft:gpt-5.6-luna:acme:GPT-5.4-PRO-migration:x1",
    "ft:gpt-5.6-luna:acme:suporte:x1",
  ])("%s stays on completions and keeps the pin", async (model) => {
    const { sent, url } = await turn(model);
    expect(url).toContain("/chat/completions");
    expect(sent.reasoning_effort).toBe("none");
  });
});

// Reading another library's routing rule is a copy that can drift, so the guard is stated as the
// invariant the copy exists to protect rather than as the copy itself: whatever @langchain/openai
// decides, and for whatever reason, a request that leaves for /v1/responses must never carry the
// completions spelling. That holds for ids nobody has thought of yet, which a transcribed list
// cannot do.
describe("the completions spelling never leaves for the responses endpoint", () => {
  const IDS = [
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-4o",
    "gpt-5.2-pro",
    "gpt-5.4-pro",
    "gpt-5.5-pro",
    "gpt-5.6-codex",
    "codex-mini-latest",
    // One per routing substring, carried in the free-text part of a fine-tune. The adapter tests
    // ALL FOUR with `includes`, so any of them can ride a suffix the operator wrote.
    "ft:gpt-5.6-luna:acme:codex-support:x1",
    "ft:gpt-5.6-luna:acme:gpt-5.2-pro-migration:x1",
    "ft:gpt-5.6-luna:acme:gpt-5.4-pro-migration:x1",
    "ft:gpt-5.6-luna:acme:gpt-5.5-pro-migration:x1",
    // The same two suffixes in the case the adapter does NOT match: still gpt-5.6, still on
    // completions, so still owed the pin.
    "ft:gpt-5.6-luna:acme:Codex-support:x1",
    "ft:gpt-5.6-luna:acme:GPT-5.4-PRO-migration:x1",
    "ft:gpt-5.6-luna:acme:suporte:x1",
    "ft:gpt-5.4-mini:acme::x1",
    "my-org/custom-reasoner",
  ];

  test.each(IDS)("%s, with nothing asked of it", async (model) => {
    fake = fakeOpenAI();
    const chat = createChatModel({ provider: "openai", model, apiKey: "test" });
    await chat
      .bindTools?.([getCurrentTime])
      .invoke([{ role: "user", content: "oi" }]);
    if (fake.urls[0]?.includes("/responses")) {
      expect(fake.requests[0]).not.toHaveProperty("reasoning_effort");
    }
  });

  // The other half of the same seam, and the half a case-insensitive guess broke: whenever a
  // gpt-5.6 model DOES leave for completions with tools attached, the issue #66 pin has to be on
  // it. Stated as an invariant so neither direction can be fixed at the other's expense —
  // withholding the pin too eagerly reopens #66 exactly as sending it too eagerly breaks the
  // Responses route.
  test.each(IDS.filter((m) => m.includes("gpt-5.6")))(
    "%s, when a gpt-5.6 stays on completions",
    async (model) => {
      fake = fakeOpenAI();
      const chat = createChatModel({
        provider: "openai",
        model,
        apiKey: "test",
      });
      await chat
        .bindTools?.([getCurrentTime])
        .invoke([{ role: "user", content: "oi" }]);
      if (fake.urls[0]?.includes("/chat/completions")) {
        expect(fake.requests[0]?.reasoning_effort).toBe("none");
      }
    },
  );

  // Inspected on the captured request rather than on the return value: an id the model refuses the
  // parameter on (gpt-4o) answers 400, and what this asserts is what LEFT, not whether it landed.
  test.each(IDS)("%s, at an explicit effort", async (model) => {
    fake = fakeOpenAI();
    const chat = createChatModel({
      provider: "openai",
      model,
      apiKey: "test",
      reasoningEffort: "medium",
    });
    await chat
      .bindTools?.([getCurrentTime])
      .invoke([{ role: "user", content: "oi" }])
      .catch(() => undefined);
    expect(fake.urls[0]).toContain("/responses");
    expect(fake.requests[0]).not.toHaveProperty("reasoning_effort");
    expect(fake.requests[0]?.reasoning).toEqual({ effort: "medium" });
  });
});
