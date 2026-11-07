import { X } from "lucide-react";
import {
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Dot,
  type DotProps,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  usePlotArea,
  XAxis,
  YAxis,
} from "recharts";
import { Popover } from "@/client/components/Popover";
import { useTheme } from "@/client/contexts/ThemeContext";
import {
  type Arranged,
  arrangeSeries,
  CATEGORICAL_SLOTS,
  lineSummary,
  OTHER_KEY,
  type SeriesDef,
  stackDetail,
  stackSummary,
  type TooltipSummary,
} from "./chart-series";
import type { DayState } from "./useStream";

// The dashboard's charts, in their own chunk (recharts is heavy and only this page draws). Colours
// come from the theme's CSS variables, read again when the theme flips, so axes, grid and series
// follow light and dark. Every chart sits inside a <Block>, which gives a screen reader the same
// figures as a table.

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

export function useChartPalette() {
  const { resolvedTheme } = useTheme();
  // biome-ignore lint/correctness/useExhaustiveDependencies: resolvedTheme is the re-read trigger; cssVar reads live DOM.
  return useMemo(
    () => ({
      grid: cssVar("--color-border", "#262626"),
      axis: cssVar("--color-text-muted", "#666666"),
      tooltipBg: cssVar("--color-bg-secondary", "#111111"),
      tooltipBorder: cssVar("--color-border-hover", "#333333"),
      text: cssVar("--color-text-primary", "#eeeeee"),
      textSecondary: cssVar("--color-text-secondary", "#a3a3a3"),
      // A day still loading, and a day with no data for good: the same tokens in both themes.
      loading: cssVar("--color-info", "#828fff"),
      loadingSoft: cssVar("--color-info-soft", "#5e6ad233"),
      noData: cssVar("--color-warning", "#f2c94c"),
      noDataSoft: cssVar("--color-warning-soft", "#f2c94c24"),
      accent: cssVar("--color-accent", "#3ea6ff"),
      error: cssVar("--color-error", "#ef4444"),
      // Series colours in their fixed order, never cycled (chart-series.ts).
      series: Array.from({ length: CATEGORICAL_SLOTS }, (_, i) =>
        cssVar(`--color-chart-${i + 1}`, "#808080"),
      ),
      // What has no identity of its own: a stack's "Other", a line chart's context lines.
      other: cssVar("--color-text-muted", "#666666"),
    }),
    [resolvedTheme],
  );
}

export type { SeriesDef };

export interface ChartRow {
  // Local day key, YYYY-MM-DD.
  day: string;
  // The same position in the previous period, when there is one.
  prevDay?: string | null;
  // A day without its figures: still loading, or with no data for good. It keeps its place on the
  // axis, marked, rather than dropping out and squeezing the series.
  state?: DayState;
  [series: string]: number | string | null | undefined;
}

type Marked = Exclude<DayState, "ready">;

// The runs of consecutive days in the same state, each drawn as one band.
export function stateRuns(
  data: ChartRow[],
): { state: Marked; first: string; last: string; days: number }[] {
  const out: { state: Marked; first: string; last: string; days: number }[] =
    [];
  for (const [i, row] of data.entries()) {
    const state = row.state;
    if (!state || state === "ready") continue;
    const prev = out[out.length - 1];
    if (prev && prev.state === state && data[i - 1]?.day === prev.last) {
      prev.last = row.day;
      prev.days++;
    } else out.push({ state, first: row.day, last: row.day, days: 1 });
  }
  return out;
}

// The vertical scale only grows while a window fills, so it does not jump at every part: it is reset
// when the window or its series change.
function useSettledMax(resetKey: string) {
  const max = useRef({ key: resetKey, value: 0 });
  if (max.current.key !== resetKey) max.current = { key: resetKey, value: 0 };
  return (dataMax: number) => {
    const v = Number.isFinite(dataMax) ? dataMax : 0;
    max.current.value = Math.max(max.current.value, niceCeil(v));
    // A chart with nothing in yet still has a scale, so its bands have a height to fill.
    return max.current.value > 0 ? max.current.value : 1;
  };
}

// The top of the scale on a round step (1, 2, 2.5 or 5 times a power of ten), so a new part moves it
// only when its figures pass that step.
export function niceCeil(v: number): number {
  if (v <= 0) return 0;
  const exp = 10 ** Math.floor(Math.log10(v));
  const f = v / exp;
  const step = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return step * exp;
}

