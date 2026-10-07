import {
  Coins,
  Database,
  ExternalLink,
  Gauge,
  Layers,
  LineChart as LineIcon,
  TriangleAlert,
} from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Card,
  SegmentedControl,
  Skeleton,
  SpendBar,
  SpendHealthLines,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { Block, type BlockTable, Delta } from "./Block";
import type { ChartRow } from "./charts";
import {
  apiQuery,
  type DashboardFilters,
  daysOf,
  type Window,
} from "./filters";
import { useBlock } from "./useBlock";

const LineTrend = lazy(() =>
  import("./charts").then((m) => ({ default: m.LineTrend })),
);
const StackedBars = lazy(() =>
  import("./charts").then((m) => ({ default: m.StackedBars })),
);

type CostsData = Awaited<
  ReturnType<typeof api.api.v1.metrics.costs.get>
>["data"];
export type Costs = NonNullable<CostsData>["costs"];
type CeilingData = Awaited<
  ReturnType<
    (typeof api.api.v1)["tenant-settings"]["spend-ceiling"]["usage"]["get"]
  >
>["data"];
type Ceiling = NonNullable<CeilingData>;

// How often the page asks again for the ceiling when no read has yet said the poll's period.
const CEILING_RETRY_MS = 60_000;

// What each `llm_usage.node` is, in the operator's words.
export function useNodeLabel() {
  const { t } = useTranslation();
  const labels: Record<string, string> = {
    agent: t("dashboard.node.agent", "Agent reply"),
    nudge: t("dashboard.node.nudge", "Follow-up"),
    vision: t("dashboard.node.vision", "Image reading"),
    observer: t("dashboard.node.observer", "Observer"),
    tts_normalize: t("dashboard.node.ttsNormalize", "Voice text preparation"),
    guardrail: t("dashboard.node.guardrail", "Guardrail"),
    memory_compact: t("dashboard.node.memoryCompact", "Memory compaction"),
    suggestion_review: t(
      "dashboard.node.suggestionReview",
      "Knowledge suggestion review",
    ),
  };
  return (node: string) => labels[node] ?? node;
}

