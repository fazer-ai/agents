import { useMemo, useRef } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTheme } from "@/client/contexts/ThemeContext";

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
      // Neighbours differ in hue, not just in shade: the first two are the ones most charts use.
      series: [
        cssVar("--color-accent", "#3ea6ff"),
        cssVar("--color-warning", "#eab308"),
        cssVar("--color-success", "#22c55e"),
        cssVar("--color-error", "#ef4444"),
        cssVar("--color-purple", "#a78bfa"),
        cssVar("--color-info", "#38bdf8"),
        cssVar("--color-text-secondary", "#a3a3a3"),
        cssVar("--color-text-muted", "#666666"),
      ],
    }),
    [resolvedTheme],
  );
}

export interface SeriesDef {
  key: string;
  label: string;
}

export interface ChartRow {
  // Local day key, YYYY-MM-DD.
  day: string;
  // The same position in the previous period, when there is one.
  prevDay?: string | null;
  [series: string]: number | string | null | undefined;
}

function dayLabel(lang: string) {
  const f = new Intl.DateTimeFormat(lang, { month: "short", day: "numeric" });
  return (key: string) => f.format(new Date(`${key}T00:00:00`));
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
  // The dot's own click runs before the chart's, which is the one that knows the day.
  const hitSeries = useRef<string | null>(null);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
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
          />
          <Tooltip
            contentStyle={{
              background: p.tooltipBg,
              border: `1px solid ${p.tooltipBorder}`,
              borderRadius: 8,
              color: p.text,
              fontSize: 12,
            }}
            labelFormatter={(l) => day(String(l))}
            formatter={(value, name, item) => {
              const key = String(item.dataKey ?? "");
              const current =
                typeof value === "number" ? format(value) : "\u2014";
              const prevKey = compare?.[key];
              const prev = prevKey
                ? (item.payload as ChartRow | undefined)?.[prevKey]
                : undefined;
              const withPrev =
                prevKey && compareLabel
                  ? `${current} (${compareLabel}: ${
                      typeof prev === "number" ? format(prev) : "\u2014"
                    })`
                  : current;
              return [withPrev, name];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: p.axis }} />
          {series.map((s, i) => (
            <Line
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={p.series[i % p.series.length]}
              strokeWidth={2}
              dot={{ r: 2 }}
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
  );
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
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
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
          />
          <Tooltip
            cursor={{ fill: p.grid, opacity: 0.4 }}
            contentStyle={{
              background: p.tooltipBg,
              border: `1px solid ${p.tooltipBorder}`,
              borderRadius: 8,
              color: p.text,
              fontSize: 12,
            }}
            labelFormatter={(l) => day(String(l))}
            formatter={(value, name) => [
              typeof value === "number" ? format(value) : "\u2014",
              name,
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: p.axis }} />
          {series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="day"
              fill={p.series[i % p.series.length]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
