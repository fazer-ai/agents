import { Activity, BookOpen, Bot, Clock, Repeat } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Skeleton } from "@/client/components";
import { api } from "@/client/lib/api";
import { Block, type BlockTable, SectionHeading } from "./Block";
import { apiQuery, type DashboardFilters, type Window } from "./filters";
import { useBlock } from "./useBlock";

// IS IT HEALTHY, AND WHAT ELSE DOES IT DO. Latency by model from the ledger, the flow log's warnings
// and errors by stage and tool (each row opens the Logs page on exactly those lines), then the
// follow-ups the agent sent and the knowledge it proposed.

// The Logs page on one row of the problems table: the same window, agent, inbox and source.
export function logsHref(
  f: DashboardFilters,
  w: Window,
  row: { stage: string; tool: string | null; level: string },
): string {
  const p = new URLSearchParams();
  p.set("stage", row.stage);
  p.set("level", row.level);
  if (row.tool) p.set("tool", row.tool);
  // A tool line that names no tool is its own group; without this the link would open every tool's.
  else if (row.stage === "tool") p.set("noTool", "true");
  p.set("source", f.source);
  if (w.since) p.set("since", w.since.toISOString());
  // The Logs page reads `until` inclusive; the window is half-open.
  p.set("until", new Date(w.until.getTime() - 1).toISOString());
  if (f.agentId) p.set("agentId", f.agentId);
  if (f.inboxId) p.set("inboxId", f.inboxId);
  return `/logs?${p.toString()}`;
}

