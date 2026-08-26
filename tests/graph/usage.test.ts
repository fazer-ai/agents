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

// WHICH MODEL THE ROW IS BILLED TO, when a fallback took the turn.
//
// The ledger has one column for who answered and no provider beside it, so this name is the whole
// record. The graph node names the model in the CALL's own metadata (measured to merge with the
// turn's, unlike `callbacks`, which replaces them), and this handler is what turns that into the
// row's `model`.
describe("UsageCapture attributes a run to the model that made it", () => {
  const capture = (rows: UsageRow[], model: string) =>
    new UsageCapture({
      tenantId: 5n,
      agentId: 9n,
      conversationId: 42n,
      threadId: "5:1:900",
      model,
      node: "agent",
      persist: async (row) => {
        rows.push(row);
      },
    });
  const KEY = "fazerai_usage_model";

  test("with no override, the row names the agent's configured model", async () => {
    const rows: UsageRow[] = [];
    const c = capture(rows, "gpt-5.4-mini");
    await c.handleLLMEnd(resultWithUsageMetadata(10, 5), "run-a");
    expect(rows[0]?.model).toBe("gpt-5.4-mini");
  });

  test("an override names the model that answered", async () => {
    const rows: UsageRow[] = [];
    const c = capture(rows, "gpt-5.4-mini");
    await c.handleLLMStart({}, [], "run-b", undefined, undefined, undefined, {
      [KEY]: "claude-haiku-4-5",
    });
    await c.handleLLMEnd(resultWithUsageMetadata(10, 5), "run-b");
    expect(rows[0]?.model).toBe("claude-haiku-4-5");
  });

  // PRESENT, NOT TRUTHY. An empty name is what a model-less `openai-compatible` fallback is called —
  // the server picks, so there is no id to record, and `""` is exactly what this ledger stores for a
  // PRIMARY pointed at such an endpoint. Read as falsy, the override was discarded and the row fell
  // back to the agent's configured model: a call that never reached that vendor, billed to it.
  test("an override that is deliberately empty is kept, not discarded", async () => {
    const rows: UsageRow[] = [];
    const c = capture(rows, "gpt-5.4-mini");
    await c.handleLLMStart({}, [], "run-c", undefined, undefined, undefined, {
      [KEY]: "",
    });
    await c.handleLLMEnd(resultWithUsageMetadata(10, 5), "run-c");
    expect(rows[0]?.model).toBe("");
  });

  // A value that is not a name at all is not an override: the key is ours, but the metadata bag is
  // shared with every other handler on the turn.
  test("a non-string override is ignored", async () => {
    const rows: UsageRow[] = [];
    const c = capture(rows, "gpt-5.4-mini");
    await c.handleLLMStart({}, [], "run-d", undefined, undefined, undefined, {
      [KEY]: 7,
    });
    await c.handleLLMEnd(resultWithUsageMetadata(10, 5), "run-d");
    expect(rows[0]?.model).toBe("gpt-5.4-mini");
  });

  // One run's override must not reach another's: the semaphore lets several calls share a turn, and
  // the primary's row would otherwise inherit whatever the fallback last announced.
  test("the override is per run", async () => {
    const rows: UsageRow[] = [];
    const c = capture(rows, "gpt-5.4-mini");
    await c.handleLLMStart({}, [], "run-e", undefined, undefined, undefined, {
      [KEY]: "claude-haiku-4-5",
    });
    await c.handleLLMEnd(resultWithUsageMetadata(10, 5), "run-e");
    await c.handleLLMEnd(resultWithUsageMetadata(10, 5), "run-f");
    expect(rows.map((r) => r.model)).toEqual([
      "claude-haiku-4-5",
      "gpt-5.4-mini",
    ]);
  });
});
