import { afterEach, describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import type { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import { createChatModel } from "@/graph/models";

// Every turn of a gpt-5.6 agent that has tools died on an OpenAI 400 (issue #66). We never send a
// reasoning effort, so what collides with the tools is the provider's own default: measured against
// the live API, `gpt-5.6-luna` with tools and no effort answers 400, and the same call with
// `reasoning_effort: "none"` answers 200 with the tool call. gpt-5.5 and older are unaffected.

interface FakeOpenAI {
  requests: Record<string, unknown>[];
  restore: () => void;
}

// Stands in for /v1/chat/completions. The rule below is transcribed from what the live API did, NOT
// imported from src — a fake that reuses the implementation's idea of the rule cannot catch that
// idea being wrong. Measured: the rejection needs BOTH a gpt-5.6 model and function tools, and the
// only effort it accepts in that combination is "none" (absent counts as the server's default,
// which is what got rejected).
function fakeOpenAI(): FakeOpenAI {
  const requests: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    requests.push(body);
    const model = String(body.model ?? "");
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const effort = body.reasoning_effort;
    const isFamily = /^(?:[\w.-]+\/)?gpt-5\.6(?:-|$)/i.test(model);
    if (isFamily && hasTools && effort !== "none") {
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
                    arguments: '{"timezone":"America/Sao_Paulo"}',
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
) {
  fake = fakeOpenAI();
  const chat = createChatModel({
    provider,
    model,
    apiKey: "test",
    temperature: 0.3,
  });
  const bound = chat.bindTools?.([getCurrentTime]) ?? chat;
  const reply = await bound.invoke([
    { role: "user", content: "que horas são?" },
  ]);
  return { reply, sent: fake.requests[0] ?? {} };
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
