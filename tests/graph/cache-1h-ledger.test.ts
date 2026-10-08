import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import { splitOneHourWrites } from "@/graph/anthropic-cache-split";
import { createChatModel } from "@/graph/models";
import { extractTokenUsage } from "@/graph/usage";
import { callCostUsd, costAt, priceCall } from "@/modules/pricing/price";
import { capturePricer } from "@/modules/pricing/reprice";

// A 1-hour cache write bills at 2x the input rate and a 5-minute one at 1.25x. These follow the
// 1-hour share from Anthropic's raw usage to the priced row: the split on the message, the ledger
// counts, and the price.

const AT = new Date("2026-10-08T12:00:00Z");

// claude-haiku-4-5 in the table: input 1, cacheWrite 1.25, cachedInput 0.1, output 5 (USD per 1M).
const HAIKU_45 = ["anthropic", "claude-haiku-4-5"] as const;

describe("the price of a call with 1-hour writes", () => {
  test("1-hour writes cost 2x the input rate, 5-minute ones the table's write rate", () => {
    const cost = callCostUsd(
      ...HAIKU_45,
      {
        promptTokens: 10_000,
        cachedReadTokens: 1_000,
        cacheCreationTokens: 6_000,
        cacheCreation1hTokens: 4_000,
        completionTokens: 100,
      },
      AT,
    );
    // fresh 3,000 x 1 + read 1,000 x 0.1 + 5m 2,000 x 1.25 + 1h 4,000 x 2 + out 100 x 5
    expect(cost).toBeCloseTo((3_000 + 100 + 2_500 + 8_000 + 500) / 1e6, 12);
  });

  test("a row that states a 1-hour rate is charged that rate, not 2x input", () => {
    const cost = costAt(
      { input: 1, output: 5, cacheWrite: 1.25, cacheWrite1h: 3 },
      {
        promptTokens: 1_000,
        cachedReadTokens: 0,
        cacheCreationTokens: 1_000,
        cacheCreation1hTokens: 1_000,
        completionTokens: 0,
      },
      false,
    );
    expect(cost).toBeCloseTo(3_000 / 1e6, 12);
  });

  test("without 1-hour writes the price is the one it always was", () => {
    const tokens = {
      promptTokens: 10_000,
      cachedReadTokens: 1_000,
      cacheCreationTokens: 6_000,
      completionTokens: 100,
    };
    expect(callCostUsd(...HAIKU_45, tokens, AT)).toBe(
      callCostUsd(...HAIKU_45, { ...tokens, cacheCreation1hTokens: 0 }, AT),
    );
    expect(callCostUsd(...HAIKU_45, tokens, AT)).toBeCloseTo(
      (3_000 + 100 + 7_500 + 500) / 1e6,
      12,
    );
  });

  test("an unknown model stays unpriced, never zero", () => {
    expect(
      callCostUsd(
        "anthropic",
        "claude-not-in-the-table",
        {
          promptTokens: 1_000,
          cachedReadTokens: 0,
          cacheCreationTokens: 800,
          cacheCreation1hTokens: 800,
          completionTokens: 10,
        },
        AT,
      ),
    ).toBeNull();
  });

  test("a tenant's own price charges the 1-hour writes at 2x its input", () => {
    const { costUsd } = priceCall(
      ...HAIKU_45,
      {
        promptTokens: 1_000,
        cachedReadTokens: 0,
        cacheCreationTokens: 1_000,
        cacheCreation1hTokens: 1_000,
        completionTokens: 0,
      },
      AT,
      {
        overrides: [
          {
            provider: "anthropic",
            model: "claude-haiku-4-5",
            input: 3,
            output: 15,
          },
        ],
      } as never,
    );
    expect(costUsd).toBeCloseTo((1_000 * 6) / 1e6, 12);
  });

  test("repricing a stored row keeps its 1-hour writes at their own rate", () => {
    const priced = capturePricer(
      "anthropic",
      () => null,
    )({
      id: 1n,
      tenantId: 1n,
      model: "claude-haiku-4-5",
      priceTable: null,
      promptTokens: 10_000,
      completionTokens: 100,
      cachedReadTokens: 1_000,
      cacheCreationTokens: 6_000,
      cacheCreation1hTokens: 4_000,
      costUsd: null,
      createdAt: AT,
    });
    expect(priced.costUsd).toBeCloseTo(
      (3_000 + 100 + 2_500 + 8_000 + 500) / 1e6,
      12,
    );
  });
});

