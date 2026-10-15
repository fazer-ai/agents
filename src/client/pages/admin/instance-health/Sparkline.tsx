import {
  DefaultZIndexes,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { useChartPalette } from "@/client/pages/dashboard/charts";
import { historyWithGaps } from "./signals";

// One signal's last hour, with its threshold drawn across it. Its own chunk, like the dashboard's
// charts: recharts is heavy and only these two pages draw. Plotted on the samples' own times, with a
// break where samples are missing, so an outage shows as one and a spike keeps its real length, on
// an axis that spans the whole window ending at the latest sample. The threshold is drawn over the
// series and clear of the bottom edge: a threshold of 0 sits on the baseline, where a flat series
// at 0 or the edge itself would otherwise hide it.
export default function Sparkline({
  points,
  threshold,
  firing,
  windowMs,
}: {
  points: { at: number; value: number }[];
  threshold: number;
  firing: boolean;
  windowMs: number;
}) {
  const palette = useChartPalette();
  const top = Math.max(threshold, ...points.map((p) => p.value)) * 1.15 || 1;
  const end = points[points.length - 1]?.at;
  return (
    <ResponsiveContainer width="100%" height={56}>
      <LineChart
        data={historyWithGaps(points)}
        margin={{ top: 4, right: 0, bottom: 2, left: 0 }}
      >
        <XAxis
          hide
          type="number"
          dataKey="at"
          scale="time"
          domain={
            end === undefined ? ["dataMin", "dataMax"] : [end - windowMs, end]
          }
        />
        <YAxis hide domain={[0, top]} />
        <ReferenceLine
          y={threshold}
          stroke={palette.series[3]}
          strokeDasharray="4 3"
          ifOverflow="extendDomain"
          zIndex={DefaultZIndexes.line + 1}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke={firing ? palette.series[3] : palette.series[0]}
          strokeWidth={1.5}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
