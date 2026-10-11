import { describe, expect, test } from "bun:test";
import type { Entry } from "@/../scripts/price-sources";
import {
  countBySource,
  litellmModels,
  openrouterModels,
  rowsHash,
} from "@/../scripts/price-sources";
import { implausibleSource } from "@/../scripts/refresh-guard";
import { costAt, type PricedTokens } from "@/modules/pricing/price";

// The two reads the price table is built from: OpenRouter's rows from OpenRouter's models API, the
// rest from LiteLLM. The shapes below are the ones each source answers.

const tokens = (promptTokens: number, extra: Partial<PricedTokens> = {}) =>
  ({
    promptTokens,
    completionTokens: 1_000,
    cachedReadTokens: 0,
    cacheCreationTokens: 0,
    ...extra,
  }) as PricedTokens;

function rowOf(rows: Record<string, Entry>, key: string): Entry {
  const row = rows[key];
  if (!row) throw new Error(`no row for ${key}`);
  return row;
}

const SONNET = {
  id: "anthropic/claude-sonnet-4.5",
  pricing: {
    prompt: "0.000003",
    completion: "0.000015",
    web_search: "0.01",
    input_cache_read: "0.0000003",
    input_cache_write: "0.00000375",
    input_cache_write_1h: "0.000006",
    overrides: [
      {
        min_prompt_tokens: 200000,
        prompt: "0.000006",
        completion: "0.0000225",
        input_cache_read: "0.0000006",
        input_cache_write: "0.0000075",
        input_cache_write_1h: "0.000012",
      },
    ],
  },
};

describe("OpenRouter's models API", () => {
  test("a model is keyed the way the runtime looks an OpenRouter call up, in USD per million", () => {
    const rows = openrouterModels({ data: [SONNET] });
    expect(Object.keys(rows)).toEqual([
      "openrouter/anthropic/claude-sonnet-4.5",
    ]);
    const row = rowOf(rows, "openrouter/anthropic/claude-sonnet-4.5");
    expect(row).toMatchObject({
      input: 3,
      output: 15,
      cachedInput: 0.3,
      cacheWrite: 3.75,
      cacheWrite1h: 6,
    });
    expect(
      costAt(row, tokens(100_000, { completionTokens: 10_000 }), false),
    ).toBeCloseTo(0.3 + 0.15, 9);
  });

  test("the long-context override applies above min_prompt_tokens, as the vendors bill it", () => {
    const row = rowOf(
      openrouterModels({ data: [SONNET] }),
      "openrouter/anthropic/claude-sonnet-4.5",
    );
    const at = costAt(row, tokens(200_000, { completionTokens: 0 }), false);
    const past = costAt(row, tokens(200_001, { completionTokens: 0 }), false);
    expect(at).toBeCloseTo(200_000 * 3e-6, 9);
    expect(past).toBeCloseTo(200_001 * 6e-6, 9);
  });

  test("a time-window override is not a tier: the base rate prices every hour", () => {
    const rows = openrouterModels({
      data: [
        {
          id: "deepseek/deepseek-v4-pro-0813",
          pricing: {
            prompt: "0.00000132",
            completion: "0.00000396",
            overrides: [
              {
                utc_days: ["saturday", "sunday"],
                prompt: "0.00000066",
                completion: "0.00000198",
              },
              {
                utc_start: 0,
                utc_end: 100,
                min_prompt_tokens: 1,
                prompt: "0.00000066",
                completion: "0.00000198",
              },
            ],
          },
        },
      ],
    });
    const row = rowOf(rows, "openrouter/deepseek/deepseek-v4-pro-0813");
    expect(row.tiers).toBeUndefined();
    expect(
      costAt(row, tokens(1_000_000, { completionTokens: 0 }), false),
    ).toBeCloseTo(1.32, 6);
  });

  test("a router priced per request, or a model with no price, gets no row", () => {
    const rows = openrouterModels({
      data: [
        { id: "openrouter/auto", pricing: { prompt: "-1", completion: "-1" } },
        { id: "no/completion", pricing: { prompt: "0.000001" } },
        { id: "no/pricing" },
        { id: "free/model:free", pricing: { prompt: "0", completion: "0" } },
      ],
    });
    expect(Object.keys(rows)).toEqual(["openrouter/free/model:free"]);
    expect(rows["openrouter/free/model:free"]).toEqual({ input: 0, output: 0 });
  });

  test("an answer that is not a model list reads as no models", () => {
    expect(openrouterModels({ error: "rate limited" })).toEqual({});
    expect(openrouterModels(null)).toEqual({});
    expect(openrouterModels("<html>")).toEqual({});
  });
});

describe("LiteLLM's table", () => {
  test("an OpenRouter row in LiteLLM is ignored, so openrouter/ keys have one source", () => {
    const rows = litellmModels({
      "gpt-x": {
        mode: "chat",
        litellm_provider: "openai",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 8e-6,
      },
      "openrouter/openai/gpt-x": {
        mode: "chat",
        litellm_provider: "openrouter",
        input_cost_per_token: 9e-6,
        output_cost_per_token: 9e-6,
      },
    });
    expect(rows).toEqual({ "gpt-x": { input: 1, output: 8 } });
  });

  test("a long-context rate is a tier above its threshold", () => {
    const rows = litellmModels({
      "gemini/gemini-y": {
        mode: "chat",
        litellm_provider: "gemini",
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        input_cost_per_token_above_200k_tokens: 2e-6,
        output_cost_per_token_above_200k_tokens: 4e-6,
      },
    });
    expect(rowOf(rows, "gemini/gemini-y").tiers).toEqual([
      { above: 200_000, input: 2, output: 4 },
    ]);
  });
});

describe("the refresh guard, per source", () => {
  test("LiteLLM's read without OpenRouter's rows is a real read once OpenRouter supplies them", () => {
    // The table before OpenRouter left LiteLLM: 195 LiteLLM rows and 486 OpenRouter ones.
    expect(
      implausibleSource(
        { litellm: 195, openrouter: 458 },
        { litellm: 195, openrouter: 486 },
      ),
    ).toBeNull();
  });

  test("a broken OpenRouter read is refused even when LiteLLM's read is whole", () => {
    expect(
      implausibleSource(
        { litellm: 195, openrouter: 0 },
        { litellm: 195, openrouter: 486 },
      ),
    ).toBe("OpenRouter");
  });

  test("a broken LiteLLM read is refused even when OpenRouter's read is whole", () => {
    expect(
      implausibleSource(
        { litellm: 20, openrouter: 458 },
        { litellm: 195, openrouter: 486 },
      ),
    ).toBe("LiteLLM");
  });

  test("rows are counted by the source their key belongs to", () => {
    expect(
      countBySource({ "gpt-x": {}, "openrouter/a/b": {}, "openrouter/c": {} }),
    ).toEqual({ litellm: 1, openrouter: 2 });
  });
});

test("an OpenRouter read is identified by its rows, not by when it ran", () => {
  const a = openrouterModels({ data: [SONNET] });
  const b = openrouterModels({ data: [SONNET] });
  const moved = openrouterModels({
    data: [{ ...SONNET, pricing: { ...SONNET.pricing, prompt: "0.0000031" } }],
  });
  expect(rowsHash(a)).toBe(rowsHash(b));
  expect(rowsHash(a)).not.toBe(rowsHash(moved));
});
