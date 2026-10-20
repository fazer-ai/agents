import {
  Activity,
  ArrowRightLeft,
  Bot,
  Coins,
  Gauge,
  Table2,
  Target,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import {
  DataBoundary,
  Input,
  PageContainer,
  SegmentedControl,
  Select,
  Skeleton,
} from "@/client/components";
import { useClientChannelEnabled } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { type InboxOption, inboxOptionLabel } from "@/client/lib/inboxOption";
import { cn } from "@/client/lib/utils";
import { SectionNav } from "./agents/SectionNav";
import { metricsErrorMessage } from "./dashboard/Block";
import { BreakdownSection } from "./dashboard/BreakdownSection";
import { CostSection } from "./dashboard/CostSection";
import {
  type Audience,
  apiQuery,
  type DashboardFilters,
  localDayKey,
  previousWindow,
  type Range,
  readFilters,
  readUpTo,
  type Source,
  type Window,
  windowOf,
  writeFilters,
} from "./dashboard/filters";
import { AutomationSection, HealthSection } from "./dashboard/HealthSection";
import {
  DEFAULT_PERFORMANCE_VIEW,
  KPI_GRID,
  KPI_SPANS,
  type Kpis,
  PerformanceSection,
  type PerformanceView,
} from "./dashboard/PerformanceSection";
import { ReasonsSection } from "./dashboard/ReasonsSection";
import { StreamProgress } from "./dashboard/StreamProgress";
import { DashboardStreamProvider, useStreamBlock } from "./dashboard/useStream";

// THE OPERATOR'S DASHBOARD, organised by the question an operator brings: is the agent
// doing its job, why does it hand over and what are people asking, what does it cost, is it healthy,
// and what else does it do on its own. One filter (period, agent, inbox, source) in the URL drives
// every block; every figure is summed from this app's own records, and which query each block runs is
// mapped in docs/dashboard.md.

function FilterBar({
  filters,
  onChange,
  agents,
  inboxes,
}: {
  filters: DashboardFilters;
  onChange: (patch: Partial<DashboardFilters>) => void;
  agents: { id: string; name: string }[];
  inboxes: InboxOption[];
}) {
  const { t } = useTranslation();
  const clientChannelEnabled = useClientChannelEnabled();
  const today = localDayKey(new Date());
  const ranges: { value: Range; label: string }[] = [
    { value: "7d", label: t("dashboard.range.7d", "7d") },
    { value: "30d", label: t("dashboard.range.30d", "30d") },
    { value: "90d", label: t("dashboard.range.90d", "90d") },
    { value: "12m", label: t("dashboard.range.12m", "12mo") },
    { value: "all", label: t("dashboard.range.all", "All") },
    { value: "custom", label: t("dashboard.range.custom", "Dates") },
  ];
  const sources: { value: Source; label: string }[] = [
    { value: "inbox", label: t("dashboard.source.inbox", "Real") },
    {
      value: "playground",
      label: t("dashboard.source.playground", "Playground"),
    },
    ...(clientChannelEnabled
      ? [
          {
            value: "client" as const,
            label: t("dashboard.source.client", "Client channel"),
          },
        ]
      : []),
    { value: "all", label: t("dashboard.source.all", "All") },
  ];
  const audiences: { value: Audience; label: string }[] = [
    { value: "all", label: t("dashboard.audience.all", "All users") },
    {
      value: "identified",
      label: t("dashboard.audience.identified", "Signed in"),
    },
    {
      value: "anonymous",
      label: t("dashboard.audience.anonymous", "Anonymous"),
    },
  ];
  return (
    <div className="flex flex-wrap items-end gap-3">
      <SegmentedControl
        aria-label={t("dashboard.range.label", "Period")}
        value={filters.range}
        onChange={(range) =>
          onChange(
            range === "custom"
              ? {
                  range,
                  from: filters.from ?? today,
                  to: filters.to ?? today,
                }
              : { range, from: null, to: null },
          )
        }
        options={ranges}
      />
      {filters.range === "custom" && (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label={t("dashboard.range.from", "From")}
            value={filters.from ?? ""}
            max={filters.to ?? today}
            onChange={(e) =>
              e.target.value && onChange({ from: e.target.value })
            }
            className="w-36"
          />
          <Input
            type="date"
            aria-label={t("dashboard.range.to", "To")}
            value={filters.to ?? ""}
            min={filters.from ?? undefined}
            max={today}
            onChange={(e) => e.target.value && onChange({ to: e.target.value })}
            className="w-36"
          />
        </div>
      )}
      <Select
        aria-label={t("dashboard.filter.agent", "Agent")}
        value={filters.agentId ?? ""}
        onChange={(e) => onChange({ agentId: e.target.value || null })}
        wrapperClassName="max-w-44"
      >
        <option value="">
          {t("dashboard.filter.allAgents", "All agents")}
        </option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Select>
      <Select
        aria-label={t("dashboard.filter.inbox", "Inbox")}
        value={filters.inboxId ?? ""}
        onChange={(e) => onChange({ inboxId: e.target.value || null })}
        // Wider than the agent select: a repeated name carries its account, which is the part
        // that tells the two apart and must not be the part cut off.
        wrapperClassName="max-w-64"
      >
        <option value="">
          {t("dashboard.filter.allInboxes", "All inboxes")}
        </option>
        {inboxes.map((i) => (
          <option key={i.id} value={i.id}>
            {inboxOptionLabel(i, t)}
          </option>
        ))}
      </Select>
      <SegmentedControl
        aria-label={t("dashboard.source.label", "Usage segment")}
        value={filters.source}
        onChange={(source) => onChange({ source })}
        options={sources}
      />
      {filters.source === "client" && (
        <SegmentedControl
          aria-label={t("dashboard.audience.label", "Audience")}
          value={filters.audience}
          onChange={(audience) => onChange({ audience })}
          options={audiences}
        />
      )}
    </div>
  );
}

const SKELETON_KEYS = ["k0", "k1", "k2", "k3", "k4"];

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="@container">
        <div className={KPI_GRID}>
          {SKELETON_KEYS.map((k, i) => (
            <Skeleton key={k} className={cn("h-24 w-full", KPI_SPANS[i])} />
          ))}
        </div>
      </div>
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

function DashboardBlocks({
  filters,
  win,
  prev,
  onFilter,
  view,
  onView,
}: {
  filters: DashboardFilters;
  win: Window;
  prev: Window | null;
  onFilter: (patch: Partial<DashboardFilters>) => void;
  view: PerformanceView;
  onView: (patch: Partial<PerformanceView>) => void;
}) {
  const { t } = useTranslation();
  const kpis = useStreamBlock<Kpis>((f) => f.kpis, ["conv"]);
  const prevKpis = useStreamBlock<Kpis>((f) => f.kpis, ["conv"], "previous");
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div id="performance" className="scroll-mt-4 lg:scroll-mt-32">
        <DataBoundary
          loading={kpis.loading && !kpis.data}
          error={kpis.error}
          errorStatus={kpis.status ?? undefined}
          onRetry={kpis.reload}
          loadingLabel={t("dashboard.loading", "Loading metrics…")}
          errorLabel={metricsErrorMessage(t, kpis.status, kpis.field)}
          skeleton={<DashboardSkeleton />}
        >
          {kpis.data && (
            <PerformanceSection
              filters={filters}
              win={win}
              prev={prev}
              kpis={kpis.data}
              kpisCoverage={kpis.coverage}
              prevKpis={prevKpis.data}
              onFilter={onFilter}
              view={view}
              onView={onView}
            />
          )}
        </DataBoundary>
      </div>

      <ReasonsSection win={win} />
      <CostSection filters={filters} win={win} prev={prev} />
      <HealthSection filters={filters} win={win} />
      <AutomationSection />
      <BreakdownSection onFilter={onFilter} />
    </div>
  );
}

