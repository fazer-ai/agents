// Which series a dashboard chart draws in a colour of its own, in what order, and what its tooltip
// and its day detail list: ranked once per window by total, the smallest past the palette grouped
// into one "Other", always last; a colour follows the series, never its rank. Every vertical list
// reads the chart as drawn, top to bottom. The rules and the reasons are in docs/dashboard.md.

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

export interface Arranged<T> {
  // The series drawn in a colour of their own, largest window total first (the base of a stack).
  kept: SeriesDef[];
  // The "Other" group, largest first; empty when everything fits the palette.
  folded: SeriesDef[];
  // The palette slot of each kept series.
  slot: Map<string, number>;
  // The rows, with the group's sum under OTHER_KEY when `sum` was asked and there is a group.
  rows: T[];
}

// Ranks a chart's series by window total (a tie keeps the caller's order) and splits off the group.
// Grouping one series alone would only rename it, so a chart over the limit keeps one slot fewer and
// the group always holds two or more.
export function arrangeSeries<T extends Row>(
  rows: T[],
  series: SeriesDef[],
  slots: number,
  sum: boolean,
): Arranged<T> {
  const ranked = series
    .map((s, i) => ({ s, i, total: windowTotal(rows, s.key) }))
    .sort((a, b) => b.total - a.total || a.i - b.i);
  const keep = series.length <= slots ? series.length : slots - 1;
  const kept = ranked.slice(0, keep);
  const folded = ranked.slice(keep).map((r) => r.s);
  const slot = new Map(
    [...kept].sort((a, b) => a.i - b.i).map((r, n) => [r.s.key, n] as const),
  );
  const out =
    sum && folded.length > 0
      ? rows.map((r) => {
          let total: number | null = null;
          for (const s of folded) {
            const v = numeric(r[s.key]);
            if (v !== null) total = (total ?? 0) + v;
          }
          return { ...r, [OTHER_KEY]: total };
        })
      : rows;
  return { kept: kept.map((r) => r.s), folded, slot, rows: out };
}

export interface TooltipItem {
  key: string;
  label: string;
  color: string;
  value: unknown;
}

export interface TooltipSummary {
  rows: (TooltipItem & { value: number })[];
  // The one "Other" line: how many series it holds, and their sum on a stack (null on a line chart,
  // whose values do not add up). Null when the group has nothing to show that day.
  other: { count: number; value: number | null } | null;
}

// A stack's tooltip, top to bottom as the stack is drawn: "Other" first, then the kept series from
// the top layer down to the base. `kept` comes base first. A zero segment is not drawn and not
// listed. Past `max` lines, the layers nearest the group (the smallest kept) join it.
export function stackSummary(
  kept: TooltipItem[],
  group: { count: number; value: unknown } | null,
  max: number,
): TooltipSummary {
  const present = kept
    .map((it) => ({ ...it, value: numeric(it.value) }))
    .filter(
      (it): it is TooltipItem & { value: number } =>
        it.value !== null && it.value !== 0,
    );
  const groupValue = group ? numeric(group.value) : null;
  const groupShown = !!group && groupValue !== null && groupValue !== 0;
  const room =
    present.length + (groupShown ? 1 : 0) > max ? max - 1 : present.length;
  const shown = present.slice(0, room);
  const cut = present.slice(room);
  const count = (group?.count ?? 0) + cut.length;
  const value =
    (groupShown ? (groupValue ?? 0) : 0) + cut.reduce((a, r) => a + r.value, 0);
  return {
    rows: shown.reverse(),
    other: groupShown || cut.length > 0 ? { count, value } : null,
  };
}

// A line chart's tooltip, top to bottom as the lines sit on that day: the highest value first. A
// zero is a value there (a rate that fell to 0%). The context lines and whatever does not fit `max`
// form the one "Other" line, last, with no value.
export function lineSummary(
  kept: TooltipItem[],
  context: number,
  max: number,
): TooltipSummary {
  const present = kept
    .map((it, i) => ({ it: { ...it, value: numeric(it.value) }, i }))
    .filter(
      (x): x is { it: TooltipItem & { value: number }; i: number } =>
        x.it.value !== null,
    )
    .sort((a, b) => b.it.value - a.it.value || a.i - b.i)
    .map((x) => x.it);
  const room =
    present.length + (context > 0 ? 1 : 0) > max ? max - 1 : present.length;
  const count = context + present.length - room;
  return {
    rows: present.slice(0, room),
    other: count > 0 ? { count, value: null } : null,
  };
}

export interface DetailRow {
  key: string;
  label: string;
  value: number;
  share: number | null;
  // True for a series inside the "Other" group, listed under it.
  member: boolean;
}

// The day detail of a stack: every series, top to bottom as drawn, the group's members under its
// own line (smallest first, as they would stack), each with its value and its share of the day.
export function stackDetail(
  row: Row,
  kept: SeriesDef[],
  folded: SeriesDef[],
): { total: number; group: DetailRow | null; rows: DetailRow[] } {
  const total = [...kept, ...folded].reduce(
    (a, s) => a + (numeric(row[s.key]) ?? 0),
    0,
  );
  const line = (s: SeriesDef, member: boolean): DetailRow => {
    const value = numeric(row[s.key]) ?? 0;
    return {
      key: s.key,
      label: s.label,
      value,
      share: total > 0 ? value / total : null,
      member,
    };
  };
  const members = [...folded].reverse().map((s) => line(s, true));
  const groupValue = members.reduce((a, r) => a + r.value, 0);
  return {
    total,
    group:
      folded.length > 0
        ? {
            key: OTHER_KEY,
            label: "",
            value: groupValue,
            share: total > 0 ? groupValue / total : null,
            member: false,
          }
        : null,
    rows: [...members, ...[...kept].reverse().map((s) => line(s, false))],
  };
}