function useDayStateText() {
  const { t } = useTranslation();
  return {
    loading: t("dashboard.chart.loading", "loading"),
    loadingTip: t("dashboard.chart.loadingTip", "computing…"),
    noData: t("dashboard.chart.noData", "no data"),
    noDataTip: t(
      "dashboard.chart.noDataTip",
      "no data: retention cleared this day's Logs before it was kept",
    ),
  };
}

// The bands of the days without figures, and their patterns: diagonal hatching for a day loading,
// dots for one with no data for good, each with a word on it where it fits.
function stateBands(
  data: ChartRow[],
  ids: { loading: string; noData: string },
  p: ReturnType<typeof useChartPalette>,
  text: ReturnType<typeof useDayStateText>,
) {
  return stateRuns(data).map((r) => (
    <ReferenceArea
      key={`${r.state}-${r.first}`}
      x1={r.first}
      x2={r.last}
      ifOverflow="visible"
      // Clicks pass through to the day columns underneath, which say which day it was.
      className="pointer-events-none"
      fill={`url(#${r.state === "loading" ? ids.loading : ids.noData})`}
      fillOpacity={1}
      stroke={r.state === "loading" ? p.loading : p.noData}
      strokeOpacity={0.5}
      label={
        r.days >= 3
          ? {
              value: r.state === "loading" ? text.loading : text.noData,
              position: "insideTop",
              // Drawn in a layer of its own, above the day columns, so it lets the click through too.
              className: "pointer-events-none",
              fill: r.state === "loading" ? p.loading : p.noData,
              fontSize: 11,
            }
          : undefined
      }
    />
  ));
}

function StatePatterns({
  ids,
  p,
}: {
  ids: { loading: string; noData: string };
  p: ReturnType<typeof useChartPalette>;
}) {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        <pattern
          id={ids.loading}
          patternUnits="userSpaceOnUse"
          width="8"
          height="8"
          patternTransform="rotate(45)"
        >
          <rect width="8" height="8" fill={p.loadingSoft} />
          <line
            x1="0"
            y1="0"
            x2="0"
            y2="8"
            stroke={p.loading}
            strokeWidth="2"
            strokeOpacity="0.45"
          />
        </pattern>
        <pattern
          id={ids.noData}
          patternUnits="userSpaceOnUse"
          width="6"
          height="6"
        >
          <rect width="6" height="6" fill={p.noDataSoft} />
          <circle cx="3" cy="3" r="1.4" fill={p.noData} fillOpacity="0.75" />
        </pattern>
      </defs>
    </svg>
  );
}

// Under the chart, what its marks mean and how many days each covers. Shown only while there is one.
function StateLegend({
  data,
  p,
  ids,
}: {
  data: ChartRow[];
  p: ReturnType<typeof useChartPalette>;
  ids: { loading: string; noData: string };
}) {
  const { t } = useTranslation();
  const loading = data.filter((r) => r.state === "loading").length;
  const noData = data.filter((r) => r.state === "noData").length;
  if (loading === 0 && noData === 0) return null;
  const swatch = (id: string, stroke: string) => (
    <svg width="14" height="10" aria-hidden="true">
      <rect
        width="14"
        height="10"
        rx="2"
        fill={`url(#${id})`}
        stroke={stroke}
        strokeOpacity="0.5"
      />
    </svg>
  );
  return (
    <ul className="text-text-muted flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {loading > 0 && (
        <li className="inline-flex items-center gap-1.5">
          {swatch(ids.loading, p.loading)}
          {t("dashboard.chart.loadingDays", "loading · {{count}} days", {
            count: loading,
          })}
        </li>
      )}
      {noData > 0 && (
        <li className="inline-flex items-center gap-1.5">
          {swatch(ids.noData, p.noData)}
          {t("dashboard.chart.noDataDays", "no data · {{count}} days", {
            count: noData,
          })}
        </li>
      )}
    </ul>
  );
}

// A chart with no series in yet plots a zero on every day under a series of its own, drawn as
// nothing: without a value to scale, the chart has no vertical axis, and the bands of the days still
// loading or with no data have nothing to be drawn against.
const NONE = "__none";

// The plot's horizontal room inside the chart box: the value axis on the left, the margin on the right.
const AXIS_WIDTH = 64;
const RIGHT_MARGIN = 12;

function plotted(data: ChartRow[], series: SeriesDef[]): ChartRow[] {
  return series.length > 0 ? data : data.map((r) => ({ ...r, [NONE]: 0 }));
}

function usePatternIds() {
  const id = useId().replace(/:/g, "");
  return { loading: `loading-${id}`, noData: `nodata-${id}` };
}

