import { ArrowDown, ArrowUp, Table2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl, Skeleton } from "@/client/components";
import { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";
import { Block, type BlockTable } from "./Block";
import { useNodeLabel } from "./CostSection";
import { apiQuery, type DashboardFilters, type Window } from "./filters";
import { useBlock } from "./useBlock";

type Dimension = "agent" | "inbox" | "model" | "node";
type BreakdownData = Awaited<
  ReturnType<typeof api.api.v1.metrics.breakdown.get>
>["data"];
type Row = NonNullable<BreakdownData>["rows"][number];
type SortKey =
  | "label"
  | "conversations"
  | "requests"
  | "costUsd"
  | "costPerConversation"
  | "resolutionRate";

// ONE TABLE FOR "WHERE DOES IT GO": the period's model calls grouped by agent, inbox, model or call
// type, with the conversations they touched, the requests, the cost, the cost per conversation and
// how many of those conversations the agent resolved. Sorting is by any column; clicking an agent or
// inbox row makes it the page's filter.
export function BreakdownSection({
  filters,
  win,
  onFilter,
}: {
  filters: DashboardFilters;
  win: Window;
  onFilter: (patch: Partial<DashboardFilters>) => void;
}) {
  const { t, i18n } = useTranslation();
  const nodeLabel = useNodeLabel();
  const [dimension, setDimension] = useState<Dimension>("agent");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "costUsd",
    desc: true,
  });
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
  const query = apiQuery(filters, win);
  const block = useBlock(
    JSON.stringify(["breakdown", query, dimension]),
    async () => {
      const res = await api.api.v1.metrics.breakdown.get({
        query: { ...query, dimension },
      });
      return { data: res.data?.rows ?? null, status: res.error?.status };
    },
  );

  const nameOf = (r: Row): string => {
    if (r.key === null)
      return dimension === "inbox"
        ? t("dashboard.breakdown.noInbox", "No inbox (playground)")
        : t("dashboard.noAgent", "Unattributed");
    if (dimension === "node") return nodeLabel(r.key);
    if (dimension === "agent")
      return r.label ?? t("dashboard.agent", "Agent #{{id}}", { id: r.key });
    if (dimension === "inbox")
      return r.label ?? t("dashboard.inbox", "Inbox #{{id}}", { id: r.key });
    return r.key;
  };
  const rows = [...(block.data ?? [])].sort((a, b) => {
    const dir = sort.desc ? -1 : 1;
    if (sort.key === "label") return nameOf(a).localeCompare(nameOf(b)) * dir;
    const av = a[sort.key];
    const bv = b[sort.key];
    // Rows with no value sort last either way.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return (av - bv) * dir;
  });
  const columns: { key: SortKey; label: string; numeric: boolean }[] = [
    { key: "label", label: dimensionLabel(), numeric: false },
    {
      key: "conversations",
      label: t("dashboard.col.conversations", "Conversations"),
      numeric: true,
    },
    {
      key: "requests",
      label: t("dashboard.col.calls", "Requests"),
      numeric: true,
    },
    { key: "costUsd", label: t("dashboard.col.cost", "Cost"), numeric: true },
    {
      key: "costPerConversation",
      label: t("dashboard.col.costPerConversation", "Cost / conversation"),
      numeric: true,
    },
    {
      key: "resolutionRate",
      label: t("dashboard.col.resolution", "Resolution"),
      numeric: true,
    },
  ];
  function dimensionLabel() {
    return dimension === "agent"
      ? t("dashboard.col.agent", "Agent")
      : dimension === "inbox"
        ? t("dashboard.col.inbox", "Inbox")
        : dimension === "model"
          ? t("dashboard.col.model", "Model")
          : t("dashboard.col.node", "Call type");
  }
  const table: BlockTable = {
    name: `dashboard-breakdown-${dimension}`,
    header: columns.map((c) => c.label),
    rows: rows.map((r) => [
      nameOf(r),
      r.conversations,
      r.requests,
      r.costUsd,
      r.costPerConversation,
      r.resolutionRate,
    ]),
  };
  const clickable = dimension === "agent" || dimension === "inbox";

  return (
    <section id="breakdown" className="flex scroll-mt-4 flex-col gap-3">
      <Block
        error={block.error}
        onRetry={block.reload}
        icon={Table2}
        title={t("dashboard.breakdown.title", "Where the usage goes")}
        help={t(
          "dashboard.breakdown.help",
          "The period's model calls grouped by the dimension you pick. Conversations are the ones those calls belonged to, and the resolution rate is the share of them the agent closed itself. Click an agent or an inbox to filter the whole page by it.",
        )}
        table={table}
        actions={
          <SegmentedControl
            aria-label={t("dashboard.breakdown.dimension", "Group by")}
            value={dimension}
            onChange={setDimension}
            options={[
              { value: "agent", label: t("dashboard.col.agent", "Agent") },
              { value: "inbox", label: t("dashboard.col.inbox", "Inbox") },
              { value: "model", label: t("dashboard.col.model", "Model") },
              { value: "node", label: t("dashboard.col.node", "Call type") },
            ]}
          />
        }
      >
        {block.loading && !block.data ? (
          <Skeleton className="h-32 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-text-muted">
            {t("dashboard.noData", "No data yet.")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-muted text-xs">
                  {columns.map((c) => {
                    const active = sort.key === c.key;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        aria-sort={
                          active
                            ? sort.desc
                              ? "descending"
                              : "ascending"
                            : "none"
                        }
                        className={cn(
                          "py-1.5 font-normal",
                          c.numeric ? "pl-3 text-right" : "pr-3 text-left",
                        )}
                      >
                        <button
                          type="button"
                          onClick={() =>
                            setSort((s) =>
                              s.key === c.key
                                ? { key: c.key, desc: !s.desc }
                                : { key: c.key, desc: c.numeric },
                            )
                          }
                          className={cn(
                            "inline-flex items-center gap-1 hover:text-text-primary",
                            active && "text-text-primary",
                          )}
                        >
                          {c.label}
                          {active &&
                            (sort.desc ? (
                              <ArrowDown
                                className="h-3 w-3"
                                aria-hidden="true"
                              />
                            ) : (
                              <ArrowUp className="h-3 w-3" aria-hidden="true" />
                            ))}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key ?? "none"} className="border-border border-t">
                    <td className="max-w-64 truncate py-1.5 pr-3 text-text-secondary">
                      {clickable && r.key !== null ? (
                        <button
                          type="button"
                          className="truncate text-left hover:text-accent hover:underline"
                          onClick={() =>
                            onFilter(
                              dimension === "agent"
                                ? { agentId: r.key }
                                : { inboxId: r.key },
                            )
                          }
                        >
                          {nameOf(r)}
                        </button>
                      ) : (
                        nameOf(r)
                      )}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {nf.format(r.conversations)}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {nf.format(r.requests)}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {cf.format(r.costUsd)}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {r.costPerConversation === null
                        ? "\u2014"
                        : cf.format(r.costPerConversation)}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {r.resolutionRate === null
                        ? "\u2014"
                        : pf(r.resolutionRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Block>
    </section>
  );
}
