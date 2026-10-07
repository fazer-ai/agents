import {
  ArrowRightLeft,
  Bot,
  MessagesSquare,
  Target,
  Timer,
  TrendingUp,
  Zap,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Card,
  HelpPopover,
  SegmentedControl,
  Select,
  Skeleton,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { formatDuration } from "@/client/lib/duration";
import { cn } from "@/client/lib/utils";
import { Block, type BlockTable, Delta } from "./Block";
import type { ChartRow } from "./charts";
import {
  apiQuery,
  type DashboardFilters,
  daysOf,
  drillDownHref,
  METRIC_DRILL,
  type TrendMetric,
  trendPointHref,
  type Window,
} from "./filters";
import { useBlock } from "./useBlock";

const LineTrend = lazy(() =>
  import("./charts").then((m) => ({ default: m.LineTrend })),
);

type KpisData = Awaited<ReturnType<typeof api.api.v1.metrics.kpis.get>>["data"];
export type Kpis = NonNullable<KpisData>["kpis"];
type OutcomesData = Awaited<
  ReturnType<typeof api.api.v1.metrics.outcomes.get>
>["data"];
type Trend = NonNullable<OutcomesData>["trend"];
type Counts = Trend["totals"];

type Metric = TrendMetric;
type Breakdown = "none" | "agent" | "inbox";

// The funnel rates of a set of counts, the same arithmetic as the server's `outcomeRates`. Null when
// the divisor is zero: an empty day has no rate, which is not a rate of 0%.
function rate(c: Counts | undefined, m: Metric): number | null {
  if (!c) return null;
  switch (m) {
    case "involvement":
      return c.total > 0 ? c.involved / c.total : null;
    case "resolution":
      return c.involved > 0 ? c.resolvedByBot / c.involved : null;
    case "automation":
      return c.total > 0 ? c.resolvedByBot / c.total : null;
    case "handoff":
      return c.total > 0 ? c.handoff / c.total : null;
  }
}

const DRILL = METRIC_DRILL;

function KpiTile({
  icon: Icon,
  label,
  primary,
  secondary,
  delta,
  accent,
  help,
  href,
}: {
  icon: typeof Bot;
  label: string;
  primary: string;
  secondary: string;
  delta?: React.ReactNode;
  accent?: boolean;
  help?: React.ReactNode;
  href?: string;
}) {
  const navigate = useNavigate();
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-text-muted text-xs">
        <Icon
          className={cn("h-4 w-4", accent ? "text-accent" : "text-text-muted")}
          aria-hidden="true"
        />
        {label}
        {help ? <HelpPopover content={help} label={label} /> : null}
      </div>
      {href ? (
        <button
          type="button"
          onClick={() => navigate(href)}
          className="self-start font-semibold text-2xl text-text-primary tabular-nums hover:text-accent hover:underline"
        >
          {primary}
        </button>
      ) : (
        <p className="font-semibold text-2xl text-text-primary tabular-nums">
          {primary}
        </p>
      )}
      <p className="text-text-muted text-xs">{secondary}</p>
      {delta}
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
          className="h-full rounded-full bg-accent-solid transition-all"
          style={{ width: `${Math.max(pct, count > 0 ? 2 : 0)}%` }}
        />
      </div>
    </div>
  );
}

