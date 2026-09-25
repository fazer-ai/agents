#!/usr/bin/env bun
// What a refresh of the price table changed, as the Markdown body of the pull request the weekly
// price refresh opens (issue #869). Also useful by hand after running
// scripts/refresh-model-prices.ts, against the table as it was before:
//
//   git show HEAD:src/modules/pricing/model-prices.json > old.json
//   bun scripts/diff-model-prices.ts old.json src/modules/pricing/model-prices.json
//   bun scripts/diff-model-prices.ts --changed old.json src/modules/pricing/model-prices.json
//
// The second form prints `true` or `false` and nothing else: whether any model's rates moved. A
// refresh always rewrites the source commit and the date it was read, because LiteLLM's file changes
// most days for providers this table does not keep; that alone is not a change worth a review.
//
// The provider defaults come first, because they are what an operator who never picked a model is
// billed at, and they are the rows tests/modules/pricing.test.ts holds to the vendors' own pages.

import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";
import { tableKeys } from "@/modules/pricing/price";

type Rates = {
  input: number;
  cachedInput?: number;
  cacheWrite?: number;
  output: number;
};
type Entry = Rates & { tiers?: (Rates & { above: number })[] };

export interface PriceTable {
  source: string;
  readAt: string;
  models: Record<string, Entry>;
}

export interface PriceDiff {
  changed: boolean;
  markdown: string;
}

// GitHub refuses a pull request body past 65,536 characters. The first refresh after a long gap can
// add a hundred models; the diff on the PR still has every row.
export const BODY_LIMIT = 60_000;

const RATE_FIELDS: [keyof Rates, string][] = [
  ["input", "input"],
  ["cachedInput", "cached input"],
  ["cacheWrite", "cache write"],
  ["output", "output"],
];

const usd = (v: number | undefined): string =>
  v === undefined ? "none" : `$${v}`;

const thousands = (above: number): string =>
  above % 1000 === 0 ? `${above / 1000}K` : String(above);

// Every rate a row carries, flattened to a label, so two rows compare field by field and a tier that
// appears or disappears reads as its rates going from "none" to a price or back.
function flatten(entry: Entry | undefined): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  if (!entry) return out;
  for (const [field, label] of RATE_FIELDS) out.set(label, entry[field]);
  for (const tier of entry.tiers ?? []) {
    for (const [field, label] of RATE_FIELDS) {
      out.set(`${label} above ${thousands(tier.above)}`, tier[field]);
    }
  }
  return out;
}

interface RateChange {
  rate: string;
  old: number | undefined;
  new: number | undefined;
}

function rateChanges(a: Entry | undefined, b: Entry | undefined): RateChange[] {
  const fa = flatten(a);
  const fb = flatten(b);
  const labels = [...new Set([...fa.keys(), ...fb.keys()])];
  return labels
    .filter((l) => fa.get(l) !== fb.get(l))
    .map((l) => ({ rate: l, old: fa.get(l), new: fb.get(l) }));
}

// The row a provider's default is priced from, found the way the runtime finds it: the first of the
// provider's candidate keys the table carries.
function resolveKey(
  provider: string,
  model: string,
  models: Record<string, Entry>,
): string | undefined {
  return tableKeys(provider, model).find((k) => k in models);
}

const rateList = (entry: Rates): string =>
  RATE_FIELDS.map(([f, label]) => `${label} ${usd(entry[f])}`).join(", ");

function rowCells(entry: Entry): string {
  const tiers = (entry.tiers ?? [])
    // All four rates: a long-context call is priced from the tier's own, cache included.
    .map((t) => `above ${thousands(t.above)}: ${rateList(t)}`)
    .join("; ");
  return `${RATE_FIELDS.map(([f]) => usd(entry[f])).join(" | ")} | ${tiers || "none"}`;
}

const ROW_HEADER = [
  "| Model | Input | Cached input | Cache write | Output | Long context |",
  "| --- | --- | --- | --- | --- | --- |",
];

const shortSource = (source: string): string =>
  /\/blob\/([0-9a-f]{12})/.exec(source)?.[1] ?? source;

// Whether a refresh that kept `kept` priced models, where the table had `previous`, is a real read.
// A real refresh moves a handful of rows; an empty or truncated source file loses most of them, and
// writing that would have the weekly job propose removing every model it lost.
export function plausibleRefresh(kept: number, previous: number): boolean {
  return kept > 0 && kept >= previous / 2;
}