function dayLabel(lang: string) {
  const f = new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" });
  return (key: string) => f.format(new Date(`${key}T00:00:00`));
}

type TooltipEntry = {
  dataKey?: unknown;
  value?: unknown;
  payload?: ChartRow;
};

function useChartText() {
  const { t } = useTranslation();
  return {
    total: (value: string) =>
      t("dashboard.chart.total", "Day total {{value}}", { value }),
    others: (count: number) =>
      t("dashboard.chart.otherLines", "Others ({{count}})", { count }),
    clickForAll: t("dashboard.chart.clickForAll", "Click to see every series"),
    close: t("dashboard.chart.closeDetail", "Close the day's detail"),
    days: t("dashboard.chart.days", "Days of the chart"),
    moreMembers: (count: number) =>
      t("dashboard.chart.moreMembers", "and {{count}} more", { count }),
    openDay: (day: string) =>
      t("dashboard.chart.openDay", "Open the detail of {{day}}", { day }),
  };
}

// The values of a payload by series key, as recharts hands them to the tooltip.
function valuesOf(entries: readonly TooltipEntry[]): Map<string, unknown> {
  return new Map(entries.map((e) => [String(e.dataKey ?? ""), e.value]));
}

// A summary of the day, in the order the chart draws it top to bottom: a short stroke of the series
// colour, its name and its value; the "Other" group in one line; on a stack, the day's total in the
// header and a hint that a click shows everything. A name is never cut short, and a line chart's
// previous-period value sits on a line of its own under its row.
function TooltipCard({
  head,
  total,
  summary,
  describe,
  note,
  hint,
  p,
}: {
  head: string;
  total: string | null;
  summary: TooltipSummary | null;
  describe: (row: TooltipSummary["rows"][number]) => string;
  // A second, muted line under a row: a line chart's previous-period value.
  note?: (row: TooltipSummary["rows"][number]) => string | null;
  hint: string | null;
  p: ReturnType<typeof useChartPalette>;
}) {
  const text = useChartText();
  const other = summary?.other;
  // The name takes the room and wraps, never cut short; the value keeps its own width beside it, and
  // a comparison goes on a muted line of its own under them.
  const line = (
    key: string,
    color: string,
    name: string,
    value: string | null,
    extra: string | null,
  ) => (
    <li key={key} data-series-key={key} className="flex flex-col">
      <span className="flex items-start justify-between gap-x-4">
        <span className="text-text-secondary flex min-w-0 flex-1 items-start gap-1.5">
          <span
            aria-hidden="true"
            className="mt-1.5 inline-block h-0.5 w-3 shrink-0 rounded-full"
            style={{ background: color }}
          />
          <span className="min-w-0 break-words">{name}</span>
        </span>
        {value !== null && (
          <span className="shrink-0 font-medium whitespace-nowrap tabular-nums">
            {value}
          </span>
        )}
      </span>
      {extra && <span className="text-text-muted text-right">{extra}</span>}
    </li>
  );
  const otherLine = other
    ? line(
        OTHER_KEY,
        p.other,
        text.others(other.count),
        other.value === null
          ? null
          : describe({
              key: OTHER_KEY,
              label: "",
              color: p.other,
              value: other.value,
            }),
        null,
      )
    : null;
  const rows = (summary?.rows ?? []).map((r) =>
    line(r.key, r.color, r.label, describe(r), note?.(r) ?? null),
  );
  // A stack's group sits on top of it; a line chart's group has no place, so it closes the list.
  const ordered = total !== null ? [otherLine, ...rows] : [...rows, otherLine];
  return (
    <div
      className="flex max-w-72 min-w-44 flex-col gap-1 rounded-lg px-3 py-2 text-xs shadow-lg"
      style={{
        background: p.tooltipBg,
        border: `1px solid ${p.tooltipBorder}`,
        color: p.text,
      }}
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="recharts-tooltip-label">{head}</span>
        {total !== null && (
          <span className="font-medium tabular-nums">{text.total(total)}</span>
        )}
      </div>
      {summary && (rows.length > 0 || otherLine) && (
        <ul className="flex flex-col gap-0.5">{ordered}</ul>
      )}
      {hint && <p className="text-text-muted">{hint}</p>}
    </div>
  );
}