export function CostSection({
  filters,
  win,
  prev,
}: {
  filters: DashboardFilters;
  win: Window;
  prev: Window | null;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const nodeLabel = useNodeLabel();
  const [split, setSplit] = useState<"model" | "node">("model");
  const cf = new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
  const cfShort = new Intl.NumberFormat(i18n.language, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
  const nf = new Intl.NumberFormat(i18n.language);
  const pf = (v: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(v);

  const query = apiQuery(filters, win);
  const costs = useBlock(JSON.stringify(["costs", query]), async () => {
    const res = await api.api.v1.metrics.costs.get({ query });
    return { data: res.data?.costs ?? null, status: res.error?.status };
  });
  const prevQuery = prev ? apiQuery(filters, prev) : null;
  const prevCosts = useBlock(
    JSON.stringify(["costs-prev", prevQuery]),
    async () => {
      if (!prevQuery) return { data: null };
      const res = await api.api.v1.metrics.costs.get({ query: prevQuery });
      return { data: res.data?.costs ?? null };
    },
  );
  const cache = useBlock(JSON.stringify(["cache", query]), async () => {
    const res = await api.api.v1.metrics.breakdown.get({
      query: { ...query, dimension: "agent" },
    });
    return { data: res.data?.rows ?? null };
  });
  const ceiling = useBlock<Ceiling>(
    JSON.stringify(["ceiling", query.until]),
    async () => {
      const res =
        await api.api.v1["tenant-settings"]["spend-ceiling"].usage.get();
      return { data: res.data ?? null };
    },
  );

  const c = costs.data;
  const p = prevCosts.data;
  const days = daysOf(win, c?.days[0]?.date ?? null);
  const prevDays = prev ? daysOf(prev) : [];
  const costByDay = new Map(c?.days.map((d) => [d.date, d]) ?? []);
  const prevByDay = new Map(p?.days.map((d) => [d.date, d]) ?? []);

  // Stacked by model or by call type: every key that has a cost in the window is a segment.
  const splitRows =
    split === "model" ? (c?.daysByModel ?? []) : (c?.daysByNode ?? []);
  const segmentKeys = [...new Set(splitRows.map((r) => r.key))].sort();
  const segments = segmentKeys.map((k, i) => ({
    key: `k${i}`,
    raw: k,
    label: split === "node" ? nodeLabel(k) : k,
  }));
  const stacked: ChartRow[] = days.map((day) => {
    const row: ChartRow = { day };
    for (const s of segments) {
      row[s.key] =
        splitRows.find((r) => r.date === day && r.key === s.raw)?.costUsd ?? 0;
    }
    return row;
  });
  const stackedTable: BlockTable = {
    name: `dashboard-cost-by-${split}`,
    header: [
      t("dashboard.col.day", "Day"),
      ...segments.map((s) => s.label),
      t("dashboard.col.total", "Total"),
    ],
    rows: stacked.map((r) => {
      const vals = segments.map((s) => (r[s.key] as number) ?? 0);
      return [r.day, ...vals, vals.reduce((a, b) => a + b, 0)];
    }),
    display: stacked.map((r) => {
      const vals = segments.map((s) => (r[s.key] as number) ?? 0);
      return [
        r.day,
        ...vals.map((v) => cf.format(v)),
        cf.format(vals.reduce((a, b) => a + b, 0)),
      ];
    }),
  };

  const perConv: ChartRow[] = days.map((day, i) => {
    const d = costByDay.get(day);
    const pd = prevDays[i] ? prevByDay.get(prevDays[i] as string) : undefined;
    return {
      day,
      perConversation: d?.costPerConversation ?? null,
      perResolved: d?.costPerResolvedConversation ?? null,
      perConversationPrev: pd?.costPerConversation ?? null,
      perResolvedPrev: pd?.costPerResolvedConversation ?? null,
    };
  });
  const perConvSeries = [
    {
      key: "perConversation",
      label: t("dashboard.cost.perConversation", "Cost / conversation"),
    },
    {
      key: "perResolved",
      label: t(
        "dashboard.cost.perResolved",
        "Cost / conversation resolved by the agent",
      ),
    },
  ];
  const money = (v: number | null | undefined) =>
    typeof v === "number" ? cf.format(v) : "\u2014";
  const perConvTable: BlockTable = {
    name: "dashboard-cost-per-conversation",
    header: [
      t("dashboard.col.day", "Day"),
      ...perConvSeries.map((s) => s.label),
      ...(prev
        ? perConvSeries.map((s) =>
            t("dashboard.col.previousOf", "{{label}} (previous period)", {
              label: s.label,
            }),
          )
        : []),
    ],
    rows: perConv.map((r) => [
      r.day,
      r.perConversation as number | null,
      r.perResolved as number | null,
      ...(prev
        ? [
            r.perConversationPrev as number | null,
            r.perResolvedPrev as number | null,
          ]
        : []),
    ]),
    display: perConv.map((r) => [
      r.day,
      money(r.perConversation as number | null),
      money(r.perResolved as number | null),
      ...(prev
        ? [
            money(r.perConversationPrev as number | null),
            money(r.perResolvedPrev as number | null),
          ]
        : []),
    ]),
  };

  // Cache share per agent: cached input over input, an agent that sent no input has no share.
  const cacheRows = (cache.data ?? []).filter((r) => r.key !== null);
  const cacheTable: BlockTable = {
    name: "dashboard-cache-share",
    header: [
      t("dashboard.col.agent", "Agent"),
      t("dashboard.col.cacheShare", "Cached input"),
      t("dashboard.col.promptTokens", "Input tokens"),
    ],
    rows: cacheRows.map((r) => [
      r.label ?? r.key,
      r.cacheShare,
      r.promptTokens,
    ]),
  };

  const ceilingData = ceiling.data;
  const ceilingSources: ("inbox" | "playground")[] =
    filters.source === "all" ? ["inbox", "playground"] : [filters.source];
  const ceilingMonth = ceilingData
    ? new Intl.DateTimeFormat(i18n.language, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(ceilingData.periodStart))
    : null;
  const ceilingWhen = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      dateStyle: "short",
      timeStyle: "short",
    });
  // The ceiling's figure refreshes on the poll's own period while the page stays open.
  const refreshMs = ceilingData?.pollIntervalMs ?? CEILING_RETRY_MS;
  useInterval(ceiling.reload, refreshMs);

  const langfuseUrl = c?.langfuse
    ? (c.langfuse.projectUrl ?? c.langfuse.baseUrl)
    : null;

  return (
    <section id="cost" className="flex scroll-mt-4 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium text-sm text-text-primary">
          {t("dashboard.cost.title", "Cost")}
        </h2>
        {langfuseUrl && (
          <a
            href={langfuseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-text-muted text-xs hover:text-text-primary"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            {t("dashboard.openInLangfuse", "Open in Langfuse")}
          </a>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-text-muted text-xs">
            <Coins className="h-4 w-4 text-accent" aria-hidden="true" />
            {t("dashboard.totalCost", "LLM cost")}
          </div>
          {costs.loading && !c ? (
            <Skeleton className="h-8 w-28" />
          ) : c ? (
            <>
              <p className="font-semibold text-2xl text-text-primary tabular-nums">
                {cf.format(c.totalCostUsd)}
              </p>
              <Delta
                kind="amount"
                current={c.totalCostUsd}
                previous={p?.totalCostUsd}
                format={(v) => cf.format(v)}
                lowerIsBetter
              />
            </>
          ) : (
            <p className="flex items-start gap-1.5 text-sm text-text-muted">
              <TriangleAlert
                className="mt-0.5 h-4 w-4 shrink-0"
                aria-hidden="true"
              />
              {t("dashboard.costsError", "Could not read the cost.")}
            </p>
          )}
        </Card>
        <Card className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-text-muted text-xs">
            <Coins className="h-4 w-4 text-accent" aria-hidden="true" />
            {t("dashboard.cost.perConversation", "Cost / conversation")}
          </div>
          <p className="font-semibold text-2xl text-text-primary tabular-nums">
            {money(c?.costPerConversation)}
          </p>
          <p className="text-text-muted text-xs">
            {t(
              "dashboard.cost.acrossConversations",
              "across {{n}} conversations",
              {
                count: c?.conversations ?? 0,
                n: nf.format(c?.conversations ?? 0),
              },
            )}
          </p>
          <Delta
            kind="amount"
            current={c?.costPerConversation ?? null}
            previous={p?.costPerConversation}
            format={(v) => cf.format(v)}
            lowerIsBetter
          />
        </Card>
        <Card className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-text-muted text-xs">
            <Coins className="h-4 w-4 text-accent" aria-hidden="true" />
            {t(
              "dashboard.cost.perResolved",
              "Cost / conversation resolved by the agent",
            )}
          </div>
          <p className="font-semibold text-2xl text-text-primary tabular-nums">
            {money(c?.costPerResolvedConversation)}
          </p>
          <p className="text-text-muted text-xs">
            {t("dashboard.cost.acrossResolved", "across {{n}} resolved", {
              count: c?.resolvedConversations ?? 0,
              n: nf.format(c?.resolvedConversations ?? 0),
            })}
          </p>
          <Delta
            kind="amount"
            current={c?.costPerResolvedConversation ?? null}
            previous={p?.costPerResolvedConversation}
            format={(v) => cf.format(v)}
            lowerIsBetter
          />
        </Card>
        <Card className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-text-muted text-xs">
            <Layers className="h-4 w-4 text-accent" aria-hidden="true" />
            {t("dashboard.tokens", "Tokens (in / out)")}
          </div>
          <p className="font-semibold text-text-primary text-xl tabular-nums">
            {c
              ? `${nf.format(c.tokens.prompt)} / ${nf.format(c.tokens.completion)}`
              : "\u2014"}
          </p>
          <p className="text-text-muted text-xs">
            {t("dashboard.calls", "{{n}} requests", {
              count: c?.requests ?? 0,
              n: nf.format(c?.requests ?? 0),
            })}
          </p>
        </Card>
      </div>

      {c && c.unpriced.calls > 0 && (
        <p
          className="flex items-start gap-1.5 text-warning text-xs"
          data-testid="cost-unpriced"
        >
          <TriangleAlert
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span>
            {t(
              "dashboard.unpriced",
              "{{n}} requests in this period have no price and are not in the cost: {{models}}. Set this account's own price for the model in Advanced > Model prices, then re-price the calls already made.",
              {
                count: c.unpriced.calls,
                n: nf.format(c.unpriced.calls),
                models: c.unpriced.models.join(", "),
              },
            )}{" "}
            <button
              type="button"
              onClick={() => navigate("/resources/advanced")}
              className="text-accent hover:underline"
            >
              {t("dashboard.unpricedCta", "Open model prices")}
            </button>
          </span>
        </p>
      )}

      <Block
        icon={Coins}
        title={t("dashboard.cost.daily", "Daily cost")}
        help={t(
          "dashboard.cost.dailyHelp",
          "Summed from this app's own record of every model call, priced when the call was made. Split by model, or by what the call was for: a change in the image reader and a change in the agent's prompt show up in different colors.",
        )}
        chart
        table={stackedTable}
        actions={
          <SegmentedControl
            aria-label={t("dashboard.cost.splitBy", "Split the cost by")}
            value={split}
            onChange={setSplit}
            options={[
              { value: "model", label: t("dashboard.cost.byModel", "Model") },
              { value: "node", label: t("dashboard.cost.byNode", "Call type") },
            ]}
          />
        }
      >
        {costs.loading && !c ? (
          <Skeleton className="h-64 w-full" />
        ) : segments.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            {t("dashboard.noData", "No data yet.")}
          </p>
        ) : (
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <StackedBars
              data={stacked}
              series={segments}
              lang={i18n.language}
              format={(v) => cfShort.format(v)}
            />
          </Suspense>
        )}
      </Block>

      <Block
        icon={LineIcon}
        title={t(
          "dashboard.cost.perConversationTrend",
          "Cost per conversation",
        )}
        help={t(
          "dashboard.cost.perConversationHelp",
          "Each day's cost divided by the conversations that had a model call that day, and by those of them the agent resolved. A day with nothing to divide by is left blank.",
        )}
        chart
        table={perConvTable}
      >
        {costs.loading && !c ? (
          <Skeleton className="h-56 w-full" />
        ) : perConv.every((r) => r.perConversation === null) ? (
          <p className="py-8 text-center text-sm text-text-muted">
            {t("dashboard.noData", "No data yet.")}
          </p>
        ) : (
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <LineTrend
              data={perConv}
              series={perConvSeries}
              lang={i18n.language}
              format={(v) => cf.format(v)}
              compare={
                prev
                  ? {
                      perConversation: "perConversationPrev",
                      perResolved: "perResolvedPrev",
                    }
                  : undefined
              }
              compareLabel={t("dashboard.previousPeriod", "previous period")}
              height={220}
            />
          </Suspense>
        )}
      </Block>

      <div className="grid gap-4 lg:grid-cols-2">
        <Block
          icon={Database}
          title={t("dashboard.cache.title", "Cached input by agent")}
          help={t(
            "dashboard.cache.help",
            "The share of each agent's input tokens the provider served from its cache, which it bills at a discount. On a long prompt this is the biggest cost lever; an agent with no input in the period shows no figure.",
          )}
          table={cacheTable}
        >
          {cache.loading && !cache.data ? (
            <Skeleton className="h-24 w-full" />
          ) : cacheRows.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t("dashboard.noData", "No data yet.")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {cacheRows.map((r) => (
                <li key={r.key} className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="truncate text-text-secondary">
                      {r.label ?? r.key}
                    </span>
                    <span className="font-medium text-text-primary tabular-nums">
                      {r.cacheShare === null ? "\u2014" : pf(r.cacheShare)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-bg-tertiary">
                    <div
                      className="h-full rounded-full bg-accent-solid"
                      style={{ width: `${(r.cacheShare ?? 0) * 100}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Block>

        {/* The month, against the ceiling: the calendar month in UTC (the ceiling's own window,
            whatever the period above), the spend so far, and where the month ends at this pace. */}
        <Card id="month" className="flex scroll-mt-4 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="flex items-center gap-2 font-medium text-sm text-text-primary">
              <Gauge className="h-4 w-4 text-accent" aria-hidden="true" />
              {t("dashboard.ceiling.title", "Spend ceiling")}
            </h3>
            <div className="flex items-center gap-3">
              {ceilingMonth && (
                <span className="text-text-muted text-xs">
                  {t(
                    "dashboard.ceiling.period",
                    "{{month}} · the calendar month, not the selected period",
                    { month: ceilingMonth },
                  )}
                </span>
              )}
              <button
                type="button"
                onClick={() => navigate("/resources/advanced")}
                className="text-accent text-xs hover:underline"
              >
                {t("dashboard.ceiling.cta", "Set the ceiling")}
              </button>
            </div>
          </div>
          {ceiling.loading && !ceilingData ? (
            <Skeleton className="h-16 w-full" />
          ) : !ceilingData ? (
            <p className="text-sm text-text-muted">
              {t("dashboard.ceiling.unread", "The ceiling could not be read.")}
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {ceilingSources.map((src) => {
                const entry = ceilingData.entries.find((e) => e.source === src);
                return (
                  <div key={src} className="flex flex-col gap-1">
                    <SpendBar
                      label={
                        src === "playground"
                          ? t("dashboard.source.playground", "Playground")
                          : t("dashboard.source.inbox", "Real")
                      }
                      entry={entry}
                      money={cfShort}
                      enabled={ceilingData.enabled}
                    />
                    {entry && (
                      <p className="text-text-muted text-xs">
                        {t(
                          "dashboard.ceiling.projection",
                          "So far {{used}}; at this pace the month ends near {{projected}}",
                          {
                            used: cfShort.format(entry.usedUsd),
                            projected: cfShort.format(entry.projectedUsd),
                          },
                        )}
                        {entry.ceilingUsd !== null &&
                          ` · ${t(
                            "dashboard.ceiling.of",
                            "ceiling {{ceiling}}",
                            {
                              ceiling: cfShort.format(entry.ceilingUsd),
                            },
                          )}`}
                      </p>
                    )}
                    <SpendHealthLines
                      entry={entry}
                      when={ceilingWhen}
                      enabled={ceilingData.enabled}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </section>
  );
}

function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
