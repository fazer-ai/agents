import { ArrowDown, Search, SearchX } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  EmptyState,
  Input,
  SegmentedControl,
} from "@/client/components";
import { cn } from "@/client/lib/utils";
import type { Formatters } from "./format";
import { MeanSpark, Meter, SectionIntro, SqlText, type Tone } from "./parts";
import type { Screen, StatementRow } from "./types";

// "What is slow?": the statements that cost the most in the window, by total or by mean time, each
// mean drawn against the budget it ran under.

export type Sort = "total" | "mean";

const th =
  "text-text-muted px-3 py-2 text-left align-bottom text-xs font-medium";
const td = "px-3 py-2.5 align-top tabular-nums whitespace-nowrap text-sm";
// The columns that give way when the table's own box is narrow (a laptop with both sidebars open),
// so the ones that answer "what is slow" fit without a horizontal scroll.
const NARROW_HIDDEN = "hidden @3xl:table-cell";
// Calls give way last, on a box narrower still (the console beside an open admin menu).
const NARROWER_HIDDEN = "hidden @lg:table-cell";

function budgetTone(pct: number | null, warnAt: number | null): Tone {
  if (pct === null) return "neutral";
  if (pct >= 100) return "error";
  if (warnAt !== null && pct >= warnAt) return "warning";
  return "accent";
}

function Unavailable({ screen }: { screen: Screen }) {
  const { t } = useTranslation();
  const st = screen.statements;
  if (st.available) return null;
  if (st.reason === "unreadable") {
    // Installed and loaded, but the read failed (a permission, a timeout): not a setup to change.
    return (
      <div
        data-testid="statements-unreadable"
        className="border-error bg-error-soft space-y-1 rounded-lg border px-4 py-3 text-sm"
      >
        <p className="text-text-primary font-medium">
          {t(
            "database.statementsUnreadable",
            "pg_stat_statements is installed, but reading it failed.",
          )}
        </p>
        <p className="text-text-secondary">
          {t(
            "database.statementsUnreadableHelp",
            'The reason is in the server log under "pg_stat_statements unreadable". The sections below still answer.',
          )}
        </p>
      </div>
    );
  }
  return (
    <div className="border-warning bg-warning-soft space-y-3 rounded-lg border px-4 py-3 text-sm">
      <p className="text-text-primary font-medium">
        {st.reason === "not_loaded"
          ? t(
              "database.statementsNotLoaded",
              "pg_stat_statements is installed but the server does not load it.",
            )
          : t(
              "database.statementsMissing",
              "Query statistics need the pg_stat_statements extension, which this database does not have.",
            )}
      </p>
      <ol className="text-text-secondary list-decimal space-y-3 pl-5">
        <li className="space-y-1.5">
          <p>
            {t(
              "database.enableStep",
              "Add these settings to the Postgres configuration (or to the server's command line) and restart Postgres:",
            )}
          </p>
          <pre
            data-testid="enable-statements"
            className="border-border bg-bg-primary text-text-primary overflow-x-auto rounded-md border p-3 font-mono text-xs"
          >
            {st.enable.join("\n")}
          </pre>
        </li>
        {st.create ? (
          <li className="space-y-1.5">
            <p>
              {t(
                "database.createStep",
                "Create the extension in this database, as a superuser (or the database owner on a managed server), or run the bootstrap again:",
              )}
            </p>
            <pre
              data-testid="create-extension"
              className="border-border bg-bg-primary text-text-primary overflow-x-auto rounded-md border p-3 font-mono text-xs"
            >
              {st.create}
            </pre>
          </li>
        ) : null}
      </ol>
      <p className="text-text-secondary">
        {t(
          "database.enableAfter",
          "The next snapshot starts the history. Timeouts and tables work without it.",
        )}
      </p>
    </div>
  );
}