// The chart's series, ranked and grouped, with each kept series holding on to the palette slot it had
// in the last render.
function useArrangedSeries(
  data: ChartRow[],
  series: SeriesDef[],
  sum: boolean,
): Arranged<ChartRow> {
  const slots = useRef<ReadonlyMap<string, number>>(new Map());
  const arranged = arrangeSeries(
    data,
    series,
    CATEGORICAL_SLOTS,
    sum,
    slots.current,
  );
  useEffect(() => {
    slots.current = arranged.slot;
  });
  return arranged;
}

// Above the chart's own layers, which recharts draws later in the same box.
const TOOLTIP_WRAPPER = { zIndex: 10, outline: "none" } as const;

// The most names the "Other" entry lists, the largest first, before it counts the rest: the list never
// outgrows its box, so it never needs scrolling, which the shared popover does not reach from the
// keyboard. Every series stays in the block's table and its CSV, and a stack's day detail.
const LEGEND_MEMBERS = 8;

interface LegendItem {
  key: string;
  label: string;
  color: string;
  // The names inside the "Other" group, largest window total first, shown when the entry is hovered
  // or opened.
  members?: SeriesDef[];
}

// The chart's legend, in the order given: the key carries the series colour, the name wears text
// ink, legible on both themes. The "Other" entry names its members on hover, click, tap or Enter.
function SeriesLegend({
  items,
  mark,
  p,
}: {
  items: LegendItem[];
  mark: "bar" | "line";
  p: ReturnType<typeof useChartPalette>;
}) {
  const text = useChartText();
  if (items.length === 0) return null;
  return (
    <ul
      data-testid="chart-legend"
      className="flex flex-wrap justify-center gap-x-4 gap-y-1 text-xs"
    >
      {items.map((it) => {
        const entry = (
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              data-legend-key
              className={
                mark === "bar"
                  ? "inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                  : "inline-block h-0.5 w-3.5 shrink-0 rounded-full"
              }
              style={{ background: it.color }}
            />
            <span style={{ color: p.textSecondary }}>{it.label}</span>
          </span>
        );
        return (
          <li key={it.key} data-series-key={it.key}>
            {it.members ? (
              <Popover
                label={it.label}
                side="top"
                align="center"
                content={
                  <ul data-testid="chart-legend-members">
                    {it.members.slice(0, LEGEND_MEMBERS).map((m) => (
                      <li key={m.key}>{m.label}</li>
                    ))}
                    {it.members.length > LEGEND_MEMBERS && (
                      <li className="text-text-muted">
                        {text.moreMembers(it.members.length - LEGEND_MEMBERS)}
                      </li>
                    )}
                  </ul>
                }
              >
                <button
                  type="button"
                  className="focus-visible:ring-accent-soft cursor-help rounded-sm focus-visible:ring-2 focus-visible:outline-none"
                >
                  {entry}
                </button>
              </Popover>
            ) : (
              entry
            )}
          </li>
        );
      })}
    </ul>
  );
}

