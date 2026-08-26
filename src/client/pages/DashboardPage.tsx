import {
  ArrowRightLeft,
  Bot,
  Coins,
  ExternalLink,
  Gauge,
  Hash,
  MessagesSquare,
  Target,
  Timer,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Card,
  DataBoundary,
  PageContainer,
  Skeleton,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { formatDuration } from "@/client/lib/duration";
import { cn } from "@/client/lib/utils";
import type { TrendPoint } from "./dashboard/CostTrendChart";

// recharts is heavy and only the dashboard needs it → lazy-load the chart so it splits into its own
// chunk (fetched on first dashboard view, not in the initial bundle).
const CostTrendChart = lazy(() => import("./dashboard/CostTrendChart"));

// Types derived from the Eden treaty — never hand-declared (see docs/eden-treaty.md).
type MetricsData = Awaited<ReturnType<typeof api.api.v1.metrics.get>>["data"];
type Metrics = NonNullable<MetricsData>["metrics"];
type KpisData = Awaited<ReturnType<typeof api.api.v1.metrics.kpis.get>>["data"];
type Kpis = NonNullable<KpisData>["kpis"];
type TimeseriesData = Awaited<
  ReturnType<typeof api.api.v1.metrics.timeseries.get>
>["data"];
type Point = NonNullable<TimeseriesData>["points"][number];
type CostsData = Awaited<
  ReturnType<typeof api.api.v1.metrics.costs.get>
>["data"];
type Costs = NonNullable<CostsData>["costs"];

type Range = "7d" | "30d" | "90d" | "all";
const RANGE_DAYS: Record<Range, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

// Usage segment: "inbox" (real customer traffic) | "playground" (operator test turns) | "all".
// Defaults to "inbox" so test turns never inflate the headline figures.
type Source = "inbox" | "playground" | "all";

function sinceFor(range: Range): string | undefined {
  const days = RANGE_DAYS[range];
  if (days === null) return undefined;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function KpiCard({
  icon: Icon,
  label,
  primary,
  secondary,
  accent,
}: {
  icon: typeof Coins;
  label: string;
  primary: string;
  secondary: string;
  accent?: boolean;
}) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-text-muted text-xs">
        <Icon
          className={cn("h-4 w-4", accent ? "text-accent" : "text-text-muted")}
          aria-hidden="true"
        />
        {label}
      </div>
      <p className="font-semibold text-2xl text-text-primary tabular-nums">
        {primary}
      </p>
      <p className="text-text-muted text-xs">{secondary}</p>
    </Card>
  );
}

