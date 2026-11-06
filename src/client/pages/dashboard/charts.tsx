import { useId, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTheme } from "@/client/contexts/ThemeContext";
import {
  CATEGORICAL_SLOTS,
  foldStacked,
  OTHER_KEY,
  type SeriesDef,
  type TooltipItem,
  tooltipRows,
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
      fill={`url(#${r.state === "loading" ? ids.loading : ids.noData})`}
      fillOpacity={1}
      stroke={r.state === "loading" ? p.loading : p.noData}
      strokeOpacity={0.5}
      label={
        r.days >= 3
          ? {
              value: r.state === "loading" ? text.loading : text.noData,
              position: "insideTop",
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
const NO_KEYS = new Set<string>();

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

// The most rows a tooltip lists before it sums the rest into one line, so it stays shorter than the
// chart whatever the series count.
const TOOLTIP_ROWS = 6;

type TooltipEntry = {
  dataKey?: unknown;
  name?: unknown;
  value?: unknown;
  color?: string;
  payload?: ChartRow;
};

// The day, then the series with a value on it, largest first: a short stroke of the series colour,
// its name, and the value, which is what the reader came for. A stacked chart adds the day's total
// and the sum of the rows it leaves out; a line chart adds neither, since its values do not add up.
function TooltipCard({
  entries,
  p,
  head,
  format,
  stacked,
  contextKeys,
  describe,
}: {
  entries: readonly TooltipEntry[];
  p: ReturnType<typeof useChartPalette>;
  head: string;
  format: (v: number) => string;
  stacked: boolean;
  contextKeys: Set<string>;
  describe?: (item: TooltipItem, entry: TooltipEntry) => string;
}) {
  const { t } = useTranslation();
  const row = entries[0]?.payload;
  const ready = !row?.state || row.state === "ready";
  const identified: TooltipItem[] = [];
  const byKey = new Map<string, TooltipEntry>();
  let context = 0;
  for (const e of entries) {
    const key = String(e.dataKey ?? "");
    if (key === NONE) continue;
    if (contextKeys.has(key)) {
      if (typeof e.value === "number" && e.value !== 0) context++;
      continue;
    }
    byKey.set(key, e);
    identified.push({
      key,
      label: String(e.name ?? key),
      color: e.color ?? p.other,
      value: e.value,
    });
  }
  const { rows, rest } = tooltipRows(identified, TOOLTIP_ROWS);
  const total = stacked
    ? identified.reduce(
        (a, it) => a + (typeof it.value === "number" ? it.value : 0),
        0,
      )
    : null;
  const more = rest.count + context;
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
        {ready && total !== null && rows.length > 1 && (
          <span className="font-medium tabular-nums">
            {t("dashboard.chart.total", "Day total")} {format(total)}
          </span>
        )}
      </div>
      {ready && rows.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center justify-between gap-4">
              <span className="text-text-secondary inline-flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block h-0.5 w-3 shrink-0 rounded-full"
                  style={{ background: r.color }}
                />
                <span className="truncate">{r.label}</span>
              </span>
              <span className="font-medium tabular-nums">
                {describe
                  ? describe(r, byKey.get(r.key) ?? {})
                  : format(r.value)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {ready && more > 0 && (
        <p className="text-text-muted">
          {stacked && context === 0
            ? t("dashboard.chart.moreWithSum", "+{{count}} more · {{value}}", {
                count: more,
                value: format(rest.sum),
              })
            : t("dashboard.chart.more", "+{{count}} more", { count: more })}
        </p>
      )}
    </div>
  );
}

// Above the legend, which recharts draws later in the same box.
const TOOLTIP_WRAPPER = { zIndex: 10, outline: "none" } as const;

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
  const ids = usePatternIds();
  const stateOf = new Map(data.map((r) => [r.day, r.state]));
  const settled = useSettledMax(
    `${data[0]?.day}|${data[data.length - 1]?.day}|${series.map((s) => s.key).join(",")}`,
  );
  const { t } = useTranslation();
  // Past the palette, a line keeps its place and its click but no identity: rates do not add up into
  // an "Other".
  const contextKeys = new Set(
    series.slice(CATEGORICAL_SLOTS).map((s) => s.key),
  );
  // The dot's own click runs before the chart's, which is the one that knows the day.
  const hitSeries = useRef<string | null>(null);
  return (
    <div className="flex w-full flex-col gap-2">
      <div style={{ height }} className="relative w-full">
        <StatePatterns ids={ids} p={p} />
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={plotted(data, series)}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            onClick={(e) => {
              const label = (e as { activeLabel?: string } | null)?.activeLabel;
              const hit = hitSeries.current ?? undefined;
              hitSeries.current = null;
              if (onPick && typeof label === "string") onPick(label, hit);
            }}
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
              width={64}
              domain={[0, settled]}
            />
            {stateBands(data, ids, p, text)}
            <Tooltip
              // Every series is null on a day under a band, and the tooltip is what says why.
              filterNull={false}
              wrapperStyle={TOOLTIP_WRAPPER}
              content={({ active, label, payload }) =>
                !active || label === undefined ? null : (
                  <TooltipCard
                    entries={(payload ?? []) as readonly TooltipEntry[]}
                    p={p}
                    head={withState(
                      day(String(label)),
                      stateOf.get(String(label)),
                      text,
                    )}
                    format={format}
                    stacked={false}
                    contextKeys={contextKeys}
                    describe={(item, entry) => {
                      const current = format(item.value as number);
                      const prevKey = compare?.[item.key];
                      if (!prevKey || !compareLabel) return current;
                      const prev = entry.payload?.[prevKey];
                      return `${current} (${compareLabel}: ${
                        typeof prev === "number" ? format(prev) : "\u2014"
                      })`;
                    }}
                  />
                )
              }
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: p.axis }}
              // In the order the series are drawn, so "Other" closes the list.
              itemSorter={null}
              // The key carries the series colour; the name wears text ink, legible on both themes.
              formatter={(value) => (
                <span style={{ color: p.textSecondary }}>{value}</span>
              )}
            />
            {series.length === 0 && (
              <Line
                dataKey={NONE}
                legendType="none"
                tooltipType="none"
                stroke="none"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
              />
            )}
            {series.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={
                  i === CATEGORICAL_SLOTS
                    ? t("dashboard.chart.otherLines", "Others ({{count}})", {
                        count: contextKeys.size,
                      })
                    : s.label
                }
                legendType={i > CATEGORICAL_SLOTS ? "none" : "line"}
                stroke={i < CATEGORICAL_SLOTS ? p.series[i] : p.other}
                strokeWidth={i < CATEGORICAL_SLOTS ? 2 : 1}
                strokeOpacity={i < CATEGORICAL_SLOTS ? 1 : 0.6}
                // A context line keeps a small dot, so a value with no neighbour still shows.
                dot={{ r: i < CATEGORICAL_SLOTS ? 2 : 1.5 }}
                activeDot={{
                  r: 5,
                  onClick: () => {
                    hitSeries.current = s.key;
                  },
                }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
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

// Bars per day, stacked by segment, so a day's bar is its total and each segment its share.
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
  const ids = usePatternIds();
  const stateOf = new Map(data.map((r) => [r.day, r.state]));
  const { t } = useTranslation();
  const drawn = foldStacked(
    data,
    series,
    CATEGORICAL_SLOTS,
    t("dashboard.chart.other", "Other"),
  );
  const settled = useSettledMax(
    `${data[0]?.day}|${data[data.length - 1]?.day}|${series.map((s) => s.key).join(",")}`,
  );
  return (
    <div className="flex w-full flex-col gap-2">
      <div style={{ height }} className="relative w-full">
        <StatePatterns ids={ids} p={p} />
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={plotted(drawn.rows, drawn.series)}
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
            onClick={(e) => {
              const label = (e as { activeLabel?: string } | null)?.activeLabel;
              if (onPick && typeof label === "string") onPick(label);
            }}
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
              width={64}
              domain={[0, settled]}
            />
            {stateBands(data, ids, p, text)}
            <Tooltip
              // Every series is null on a day under a band, and the tooltip is what says why.
              filterNull={false}
              cursor={{ fill: p.grid, opacity: 0.4 }}
              wrapperStyle={TOOLTIP_WRAPPER}
              content={({ active, label, payload }) =>
                !active || label === undefined ? null : (
                  <TooltipCard
                    entries={(payload ?? []) as readonly TooltipEntry[]}
                    p={p}
                    head={withState(
                      day(String(label)),
                      stateOf.get(String(label)),
                      text,
                    )}
                    format={format}
                    stacked
                    contextKeys={NO_KEYS}
                  />
                )
              }
            />
            <Legend
              wrapperStyle={{ fontSize: 12, color: p.axis }}
              // In the order the series are drawn, so "Other" closes the list.
              itemSorter={null}
              // The key carries the series colour; the name wears text ink, legible on both themes.
              formatter={(value) => (
                <span style={{ color: p.textSecondary }}>{value}</span>
              )}
            />
            {drawn.series.length === 0 && (
              <Bar
                dataKey={NONE}
                legendType="none"
                tooltipType="none"
                isAnimationActive={false}
              />
            )}
            {drawn.series.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="day"
                fill={s.key === OTHER_KEY ? p.other : p.series[i]}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <StateLegend data={data} p={p} ids={ids} />
    </div>
  );
}