// One line per series over the days of the window. `compare` names, per series, the key holding the
// previous period's value at the same position, which the tooltip shows beside the current one.
// Clicking a point hands its day to `onPick` (the drill-down), with the key of the line whose dot was
// hit; a click on the plot between lines names the day alone.
export function LineTrend({
  data,
  series,
  lang,
  format,
  compare,
  compareLabel,
  onPick,
  height = 260,
}: {
  data: ChartRow[];
  series: SeriesDef[];
  lang: string;
  format: (v: number) => string;
  compare?: Record<string, string>;
  compareLabel?: string;
  onPick?: (day: string, seriesKey?: string) => void;
  height?: number;
}) {
  const p = useChartPalette();
  const day = useMemo(() => dayLabel(lang), [lang]);
  const text = useDayStateText();
  const chartText = useChartText();
  const ids = usePatternIds();
  const stateOf = new Map(data.map((r) => [r.day, r.state]));
  const settled = useSettledMax(
    `${data[0]?.day}|${data[data.length - 1]?.day}|${series.map((s) => s.key).join(",")}`,
  );
  const arranged = useArrangedSeries(data, series, false);
  const colorOf = (key: string) =>
    p.series[arranged.slot.get(key) ?? 0] ?? p.other;
  // Past the palette, a line keeps its place and its click but no identity: rates do not add up into
  // an "Other", so the group is drawn as neutral context lines under one name.
  const groupName = chartText.others(arranged.folded.length);
  // A point names its own day and series from its row; the day's column names the day alone. Never
  // recharts' hover state, which a click with no movement before it leaves on another day.
  const point =
    (s: SeriesDef, r: number) =>
    (props: unknown): ReactElement => {
      const dot = props as DotProps & { index?: number; payload?: ChartRow };
      const at = dot.payload?.day;
      return (
        <Dot
          {...dot}
          key={`${s.key}-${dot.index}`}
          r={r}
          onClick={
            onPick && typeof at === "string"
              ? () => onPick(at, s.key)
              : undefined
          }
        />
      );
    };
  const describeRow = (r: { value: number | null }) =>
    r.value === null ? "\u2014" : format(r.value);
  const compareNote = (r: { key: string }, row?: ChartRow) => {
    const prevKey = compare?.[r.key];
    if (!prevKey || !compareLabel) return null;
    const prev = row?.[prevKey];
    return `${compareLabel}: ${typeof prev === "number" ? format(prev) : "\u2014"}`;
  };
  const line = (s: SeriesDef, context: boolean) => (
    <Line
      key={s.key}
      type="monotone"
      dataKey={s.key}
      name={context ? groupName : s.label}
      stroke={context ? p.other : colorOf(s.key)}
      strokeWidth={context ? 1 : 2}
      // A context line keeps a small dot, so a value with no neighbour still shows.
      dot={point(s, context ? 1.5 : 2)}
      activeDot={point(s, 5)}
      isAnimationActive={false}
    />
  );
  return (
    <div className="flex w-full flex-col gap-2">
      <div
        style={{ height }}
        // A line between its points lets the click through to the day's column under it.
        className="relative w-full [&_.recharts-line-curve]:pointer-events-none"
        // The drawing only: a screen reader reads the block's table instead, and still reaches the
        // legend and the day detail.
        aria-hidden="true"
      >
        <StatePatterns ids={ids} p={p} />
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={plotted(data, series)}
            margin={{ top: 8, right: RIGHT_MARGIN, bottom: 0, left: 0 }}
            style={onPick ? { cursor: "pointer" } : undefined}
          >
            <CartesianGrid
              stroke={p.grid}
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              dataKey="day"
              // Bands, so a single day still loading has a width to mark, and the points sit mid-band.
              scale="band"
              tickFormatter={day}
              stroke={p.axis}
              tick={{ fill: p.axis, fontSize: 11 }}
              minTickGap={24}
            />
            <YAxis
              stroke={p.axis}
              tick={{ fill: p.axis, fontSize: 11 }}
              tickFormatter={format}
              width={AXIS_WIDTH}
              domain={[0, settled]}
            />
            {stateBands(data, ids, p, text)}
            <Tooltip
              // Every series is null on a day under a band, and the tooltip is what says why.
              filterNull={false}
              wrapperStyle={TOOLTIP_WRAPPER}
              content={({ active, label, payload }) => {
                if (!active || label === undefined) return null;
                const entries = (payload ?? []) as readonly TooltipEntry[];
                const values = valuesOf(entries);
                const row = entries[0]?.payload;
                const ready = !row?.state || row.state === "ready";
                return (
                  <TooltipCard
                    head={withState(
                      day(String(label)),
                      stateOf.get(String(label)),
                      text,
                    )}
                    total={null}
                    summary={
                      ready
                        ? lineSummary(
                            arranged.kept.map((s) => {
                              const prevKey = compare?.[s.key];
                              return {
                                key: s.key,
                                label: s.label,
                                color: colorOf(s.key),
                                value: values.get(s.key),
                                compared:
                                  !!prevKey &&
                                  !!compareLabel &&
                                  typeof row?.[prevKey] === "number",
                              };
                            }),
                            arranged.folded.length,
                          )
                        : null
                    }
                    describe={describeRow}
                    note={(r) => compareNote(r, row)}
                    hint={null}
                    p={p}
                  />
                );
              }}
            />
            {series.length === 0 && (
              <Line
                dataKey={NONE}
                tooltipType="none"
                stroke="none"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            )}
            {arranged.folded.map((s) => line(s, true))}
            {arranged.kept.map((s) => line(s, false))}
            {onPick && (
              <DayHits
                days={data.map((r) => r.day)}
                onPick={(d) => onPick(d)}
                pad={POINT_PAD}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <SeriesLegend
        mark="line"
        p={p}
        items={[
          ...arranged.kept.map((s) => ({
            key: s.key,
            label: s.label,
            color: colorOf(s.key),
          })),
          ...(arranged.folded.length > 0
            ? [
                {
                  key: OTHER_KEY,
                  label: groupName,
                  color: p.other,
                  members: arranged.folded,
                },
              ]
            : []),
        ]}
      />
      <StateLegend data={data} p={p} ids={ids} />
    </div>
  );
}

function withState(
  label: string,
  state: DayState | undefined,
  text: ReturnType<typeof useDayStateText>,
): string {
  if (state === "loading") return `${label} · ${text.loadingTip}`;
  if (state === "noData") return `${label} · ${text.noDataTip}`;
  return label;
}

// How far a line chart's day columns reach past the plot, so a point drawn on its top or bottom edge
// (a rate at 100% or at 0%) is a day's column all over, not only on its inner half.
const POINT_PAD = 8;

// The height recharts gives the category axis under the plot.
const X_AXIS_HEIGHT = 30;

// One transparent column per day behind the bars, so a click or a tap on a day's empty room (above
// its stack, or the band of a day still loading) names that day by itself, whatever the hover state
// says. A segment, the "Other" layer included, names its own day from its row.
function DayHits({
  days,
  onPick,
  pad = 0,
}: {
  days: string[];
  onPick: (day: string) => void;
  // How far the columns reach past the plot's top and bottom, for a point drawn on its edge.
  pad?: number;
}) {
  const area = usePlotArea();
  if (!area || days.length === 0) return null;
  const band = area.width / days.length;
  return (
    <g data-testid="chart-day-hits">
      {days.map((d, i) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: the pointer's way in; the keyboard's is DayKeys.
        <rect
          key={d}
          data-day={d}
          x={area.x + band * i}
          y={area.y - pad}
          width={band}
          height={area.height + 2 * pad}
          fill="transparent"
          onClick={() => onPick(d)}
        />
      ))}
    </g>
  );
}

// The same days for a keyboard and a screen reader: one tab stop over the plot, the arrows move
// between days, Enter or Space opens the focused one. Invisible to the pointer, which the columns serve.
function DayKeys({
  days,
  picked,
  label,
  onPick,
  buttons,
}: {
  days: string[];
  picked: string | null;
  label: (day: string) => string;
  onPick: (day: string) => void;
  // Each day's button, by day, for the detail to hand the focus back to when it closes.
  buttons: RefObject<Map<string, HTMLButtonElement>>;
}) {
  const text = useChartText();
  const [cursor, setCursor] = useState(0);
  const at = Math.min(cursor, Math.max(days.length - 1, 0));
  const move = (to: number) => {
    const i = Math.max(0, Math.min(days.length - 1, to));
    setCursor(i);
    const d = days[i];
    if (d) buttons.current.get(d)?.focus();
  };
  if (days.length === 0) return null;
  return (
    <fieldset
      aria-label={text.days}
      className="pointer-events-none absolute m-0 flex min-w-0 border-0 p-0"
      style={{
        left: AXIS_WIDTH,
        right: RIGHT_MARGIN,
        top: 8,
        bottom: X_AXIS_HEIGHT,
      }}
    >
      {days.map((d, i) => (
        <button
          key={d}
          ref={(el) => {
            if (el) buttons.current.set(d, el);
            else buttons.current.delete(d);
          }}
          type="button"
          data-day={d}
          tabIndex={i === at ? 0 : -1}
          aria-label={text.openDay(label(d))}
          aria-pressed={picked === d}
          className="focus-visible:ring-accent h-full flex-1 rounded-sm opacity-0 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
          onFocus={() => setCursor(i)}
          // Enter, Space and a screen reader's activation all arrive as the button's own click.
          onClick={() => onPick(d)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") {
              e.preventDefault();
              move(i + 1);
            } else if (e.key === "ArrowLeft") {
              e.preventDefault();
              move(i - 1);
            } else if (e.key === "Home") {
              e.preventDefault();
              move(0);
            } else if (e.key === "End") {
              e.preventDefault();
              move(days.length - 1);
            }
          }}
        />
      ))}
    </fieldset>
  );
}