export function PerformanceSection({
  filters,
  win,
  prev,
  kpis,
  prevKpis,
  onFilter,
}: {
  filters: DashboardFilters;
  win: Window;
  prev: Window | null;
  kpis: Kpis;
  prevKpis: Kpis | null;
  onFilter: (patch: Partial<DashboardFilters>) => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"rate" | "count">("rate");
  const [metric, setMetric] = useState<Metric>("resolution");
  const [breakdown, setBreakdown] = useState<Breakdown>("none");
  const nf = new Intl.NumberFormat(i18n.language);
  const pf = (v: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(v);

  const query = apiQuery(filters, win);
  const trend = useBlock(
    JSON.stringify(["outcomes", query, breakdown]),
    async () => {
      const res = await api.api.v1.metrics.outcomes.get({
        query: {
          ...query,
          ...(breakdown === "none" ? {} : { breakdown }),
        },
      });
      return { data: res.data?.trend ?? null, status: res.error?.status };
    },
  );
  const prevQuery = prev ? apiQuery(filters, prev) : null;
  const prevTrend = useBlock(
    JSON.stringify(["outcomes-prev", prevQuery]),
    async () => {
      if (!prevQuery) return { data: null };
      const res = await api.api.v1.metrics.outcomes.get({ query: prevQuery });
      return { data: res.data?.trend ?? null };
    },
  );

  const metricLabel: Record<Metric, string> = {
    involvement: t("dashboard.kpi.involvement", "Involvement"),
    resolution: t("dashboard.kpi.resolution", "Resolution"),
    automation: t("dashboard.kpi.automation", "Automation"),
    handoff: t("dashboard.kpi.handoff", "Handoffs"),
  };
  const prevRate = (m: Metric) =>
    prevKpis
      ? m === "involvement"
        ? prevKpis.involvementRate
        : m === "resolution"
          ? prevKpis.resolutionRate
          : m === "automation"
            ? prevKpis.automationRate
            : prevKpis.handoffRate
      : null;
  const periodHref = (m: Metric) =>
    drillDownHref(filters, { since: win.since, until: win.until }, DRILL[m]);

  // The chart's rows: every day of the window, the previous period's value at the same position.
  const tr = trend.data;
  const days = daysOf(win, tr?.days[0]?.date ?? null);
  const prevDays = prev ? daysOf(prev) : [];
  const prevByDay = new Map(prevTrend.data?.days.map((d) => [d.date, d]) ?? []);
  const byDay = new Map(tr?.days.map((d) => [d.date, d]) ?? []);
  const seriesDefs =
    breakdown === "none"
      ? (
          ["involvement", "resolution", "automation", "handoff"] as Metric[]
        ).map((m) => ({ key: m, label: metricLabel[m] }))
      : (tr?.series ?? []).map((s) => ({ key: `s${s.key}`, label: s.label }));
  const rows: ChartRow[] = days.map((day, i) => {
    const row: ChartRow = { day, prevDay: prevDays[i] ?? null };
    if (breakdown === "none") {
      for (const m of [
        "involvement",
        "resolution",
        "automation",
        "handoff",
      ] as Metric[]) {
        row[m] = rate(byDay.get(day), m);
        const p = prevDays[i];
        row[`${m}Prev`] = p ? rate(prevByDay.get(p), m) : null;
      }
    } else {
      for (const s of tr?.series ?? []) {
        const d = s.days.find((x) => x.date === day);
        row[`s${s.key}`] = rate(d, metric);
      }
    }
    return row;
  });
  const compare =
    breakdown === "none" && prev
      ? {
          involvement: "involvementPrev",
          resolution: "resolutionPrev",
          automation: "automationPrev",
          handoff: "handoffPrev",
        }
      : undefined;
  const fmtRate = (v: number | null | undefined) =>
    typeof v === "number" ? pf(v) : "\u2014";
  const table: BlockTable = {
    name: "dashboard-outcomes",
    header: [
      t("dashboard.col.day", "Day"),
      ...seriesDefs.map((s) => s.label),
      ...(compare
        ? seriesDefs.map((s) =>
            t("dashboard.col.previousOf", "{{label}} (previous period)", {
              label: s.label,
            }),
          )
        : []),
    ],
    rows: rows.map((r) => [
      r.day,
      ...seriesDefs.map((s) => (r[s.key] as number | null) ?? null),
      ...(compare
        ? seriesDefs.map((s) => (r[`${s.key}Prev`] as number | null) ?? null)
        : []),
    ]),
    display: rows.map((r) => [
      r.day,
      ...seriesDefs.map((s) => fmtRate(r[s.key] as number | null)),
      ...(compare
        ? seriesDefs.map((s) => fmtRate(r[`${s.key}Prev`] as number | null))
        : []),
    ]),
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-sm text-text-primary">
          {t("dashboard.funnel", "Automation funnel")}
        </h2>
        <SegmentedControl
          aria-label={t("dashboard.funnelMode", "Show the funnel as")}
          value={mode}
          onChange={setMode}
          options={[
            { value: "rate", label: t("dashboard.percent", "%") },
            { value: "count", label: t("dashboard.absolute", "#") },
          ]}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <KpiTile
          icon={MessagesSquare}
          label={t("dashboard.kpi.total", "Conversations")}
          primary={nf.format(kpis.totalConversations)}
          secondary={t("dashboard.kpi.totalHint", "in the period")}
          href={drillDownHref(filters, win, "all")}
          delta={
            <Delta
              kind="amount"
              current={kpis.totalConversations}
              previous={prevKpis?.totalConversations}
              format={(v) => nf.format(v)}
            />
          }
        />
        <KpiTile
          icon={Bot}
          accent
          label={metricLabel.involvement}
          primary={
            mode === "rate"
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
          href={periodHref("involvement")}
          delta={
            <Delta
              kind="rate"
              current={kpis.involvementRate}
              previous={prevRate("involvement")}
              format={pf}
            />
          }
        />
        <KpiTile
          icon={Target}
          accent
          label={metricLabel.resolution}
          primary={
            mode === "rate"
              ? pf(kpis.resolutionRate)
              : nf.format(kpis.resolvedByBot)
          }
          secondary={t(
            "dashboard.kpi.resolutionHint",
            "{{resolved}} closed by the agent itself",
            { resolved: nf.format(kpis.resolvedByBot) },
          )}
          href={periodHref("resolution")}
          delta={
            <Delta
              kind="rate"
              current={kpis.resolutionRate}
              previous={prevRate("resolution")}
              format={pf}
            />
          }
        />
        <KpiTile
          icon={Zap}
          label={metricLabel.automation}
          primary={
            mode === "rate"
              ? pf(kpis.automationRate)
              : nf.format(kpis.resolvedByBot)
          }
          secondary={t(
            "dashboard.kpi.automationHint",
            "resolved by the agent, of every conversation",
          )}
          help={t(
            "dashboard.kpi.automationHelp",
            "Involvement × Resolution: the share of all conversations in the period that the agent took and closed itself.",
          )}
          delta={
            <Delta
              kind="rate"
              current={kpis.automationRate}
              previous={prevRate("automation")}
              format={pf}
            />
          }
        />
        <KpiTile
          icon={ArrowRightLeft}
          label={metricLabel.handoff}
          primary={
            mode === "rate" ? pf(kpis.handoffRate) : nf.format(kpis.handoff)
          }
          secondary={t(
            "dashboard.kpi.handoffHint",
            "{{handoff}} escalated to a human",
            { handoff: nf.format(kpis.handoff) },
          )}
          href={periodHref("handoff")}
          delta={
            <Delta
              kind="rate"
              current={kpis.handoffRate}
              previous={prevRate("handoff")}
              format={pf}
              lowerIsBetter
            />
          }
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
          label={metricLabel.involvement}
          count={kpis.involved}
          total={kpis.totalConversations}
          nf={nf}
        />
        <FunnelBar
          label={metricLabel.resolution}
          count={kpis.resolvedByBot}
          total={kpis.totalConversations}
          nf={nf}
        />
        {/* Conversations resolved before this instance started recording WHO closed them cannot be
            attributed either way. Saying so is the difference between a funnel that looks lower for
            a historical window and an operator concluding the agent got worse the day they upgraded. */}
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

      <Block
        error={trend.error}
        onRetry={trend.reload}
        icon={TrendingUp}
        title={t("dashboard.trend.title", "Funnel over time")}
        help={t(
          "dashboard.trend.help",
          "One point per day of the conversations that started that day, so a one-day period shows the same rate on the tile and on the line. Click a point to open those conversations. A day with no conversations has no rate and is left blank.",
        )}
        chart
        table={table}
        actions={
          <>
            {breakdown !== "none" && (
              <Select
                aria-label={t("dashboard.trend.metric", "Rate")}
                value={metric}
                onChange={(e) => setMetric(e.target.value as Metric)}
                wrapperClassName="max-w-36"
              >
                {(Object.keys(metricLabel) as Metric[]).map((m) => (
                  <option key={m} value={m}>
                    {metricLabel[m]}
                  </option>
                ))}
              </Select>
            )}
            <SegmentedControl
              aria-label={t("dashboard.trend.breakdown", "Split by")}
              value={breakdown}
              onChange={setBreakdown}
              options={[
                { value: "none", label: t("dashboard.col.total", "Total") },
                {
                  value: "agent",
                  label: t("dashboard.trend.byAgent", "By agent"),
                },
                {
                  value: "inbox",
                  label: t("dashboard.trend.byInbox", "By inbox"),
                },
              ]}
            />
          </>
        }
      >
        {trend.loading && !tr ? (
          <Skeleton className="h-64 w-full" />
        ) : (tr?.days.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            {t("dashboard.noData", "No data yet.")}
          </p>
        ) : (
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <LineTrend
              data={rows}
              series={seriesDefs}
              lang={i18n.language}
              format={(v) => pf(v)}
              compare={compare}
              compareLabel={t("dashboard.previousPeriod", "previous period")}
              onPick={(day, seriesKey) =>
                navigate(
                  trendPointHref(filters, day, breakdown, metric, seriesKey),
                )
              }
            />
          </Suspense>
        )}
      </Block>

      {breakdown !== "none" && tr?.series && tr.series.length > 0 && (
        <Card className="flex flex-col gap-2">
          <h3 className="font-medium text-sm text-text-primary">
            {t("dashboard.trend.perSeries", "{{metric}} in the period", {
              metric: metricLabel[metric],
            })}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {tr.series.map((s) => (
              <li
                key={s.key}
                className="flex items-center justify-between gap-4 text-sm"
              >
                <button
                  type="button"
                  className="truncate text-left text-text-secondary hover:text-accent hover:underline"
                  onClick={() =>
                    onFilter(
                      breakdown === "agent"
                        ? { agentId: s.key }
                        : { inboxId: s.key },
                    )
                  }
                >
                  {s.label}
                </button>
                <span className="shrink-0 font-medium text-text-primary tabular-nums">
                  {fmtRate(rate(s.totals, metric))}
                  <span className="ml-1.5 text-text-muted text-xs">
                    {t(
                      "dashboard.trend.ofConversations",
                      "{{n}} conversations",
                      {
                        count: s.totals.total,
                        n: nf.format(s.totals.total),
                      },
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* The human half of an attendance: Chatwoot's own first-response SLA, mirrored onto the
          conversation. The median and the 90th percentile, and an empty period says so rather than
          showing 0 s. */}
      <div className="grid gap-4 sm:grid-cols-3">
        <KpiTile
          icon={Timer}
          label={t("dashboard.kpi.firstResponse", "First response")}
          primary={
            kpis.firstResponseSeconds === null
              ? "\u2014"
              : t("dashboard.kpi.firstResponsePair", "{{p50}} · p90 {{p90}}", {
                  p50:
                    formatDuration(kpis.firstResponseSeconds, i18n.language) ??
                    "\u2014",
                  p90:
                    formatDuration(
                      kpis.firstResponseP90Seconds,
                      i18n.language,
                    ) ?? "\u2014",
                })
          }
          secondary={
            kpis.firstResponseSampled > 0
              ? t(
                  "dashboard.kpi.firstResponseHint2",
                  "median and 90th percentile over {{sampled}} answered conversations",
                  { sampled: nf.format(kpis.firstResponseSampled) },
                )
              : t(
                  "dashboard.kpi.firstResponseNone",
                  "no data for this period yet",
                )
          }
          help={t(
            "dashboard.kpi.firstResponseHelp",
            "Measures the time from conversation creation to the first reply from a person. Agent replies appear in the funnel above, not here.\n\nIf the business started the conversation, its opening message counts as the first reply, just as it does in the Chatwoot dashboard.\n\nOlder conversations only appear after Chatwoot sends another event for them. An empty period means there is no data.",
          )}
          delta={
            <Delta
              kind="amount"
              current={kpis.firstResponseSeconds}
              previous={prevKpis?.firstResponseSeconds}
              format={(v) => formatDuration(v, i18n.language) ?? "\u2014"}
              lowerIsBetter
            />
          }
        />
      </div>
    </section>
  );
}