function FunnelBar({
  label,
  count,
  total,
  nf,
}: {
  label: string;
  count: number;
  total: number;
  nf: Intl.NumberFormat;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  const pctLabel = `(${pct.toFixed(0)}%)`;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary">{label}</span>
        <span className="font-medium text-text-primary tabular-nums">
          {nf.format(count)}
          <span className="ml-1 text-text-muted text-xs">{pctLabel}</span>
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${Math.max(pct, count > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  );
}

// CostDay is derived from the costs response. The chart accepts either local
// timeseries points (for calls) or cost-days from Langfuse (for cost).
type CostDay = NonNullable<Extract<Costs, { status: "ok" }>["days"][number]>;

// The operator's IANA timezone. The daily buckets are computed in THIS zone — both here (the
// zero-fill window) and on the backend (the SQL date_trunc gets `?tz=`) — so a late-night turn
// lands on the right LOCAL day instead of leaking into "tomorrow" in UTC. This is the recurring
// "21h BRT shows usage on tomorrow (00h UTC)" bug; the fix is to never reason in UTC for days.
export const OPERATOR_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Local day key (YYYY-MM-DD) of a Date in the operator's zone. Browser Date getters already read in
// OPERATOR_TZ (it IS the browser zone), so a manual format avoids any UTC round-trip.
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Builds the continuous daily chart series spanning the SELECTED range: the backend returns only days
// with data, but the chart should show every day in the window (0 where missing) so the bars reflect
// the filter, not just what happened. Days are LOCAL — "today" is the operator's today, never
// tomorrow-in-UTC. For "all" the span runs from the oldest data day to today. cost comes from Langfuse
// (UTC day key, matched as a plain string — the documented day-boundary caveat); calls/conversations
// come from our local-day timeseries; costPerConv = cost ÷ conversations (null when either is 0).
function buildCostTrend(
  points: Point[],
  costDays: CostDay[],
  range: Range,
): TrendPoint[] {
  const callsByDay = new Map(points.map((p) => [p.bucket, p.calls]));
  const convsByDay = new Map(points.map((p) => [p.bucket, p.conversations]));
  const costByDay = new Map(costDays.map((d) => [d.date, d.costUsd]));
  const days = RANGE_DAYS[range];
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let cur: Date;
  if (days != null) {
    cur = new Date(
      end.getFullYear(),
      end.getMonth(),
      end.getDate() - (days - 1),
    );
  } else {
    // "YYYY-MM-DD" with no offset parses as LOCAL midnight → the right day in the operator's zone.
    const firstKey = [
      ...points.map((p) => p.bucket),
      ...costDays.map((d) => d.date),
    ].sort()[0];
    cur = firstKey ? new Date(`${firstKey}T00:00:00`) : new Date(end);
  }
  const out: TrendPoint[] = [];
  while (cur.getTime() <= end.getTime()) {
    const key = localDayKey(cur);
    const cost = costByDay.get(key) ?? 0;
    const conversations = convsByDay.get(key) ?? 0;
    const calls = callsByDay.get(key) ?? 0;
    const costPerConv =
      cost > 0 && conversations > 0 ? cost / conversations : null;
    out.push({
      key,
      labelMs: cur.getTime(),
      cost,
      conversations,
      calls,
      costPerConv,
    });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function RangeToggle({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  const { t } = useTranslation();
  const ranges: { key: Range; label: string }[] = [
    { key: "7d", label: t("dashboard.range.7d", "7d") },
    { key: "30d", label: t("dashboard.range.30d", "30d") },
    { key: "90d", label: t("dashboard.range.90d", "90d") },
    { key: "all", label: t("dashboard.range.all", "All") },
  ];
  return (
    <div className="inline-flex rounded-lg border border-border bg-bg-tertiary p-0.5">
      {ranges.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => onChange(r.key)}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
            value === r.key
              ? "bg-bg-secondary text-text-primary"
              : "text-text-muted hover:text-text-secondary",
          )}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function SourceToggle({
  value,
  onChange,
}: {
  value: Source;
  onChange: (s: Source) => void;
}) {
  const { t } = useTranslation();
  const sources: { key: Source; label: string }[] = [
    { key: "inbox", label: t("dashboard.source.inbox", "Real") },
    {
      key: "playground",
      label: t("dashboard.source.playground", "Playground"),
    },
    { key: "all", label: t("dashboard.source.all", "All") },
  ];
  return (
    <div className="inline-flex rounded-lg border border-border bg-bg-tertiary p-0.5">
      {sources.map((s) => (
        <button
          key={s.key}
          type="button"
          onClick={() => onChange(s.key)}
          className={cn(
            "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
            value === s.key
              ? "bg-bg-secondary text-text-primary"
              : "text-text-muted hover:text-text-secondary",
          )}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

// NOTE: Static keys so the skeleton placeholders don't key off the array index.
const DASH_KPI_KEYS = ["kpi-0", "kpi-1", "kpi-2", "kpi-3"];
const DASH_FUNNEL_KEYS = ["funnel-0", "funnel-1", "funnel-2"];
const DASH_COST_KEYS = ["cost-0", "cost-1", "cost-2"];
const DASH_AGENT_KEYS = ["agent-0", "agent-1", "agent-2"];
const DASH_BARS = Array.from({ length: 24 }, (_, i) => ({
  key: `bar-${i}`,
  height: `${30 + ((i * 37) % 70)}%`,
}));

// Bespoke loading placeholder mirroring the dashboard's multi-block layout
// (KPI grid + funnel bars + cost chart + cost summary + cost-by-agent list).
function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-7 w-20" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {DASH_KPI_KEYS.map((key) => (
            <Card key={key} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-20" />
              <Skeleton className="h-3 w-28" />
            </Card>
          ))}
        </div>
        <Card className="flex flex-col gap-3">
          {DASH_FUNNEL_KEYS.map((key) => (
            <div key={key} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-16" />
              </div>
              <Skeleton className="h-2.5 w-full rounded-full" />
            </div>
          ))}
        </Card>
      </section>
      <Card className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-7 w-24" />
        </div>
        <div className="flex h-44 items-end gap-1">
          {DASH_BARS.map(({ key, height }) => (
            <div
              key={key}
              className="flex h-full flex-1 flex-col items-center justify-end"
            >
              <Skeleton className="w-full rounded-t" style={{ height }} />
            </div>
          ))}
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-3">
        {DASH_COST_KEYS.map((key) => (
          <Card key={key} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-3 w-32" />
          </Card>
        ))}
      </div>
      <Card className="flex flex-col gap-3">
        <Skeleton className="h-5 w-36" />
        <ul className="flex flex-col gap-2">
          {DASH_AGENT_KEYS.map((key) => (
            <li key={key} className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-16" />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// Loading placeholder for just the "LLM usage" section (chart + cost/token summary + by-agent
// list), shown while a traffic-source switch reloads. Mirrors the lower half of DashboardSkeleton.
function UsageSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <Card className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-7 w-24" />
        </div>
        <div className="flex h-44 items-end gap-1">
          {DASH_BARS.map(({ key, height }) => (
            <div
              key={key}
              className="flex h-full flex-1 flex-col items-center justify-end"
            >
              <Skeleton className="w-full rounded-t" style={{ height }} />
            </div>
          ))}
        </div>
      </Card>
      <div className="grid gap-4 sm:grid-cols-3">
        {DASH_COST_KEYS.map((key) => (
          <Card key={key} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-3 w-32" />
          </Card>
        ))}
      </div>
      <Card className="flex flex-col gap-3">
        <Skeleton className="h-5 w-36" />
        <ul className="flex flex-col gap-2">
          {DASH_AGENT_KEYS.map((key) => (
            <li key={key} className="flex items-center justify-between gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-16" />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [costs, setCosts] = useState<Costs | null>(null);
  const [agentNames, setAgentNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  // The "LLM usage" section reloads on its own when the operator switches traffic source, so it has
  // its own loading/error state (a source switch must not blank the whole page).
  const [usageLoading, setUsageLoading] = useState(true);
  const [usageError, setUsageError] = useState(false);
  const [usageErrorStatus, setUsageErrorStatus] = useState<number | null>(null);
  const [range, setRange] = useState<Range>("30d");
  const [source, setSource] = useState<Source>("inbox");
  const [kpiMode, setKpiMode] = useState<"rate" | "count">("rate");
  const [chartMetric, setChartMetric] = useState<"cost" | "calls">("cost");

  // Page-level (source-independent): funnel KPIs, Langfuse cost, agent-name map. Only re-runs on
  // range change.
  const load = useCallback(async (r: Range) => {
    setLoading(true);
    setError(false);
    setErrorStatus(null);
    const since = sinceFor(r);
    const query = since ? { since } : {};
    try {
      const [k, costsRes, agents] = await Promise.all([
        api.api.v1.metrics.kpis.get({ query }),
        api.api.v1.metrics.costs.get({ query }).catch(() => ({ data: null })),
        api.api.v1.agents.get(),
      ]);
      if (k.error || !k.data) {
        setError(true);
        setErrorStatus(k.error?.status ?? null);
        return;
      }
      setKpis(k.data.kpis);
      setCosts(
        costsRes.data ? costsRes.data.costs : { status: "error" as const },
      );
      if (agents.data) {
        const map: Record<string, string> = {};
        for (const a of agents.data.agents) map[a.id] = a.name;
        setAgentNames(map);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Usage section (source-dependent): token figures + timeseries follow the selected segment. Keeps
  // the previous data while reloading so the section shows a skeleton, not a flash of stale values.
  const loadUsage = useCallback(async (r: Range, src: Source) => {
    setUsageLoading(true);
    setUsageError(false);
    setUsageErrorStatus(null);
    const since = sinceFor(r);
    const query = since ? { since } : {};
    // tz drives the backend's daily bucketing (operator-local days, not UTC).
    const usageQuery = {
      ...query,
      ...(src === "all" ? {} : { source: src }),
      tz: OPERATOR_TZ,
    };
    try {
      const [m, ts] = await Promise.all([
        api.api.v1.metrics.get({ query: usageQuery }),
        api.api.v1.metrics.timeseries.get({ query: usageQuery }),
      ]);
      if (m.error || !m.data || ts.error || !ts.data) {
        setUsageError(true);
        setUsageErrorStatus(m.error?.status ?? ts.error?.status ?? null);
        return;
      }
      setMetrics(m.data.metrics);
      setPoints(ts.data.points);
    } catch {
      setUsageError(true);
    } finally {
      setUsageLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

  useEffect(() => {
    void loadUsage(range, source);
  }, [loadUsage, range, source]);

  const nf = new Intl.NumberFormat(i18n.language);
  const cf = new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
  const pf = (v: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(v);

  // The funnel KPIs and Langfuse cost reflect REAL traffic only; surface cost UI just for the
  // "Real" segment (cost next to playground/all tokens would be a mismatch).
  const realView = source === "inbox";
  const costsOk = costs?.status === "ok";
  const showCost = realView && costsOk;
  const costsError = realView && costs?.status === "error";
  // "Open in Langfuse" target: the tenant's project page when the project id could be resolved
  // (item 6), else the instance root as a fallback.
  const langfuseUrl =
    showCost && costs?.status === "ok"
      ? (costs.projectUrl ?? costs.baseUrl)
      : null;
  const costDays = costsOk && costs.status === "ok" ? costs.days : [];
  const totalCostUsd =
    costsOk && costs.status === "ok" ? costs.totalCostUsd : 0;
  const costByModel =
    showCost && costs.status === "ok" && costs.byModel.length > 0
      ? costs.byModel
      : null;

  // The chart shows cost only in the Real segment with Langfuse; otherwise call volume. Crucially,
  // fall back to call volume when cost is selected but Langfuse has no NON-ZERO cost for the period
  // (ingestion lag, or model pricing not configured → costUsd 0). Otherwise the cost bars render at
  // height 0 and the panel looks blank even though there is real usage to show.
  const costHasData = costDays.some((d) => d.costUsd > 0);
  const effectiveChartMetric =
    showCost && (chartMetric === "calls" || costHasData)
      ? chartMetric
      : "calls";
  // True when the operator picked cost but we fell back to calls (so we can explain the panel).
  const costFellBackToCalls =
    showCost && chartMetric === "cost" && !costHasData;

  // Merged daily series for the recharts trend (cost + conversations + cost/conversation). Genuinely
  // empty (no usage AND no cost) → the "no data" placeholder instead of an axes-only empty chart.
  const chartData = buildCostTrend(points, costDays, range);
  const hasChartData = points.length > 0 || costDays.length > 0;
  // Cost per conversation across the whole window (item 7): the robust aggregate (total cost ÷ total
  // conversations), free of the per-day line's UTC/local day-boundary caveat. Only in the Real segment
  // with actual cost (never in playground/all, and not while cost is still $0 from ingestion lag).
  const costPerConversation =
    showCost && totalCostUsd > 0 && kpis && kpis.totalConversations > 0
      ? totalCostUsd / kpis.totalConversations
      : null;

  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Gauge className="h-6 w-6 text-accent" aria-hidden="true" />
          <div>
            <h1 className="font-semibold text-text-primary text-xl">
              {t("dashboard.title", "Dashboard")}
            </h1>
            <p className="mt-0.5 text-sm text-text-muted">
              {t(
                "dashboard.subtitle",
                "Automation funnel, LLM cost and conversation volume.",
              )}
            </p>
          </div>
        </div>
        <RangeToggle value={range} onChange={setRange} />
      </header>

      <DataBoundary
        loading={loading}
        error={error || !kpis}
        errorStatus={errorStatus ?? undefined}
        onRetry={() => load(range)}
        loadingLabel={t("dashboard.loading", "Loading metrics…")}
        errorLabel={t("dashboard.error", "Could not load metrics.")}
        skeleton={<DashboardSkeleton />}
      >
        {kpis && (
          <>
            {/* Automation funnel KPIs */}
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h2 className="font-medium text-sm text-text-primary">
                  {t("dashboard.funnel", "Automation funnel")}
                </h2>
                <div className="inline-flex rounded-lg border border-border bg-bg-tertiary p-0.5">
                  <button
                    type="button"
                    onClick={() => setKpiMode("rate")}
                    className={cn(
                      "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                      kpiMode === "rate"
                        ? "bg-bg-secondary text-text-primary"
                        : "text-text-muted hover:text-text-secondary",
                    )}
                  >
                    {t("dashboard.percent", "%")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setKpiMode("count")}
                    className={cn(
                      "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                      kpiMode === "count"
                        ? "bg-bg-secondary text-text-primary"
                        : "text-text-muted hover:text-text-secondary",
                    )}
                  >
                    {t("dashboard.absolute", "#")}
                  </button>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard
                  icon={MessagesSquare}
                  label={t("dashboard.kpi.total", "Conversations")}
                  primary={nf.format(kpis.totalConversations)}
                  secondary={t("dashboard.kpi.totalHint", "in the period")}
                />
                <KpiCard
                  icon={Bot}
                  accent
                  label={t("dashboard.kpi.involvement", "Involvement")}
                  primary={
                    kpiMode === "rate"
                      ? pf(kpis.involvementRate)
                      : nf.format(kpis.involved)
                  }
                  secondary={t(
                    "dashboard.kpi.involvementHint",
                    "{{involved}} of {{total}} handled by AI",
                    {
                      involved: nf.format(kpis.involved),
                      total: nf.format(kpis.totalConversations),
                    },
                  )}
                />
                <KpiCard
                  icon={Target}
                  accent
                  label={t("dashboard.kpi.resolution", "Resolution")}
                  primary={
                    kpiMode === "rate"
                      ? pf(kpis.resolutionRate)
                      : nf.format(kpis.resolvedByBot)
                  }
                  secondary={t(
                    "dashboard.kpi.resolutionHint",
                    "{{resolved}} closed by the agent itself",
                    { resolved: nf.format(kpis.resolvedByBot) },
                  )}
                />
                <KpiCard
                  icon={ArrowRightLeft}
                  label={t("dashboard.kpi.handoff", "Handoffs")}
                  primary={
                    kpiMode === "rate"
                      ? pf(
                          kpis.totalConversations > 0
                            ? kpis.handoff / kpis.totalConversations
                            : 0,
                        )
                      : nf.format(kpis.handoff)
                  }
                  secondary={t(
                    "dashboard.kpi.handoffHint",
                    "{{handoff}} escalated to a human",
                    { handoff: nf.format(kpis.handoff) },
                  )}
                />
              </div>

              <Card className="flex flex-col gap-3">
                <FunnelBar
                  label={t("dashboard.kpi.total", "Conversations")}
                  count={kpis.totalConversations}
                  total={kpis.totalConversations}
                  nf={nf}
                />
                <FunnelBar
                  label={t("dashboard.kpi.involvement", "Involvement")}
                  count={kpis.involved}
                  total={kpis.totalConversations}
                  nf={nf}
                />
                <FunnelBar
                  label={t("dashboard.kpi.resolution", "Resolution")}
                  count={kpis.resolvedByBot}
                  total={kpis.totalConversations}
                  nf={nf}
                />
                {/* Conversations resolved before this instance started recording WHO closed them
                    cannot be attributed either way. Saying so is the difference between a funnel
                    that looks lower for a historical window and an operator concluding the agent
                    got worse the day they upgraded. Disappears once the window moves past them. */}
                {kpis.resolvedBeforeTracking > 0 && (
                  <p className="text-text-tertiary text-xs">
                    {t(
                      "dashboard.kpi.resolutionUntracked",
                      "{{untracked}} more were resolved before this instance began recording who closed a conversation, so they are not counted here.",
                      { untracked: nf.format(kpis.resolvedBeforeTracking) },
                    )}
                  </p>
                )}
              </Card>
            </section>

            {/* The human half of an attendance. Everything above is derived from LlmUsage, so on an
                inbox the agent never touched the whole funnel reads zero, which reads as failure
                rather than as "the agent was not here". This one number is Chatwoot's own
                first-response SLA, mirrored onto the conversation, and it still answers there.
                Rendered even with no sample, and saying so: an absent median that showed up as 0 s
                would be the same lie in a new place. */}
            <section className="flex flex-col gap-3">
              <h2 className="font-medium text-sm text-text-primary">
                {t("dashboard.attendance", "Team response")}
              </h2>
              <div className="grid gap-4 sm:grid-cols-3">
                <KpiCard
                  icon={Timer}
                  label={t("dashboard.kpi.firstResponse", "First response")}
                  primary={
                    formatDuration(kpis.firstResponseSeconds, i18n.language) ??
                    "\u2014"
                  }
                  secondary={
                    kpis.firstResponseSampled > 0
                      ? t(
                          "dashboard.kpi.firstResponseHint",
                          "median over {{sampled}} answered conversations",
                          { sampled: nf.format(kpis.firstResponseSampled) },
                        )
                      : t(
                          "dashboard.kpi.firstResponseNone",
                          "no data for this period yet",
                        )
                  }
                />
                <p className="text-text-tertiary text-xs sm:col-span-2">
                  {t(
                    "dashboard.kpi.firstResponseNote",
                    "How long the team took to answer, as Chatwoot itself measures it: from the conversation's creation to its first reply from a person. The agent's own answers are not counted here, they are in the funnel above. On a conversation the business opened, the opening message counts as the reply, which is what this number means on the Chatwoot dashboard too. A conversation joins this count the next time Chatwoot sends an event for it, so one already closed before this version may never appear, and an empty period means there is nothing to read rather than that nobody answered.",
                  )}
                </p>
              </div>
            </section>

            {/* Usage section: segmented by traffic source (real / playground / all). The toggle
                stays outside the inner boundary so it is interactive while the section reloads. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-medium text-sm text-text-primary">
                {t("dashboard.usageTitle", "LLM usage")}
              </h2>
              <SourceToggle value={source} onChange={setSource} />
            </div>

            <DataBoundary
              loading={usageLoading}
              error={usageError || !metrics}
              errorStatus={usageErrorStatus ?? undefined}
              onRetry={() => loadUsage(range, source)}
              errorLabel={t("dashboard.error", "Could not load metrics.")}
              skeleton={<UsageSkeleton />}
            >
              {metrics && (
                <>
                  {/* Usage timeseries */}
                  <Card className="flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <h2 className="flex items-center gap-2 font-medium text-text-primary">
                        <TrendingUp
                          className="h-4 w-4 text-accent"
                          aria-hidden
                        />
                        {t("dashboard.timeseries", "Daily usage")}
                      </h2>
                      <div className="flex items-center gap-3">
                        {langfuseUrl && (
                          <a
                            href={langfuseUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-text-muted text-xs hover:text-text-primary"
                          >
                            <ExternalLink
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                            {t("dashboard.openInLangfuse", "Open in Langfuse")}
                          </a>
                        )}
                        {showCost && (
                          <div className="inline-flex rounded-lg border border-border bg-bg-tertiary p-0.5">
                            <button
                              type="button"
                              onClick={() => setChartMetric("cost")}
                              className={cn(
                                "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                                chartMetric === "cost"
                                  ? "bg-bg-secondary text-text-primary"
                                  : "text-text-muted hover:text-text-secondary",
                              )}
                            >
                              {t("dashboard.metric.cost", "Cost")}
                            </button>
                            <button
                              type="button"
                              onClick={() => setChartMetric("calls")}
                              className={cn(
                                "rounded-md px-2.5 py-1 font-medium text-xs transition-colors",
                                chartMetric === "calls"
                                  ? "bg-bg-secondary text-text-primary"
                                  : "text-text-muted hover:text-text-secondary",
                              )}
                            >
                              {t("dashboard.metric.calls", "Requests")}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                    {hasChartData ? (
                      <Suspense fallback={<Skeleton className="h-72 w-full" />}>
                        <CostTrendChart
                          data={chartData}
                          metric={effectiveChartMetric}
                          i18nLang={i18n.language}
                        />
                      </Suspense>
                    ) : (
                      <p className="py-8 text-center text-sm text-text-muted">
                        {t("dashboard.noData", "No data yet.")}
                      </p>
                    )}
                    {costFellBackToCalls && (
                      <p className="text-text-muted text-xs">
                        {t(
                          "dashboard.costFallback",
                          "No cost data for this period yet; showing request volume.",
                        )}
                      </p>
                    )}
                  </Card>

                  {/* Cost + token summary. The cost slot is ALWAYS present in the Real segment (item 8):
                      it shows the value with Langfuse, or a compact disabled/error state in the SAME
                      slot — so switching tabs never inserts/removes a separate notice card below and the
                      block height stays stable. Non-real segments drop the cost column (cost there would
                      be a mismatch). */}
                  <div
                    className={cn(
                      "grid gap-4",
                      costPerConversation != null
                        ? "sm:grid-cols-2 lg:grid-cols-4"
                        : realView
                          ? "sm:grid-cols-3"
                          : "sm:grid-cols-2",
                    )}
                  >
                    {realView &&
                      (showCost ? (
                        <KpiCard
                          icon={Coins}
                          label={t("dashboard.totalCost", "LLM cost")}
                          primary={cf.format(totalCostUsd)}
                          secondary={t("dashboard.calls", "{{n}} requests", {
                            n: nf.format(metrics.llm.calls),
                          })}
                        />
                      ) : (
                        <Card className="flex flex-col gap-2">
                          <div className="flex items-center gap-2 text-text-muted text-xs">
                            <Coins className="h-4 w-4" aria-hidden="true" />
                            {t("dashboard.totalCost", "LLM cost")}
                          </div>
                          {costsError ? (
                            <p className="flex items-start gap-1.5 text-sm text-text-muted">
                              <TriangleAlert
                                className="mt-0.5 h-4 w-4 shrink-0"
                                aria-hidden="true"
                              />
                              {t(
                                "dashboard.costsError",
                                "Could not fetch costs from Langfuse.",
                              )}
                            </p>
                          ) : (
                            <>
                              <p className="text-sm text-text-muted">
                                {t(
                                  "dashboard.costsDisabledDesc",
                                  "Connect Langfuse to track actual LLM spend from your real usage.",
                                )}
                              </p>
                              <button
                                type="button"
                                onClick={() => navigate("/resources/advanced")}
                                className="self-start text-accent text-xs hover:underline"
                              >
                                {t(
                                  "dashboard.costsEnableCta",
                                  "Enable cost tracking",
                                )}
                              </button>
                            </>
                          )}
                        </Card>
                      ))}
                    {costPerConversation != null && (
                      <KpiCard
                        icon={Coins}
                        accent
                        label={t(
                          "dashboard.costPerConversation",
                          "Cost / conversation",
                        )}
                        primary={cf.format(costPerConversation)}
                        secondary={t(
                          "dashboard.costPerConversationHint",
                          "across {{n}} conversations",
                          { n: nf.format(kpis.totalConversations) },
                        )}
                      />
                    )}
                    <KpiCard
                      icon={Hash}
                      label={t("dashboard.tokens", "Tokens (in / out)")}
                      primary={`${nf.format(metrics.llm.promptTokens)} / ${nf.format(
                        metrics.llm.completionTokens,
                      )}`}
                      secondary={
                        metrics.llm.cachedReadTokens > 0 ||
                        metrics.llm.cacheCreationTokens > 0
                          ? t(
                              "dashboard.tokensCachedHint",
                              "{{cached}} cached · {{written}} cache-write",
                              {
                                cached: nf.format(metrics.llm.cachedReadTokens),
                                written: nf.format(
                                  metrics.llm.cacheCreationTokens,
                                ),
                              },
                            )
                          : t("dashboard.tokensHint", "prompt / completion")
                      }
                    />
                    <KpiCard
                      icon={MessagesSquare}
                      label={t("dashboard.conversations", "Conversations")}
                      primary={nf.format(metrics.conversations.total)}
                      secondary={metrics.conversations.byStatus
                        .map(
                          (s) =>
                            // biome-ignore lint/plugin/no-dynamic-i18n-key: status keys defined via magic comments in ConversationsPage
                            `${t(`conversations.status.${s.status}`, s.status)}: ${nf.format(s.count)}`,
                        )
                        .join(" · ")}
                    />
                  </div>

                  {/* Usage by agent */}
                  <Card className="flex flex-col gap-3">
                    <h2 className="font-medium text-text-primary">
                      {t("dashboard.usageByAgent", "Usage by agent")}
                    </h2>
                    {metrics.llm.byAgent.length === 0 ? (
                      <p className="text-sm text-text-muted">
                        {t("dashboard.noData", "No data yet.")}
                      </p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {metrics.llm.byAgent.map((a) => (
                          <li
                            key={a.agentId ?? "none"}
                            className="flex items-center justify-between gap-4 text-sm"
                          >
                            <span className="truncate text-text-secondary">
                              {a.agentId
                                ? (agentNames[a.agentId] ??
                                  t("dashboard.agent", "Agent #{{id}}", {
                                    id: a.agentId,
                                  }))
                                : t("dashboard.noAgent", "Unattributed")}
                            </span>
                            <span className="shrink-0 font-medium text-text-primary tabular-nums">
                              {t(
                                "dashboard.agentCallsTokens",
                                "{{calls}} requests · {{tokens}} tokens",
                                {
                                  calls: nf.format(a.calls),
                                  tokens: nf.format(
                                    a.promptTokens + a.completionTokens,
                                  ),
                                },
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>

                  {/* Usage by inbox + by model (token/call based, follows the selected segment) */}
                  <div className="grid gap-4 lg:grid-cols-2">
                    <Card className="flex flex-col gap-3">
                      <h2 className="font-medium text-text-primary">
                        {t("dashboard.usageByInbox", "Usage by inbox")}
                      </h2>
                      {metrics.llm.byInbox.length === 0 ? (
                        <p className="text-sm text-text-muted">
                          {t("dashboard.noData", "No data yet.")}
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {metrics.llm.byInbox.map((ib) => (
                            <li
                              key={ib.inboxId}
                              className="flex items-center justify-between gap-4 text-sm"
                            >
                              <span className="truncate text-text-secondary">
                                {ib.name ??
                                  t("dashboard.inbox", "Inbox #{{id}}", {
                                    id: ib.inboxId,
                                  })}
                              </span>
                              <span className="shrink-0 font-medium text-text-primary tabular-nums">
                                {t(
                                  "dashboard.agentCallsTokens",
                                  "{{calls}} requests · {{tokens}} tokens",
                                  {
                                    calls: nf.format(ib.calls),
                                    tokens: nf.format(
                                      ib.promptTokens + ib.completionTokens,
                                    ),
                                  },
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Card>

                    <Card className="flex flex-col gap-3">
                      <h2 className="font-medium text-text-primary">
                        {t("dashboard.usageByModel", "Usage by model")}
                      </h2>
                      {metrics.llm.byModel.length === 0 ? (
                        <p className="text-sm text-text-muted">
                          {t("dashboard.noData", "No data yet.")}
                        </p>
                      ) : (
                        <ul className="flex flex-col gap-2">
                          {metrics.llm.byModel.map((m) => (
                            <li
                              key={m.model}
                              className="flex items-center justify-between gap-4 text-sm"
                            >
                              <span className="truncate text-text-secondary">
                                {m.model}
                              </span>
                              <span className="shrink-0 font-medium text-text-primary tabular-nums">
                                {t(
                                  "dashboard.agentCallsTokens",
                                  "{{calls}} requests · {{tokens}} tokens",
                                  {
                                    calls: nf.format(m.calls),
                                    tokens: nf.format(
                                      m.promptTokens + m.completionTokens,
                                    ),
                                  },
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Card>
                  </div>

                  {/* Cost by model — only when Langfuse costs are available (Real segment) */}
                  {costByModel && (
                    <Card className="flex flex-col gap-3">
                      <h2 className="font-medium text-text-primary">
                        {t("dashboard.costByModel", "Cost by model")}
                      </h2>
                      <ul className="flex flex-col gap-2">
                        {costByModel.map((m) => (
                          <li
                            key={m.model}
                            className="flex items-center justify-between gap-4 text-sm"
                          >
                            <span className="truncate text-text-secondary">
                              {m.model}
                            </span>
                            <span className="shrink-0 font-medium text-text-primary tabular-nums">
                              {cf.format(m.costUsd)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}
                </>
              )}
            </DataBoundary>
          </>
        )}
      </DataBoundary>
    </PageContainer>
  );
}