export function diffModelPrices(
  oldTable: PriceTable,
  newTable: PriceTable,
  defaults: Record<string, string> = PROVIDER_DEFAULT_MODEL,
): PriceDiff {
  const a = oldTable.models;
  const b = newTable.models;
  const added = Object.keys(b)
    .filter((k) => !(k in a))
    .sort();
  const removed = Object.keys(a)
    .filter((k) => !(k in b))
    .sort();
  const changed = Object.keys(b)
    .filter((k) => k in a)
    .sort()
    .map((k) => ({ key: k, changes: rateChanges(a[k], b[k]) }))
    .filter((c) => c.changes.length > 0);

  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    return {
      changed: false,
      markdown: `No model's price changed between litellm@${shortSource(oldTable.source)} and litellm@${shortSource(newTable.source)}.\n`,
    };
  }

  const lines: string[] = [
    `The price table was read again from LiteLLM: litellm@${shortSource(oldTable.source)} (${oldTable.readAt}) to litellm@${shortSource(newTable.source)} (${newTable.readAt}). Rates are USD per million tokens.`,
    "",
    `${changed.length} changed, ${added.length} added, ${removed.length} removed.`,
    "",
    "## Provider defaults",
    "",
    "What an agent that never picked a model is billed at (`src/graph/model-defaults.ts`).",
    "",
    "| Provider | Model | Row | What changed |",
    "| --- | --- | --- | --- |",
  ];
  const defaultKeys = new Set<string>();
  for (const [provider, model] of Object.entries(defaults)) {
    if (!model) continue;
    const before = resolveKey(provider, model, a);
    const after = resolveKey(provider, model, b);
    const key = after ?? before;
    let what: string;
    if (!before && !after) what = "not in the table, so never priced";
    else if (!after) what = `**removed**: its calls lose their price`;
    else if (!before) what = `**added**: ${rateList(b[after] as Entry)}`;
    else {
      const ch = rateChanges(a[before], b[after]);
      what =
        ch.length === 0
          ? "unchanged"
          : `**${ch.map((c) => `${c.rate} ${usd(c.old)} to ${usd(c.new)}`).join(", ")}**`;
    }
    if (before) defaultKeys.add(before);
    if (after) defaultKeys.add(after);
    lines.push(
      `| ${provider} | \`${model}\` | ${key ? `\`${key}\`` : "none"} | ${what} |`,
    );
  }

  // A default's row is told in the table above and nowhere else, so each model appears once.
  const changedRest = changed.filter((c) => !defaultKeys.has(c.key));
  const addedRest = added.filter((k) => !defaultKeys.has(k));
  const removedRest = removed.filter((k) => !defaultKeys.has(k));

  if (changedRest.length > 0) {
    lines.push(
      "",
      "## Changed",
      "",
      "| Model | Rate | Old | New |",
      "| --- | --- | --- | --- |",
    );
    for (const c of changedRest) {
      for (const r of c.changes) {
        lines.push(
          `| \`${c.key}\` | ${r.rate} | ${usd(r.old)} | ${usd(r.new)} |`,
        );
      }
    }
  }
  if (addedRest.length > 0) {
    lines.push("", "## Added", "", ...ROW_HEADER);
    for (const k of addedRest) {
      lines.push(`| \`${k}\` | ${rowCells(b[k] as Entry)} |`);
    }
  }
  if (removedRest.length > 0) {
    lines.push(
      "",
      "## Removed",
      "",
      "A call to one of these is priced as unknown (no cost) from the moment this merges.",
      "",
      ...ROW_HEADER,
    );
    for (const k of removedRest) {
      lines.push(`| \`${k}\` | ${rowCells(a[k] as Entry)} |`);
    }
  }

  let markdown = `${lines.join("\n")}\n`;
  if (markdown.length > BODY_LIMIT) {
    const cut = markdown.lastIndexOf("\n", BODY_LIMIT);
    markdown = `${markdown.slice(0, cut)}\n\nThe summary stops here for length; the file diff has every row.\n`;
  }
  return { changed: true, markdown };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const onlyChanged = args[0] === "--changed";
  const [oldPath, newPath] = onlyChanged ? args.slice(1) : args;
  if (!oldPath || !newPath) {
    console.error(
      "usage: bun scripts/diff-model-prices.ts [--changed] <old.json> <new.json>",
    );
    process.exit(2);
  }
  const diff = diffModelPrices(
    (await Bun.file(oldPath).json()) as PriceTable,
    (await Bun.file(newPath).json()) as PriceTable,
  );
  process.stdout.write(onlyChanged ? `${diff.changed}\n` : diff.markdown);
}
