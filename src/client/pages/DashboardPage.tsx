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
import { api } from "@/client/lib/api";
import { SectionNav } from "./agents/SectionNav";
import { BreakdownSection } from "./dashboard/BreakdownSection";
import { CostSection } from "./dashboard/CostSection";
import {
  apiQuery,
  type DashboardFilters,
  localDayKey,
  previousWindow,
  type Range,
  readFilters,
  type Source,
  windowOf,
  writeFilters,
} from "./dashboard/filters";
import { AutomationSection, HealthSection } from "./dashboard/HealthSection";
import { type Kpis, PerformanceSection } from "./dashboard/PerformanceSection";
import { ReasonsSection } from "./dashboard/ReasonsSection";
import { useBlock } from "./dashboard/useBlock";

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
  inboxes: { id: string; name: string }[];
}) {
  const { t } = useTranslation();
  const today = localDayKey(new Date());
  const ranges: { value: Range; label: string }[] = [
    { value: "7d", label: t("dashboard.range.7d", "7d") },
    { value: "30d", label: t("dashboard.range.30d", "30d") },
    { value: "90d", label: t("dashboard.range.90d", "90d") },
    { value: "all", label: t("dashboard.range.all", "All") },
    { value: "custom", label: t("dashboard.range.custom", "Dates") },
  ];
  const sources: { value: Source; label: string }[] = [
    { value: "inbox", label: t("dashboard.source.inbox", "Real") },
    {
      value: "playground",
      label: t("dashboard.source.playground", "Playground"),
    },
    { value: "all", label: t("dashboard.source.all", "All") },
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
        wrapperClassName="max-w-44"
      >
        <option value="">
          {t("dashboard.filter.allInboxes", "All inboxes")}
        </option>
        {inboxes.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </Select>
      <SegmentedControl
        aria-label={t("dashboard.source.label", "Usage segment")}
        value={filters.source}
        onChange={(source) => onChange({ source })}
        options={sources}
      />
    </div>
  );
}

const SKELETON_KEYS = ["k0", "k1", "k2", "k3", "k4"];

function DashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden="true">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {SKELETON_KEYS.map((k) => (
          <Skeleton key={k} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

export function DashboardPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const [agents, setAgents] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const [inboxes, setInboxes] = useState<{ id: string; name: string }[] | null>(
    null,
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

  // The window is recomputed per render from the filters; its day keys are stable within a day.
  const win = windowOf(filters);
  const prev = previousWindow(win);
  const query = apiQuery(filters, win);
  const kpis = useBlock<Kpis>(JSON.stringify(["kpis", query]), async () => {
    const res = await api.api.v1.metrics.kpis.get({ query });
    return { data: res.data?.kpis ?? null, status: res.error?.status };
  });
  const prevQuery = prev ? apiQuery(filters, prev) : null;
  const prevKpis = useBlock<Kpis>(
    JSON.stringify(["kpis-prev", prevQuery]),
    async () => {
      if (!prevQuery) return { data: null };
      const res = await api.api.v1.metrics.kpis.get({ query: prevQuery });
      return { data: res.data?.kpis ?? null };
    },
  );

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
      <header className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
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
        </div>
        <FilterBar
          filters={filters}
          onChange={setFilters}
          agents={agents ?? []}
          inboxes={inboxes ?? []}
        />
      </header>

      <div className="flex gap-6">
        <SectionNav sections={sections} />
        <div className="flex min-w-0 grow flex-col gap-8">
          <div id="performance" className="scroll-mt-4">
            <DataBoundary
              loading={kpis.loading && !kpis.data}
              error={kpis.error}
              errorStatus={kpis.status ?? undefined}
              onRetry={kpis.reload}
              loadingLabel={t("dashboard.loading", "Loading metrics…")}
              errorLabel={t("dashboard.error", "Could not load metrics.")}
              skeleton={<DashboardSkeleton />}
            >
              {kpis.data && (
                <PerformanceSection
                  filters={filters}
                  win={win}
                  prev={prev}
                  kpis={kpis.data}
                  prevKpis={prevKpis.data}
                  onFilter={setFilters}
                />
              )}
            </DataBoundary>
          </div>
          <ReasonsSection filters={filters} win={win} />
          <CostSection filters={filters} win={win} prev={prev} />
          <HealthSection filters={filters} win={win} />
          <AutomationSection filters={filters} win={win} />
          <BreakdownSection filters={filters} win={win} onFilter={setFilters} />
        </div>
      </div>
    </PageContainer>
  );
}
