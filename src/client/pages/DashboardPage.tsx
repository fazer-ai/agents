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
  Badge,
  Input,
  PageContainer,
  SegmentedControl,
  Select,
} from "@/client/components";
import { useClientChannelEnabled } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { type InboxOption, inboxOptionLabel } from "@/client/lib/inboxOption";
import { SectionNav } from "./agents/SectionNav";
import { BreakdownSection } from "./dashboard/BreakdownSection";
import { CostSection } from "./dashboard/CostSection";
import {
  type Audience,
  apiQuery,
  type DashboardFilters,
  FIRST_CUSTOM_DAY,
  localDayKey,
  previousWindow,
  type Range,
  rangeRunning,
  readFilters,
  readUpTo,
  type Source,
  validDay,
  type Window,
  windowOf,
  writeFilters,
} from "./dashboard/filters";
import { AutomationSection, HealthSection } from "./dashboard/HealthSection";
import {
  DEFAULT_PERFORMANCE_VIEW,
  type Kpis,
  PerformanceSection,
  type PerformanceView,
} from "./dashboard/PerformanceSection";
import { daysLabel } from "./dashboard/period";
import { ReasonsSection } from "./dashboard/ReasonsSection";
import {
  DashboardMetricsProvider,
  useMetricsBlock,
  withComparison,
} from "./dashboard/useMetrics";

// THE OPERATOR'S DASHBOARD, organised by the question an operator brings: is the agent
// doing its job, why does it hand over and what are people asking, what does it cost, is it healthy,
// and what else does it do on its own. One filter (period, agent, inbox, source) in the URL drives
// every block; every figure is summed from this app's own records, and which query each block runs is
// mapped in docs/dashboard.md.

// The period's two families, each named: a calendar period is a closed or running stretch of the
// calendar, a trailing window ends today and moves with it.
function usePeriodGroups(): {
  label: string;
  options: { value: Range; label: string }[];
}[] {
  const { t } = useTranslation();
  return [
    {
      label: t("dashboard.period.calendar", "Calendar"),
      options: [
        { value: "today", label: t("dashboard.period.today", "Today") },
        {
          value: "yesterday",
          label: t("dashboard.period.yesterday", "Yesterday"),
        },
        {
          value: "this-week",
          label: t("dashboard.period.thisWeek", "This week"),
        },
        {
          value: "last-week",
          label: t("dashboard.period.lastWeek", "Last week"),
        },
        {
          value: "this-month",
          label: t("dashboard.period.thisMonth", "This month"),
        },
        {
          value: "last-month",
          label: t("dashboard.period.lastMonth", "Last month"),
        },
        {
          value: "this-quarter",
          label: t("dashboard.period.thisQuarter", "This quarter"),
        },
        {
          value: "last-quarter",
          label: t("dashboard.period.lastQuarter", "Last quarter"),
        },
        {
          value: "this-year",
          label: t("dashboard.period.thisYear", "This year"),
        },
      ],
    },
    {
      label: t("dashboard.period.trailing", "Rolling window"),
      options: [
        { value: "7d", label: t("dashboard.period.7d", "Last 7 days") },
        { value: "30d", label: t("dashboard.period.30d", "Last 30 days") },
        { value: "90d", label: t("dashboard.period.90d", "Last 90 days") },
        {
          value: "12m",
          label: t("dashboard.period.12m", "Last 12 months"),
        },
        { value: "all", label: t("dashboard.period.all", "All time") },
      ],
    },
  ];
}