export function StatementsPanel({
  screen,
  fmt,
  sort,
  setSort,
}: {
  screen: Screen;
  fmt: Formatters;
  sort: Sort;
  setSort: (s: Sort) => void;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const st = screen.statements;
  const drift = screen.signals.find(
    (s) => s.signal === "statement_mean_budget_pct",
  );
  const warnAt = drift?.threshold ?? null;

  const intro = (
    <SectionIntro
      title={t("database.statementsTitle", "Query statistics")}
      aside={
        st.available ? (
          <span className="text-text-muted text-xs">
            {t(
              "database.budgetNote",
              "Bars: mean time against the budget the query ran under ({{metrics}} for console reads, {{tx}} for the rest)",
              {
                metrics: fmt.ms(st.metricsBudgetMs),
                tx: fmt.ms(st.budgetMs),
              },
            )}
          </span>
        ) : null
      }
    >
      {t(
        "database.statementsHelp",
        "The statements that cost the most in the window, from pg_stat_statements snapshots. Values are normalized ($N).",
      )}
    </SectionIntro>
  );

  if (!st.available) {
    return (
      <div className="space-y-4">
        {intro}
        <Unavailable screen={screen} />
      </div>
    );
  }

  const all = sort === "total" ? st.byTotal : st.byMean;
  const needle = filter.trim().toLowerCase();
  const rows = needle
    ? all.filter((r) => r.query.toLowerCase().includes(needle))
    : all;

  const sortHeader = (key: Sort, label: string) => (
    <th
      className={cn(th, { "text-text-primary": sort === key })}
      aria-sort={sort === key ? "descending" : undefined}
    >
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        {label}
        {sort === key && <ArrowDown className="h-3 w-3" aria-hidden="true" />}
      </span>
    </th>
  );

  return (
    <div className="space-y-4">
      {intro}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search
            className="text-text-muted pointer-events-none absolute top-1/2 left-2.5 z-10 h-3.5 w-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("database.filterStatements", "Filter by text")}
            aria-label={t("database.filterStatements", "Filter by text")}
            className="pl-8"
            data-testid="statements-filter"
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-text-muted text-xs" id="statements-sort">
            {t("database.sortLabel", "Largest first by")}
          </span>
          <SegmentedControl<Sort>
            aria-labelledby="statements-sort"
            value={sort}
            onChange={setSort}
            options={[
              { value: "total", label: t("database.sortTotal", "Total time") },
              { value: "mean", label: t("database.sortMean", "Mean time") },
            ]}
          />
        </div>
      </div>
      {all.length === 0 ? (
        <EmptyState
          title={t("database.noStatementsTitle", "Nothing measured yet")}
          description={t(
            "database.noStatements",
            "Nothing ran between snapshots in this window yet. Figures appear after the second snapshot.",
          )}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title={t("database.noMatchTitle", "No statement matches")}
          description={t(
            "database.noMatch",
            "None of the {{count}} statements of this window contains “{{text}}”.",
            { count: all.length, text: filter.trim() },
          )}
          action={
            <Button variant="secondary" size="sm" onClick={() => setFilter("")}>
              {t("database.clearFilter", "Clear the filter")}
            </Button>
          }
        />
      ) : (
        <div className="border-border @container overflow-x-auto rounded-lg border">
          <table className="w-full text-sm" data-testid="statements-table">
            <thead className="border-border border-b">
              <tr>
                <th className={th}>{t("database.query", "Query")}</th>
                <th className={cn(th, NARROWER_HIDDEN, "text-right")}>
                  {t("database.calls", "Calls")}
                </th>
                <th className={cn(th, NARROW_HIDDEN, "text-right")}>
                  {t("database.rows", "Rows")}
                </th>
                {sortHeader("total", t("database.totalTime", "Total time"))}
                {sortHeader("mean", t("database.meanTime", "Mean time"))}
                <th className={cn(th, NARROW_HIDDEN)}>
                  {t("database.meanTrend", "Mean over time")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <StatementLine
                  key={`${r.userid}:${r.queryid}`}
                  r={r}
                  fmt={fmt}
                  tone={budgetTone(r.meanBudgetPct, warnAt)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {needle && rows.length > 0 && (
        <p className="text-text-muted text-xs">
          {t("database.matchCount", "{{shown}} of {{count}} statements", {
            shown: rows.length,
            count: all.length,
          })}
        </p>
      )}
    </div>
  );
}

function StatementLine({
  r,
  fmt,
  tone,
}: {
  r: StatementRow;
  fmt: Formatters;
  tone: Tone;
}) {
  const { t } = useTranslation();
  return (
    <tr
      className="border-border border-b last:border-0"
      data-testid="statement-row"
    >
      <td className="w-full max-w-0 min-w-48 px-3 py-2.5 align-top">
        <SqlText sql={r.query} />
      </td>
      <td className={cn(td, NARROWER_HIDDEN, "text-right")}>
        {fmt.number(r.calls)}
      </td>
      <td className={cn(td, NARROW_HIDDEN, "text-right")}>
        {fmt.number(r.rows)}
      </td>
      <td className={td}>{fmt.ms(r.totalMs)}</td>
      <td className={cn(td, "w-40")}>
        <div className="flex items-baseline justify-between gap-2">
          <span>{fmt.ms(r.meanMs)}</span>
          {r.meanBudgetPct !== null && (
            <span
              data-testid="budget-pct"
              className={cn("text-xs", {
                "text-text-muted": tone === "accent" || tone === "neutral",
                "text-warning": tone === "warning",
                "text-error font-medium": tone === "error",
              })}
            >
              {t("database.budgetShare", "{{pct}} of {{budget}}", {
                pct: fmt.percent(r.meanBudgetPct),
                budget: fmt.ms(r.budgetMs),
              })}
            </span>
          )}
        </div>
        <Meter className="mt-1.5" pct={r.meanBudgetPct ?? 0} tone={tone} />
      </td>
      <td className={cn(td, NARROW_HIDDEN)}>
        <MeanSpark
          points={r.spark}
          label={t("database.meanOverWindow", "Mean over the window")}
        />
      </td>
    </tr>
  );
}
