import { describe, expect, test } from "bun:test";
import {
  BODY_LIMIT,
  diffModelPrices,
  type PriceTable,
} from "@/../scripts/diff-model-prices";
import { plausibleRefresh } from "@/../scripts/refresh-guard";

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
  "moved-model": { input: 2, output: 4 },
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
    "moved-model": { input: 2.5, output: 4 },
    "steady-model": { input: 0.5, output: 1.5 },
  });
  const diff = diffModelPrices(OLD, NEW, DEFAULTS);
  const md = diff.markdown;

  test("counts it as a change and names both ends of the refresh", () => {
    expect(diff.changed).toBe(true);
    expect(md).toContain(
      "litellm@aaaaaaaaaaaa (2026-09-18) to litellm@bbbbbbbbbbbb (2026-09-25)",
    );
    expect(md).toContain("2 changed, 1 added, 1 removed.");
  });

  test("every changed rate is a row with its old and new price", () => {
    const changedSection = md.slice(
      md.indexOf("## Changed"),
      md.indexOf("## Added"),
    );
    expect(changedSection).toContain("| `moved-model` | input | $2 | $2.5 |");
    // Only what moved: the unchanged output rate and the untouched model stay out of the table.
    expect(changedSection).not.toContain("| `moved-model` | output |");
    expect(md).not.toContain("steady-model");
  });

  // A default stands out where it appears (marked, listed first) and is still told exactly once,
  // with every rate that moved, tiers and a rate that went from none to a price included.
  test("a default is marked and listed first, and each model appears once", () => {
    const changedSection = md.slice(
      md.indexOf("## Changed"),
      md.indexOf("## Added"),
    );
    expect(changedSection).toContain(
      "| `gpt-x` (default) | input | $1 | $1.25 |",
    );
    expect(changedSection).toContain(
      "| `gpt-x` (default) | cache write | none | $1.5 |",
    );
    expect(changedSection).toContain(
      "| `gpt-x` (default) | input above 272K | $2 | $2.5 |",
    );
    expect(changedSection.indexOf("gpt-x")).toBeLessThan(
      changedSection.indexOf("moved-model"),
    );
    for (const name of ["`gpt-x`", "`new-model`", "`old-model`"])
      expect(md.split(name).length - 1).toBeGreaterThan(0);
    // One row per changed rate, one row per added or removed model, and nothing else names them.
    expect(md.split("`new-model`").length - 1).toBe(1);
    expect(md.split("`old-model`").length - 1).toBe(1);
    expect(md).toContain("Rows marked (default) are what an agent");
    expect(md).not.toContain("## Provider defaults");
  });

  // A default's row that goes away, or moves to another key of the same model, is told as the
  // rows it was, with all its rates (review round 3).
  test("a default whose row disappears or changes key keeps every rate in the summary", () => {
    const moved = diffModelPrices(
      table(SHA_OLD, "2026-09-18", {
        "deepseek-chat": { input: 0.28, cachedInput: 0.028, output: 0.42 },
        "gpt-x": {
          input: 1,
          output: 8,
          tiers: [{ above: 272_000, input: 2, cachedInput: 0.2, output: 12 }],
        },
      }),
      table(SHA_NEW, "2026-09-25", {
        "deepseek/deepseek-chat": {
          input: 0.28,
          cachedInput: 0.028,
          output: 0.42,
        },
      }),
      DEFAULTS,
    ).markdown;
    const added = moved.slice(
      moved.indexOf("## Added"),
      moved.indexOf("## Removed"),
    );
    const removed = moved.slice(moved.indexOf("## Removed"));
    expect(added).toContain("| `deepseek/deepseek-chat` (default) | $0.28 |");
    expect(removed).toContain("| `deepseek-chat` (default) | $0.28 |");
    expect(removed).toContain(
      "above 272K: input $2, cached input $0.2, cache write none, output $12",
    );
  });

  test("an added model lists its rates, and a removed one the rates it had", () => {
    const added = md.slice(md.indexOf("## Added"), md.indexOf("## Removed"));
    expect(added).toContain("| `new-model` | $3 | $0.3 | none | $9 | none |");
    const removed = md.slice(md.indexOf("## Removed"));
    expect(removed).toContain(
      "| `old-model` | $5 | none | none | $15 | none |",
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

// A long-context call is priced from the tier's own rates, cache included, so an added or removed
// row shows all four of them (review round 1).
test("an added model's long-context tier lists its cache rates too", () => {
  const before = table(SHA_OLD, "2026-09-18", {});
  const after = table(SHA_NEW, "2026-09-25", {
    "long-model": {
      input: 1,
      output: 4,
      tiers: [
        {
          above: 200_000,
          input: 2,
          cachedInput: 0.5,
          cacheWrite: 2.5,
          output: 8,
        },
      ],
    },
  });
  const md = diffModelPrices(before, after, DEFAULTS).markdown;
  expect(md).toContain(
    "above 200K: input $2, cached input $0.5, cache write $2.5, output $8",
  );
});

// A source that answers 200 with an empty or truncated file must not become a table with every
// model removed (verification of #869).
test("a default sorts ahead of a model whose name comes first", () => {
  const md = diffModelPrices(
    table(SHA_OLD, "2026-09-18", {
      "aa-model": { input: 1, output: 2 },
      "zz-default": { input: 1, output: 2 },
    }),
    table(SHA_NEW, "2026-09-25", {
      "aa-model": { input: 1.5, output: 2 },
      "zz-default": { input: 1.5, output: 2 },
    }),
    { openai: "zz-default" },
  ).markdown;
  expect(md.indexOf("`zz-default` (default)")).toBeGreaterThan(-1);
  expect(md.indexOf("`zz-default`")).toBeLessThan(md.indexOf("`aa-model`"));
});

test("a refresh that lost most of the table is refused", () => {
  expect(plausibleRefresh(0, 665)).toBe(false);
  expect(plausibleRefresh(300, 665)).toBe(false);
  // Exactly half is kept; one model fewer is not.
  expect(plausibleRefresh(5, 10)).toBe(true);
  expect(plausibleRefresh(4, 10)).toBe(false);
  expect(plausibleRefresh(660, 665)).toBe(true);
  expect(plausibleRefresh(700, 665)).toBe(true);
  // The very first read has nothing to compare with, but still needs a model.
  expect(plausibleRefresh(10, 0)).toBe(true);
  expect(plausibleRefresh(0, 0)).toBe(false);
});