function result(message: AIMessage): LLMResult {
  return { generations: [[{ text: "", message } as never]] };
}

describe("the 1-hour share on the message", () => {
  const message = () =>
    new AIMessage({
      content: "ok",
      usage_metadata: {
        input_tokens: 10_000,
        output_tokens: 100,
        total_tokens: 10_100,
        input_token_details: { cache_creation: 6_000, cache_read: 1_000 },
      },
      response_metadata: {
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: 2_000,
            ephemeral_1h_input_tokens: 4_000,
          },
        },
      },
    });

  test("the split moves the 1-hour writes to their own key and keeps the total", () => {
    const m = message();
    splitOneHourWrites(m);
    expect(m.usage_metadata?.input_token_details).toEqual({
      cache_creation: 2_000,
      cache_creation_1h: 4_000,
      cache_read: 1_000,
    } as never);
    expect(extractTokenUsage(result(m))).toEqual({
      promptTokens: 10_000,
      completionTokens: 100,
      cachedReadTokens: 1_000,
      cacheCreationTokens: 6_000,
      cacheCreation1hTokens: 4_000,
    });
  });

  test("splitting twice does not move the writes twice", () => {
    const m = message();
    splitOneHourWrites(m);
    splitOneHourWrites(m);
    expect(extractTokenUsage(result(m)).cacheCreationTokens).toBe(6_000);
    expect(extractTokenUsage(result(m)).cacheCreation1hTokens).toBe(4_000);
  });

  test("a call with no 1-hour writes is left as it was", () => {
    const m = new AIMessage({
      content: "ok",
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 1,
        total_tokens: 101,
        input_token_details: { cache_creation: 60, cache_read: 0 },
      },
      response_metadata: {
        usage: {
          cache_creation: {
            ephemeral_5m_input_tokens: 60,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
    });
    splitOneHourWrites(m);
    expect(m.usage_metadata?.input_token_details).toEqual({
      cache_creation: 60,
      cache_read: 0,
    });
    expect(extractTokenUsage(result(m)).cacheCreation1hTokens).toBe(0);
  });
});

// The model the factory builds, against a local server answering as Anthropic does with a 1-hour
// write: the message the rest of the runtime reads already carries the split.
const BunResponse = (globalThis as unknown as { BunResponse: typeof Response })
  .BunResponse;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};
let server: ReturnType<typeof Bun.serve>;
let prevBase: string | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "OPTIONS")
        return new BunResponse(null, { status: 204, headers: CORS });
      await req.json();
      return new BunResponse(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-haiku-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 3_000,
            cache_read_input_tokens: 1_000,
            cache_creation_input_tokens: 6_000,
            cache_creation: {
              ephemeral_5m_input_tokens: 2_000,
              ephemeral_1h_input_tokens: 4_000,
            },
            output_tokens: 100,
          },
        }),
        { headers: { ...CORS, "content-type": "application/json" } },
      );
    },
  });
  prevBase = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = prevBase;
});

describe("the anthropic model the factory builds", () => {
  test("hands the runtime a message whose usage already separates the 1-hour writes", async () => {
    const model = createChatModel({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: "k",
      maxRetries: 0,
      promptCacheTtl: "1h",
    } as never);
    const llm = await model.generate([[new HumanMessage("oi")]]);
    const usage = extractTokenUsage(llm);
    expect(usage.cacheCreationTokens).toBe(6_000);
    expect(usage.cacheCreation1hTokens).toBe(4_000);
    expect(usage.promptTokens).toBe(10_000);
    // The Langfuse handler turns each of these keys into an `input_<key>` detail.
    const message = (llm.generations[0]?.[0] as { message?: AIMessage })
      ?.message;
    expect(message?.usage_metadata?.input_token_details).toMatchObject({
      cache_creation: 2_000,
      cache_creation_1h: 4_000,
    });
  });
});
