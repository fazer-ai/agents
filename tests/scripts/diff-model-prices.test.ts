import { describe, expect, test } from "bun:test";
import {
  BODY_LIMIT,
  diffModelPrices,
  type PriceTable,
} from "@/../scripts/diff-model-prices";

// Issue #869: the body of the pull request the weekly price refresh opens. What a reviewer has to
// see is which rates moved, which rows appeared and which went away, with the provider defaults
// first, and a refresh that only moved the source commit must not count as a change at all.

const SHA_OLD = "a".repeat(40);
const SHA_NEW = "b".repeat(40);
const table = (
  sha: string,
  readAt: string,
  models: PriceTable["models"],
): PriceTable => ({
  source: `https://github.com/BerriAI/litellm/blob/${sha}/model_prices_and_context_window.json`,
  readAt,
  models,
});

const DEFAULTS = {
  openai: "gpt-x",
  google: "gemini-y",
  deepseek: "deepseek-chat",
  "openai-compatible": "",
};

const OLD = table(SHA_OLD, "2026-09-18", {
  "gpt-x": {
    input: 1,
    cachedInput: 0.1,
    output: 8,
    tiers: [{ above: 272_000, input: 2, cachedInput: 0.2, output: 12 }],
  },
  "gemini/gemini-y": { input: 0.3, cachedInput: 0.03, output: 2.5 },
  "deepseek-chat": { input: 0.28, cachedInput: 0.028, output: 0.42 },
  "old-model": { input: 5, output: 15 },
  "steady-model": { input: 0.5, output: 1.5 },
});

describe("diffModelPrices", () => {
  test("a refresh that only moved the source commit and the date is no change", () => {
    const next = table(SHA_NEW, "2026-09-25", structuredClone(OLD.models));
    const diff = diffModelPrices(OLD, next, DEFAULTS);
    expect(diff.changed).toBe(false);
    expect(diff.markdown).toBe(
      "No model's price changed between litellm@aaaaaaaaaaaa and litellm@bbbbbbbbbbbb.\n",
    );
  });

  const NEW = table(SHA_NEW, "2026-09-25", {
    "gpt-x": {
      input: 1.25,
      cachedInput: 0.1,
      cacheWrite: 1.5,
      output: 8,
      tiers: [{ above: 272_000, input: 2.5, cachedInput: 0.2, output: 12 }],
    },
    "gemini/gemini-y": { input: 0.3, cachedInput: 0.03, output: 2.5 },
    "deepseek-chat": { input: 0.28, cachedInput: 0.028, output: 0.42 },
    "new-model": { input: 3, cachedInput: 0.3, output: 9 },
    "steady-model": { input: 0.5, output: 1.5 },
  });
  const diff = diffModelPrices(OLD, NEW, DEFAULTS);
  const md = diff.markdown;

  test("counts it as a change and names both ends of the refresh", () => {
    expect(diff.changed).toBe(true);
    expect(md).toContain(
      "litellm@aaaaaaaaaaaa (2026-09-18) to litellm@bbbbbbbbbbbb (2026-09-25)",
    );
    expect(md).toContain("1 changed, 1 added, 1 removed.");
  });

  test("every changed rate is a row with its old and new price, tiers included", () => {
    expect(md).toContain("| `gpt-x` (default) | input | $1 | $1.25 |");
    // A rate the row did not carry before reads as going from none to a price.
    expect(md).toContain("| `gpt-x` (default) | cache write | none | $1.5 |");
    expect(md).toContain(
      "| `gpt-x` (default) | input above 272K | $2 | $2.5 |",
    );
    // Only what moved: the unchanged output rate and the untouched model stay out of the table.
    expect(md).not.toContain("| `gpt-x` (default) | output |");
    expect(md).not.toContain("steady-model");
  });

  test("an added model lists its rates, and a removed one the rates it had", () => {
    const added = md.slice(md.indexOf("## Added"), md.indexOf("## Removed"));
    expect(added).toContain("| `new-model` | $3 | $0.3 | none | $9 | none |");
    const removed = md.slice(md.indexOf("## Removed"));
    expect(removed).toContain(
      "| `old-model` | $5 | none | none | $15 | none |",
    );
  });

  test("the provider defaults come first, each with what happened to its row", () => {
    const defaults = md.indexOf("## Provider defaults");
    expect(defaults).toBeGreaterThan(-1);
    expect(defaults).toBeLessThan(md.indexOf("## Changed"));
    expect(md.indexOf("## Changed")).toBeLessThan(md.indexOf("## Added"));
    expect(md.indexOf("## Added")).toBeLessThan(md.indexOf("## Removed"));

    const section = md.slice(defaults, md.indexOf("## Changed"));
    expect(section).toContain(
      "| openai | `gpt-x` | `gpt-x` | **input $1 to $1.25, cache write none to $1.5, input above 272K $2 to $2.5** |",
    );
    // Found the way the runtime finds it: Google's rows carry the `gemini/` prefix.
    expect(section).toContain(
      "| google | `gemini-y` | `gemini/gemini-y` | unchanged |",
    );
    expect(section).toContain(
      "| deepseek | `deepseek-chat` | `deepseek-chat` | unchanged |",
    );
    // openai-compatible has no default model and no price to report.
    expect(section).not.toContain("openai-compatible");
  });

  test("a default whose row appears or disappears is called out as such", () => {
    const gone = table(SHA_NEW, "2026-09-25", {
      ...structuredClone(OLD.models),
      "gemini/gemini-y": undefined as never,
    });
    delete gone.models["gemini/gemini-y"];
    const lost = diffModelPrices(OLD, gone, DEFAULTS).markdown;
    expect(lost).toContain(
      "| google | `gemini-y` | `gemini/gemini-y` | **removed**: its calls lose their price |",
    );
    expect(lost).toContain(
      "| `gemini/gemini-y` (default) | $0.3 | $0.03 | none | $2.5 | none |",
    );

    const found = diffModelPrices(
      table(SHA_OLD, "2026-09-18", { "steady-model": { input: 1, output: 2 } }),
      table(SHA_NEW, "2026-09-25", {
        "steady-model": { input: 1, output: 2 },
        "gpt-x": { input: 1, output: 8 },
      }),
      DEFAULTS,
    ).markdown;
    expect(found).toContain(
      "| openai | `gpt-x` | `gpt-x` | **added**: input $1, cached input none, cache write none, output $8 |",
    );
    expect(found).toContain(
      "| google | `gemini-y` | none | not in the table, so never priced |",
    );
  });

  test("a body past GitHub's limit is cut on a line and says so", () => {
    const many: PriceTable["models"] = {};
    for (let i = 0; i < 2_000; i++) {
      many[`model-${String(i).padStart(4, "0")}`] = { input: i, output: i };
    }
    const big = diffModelPrices(
      table(SHA_OLD, "2026-09-18", {}),
      table(SHA_NEW, "2026-09-25", many),
      DEFAULTS,
    ).markdown;
    expect(big.length).toBeLessThanOrEqual(BODY_LIMIT + 100);
    expect(big).toEndWith(
      "\n\nThe summary stops here for length; the file diff has every row.\n",
    );
  });
});
