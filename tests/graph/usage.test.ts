import { describe, expect, test } from "bun:test";
import type { LLMResult } from "@langchain/core/outputs";
import { extractTokenUsage, UsageCapture, type UsageRow } from "@/graph/usage";

function resultWithUsageMetadata(input: number, output: number): LLMResult {
  return {
    generations: [
      [
        {
          text: "hi",
          message: {
            usage_metadata: { input_tokens: input, output_tokens: output },
          },
        },
      ],
    ],
  } as unknown as LLMResult;
}

describe("extractTokenUsage", () => {
  test("prefers normalized usage_metadata, summing across generations", () => {
    expect(extractTokenUsage(resultWithUsageMetadata(120, 30))).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  test("reads input_token_details.cache_read/cache_creation (LangChain v1.x)", () => {
    const r = {
      generations: [
        [
          {
            text: "hi",
            message: {
              usage_metadata: {
                input_tokens: 1000,
                output_tokens: 50,
                input_token_details: { cache_read: 800, cache_creation: 120 },
              },
            },
          },
        ],
      ],
    } as unknown as LLMResult;
    // promptTokens stays the TOTAL input; cached is a discounted subset, not additive.
    expect(extractTokenUsage(r)).toEqual({
      promptTokens: 1000,
      completionTokens: 50,
      cachedReadTokens: 800,
      cacheCreationTokens: 120,
    });
  });

  test("falls back to OpenAI-style llmOutput.tokenUsage (+ cached subset)", () => {
    const r = {
      generations: [[{ text: "x" }]],
      llmOutput: {
        tokenUsage: {
          promptTokens: 7,
          completionTokens: 3,
          promptTokensDetails: { cachedTokens: 4 },
        },
      },
    } as unknown as LLMResult;
    expect(extractTokenUsage(r)).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      cachedReadTokens: 4,
      cacheCreationTokens: 0,
    });
  });

  test("falls back to Anthropic-style llmOutput.usage (cache counters ADDITIVE)", () => {
    const r = {
      generations: [[{ text: "x" }]],
      llmOutput: {
        usage: {
          input_tokens: 11,
          output_tokens: 5,
          cache_read_input_tokens: 8,
          cache_creation_input_tokens: 2,
        },
      },
    } as unknown as LLMResult;
    // NOTE: 11 + 8 + 2 (issue #334). Anthropic documents `input_tokens` as the tokens that were
    // NEITHER read from NOR used to create a cache, so the billed input is the sum of the three —
    // the opposite of the OpenAI shape above, where the cached count is already inside the prompt.
    // This assertion used to read 11, which is the row disagreeing with itself: `cachedReadTokens`
    // is documented as a discounted SUBSET of `promptTokens`, and 8 is not a subset of 11 when 11
    // already excludes it.
    expect(extractTokenUsage(r)).toEqual({
      promptTokens: 21,
      completionTokens: 5,
      cachedReadTokens: 8,
      cacheCreationTokens: 2,
    });
  });

  test("no usage anywhere → zero", () => {
    const r = { generations: [[{ text: "x" }]] } as unknown as LLMResult;
    expect(extractTokenUsage(r)).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe("UsageCapture", () => {
  test("persists one row with full attribution", async () => {
    const rows: UsageRow[] = [];
    const capture = new UsageCapture({
      tenantId: 5n,
      agentId: 9n,
      conversationId: 42n,
      threadId: "5:1:900",
      model: "gpt-4o-mini",
      node: "agent",
      persist: async (row) => {
        rows.push(row);
      },
    });
    await capture.handleLLMEnd(
      resultWithUsageMetadata(1_000_000, 1_000_000),
      "run-1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: 5n,
      agentId: 9n,
      conversationId: 42n,
      threadId: "5:1:900",
      model: "gpt-4o-mini",
      node: "agent",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      // Defaults: real-traffic source, no inbox/cached attribution unless provided.
      source: "inbox",
      inboxId: null,
      cachedReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  test("forwards source/inboxId/cached attribution to the sink", async () => {
    const rows: UsageRow[] = [];
    const capture = new UsageCapture({
      tenantId: 5n,
      agentId: 9n,
      inboxId: 7n,
      source: "playground",
      model: "gpt-4o-mini",
      persist: async (row) => {
        rows.push(row);
      },
    });
    const r = {
      generations: [
        [
          {
            text: "hi",
            message: {
              usage_metadata: {
                input_tokens: 100,
                output_tokens: 20,
                input_token_details: { cache_read: 60, cache_creation: 10 },
              },
            },
          },
        ],
      ],
    } as unknown as LLMResult;
    await capture.handleLLMEnd(r, "run-1");
    expect(rows[0]).toMatchObject({
      source: "playground",
      inboxId: 7n,
      cachedReadTokens: 60,
      cacheCreationTokens: 10,
    });
  });

  test("skips the write entirely when there is no token usage", async () => {
    const rows: UsageRow[] = [];
    const capture = new UsageCapture({
      tenantId: 5n,
      model: "gpt-4o-mini",
      persist: async (row) => {
        rows.push(row);
      },
    });
    await capture.handleLLMEnd(
      { generations: [[{ text: "x" }]] } as unknown as LLMResult,
      "run-1",
    );
    expect(rows).toEqual([]);
  });

  test("a failing sink never throws into the reply path", async () => {
    const capture = new UsageCapture({
      tenantId: 5n,
      model: "gpt-4o-mini",
      persist: async () => {
        throw new Error("db down");
      },
    });
    await expect(
      capture.handleLLMEnd(resultWithUsageMetadata(10, 10), "run-1"),
    ).resolves.toBeUndefined();
  });
});