// The instant a view was opened, which its window and the previous period's are computed at, and
// what opens it again. Held while the view stays the same: a fresh instant on every render would
// restart the previous period's stream, which ends at that time of day. A new view, a new local day
// (a page left open past midnight) or a retry opens it again, so both periods end at the same time.
export function useOpenedAt(viewKey: string): [Date, () => void] {
  const today = localDayKey(new Date());
  const [retries, setRetries] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view, a new day or a retry is a new opening.
  const at = useMemo(() => new Date(), [viewKey, today, retries]);
  const reopen = useCallback(() => setRetries((n) => n + 1), []);
  return [at, reopen];
}

export function DashboardPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const clientChannelEnabled = useClientChannelEnabled();
  // A saved `source=client` link on an install with the channel off reads as the default segment, so
  // the control shown and the figures asked for stay the same thing.
  const filters = useMemo(() => {
    const f = readFilters(params);
    return f.source === "client" && !clientChannelEnabled
      ? { ...f, source: "inbox" as const }
      : f;
  }, [params, clientChannelEnabled]);
  const [agents, setAgents] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const [inboxes, setInboxes] = useState<InboxOption[] | null>(null);
  const [perfView, setPerfView] = useState<PerformanceView>(
    DEFAULT_PERFORMANCE_VIEW,
  );

  const setFilters = useCallback(
    (patch: Partial<DashboardFilters>) => {
      setParams(writeFilters({ ...filters, ...patch }));
    },
    [filters, setParams],
  );

  // An unreadable list leaves both null: the selects show only "All", and a link's ids are kept
  // rather than dropped against a list that never arrived.
  useEffect(() => {
    void api.api.v1.metrics["filter-options"]
      .get()
      .then((r) => {
        if (!r.data) return;
        setAgents(r.data.agents);
        setInboxes(r.data.inboxes);
      })
      .catch(() => {});
  }, []);

  // A link naming an agent or inbox this account does not have opens on every agent or inbox,
  // with the parameter dropped, rather than on an empty page that looks like that id's numbers.
  useEffect(() => {
    const patch: Partial<DashboardFilters> = {};
    if (
      agents &&
      filters.agentId &&
      !agents.some((a) => a.id === filters.agentId)
    )
      patch.agentId = null;
    if (
      inboxes &&
      filters.inboxId &&
      !inboxes.some((i) => i.id === filters.inboxId)
    )
      patch.inboxId = null;
    if (Object.keys(patch).length > 0)
      setParams(writeFilters({ ...filters, ...patch }), { replace: true });
  }, [agents, inboxes, filters, setParams]);

  const [openedAt, reopen] = useOpenedAt(writeFilters(filters).toString());
  const win = windowOf(filters, openedAt);
  const prev = previousWindow(win, openedAt);
  const query = apiQuery(filters, readUpTo(win, openedAt));
  const prevQuery = prev ? apiQuery(filters, prev) : null;

  const sections = [
    {
      id: "performance",
      icon: Target,
      label: t("dashboard.nav.performance", "Performance"),
    },
    {
      id: "reasons",
      icon: ArrowRightLeft,
      label: t("dashboard.nav.reasons", "Handoffs and topics"),
    },
    { id: "cost", icon: Coins, label: t("dashboard.nav.cost", "Cost") },
    {
      id: "health",
      icon: Activity,
      label: t("dashboard.nav.health", "Health"),
    },
    {
      id: "automation",
      icon: Bot,
      label: t("dashboard.nav.automation", "Follow-ups and knowledge"),
    },
    {
      id: "breakdown",
      icon: Table2,
      label: t("dashboard.nav.breakdown", "Where the usage goes"),
    },
  ];

  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex items-center gap-3">
        <Gauge className="h-6 w-6 text-accent" aria-hidden="true" />
        <div>
          <h1 className="font-semibold text-text-primary text-xl">
            {t("dashboard.title", "Dashboard")}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t(
              "dashboard.subtitle2",
              "How the agents are doing, what they cost and where it goes.",
            )}
          </p>
        </div>
      </header>

      {/* The filter and the section index stay on screen while the page scrolls, as a band across
          the top rather than a column beside it: at a laptop's width a column took a quarter of
          the room the blocks need. -mx-6/px-6 cover the scroll container's padding, so the blocks
          pass under the band and not beside it. */}
      <div className="z-[var(--z-page-sticky)] -mx-6 -mt-3 flex flex-col gap-3 border-border border-b bg-bg-secondary px-6 py-3 lg:sticky lg:-top-6">
        <FilterBar
          filters={filters}
          onChange={setFilters}
          agents={agents ?? []}
          inboxes={inboxes ?? []}
        />
        <SectionNav sections={sections} layout="bar" />
      </div>

      <DashboardStreamProvider
        query={query}
        prevQuery={prevQuery}
        openedAt={openedAt}
        onReload={reopen}
      >
        <StreamProgress />
        <DashboardBlocks
          filters={filters}
          win={win}
          prev={prev}
          onFilter={setFilters}
          view={perfView}
          onView={(patch) => setPerfView((v) => ({ ...v, ...patch }))}
        />
      </DashboardStreamProvider>
    </PageContainer>
  );
}