// Beside the selector: whether the period is still under way, and the stretch its figures are
// compared with, so "this week" on a Monday morning is not read as a finished week.
function PeriodNote({
  running,
  prev,
}: {
  running: boolean;
  prev: Window | null;
}) {
  const { t, i18n } = useTranslation();
  if (!running && !prev?.firstDay) return null;
  const to = t("dashboard.chart.rangeTo", "to");
  // The days the previous period is read over end where its query does: inside a day when it is cut
  // at the read's time of day, else on the day before its exclusive end.
  const untilDay = prev ? localDayKey(prev.until) : null;
  const partial =
    !!prev && prev.until.getTime() > new Date(`${untilDay}T00:00:00`).getTime();
  const lastShown = prev
    ? partial
      ? (untilDay as string)
      : localDayKey(new Date(prev.until.getTime() - 1))
    : null;
  // At the first instant of a running period its comparison is empty, and names no days.
  const range =
    prev?.firstDay && lastShown && prev.since && prev.until > prev.since
      ? daysLabel(i18n.language, prev.firstDay, lastShown, to)
      : null;
  return (
    <p
      className="text-text-muted flex flex-wrap items-center gap-2 text-xs"
      data-testid="period-note"
    >
      {running && (
        <Badge variant="info">
          {t("dashboard.period.running", "In progress")}
        </Badge>
      )}
      {range &&
        (partial
          ? t(
              "dashboard.period.comparedUpTo",
              "Compared with {{range}}, up to {{time}}",
              {
                range,
                time: new Intl.DateTimeFormat(i18n.language, {
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(prev.until),
              },
            )
          : t("dashboard.period.compared", "Compared with {{range}}", {
              range,
            }))}
    </p>
  );
}

function FilterBar({
  filters,
  onChange,
  agents,
  inboxes,
  prev,
}: {
  filters: DashboardFilters;
  onChange: (patch: Partial<DashboardFilters>) => void;
  agents: { id: string; name: string }[];
  inboxes: InboxOption[];
  prev: Window | null;
}) {
  const { t } = useTranslation();
  const clientChannelEnabled = useClientChannelEnabled();
  const today = localDayKey(new Date());
  const periodGroups = usePeriodGroups();
  // The two days as typed. A date input reports partial years while a year is retyped, so the link
  // takes the pair only once both days are valid and in order; until then the draft stays on screen.
  const [draft, setDraft] = useState({
    from: filters.from ?? "",
    to: filters.to ?? "",
  });
  useEffect(() => {
    setDraft({ from: filters.from ?? "", to: filters.to ?? "" });
  }, [filters.from, filters.to]);
  const setDay = (bound: "from" | "to", value: string) => {
    const next = { ...draft, [bound]: value };
    setDraft(next);
    if (validDay(next.from) && validDay(next.to) && next.from <= next.to)
      onChange({ from: next.from, to: next.to });
  };
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
    <div className="flex flex-wrap items-center gap-3">
      <Select
        aria-label={t("dashboard.range.label", "Period")}
        value={filters.range}
        onChange={(e) => {
          const range = e.target.value as Range;
          onChange(
            range === "custom"
              ? {
                  range,
                  from: filters.from ?? today,
                  to: filters.to ?? today,
                }
              : { range, from: null, to: null },
          );
        }}
        wrapperClassName="max-w-48"
      >
        {periodGroups.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
        <option value="custom">
          {t("dashboard.period.custom", "Custom dates")}
        </option>
      </Select>
      {filters.range === "custom" && (
        <div className="flex items-center gap-2">
          <Input
            type="date"
            aria-label={t("dashboard.range.from", "From")}
            value={draft.from}
            min={FIRST_CUSTOM_DAY}
            max={filters.to ?? today}
            onChange={(e) => setDay("from", e.target.value)}
            className="w-36"
          />
          <Input
            type="date"
            aria-label={t("dashboard.range.to", "To")}
            value={draft.to}
            min={filters.from ?? FIRST_CUSTOM_DAY}
            max={today}
            onChange={(e) => setDay("to", e.target.value)}
            className="w-36"
          />
        </div>
      )}
      <PeriodNote running={rangeRunning(filters.range)} prev={prev} />
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
  const prevKpis = useMetricsBlock("kpis", (b: { kpis: Kpis }) => b.kpis, {
    which: "previous",
  });
  const kpis = withComparison(
    useMetricsBlock("kpis", (b: { kpis: Kpis }) => b.kpis),
    prevKpis,
  );
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <div id="performance" className="scroll-mt-4 lg:scroll-mt-32">
        <PerformanceSection
          filters={filters}
          win={win}
          prev={prev}
          kpis={kpis}
          prevKpis={prevKpis.data}
          onFilter={onFilter}
          view={view}
          onView={onView}
        />
      </div>

      <ReasonsSection win={win} />
      <CostSection filters={filters} win={win} prev={prev} />
      <HealthSection filters={filters} win={win} />
      <AutomationSection />
      <BreakdownSection onFilter={onFilter} />
    </div>
  );
}

// The waits before the filter options are asked again after a failure. Exported so a test need not
// wait for them.
export const OPTIONS_RETRY_MS = [1000, 4000];

// The instant a view was opened, which its window and the previous period's are computed at. Held
// while the view stays the same: a fresh instant on every render would ask every block again, and the
// previous period ends at that time of day. A new view or a new local day (a page left open past
// midnight) opens it again, so both periods end at the same time.
export function useOpenedAt(viewKey: string): Date {
  const today = localDayKey(new Date());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new view or a new day is a new opening.
  return useMemo(() => new Date(), [viewKey, today]);
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
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [firstDay, setFirstDay] = useState<string | null>(null);
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
  // rather than dropped against a list that never arrived. The flow-log blocks wait for the
  // retention it carries, so a failed read is asked again twice, a second and then four seconds
  // later; past that those blocks say they could not load, and their retry asks once more.
  const [optionsTry, setOptionsTry] = useState(0);
  const [optionsFailed, setOptionsFailed] = useState(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const failed = () => {
      if (!live) return;
      if (optionsTry % 3 < 2)
        timer = setTimeout(
          () => setOptionsTry((n) => n + 1),
          OPTIONS_RETRY_MS[optionsTry % 3] ?? 0,
        );
      else setOptionsFailed(true);
    };
    void api.api.v1.metrics["filter-options"]
      .get()
      .then((r) => {
        if (!live) return;
        if (!r.data) return failed();
        setOptionsFailed(false);
        setAgents(r.data.agents);
        setInboxes(r.data.inboxes);
        setRetentionDays(r.data.flowLogRetentionDays);
        setFirstDay(
          r.data.firstRecordAt
            ? localDayKey(new Date(r.data.firstRecordAt))
            : null,
        );
      })
      .catch(failed);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [optionsTry]);
  const retryOptions = useCallback(() => {
    setOptionsFailed(false);
    setOptionsTry((n) => n + 3 - (n % 3));
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

  const openedAt = useOpenedAt(writeFilters(filters).toString());
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
        <Gauge className="text-accent h-6 w-6" aria-hidden="true" />
        <div>
          <h1 className="text-text-primary text-xl font-semibold">
            {t("dashboard.title", "Dashboard")}
          </h1>
          <p className="text-text-muted mt-0.5 text-sm">
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
      <div className="border-border bg-bg-secondary z-[var(--z-page-sticky)] -mx-6 -mt-3 flex flex-col gap-3 border-b px-6 py-3 lg:sticky lg:-top-6">
        <FilterBar
          filters={filters}
          onChange={setFilters}
          agents={agents ?? []}
          inboxes={inboxes ?? []}
          prev={prev}
        />
        <SectionNav sections={sections} layout="bar" />
      </div>

      <DashboardMetricsProvider
        query={query}
        prevQuery={prevQuery}
        win={win}
        openedAt={openedAt}
        retentionDays={retentionDays}
        firstDay={firstDay}
        retentionFailed={optionsFailed}
        retryRetention={retryOptions}
      >
        <DashboardBlocks
          filters={filters}
          win={win}
          prev={prev}
          onFilter={setFilters}
          view={perfView}
          onView={(patch) => setPerfView((v) => ({ ...v, ...patch }))}
        />
      </DashboardMetricsProvider>
    </PageContainer>
  );
}
