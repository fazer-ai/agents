import { describe, expect, test } from "bun:test";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import {
  callCostUsd,
  deepseekOffPeak,
  modelRates,
  PRICES_READ_AT,
  PRICES_SOURCE,
} from "@/modules/pricing/price";
import {
  PRICE_TABLE_READ_AT,
  PRICE_TABLE_VERSION,
} from "@/modules/pricing/version";

// Issue #863: what a call cost, from the price table the ledger is written with. The table is
// LiteLLM's, pinned; the rows below are held to what each VENDOR's own pricing page said on the day
// the table was read, so a regenerated table that disagrees with the vendor on a default model is a
// red test, not a quietly wrong figure on every turn.

const WEEKDAY_PEAK = new Date("2026-09-24T07:30:00Z"); // Thursday, 07:30 UTC
const WEEKDAY_OFF = new Date("2026-09-24T12:00:00Z"); // Thursday, noon UTC
const SATURDAY = new Date("2026-09-26T07:30:00Z");

const tokens = (
  promptTokens: number,
  completionTokens: number,
  cachedReadTokens = 0,
  cacheCreationTokens = 0,
) => ({
  promptTokens,
  completionTokens,
  cachedReadTokens,
  cacheCreationTokens,
});

describe("the table", () => {
  // The console names the table from `version.ts`, which is written beside the table so the browser
  // does not ship it; both files come from one run of the script, and this holds them to it.
  test("the version the rows record is the table's own", () => {
    expect(PRICE_TABLE_READ_AT).toBe(PRICES_READ_AT);
    const sha = /\/blob\/([0-9a-f]{12})/.exec(PRICES_SOURCE)?.[1];
    expect(PRICE_TABLE_VERSION).toBe(`litellm@${sha}`);
  });

  test("says where it came from and when", () => {
    expect(PRICES_SOURCE).toMatch(
      /^https:\/\/github\.com\/BerriAI\/litellm\/blob\/[0-9a-f]{40}\//,
    );
    expect(PRICES_READ_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // USD per million, as each vendor's page states them (read 2026-09-25):
  // developers.openai.com/api/docs/pricing, platform.claude.com/docs/en/about-claude/pricing,
  // ai.google.dev/gemini-api/docs/pricing.
  test.each([
    [
      "openai",
      "gpt-5.6-luna",
      { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
    ],
    [
      "openai",
      "gpt-6-luna",
      { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
    ],
    [
      "openai",
      "gpt-5.4-mini",
      { input: 0.75, cachedInput: 0.075, output: 4.5 },
    ],
    ["openai", "gpt-4o-mini", { input: 0.15, cachedInput: 0.075, output: 0.6 }],
    [
      "anthropic",
      "claude-sonnet-4-6",
      { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
    ],
    [
      "google",
      "gemini-3.5-flash",
      { input: 1.5, cachedInput: 0.15, output: 9 },
    ],
    [
      "openrouter",
      "openai/gpt-5.6-luna",
      { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
    ],
  ])("%s %s carries the vendor's rates", (provider, model, rates) => {
    expect(modelRates(provider, model)).toMatchObject(rates);
  });

  test("every provider default with a published price is in the table", () => {
    for (const [provider, model] of Object.entries(PROVIDER_DEFAULT_MODEL)) {
      if (provider === "openai-compatible" || provider === "deepseek") continue;
      expect(modelRates(provider, model)).not.toBeNull();
    }
  });
});

describe("a call's cost", () => {
  test("each rate multiplies its own share, and the cache counts are parts of the input", () => {
    // 10,000 in, of which 6,000 read from the cache and 1,000 written to it, 500 out.
    const cost = callCostUsd(
      "anthropic",
      "claude-sonnet-4-6",
      tokens(10_000, 500, 6_000, 1_000),
      WEEKDAY_OFF,
    );
    expect(cost).toBeCloseTo(
      (3_000 * 3 + 6_000 * 0.3 + 1_000 * 3.75 + 500 * 15) / 1e6,
      12,
    );
  });

  test("a call past the long-context threshold is priced at the long-context rates", () => {
    const at = WEEKDAY_OFF;
    expect(
      callCostUsd("openai", "gpt-5.6-luna", tokens(272_000, 100), at),
    ).toBeCloseTo((272_000 * 0.2 + 100 * 1.2) / 1e6, 12);
    expect(
      callCostUsd("openai", "gpt-5.6-luna", tokens(300_000, 100), at),
    ).toBeCloseTo((300_000 * 0.4 + 100 * 1.8) / 1e6, 12);
  });

  test("Google's models are found by the model factory's name and by the image reader's", () => {
    const expected = (1_000 * 1.5 + 100 * 9) / 1e6;
    for (const provider of ["google", "gemini"]) {
      expect(
        callCostUsd(
          provider,
          "gemini-3.5-flash",
          tokens(1_000, 100),
          WEEKDAY_OFF,
        ),
      ).toBeCloseTo(expected, 12);
    }
  });

  test("what the table cannot price is null, never zero", () => {
    expect(
      callCostUsd("openai", "not-a-model", tokens(1_000, 100), WEEKDAY_OFF),
    ).toBeNull();
    // Whatever the operator's own server is, even when it calls itself by a priced name.
    expect(
      callCostUsd(
        "openai-compatible",
        "gpt-4o-mini",
        tokens(1_000, 100),
        WEEKDAY_OFF,
      ),
    ).toBeNull();
    // A cache write on a model whose row has no cache-write rate.
    expect(
      callCostUsd(
        "openai",
        "gpt-4o-mini",
        tokens(1_000, 100, 0, 256),
        WEEKDAY_OFF,
      ),
    ).toBeNull();
    // A cache read on a model with no cached rate.
    expect(
      callCostUsd(
        "openai",
        "gpt-5.5-pro",
        tokens(1_000, 100, 512),
        WEEKDAY_OFF,
      ),
    ).toBeNull();
  });
});

describe("DeepSeek's hours", () => {
  // api-docs.deepseek.com/quick_start/pricing (read 2026-09-25): peak is 01:00-04:00 and 06:00-10:00
  // UTC on weekdays, and off-peak is half.
  test("peak and off-peak", () => {
    expect(deepseekOffPeak(new Date("2026-09-24T00:59:00Z"))).toBe(true);
    expect(deepseekOffPeak(new Date("2026-09-24T01:00:00Z"))).toBe(false);
    expect(deepseekOffPeak(new Date("2026-09-24T03:59:00Z"))).toBe(false);
    expect(deepseekOffPeak(new Date("2026-09-24T04:00:00Z"))).toBe(true);
    expect(deepseekOffPeak(new Date("2026-09-24T05:59:00Z"))).toBe(true);
    expect(deepseekOffPeak(new Date("2026-09-24T06:00:00Z"))).toBe(false);
    expect(deepseekOffPeak(new Date("2026-09-24T09:59:00Z"))).toBe(false);
    expect(deepseekOffPeak(WEEKDAY_PEAK)).toBe(false);
    expect(deepseekOffPeak(new Date("2026-09-24T10:00:00Z"))).toBe(true);
    expect(deepseekOffPeak(SATURDAY)).toBe(true);
  });

  test("off-peak is half the table's peak price", () => {
    const peak = callCostUsd(
      "deepseek",
      "deepseek-flash",
      tokens(1_000, 100),
      WEEKDAY_PEAK,
    );
    expect(peak).toBeCloseTo((1_000 * 0.3 + 100 * 1.2) / 1e6, 12);
    expect(
      callCostUsd("deepseek", "deepseek-flash", tokens(1_000, 100), SATURDAY),
    ).toBeCloseTo((peak as number) / 2, 12);
  });
});