// The detail of the day a stack was clicked on: every series, the "Other" group's members included,
// top to bottom as drawn, each with its value and its share of the day, and a way to close it.
function DayDetail({
  row,
  head,
  kept,
  folded,
  colorOf,
  format,
  lang,
  onClose,
  box,
  p,
}: {
  row: ChartRow;
  head: string;
  kept: SeriesDef[];
  folded: SeriesDef[];
  colorOf: (key: string) => string;
  format: (v: number) => string;
  lang: string;
  onClose: () => void;
  // The detail's own element, which its chart reads to tell its detail from another chart's.
  box: RefObject<HTMLElement | null>;
  p: ReturnType<typeof useChartPalette>;
}) {
  const text = useChartText();
  const pf = new Intl.NumberFormat(lang, {
    style: "percent",
    maximumFractionDigits: 1,
  });
  const ready = !row.state || row.state === "ready";
  const detail = stackDetail(row, kept, folded);
  // The click that opened it left the focus on the chart, so Escape is heard on the whole page, and
  // the focus moves in for a keyboard or a screen reader to land on the day.
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, [box]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A popup above it (the Others list) takes its own Escape first and marks it handled, and an
      // Escape pressed inside another chart's detail is that one's.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // The key's own target, which closing the detail (and moving the focus) does not change.
      const at = e.target instanceof Element ? e.target : null;
      const elsewhere =
        at?.closest('[data-testid="chart-day-detail"]') &&
        !box.current?.contains(at);
      if (elsewhere) return;
      // Handled: one Escape closes one detail.
      e.preventDefault();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, box]);
  const line = (
    key: string,
    label: string,
    value: number,
    share: number | null,
    color: string | null,
    member: boolean,
  ) => (
    <li
      key={key}
      data-series-key={key}
      className="flex items-center justify-between gap-4 py-0.5"
    >
      <span
        className="text-text-secondary inline-flex min-w-0 items-center gap-1.5"
        style={member ? { paddingLeft: "1.25rem" } : undefined}
      >
        {color && (
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ background: color }}
          />
        )}
        <span className="truncate">{label}</span>
      </span>
      <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
        <span className="text-text-primary font-medium">{format(value)}</span>
        <span className="text-text-muted w-14 text-right">
          {share === null ? "—" : pf.format(share)}
        </span>
      </span>
    </li>
  );
  return (
    <section
      data-testid="chart-day-detail"
      ref={box}
      tabIndex={-1}
      aria-label={head}
      className="border-border bg-bg-tertiary flex flex-col gap-2 rounded-lg border px-3 py-2 text-xs outline-none"
    >
      <div className="flex items-center justify-between gap-4">
        <span className="text-text-primary font-medium">{head}</span>
        <span className="flex items-center gap-2">
          {ready && (
            <span className="text-text-primary font-medium tabular-nums">
              {text.total(format(detail.total))}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={text.close}
            className="text-text-muted hover:text-text-primary rounded-sm p-0.5"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </span>
      </div>
      {ready && (
        <ul className="flex flex-col">
          {detail.group &&
            line(
              OTHER_KEY,
              text.others(folded.length),
              detail.group.value,
              detail.group.share,
              p.other,
              false,
            )}
          {detail.rows.map((r) =>
            line(
              r.key,
              r.label,
              r.value,
              r.share,
              r.member ? null : colorOf(r.key),
              r.member,
            ),
          )}
        </ul>
      )}
    </section>
  );
}

// Bars per day, stacked by segment, so a day's bar is its total and each segment its share. The
// largest series over the window sits at the base and "Other" on top; clicking a day opens its
// detail under the chart.
export function StackedBars({
  data,
  series,
  lang,
  format,
  onPick,
  height = 260,
}: {
  data: ChartRow[];
  series: SeriesDef[];
  lang: string;
  format: (v: number) => string;
  onPick?: (day: string) => void;
  height?: number;
}) {
  const p = useChartPalette();
  const day = useMemo(() => dayLabel(lang), [lang]);
  const text = useDayStateText();
  const chartText = useChartText();
  const ids = usePatternIds();
  const stateOf = new Map(data.map((r) => [r.day, r.state]));
  const arranged = useArrangedSeries(data, series, true);
  const colorOf = (key: string) =>
    key === OTHER_KEY
      ? p.other
      : (p.series[arranged.slot.get(key) ?? 0] ?? p.other);
  const groupName = chartText.others(arranged.folded.length);
  const drawn: SeriesDef[] = [
    ...arranged.kept,
    ...(arranged.folded.length > 0
      ? [{ key: OTHER_KEY, label: groupName }]
      : []),
  ];
  const settled = useSettledMax(
    `${data[0]?.day}|${data[data.length - 1]?.day}|${series.map((s) => s.key).join(",")}`,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const dayButtons = useRef(new Map<string, HTMLButtonElement>());
  const detailBox = useRef<HTMLElement>(null);
  // Closing the detail from inside it hands the focus back to its day, where the arrows go on.
  const closeDetail = useCallback(() => {
    const inside = detailBox.current?.contains(document.activeElement);
    if (inside && picked) dayButtons.current.get(picked)?.focus();
    setPicked(null);
  }, [picked]);
  const days = data.map((r) => r.day);
  // The day comes from what was clicked or pressed, never from the hover: a second click on the
  // open day closes it.
  const pick = (d: string) => {
    setPicked((cur) => (cur === d ? null : d));
    onPick?.(d);
  };
  const pickedRow = picked ? data.find((r) => r.day === picked) : undefined;
  return (
    <div className="flex w-full flex-col gap-2">
      <div style={{ height }} className="relative w-full">
        <div
          className="absolute inset-0"
          // The drawing only: a screen reader reads the block's table instead, and still reaches the
          // days, the legend and the day detail.
          aria-hidden="true"
        >
          <StatePatterns ids={ids} p={p} />
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              // Recharts stacks the bars in the order they first registered, so a new ranking or a new
              // group draws a new chart rather than a legend that disagrees with the stack.
              key={drawn.map((s) => s.key).join("|")}
              data={plotted(arranged.rows, drawn)}
              margin={{ top: 8, right: RIGHT_MARGIN, bottom: 0, left: 0 }}
              style={{ cursor: "pointer" }}
            >
              <CartesianGrid
                stroke={p.grid}
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="day"
                tickFormatter={day}
                stroke={p.axis}
                tick={{ fill: p.axis, fontSize: 11 }}
                minTickGap={24}
              />
              <YAxis
                stroke={p.axis}
                tick={{ fill: p.axis, fontSize: 11 }}
                tickFormatter={format}
                width={AXIS_WIDTH}
                domain={[0, settled]}
              />
              {stateBands(data, ids, p, text)}
              <Tooltip
                // Every series is null on a day under a band, and the tooltip is what says why.
                filterNull={false}
                cursor={{ fill: p.grid, opacity: 0.4 }}
                wrapperStyle={TOOLTIP_WRAPPER}
                content={({ active, label, payload }) => {
                  if (!active || label === undefined) return null;
                  const entries = (payload ?? []) as readonly TooltipEntry[];
                  const values = valuesOf(entries);
                  const row = entries[0]?.payload;
                  const ready = !row?.state || row.state === "ready";
                  const total = drawn.reduce((a, s) => {
                    const v = values.get(s.key);
                    return a + (typeof v === "number" ? v : 0);
                  }, 0);
                  return (
                    <TooltipCard
                      head={withState(
                        day(String(label)),
                        stateOf.get(String(label)),
                        text,
                      )}
                      total={ready && drawn.length > 0 ? format(total) : null}
                      summary={
                        ready
                          ? stackSummary(
                              arranged.kept.map((s) => ({
                                key: s.key,
                                label: s.label,
                                color: colorOf(s.key),
                                value: values.get(s.key),
                              })),
                              arranged.folded.length > 0
                                ? {
                                    count: arranged.folded.length,
                                    value: values.get(OTHER_KEY),
                                  }
                                : null,
                            )
                          : null
                      }
                      describe={(r) => format(r.value ?? 0)}
                      hint={
                        ready && drawn.length > 0 ? chartText.clickForAll : null
                      }
                      p={p}
                    />
                  );
                }}
              />
              {drawn.length === 0 && (
                <Bar
                  dataKey={NONE}
                  tooltipType="none"
                  isAnimationActive={false}
                />
              )}
              {drawn.map((s) => (
                <Bar
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  stackId="day"
                  fill={colorOf(s.key)}
                  isAnimationActive={false}
                  // A segment sits above its day's column, so it names its day itself, from its row.
                  onClick={(bar) => {
                    const d = (bar as { payload?: ChartRow }).payload?.day;
                    if (typeof d === "string") pick(d);
                  }}
                />
              ))}
              <DayHits days={days} onPick={pick} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <DayKeys
          days={days}
          picked={picked}
          label={(d) => day(d)}
          onPick={pick}
          buttons={dayButtons}
        />
      </div>
      <SeriesLegend
        mark="bar"
        p={p}
        items={drawn.map((s) => ({
          key: s.key,
          label: s.label,
          color: colorOf(s.key),
          ...(s.key === OTHER_KEY ? { members: arranged.folded } : {}),
        }))}
      />
      <StateLegend data={data} p={p} ids={ids} />
      {pickedRow && (
        <DayDetail
          // A new day is a new detail: it takes the focus again, while a streamed update of the same
          // day leaves the focus where it is.
          key={pickedRow.day}
          row={pickedRow}
          head={withState(day(pickedRow.day), pickedRow.state, text)}
          kept={arranged.kept}
          folded={arranged.folded}
          colorOf={colorOf}
          format={format}
          lang={lang}
          onClose={closeDetail}
          box={detailBox}
          p={p}
        />
      )}
    </div>
  );
}