export function HealthSection({
  filters,
  win,
}: {
  filters: DashboardFilters;
  win: Window;
}) {
  const { t, i18n } = useTranslation();
  const nf = new Intl.NumberFormat(i18n.language);
  // The unit is in the column header, as in the CSV.
  const ms = (v: number | null) =>
    v === null ? "\u2014" : nf.format(Math.round(v));
  const query = apiQuery(filters, win);
  const health = useBlock(JSON.stringify(["health", query]), async () => {
    const res = await api.api.v1.metrics.health.get({ query });
    return { data: res.data?.health ?? null };
  });
  const h = health.data;
  const latencyTable: BlockTable = {
    name: "dashboard-latency",
    header: [
      t("dashboard.col.model", "Model"),
      t("dashboard.col.calls", "Requests"),
      t("dashboard.col.percentileMs", "{{p}} (ms)", { p: "p50" }),
      t("dashboard.col.percentileMs", "{{p}} (ms)", { p: "p90" }),
    ],
    rows: (h?.latency ?? []).map((r) => [r.model, r.calls, r.p50Ms, r.p90Ms]),
  };
  const problemsTable: BlockTable = {
    name: "dashboard-problems",
    header: [
      t("dashboard.col.stage", "Stage"),
      t("dashboard.col.tool", "Tool"),
      t("dashboard.col.level", "Level"),
      t("dashboard.col.lines", "Log lines"),
      t("dashboard.col.conversations", "Conversations"),
    ],
    rows: (h?.problems ?? []).map((r) => [
      r.stage,
      r.tool,
      r.level,
      r.lines,
      r.conversations,
    ]),
  };
  const levelLabel = (l: string) =>
    l === "error"
      ? t("dashboard.health.error", "Error")
      : t("dashboard.health.warn", "Warning");

  return (
    <section
      id="health"
      className="flex scroll-mt-4 flex-col gap-3 lg:scroll-mt-32"
    >
      <SectionHeading icon={Activity}>
        {t("dashboard.health.title", "Health")}
      </SectionHeading>
      <div className="grid gap-4 lg:grid-cols-2">
        <Block
          error={health.error}
          loading={health.loading && !health.data}
          onRetry={health.reload}
          icon={Clock}
          title={t("dashboard.health.latency", "Model call latency")}
          help={t(
            "dashboard.health.latencyHelp",
            "How long each model call took, as this app timed it: half of the calls took less than p50, nine in ten less than p90. Calls made before the timing was recorded are not counted.",
          )}
          table={latencyTable}
        >
          {health.loading && !h ? (
            <Skeleton className="h-24 w-full" />
          ) : !h || h.latency.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t("dashboard.noData", "No data yet.")}
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted text-xs">
                  {latencyTable.header.map((c, i) => (
                    <th
                      key={c}
                      scope="col"
                      className={
                        i === 0
                          ? "py-1.5 pr-3 font-normal"
                          : "py-1.5 pl-3 text-right font-normal"
                      }
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {h.latency.map((r) => (
                  <tr key={r.model} className="border-border border-t">
                    <td className="truncate py-1.5 pr-3 text-text-secondary">
                      {r.model}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {nf.format(r.calls)}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {ms(r.p50Ms)}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {ms(r.p90Ms)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Block>

        <Block
          error={health.error}
          loading={health.loading && !health.data}
          onRetry={health.reload}
          icon={Activity}
          title={t("dashboard.health.problems", "Warnings and errors")}
          help={t(
            "dashboard.health.problemsHelp",
            "Lines of the execution log at warning or error level, by stage and, for a tool, by tool. Open a row to see those lines on the Logs page with the same filters.",
          )}
          table={problemsTable}
        >
          {health.loading && !h ? (
            <Skeleton className="h-24 w-full" />
          ) : !h || h.problems.length === 0 ? (
            <p className="text-sm text-text-muted">
              {t(
                "dashboard.health.noProblems",
                "No warnings or errors in this period.",
              )}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {h.problems.map((r) => (
                <li
                  key={`${r.stage}|${r.tool ?? ""}|${r.level}`}
                  className="flex items-center justify-between gap-4 text-sm"
                >
                  <Link
                    to={logsHref(filters, win, r)}
                    className="truncate text-text-secondary hover:text-accent hover:underline"
                  >
                    {r.tool ? `${r.stage} · ${r.tool}` : r.stage}
                    <span
                      className={
                        r.level === "error"
                          ? "ml-2 text-error text-xs"
                          : "ml-2 text-warning text-xs"
                      }
                    >
                      {levelLabel(r.level)}
                    </span>
                  </Link>
                  <span className="shrink-0 font-medium text-text-primary tabular-nums">
                    {nf.format(r.lines)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Block>
      </div>
    </section>
  );
}

export function AutomationSection({
  filters,
  win,
}: {
  filters: DashboardFilters;
  win: Window;
}) {
  const { t, i18n } = useTranslation();
  const nf = new Intl.NumberFormat(i18n.language);
  const query = apiQuery(filters, win);
  const followUps = useBlock(JSON.stringify(["followups", query]), async () => {
    const res = await api.api.v1.metrics["follow-ups"].get({ query });
    return { data: res.data?.followUps ?? null };
  });
  const knowledge = useBlock(JSON.stringify(["knowledge", query]), async () => {
    const res = await api.api.v1.metrics.knowledge.get({ query });
    return { data: res.data?.knowledge ?? null };
  });
  const f = followUps.data;
  const k = knowledge.data;
  const fuRows: [string, number | undefined][] = [
    [t("dashboard.followups.steps", "Steps delivered"), f?.stepsSent],
    [
      t("dashboard.followups.conversations", "Conversations reached"),
      f?.conversations,
    ],
    [t("dashboard.followups.cameBack", "Customer wrote back"), f?.cameBack],
    [
      t("dashboard.followups.closed", "Closed by the last step"),
      f?.closedByLastStep,
    ],
  ];
  const kRows: [string, number | undefined][] = [
    [t("dashboard.knowledge.proposed", "Proposed"), k?.proposed],
    [t("dashboard.knowledge.waiting", "Waiting for review"), k?.waiting],
    [
      t("dashboard.knowledge.discarded", "Discarded by the reviewer"),
      k?.discarded,
    ],
    [t("dashboard.knowledge.approved", "Approved"), k?.approved],
    [t("dashboard.knowledge.rejected", "Rejected"), k?.rejected],
  ];
  const figures = (rows: [string, number | undefined][]) => (
    <dl className="grid grid-cols-2 gap-3">
      {rows.map(([label, v]) => (
        <div key={label} className="flex flex-col">
          <dt className="text-text-muted text-xs">{label}</dt>
          <dd className="font-semibold text-lg text-text-primary tabular-nums">
            {v === undefined ? "\u2014" : nf.format(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <section
      id="automation"
      className="flex scroll-mt-4 flex-col gap-3 lg:scroll-mt-32"
    >
      <SectionHeading icon={Bot}>
        {t("dashboard.automation.title", "What the agent does on its own")}
      </SectionHeading>
      <div className="grid gap-4 lg:grid-cols-2">
        <Block
          error={followUps.error}
          loading={followUps.loading && !followUps.data}
          onRetry={followUps.reload}
          icon={Repeat}
          title={t("dashboard.followups.title", "Follow-ups")}
          help={t(
            "dashboard.followups.help",
            "Follow-up steps that reached the customer in the period (a message or a template; a step that stayed silent is not counted), the conversations they reached, how many customers wrote again after one, and how many the last step closed.",
          )}
          table={{
            name: "dashboard-follow-ups",
            header: [
              t("dashboard.col.figure", "Figure"),
              t("dashboard.col.value", "Value"),
            ],
            rows: fuRows.map(([l, v]) => [l, v ?? null]),
          }}
        >
          {followUps.loading && !f ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            figures(fuRows)
          )}
        </Block>
        <Block
          error={knowledge.error}
          loading={knowledge.loading && !knowledge.data}
          onRetry={knowledge.reload}
          icon={BookOpen}
          title={t("dashboard.knowledge.title", "Knowledge suggestions")}
          help={t(
            "dashboard.knowledge.help",
            "Entries the agents proposed for their knowledge bases in the period, and where each stands now: waiting for a person, set aside by the reviewer model, approved or rejected.",
          )}
          table={{
            name: "dashboard-knowledge",
            header: [
              t("dashboard.col.figure", "Figure"),
              t("dashboard.col.value", "Value"),
            ],
            rows: kRows.map(([l, v]) => [l, v ?? null]),
          }}
        >
          {knowledge.loading && !k ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            figures(kRows)
          )}
        </Block>
      </div>
    </section>
  );
}
