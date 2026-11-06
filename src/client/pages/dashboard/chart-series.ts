// Which series a dashboard chart draws in a colour of its own, and what its tooltip lists. Kept out
// of the components so the rules are a table, not a render.
//
// A chart has CATEGORICAL_SLOTS distinct hues and never cycles them: past that count, a stacked
// chart folds its smallest series (by their total over the window) into one "Other" in a neutral
// colour, since a stack's segments add up; a line chart cannot add rates, so its later series are
// drawn as neutral context lines with no identity of their own. The table view and the CSV are built
// by the callers from the unfolded series, so they keep every one.

export const OTHER_KEY = "__other";

// How many distinct series colours a chart has: the `--color-chart-1` to `--color-chart-8` tokens of
// `public/index.css`, never cycled.
export const CATEGORICAL_SLOTS = 8;

export interface SeriesDef {
  key: string;
  label: string;
}

type Row = { [series: string]: unknown };

function numeric(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function windowTotal(rows: Row[], key: string): number {
  let sum = 0;
  for (const r of rows) sum += numeric(r[key]) ?? 0;
  return sum;
}

// The series a stacked chart keeps, in the caller's order (a colour follows its series, not its
// rank), and the ones folded into "Other". Folding one series alone would only rename it, so a chart
// over the limit keeps one slot fewer and "Other" always holds two or more.
export function foldStacked<T extends Row>(
  rows: T[],
  series: SeriesDef[],
  slots: number,
  otherLabel: string,
): { series: SeriesDef[]; rows: T[]; folded: SeriesDef[] } {
  if (series.length <= slots) return { series, rows, folded: [] };
  const keep = slots - 1;
  const ranked = series
    .map((s, i) => ({ s, i, total: windowTotal(rows, s.key) }))
    .sort((a, b) => b.total - a.total || a.i - b.i);
  const kept = new Set(ranked.slice(0, keep).map((r) => r.s.key));
  const folded = series.filter((s) => !kept.has(s.key));
  const out = rows.map((r) => {
    let sum: number | null = null;
    for (const s of folded) {
      const v = numeric(r[s.key]);
      if (v !== null) sum = (sum ?? 0) + v;
    }
    return { ...r, [OTHER_KEY]: sum };
  });
  return {
    series: [
      ...series.filter((s) => kept.has(s.key)),
      { key: OTHER_KEY, label: otherLabel },
    ],
    rows: out,
    folded,
  };
}

export interface TooltipItem {
  key: string;
  label: string;
  color: string;
  value: unknown;
  // What the row shows; the value alone when absent.
  text?: string;
}

// The rows of a tooltip: the series with a value on that day, the largest first, at most `max` of
// them, and what is left over as a count and a sum. A zero segment of a stack is nothing to show; a
// zero on a line (a rate that fell to 0%) is a value, so `keepZero` keeps it.
export function tooltipRows(
  items: TooltipItem[],
  max: number,
  keepZero = false,
): {
  rows: (TooltipItem & { value: number })[];
  rest: { count: number; sum: number };
} {
  const present = items
    .map((it, i) => ({ it, i, v: numeric(it.value) }))
    .filter(
      (x): x is { it: TooltipItem; i: number; v: number } =>
        x.v !== null && (keepZero || x.v !== 0),
    )
    .sort((a, b) => Math.abs(b.v) - Math.abs(a.v) || a.i - b.i);
  const shown = present.length > max ? max - 1 : present.length;
  const rest = present.slice(shown);
  return {
    rows: present.slice(0, shown).map((x) => ({ ...x.it, value: x.v })),
    rest: {
      count: rest.length,
      sum: rest.reduce((a, x) => a + x.v, 0),
    },
  };
}
