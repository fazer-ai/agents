import { Database } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router";
import {
  Card,
  DataBoundary,
  EmptyState,
  SegmentedControl,
  Skeleton,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { formatSignalValue } from "../instance-health/signals";

// The database's own figures (docs/logs.md, "Database"), SUPER_ADMIN only: the statements that cost
// the most in a window, the statements that hit their budget with the plan they ran under, and the
// tables and indexes. Read-only: nothing here sends SQL.

const WINDOW_KEYS = ["1h", "24h", "7d"] as const;
type WindowKey = (typeof WINDOW_KEYS)[number];
type Sort = "total" | "mean";

// Every shape below is the endpoint's own (docs/eden-treaty.md): a field the server adds or renames
// reaches this page at the next type check.
type DatabaseResponse = Awaited<
  ReturnType<(typeof api.api.v1)["instance-health"]["database"]["get"]>
>["data"];
type Screen = NonNullable<DatabaseResponse>["database"];

const REFRESH_MS = 60_000;

// Read inside another call's options, where the extractor does not look:
// t('database.unlabeled', 'unlabeled work')

export function formatBytes(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1024 ** 3) return `${sign}${(abs / 1024 ** 3).toFixed(1)} GB`;
  if (abs >= 1024 ** 2) return `${sign}${(abs / 1024 ** 2).toFixed(1)} MB`;
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(1)} kB`;
  return `${sign}${Math.round(abs)} B`;
}

function formatMs(ms: number): string {
  return ms < 1 && ms > 0 ? `${ms.toFixed(2)} ms` : formatSignalValue(ms, "ms");
}

// Mean time per bucket of the window, drawn as a line with gaps where the statement did not run.
function MeanSpark({ points }: { points: (number | null)[] }) {
  const values = points.filter((p): p is number => p !== null);
  const top = Math.max(...values, 0) || 1;
  const w = 96;
  const h = 24;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((p, i) => {
    if (p === null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
      return;
    }
    current.push(
      `${(i * step).toFixed(1)},${(h - (p / top) * (h - 2) - 1).toFixed(1)}`,
    );
  });
  if (current.length) segments.push(current.join(" "));
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label="mean time"
      data-testid="mean-spark"
      className="text-accent shrink-0"
    >
      {segments.map((pts) =>
        pts.includes(" ") ? (
          <polyline
            key={pts}
            points={pts}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
          />
        ) : (
          <circle
            key={pts}
            cx={pts.split(",")[0]}
            cy={pts.split(",")[1]}
            r={1.5}
            fill="currentColor"
          />
        ),
      )}
    </svg>
  );
}

const th = "text-text-secondary px-2 py-2 font-medium whitespace-nowrap";
const td = "px-2 py-2 align-top tabular-nums whitespace-nowrap";

function StatementsSection({
  screen,
  sort,
  setSort,
}: {
  screen: Screen;
  sort: Sort;
  setSort: (s: Sort) => void;
}) {
  const { t } = useTranslation();
  const st = screen.statements;
  if (!st.available && st.reason === "unreadable") {
    // Installed and loaded, but the read failed (a permission, a timeout): not a setup to change.
    return (
      <div
        data-testid="statements-unreadable"
        className="border-error bg-error-soft space-y-2 rounded-lg border px-4 py-3 text-sm"
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
  if (!st.available) {
    return (
      <div className="border-warning bg-warning-soft space-y-2 rounded-lg border px-4 py-3 text-sm">
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
        <p className="text-text-secondary">
          {t(
            "database.enableHelp",
            "Add these settings to the Postgres configuration (or to the server's command line), restart Postgres, and the next snapshot starts the history. The sections below work without it.",
          )}
        </p>
        <pre
          data-testid="enable-statements"
          className="bg-bg-tertiary text-text-primary overflow-x-auto rounded p-3 font-mono text-xs"
        >
          {st.enable.join("\n")}
        </pre>
        {st.create ? (
          <>
            <p className="text-text-secondary">
              {t(
                "database.createHelp",
                "Then create the extension in this database, connected as a superuser (or the database owner on a managed server), or run the bootstrap again:",
              )}
            </p>
            <pre
              data-testid="create-extension"
              className="bg-bg-tertiary text-text-primary overflow-x-auto rounded p-3 font-mono text-xs"
            >
              {st.create}
            </pre>
          </>
        ) : null}
      </div>
    );
  }
  const rows = sort === "total" ? st.byTotal : st.byMean;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl<Sort>
          aria-label={t("database.sortBy", "Sort by")}
          value={sort}
          onChange={setSort}
          options={[
            { value: "total", label: t("database.sortTotal", "Total time") },
            { value: "mean", label: t("database.sortMean", "Mean time") },
          ]}
        />
        <p className="text-text-secondary text-xs">
          {t(
            "database.snapshots",
            "{{count}} snapshots in the window, one every 5 minutes",
            { count: st.snapshots },
          )}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="text-text-secondary text-sm">
          {t(
            "database.noStatements",
            "Nothing ran between snapshots in this window yet. Figures appear after the second snapshot.",
          )}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="statements-table">
            <thead>
              <tr className="border-border border-b text-left">
                <th className={th}>{t("database.query", "Query")}</th>
                <th className={th}>{t("database.calls", "Calls")}</th>
                <th className={th}>{t("database.rows", "Rows")}</th>
                <th className={th}>{t("database.totalTime", "Total time")}</th>
                <th className={th}>{t("database.meanTime", "Mean time")}</th>
                <th className={th}>
                  {t("database.meanOverWindow", "Mean over the window")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={`${r.userid}:${r.queryid}`}
                  className="border-border border-b last:border-0"
                  data-testid="statement-row"
                >
                  <td className="max-w-xl px-2 py-2 align-top">
                    <code className="text-text-primary line-clamp-3 font-mono text-xs break-all">
                      {r.query}
                    </code>
                  </td>
                  <td className={td}>{r.calls.toLocaleString()}</td>
                  <td className={td}>{r.rows.toLocaleString()}</td>
                  <td className={td}>{formatMs(r.totalMs)}</td>
                  <td className={td}>{formatMs(r.meanMs)}</td>
                  <td className={td}>
                    <MeanSpark points={r.spark} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TimeoutsSection({ screen }: { screen: Screen }) {
  const { t } = useTranslation();
  if (screen.timeouts.length === 0) {
    return (
      <p className="text-text-secondary text-sm" data-testid="no-timeouts">
        {t(
          "database.noTimeouts",
          "No statement hit its time budget in this window.",
        )}
      </p>
    );
  }
  return (
    <ul className="space-y-3" data-testid="timeouts-list">
      {screen.timeouts.map((x) => (
        <li
          key={x.fingerprint}
          className="border-border space-y-2 rounded-lg border p-3"
          data-testid="timeout-item"
        >
          <div className="text-text-secondary flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>
              {t("database.occurrences", "{{count}} times", {
                count: x.occurrences,
              })}
            </span>
            <span>
              {t("database.lastAt", "last {{time}}", {
                time: new Date(x.lastAt).toLocaleString(),
              })}
            </span>
            <span>
              {t("database.ranBy", "ran by {{label}}", {
                label: x.label ?? t("database.unlabeled", "unlabeled work"),
              })}
            </span>
            <span>
              {x.fleet
                ? t("database.scopeFleet", "fleet role")
                : x.tenantId
                  ? t("database.scopeTenant", "tenant {{id}}", {
                      id: x.tenantId,
                    })
                  : t("database.scopeNone", "no tenant scope")}
            </span>
            {x.budgetMs !== null && (
              <span>
                {t("database.budget", "budget {{budget}}", {
                  budget: formatSignalValue(x.budgetMs, "ms"),
                })}
              </span>
            )}
          </div>
          <code className="text-text-primary block font-mono text-xs break-all">
            {x.statement}
          </code>
          {x.plan ? (
            <details>
              <summary className="text-text-secondary cursor-pointer text-xs">
                {t("database.plan", "Plan, as {{who}}", {
                  who: x.plannedAs ?? "",
                })}
              </summary>
              <pre
                data-testid="timeout-plan"
                className="bg-bg-tertiary text-text-primary mt-2 overflow-x-auto rounded p-3 font-mono text-xs"
              >
                {x.plan}
              </pre>
            </details>
          ) : x.planError ? (
            <p className="text-text-secondary text-xs">
              {t("database.planError", "No plan: {{error}}", {
                error: x.planError,
              })}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TablesSection({ screen }: { screen: Screen }) {
  const { t } = useTranslation();
  const date = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString() : "—";
  return (
    <div className="space-y-6">
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="tables-table">
          <thead>
            <tr className="border-border border-b text-left">
              <th className={th}>{t("database.table", "Table")}</th>
              <th className={th}>{t("database.size", "Size")}</th>
              <th className={th}>
                {t("database.growth", "Growth in the window")}
              </th>
              <th className={th}>{t("database.liveTuples", "Live rows")}</th>
              <th className={th}>{t("database.deadTuples", "Dead rows")}</th>
              <th className={th}>
                {t("database.lastAutovacuum", "Last autovacuum")}
              </th>
              <th className={th}>
                {t("database.lastAutoanalyze", "Last autoanalyze")}
              </th>
              <th className={th}>{t("database.seqScans", "Seq scans")}</th>
            </tr>
          </thead>
          <tbody>
            {screen.tables.map((r) => (
              <tr
                key={r.table}
                className="border-border border-b last:border-0"
                data-testid="table-row"
              >
                <td className={td}>
                  <code className="font-mono text-xs">{r.table}</code>
                </td>
                <td className={td}>{formatBytes(r.totalBytes)}</td>
                <td className={td}>
                  {r.growthBytes === null ? "—" : formatBytes(r.growthBytes)}
                </td>
                <td className={td}>{r.liveTuples.toLocaleString()}</td>
                <td className={td}>{r.deadTuples.toLocaleString()}</td>
                <td className={td}>{date(r.lastAutovacuum)}</td>
                <td className={td}>{date(r.lastAutoanalyze)}</td>
                <td className={td}>{r.seqScans.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-2">
          <h4 className="text-text-primary text-sm font-medium">
            {t("database.unusedIndexes", "Indexes never scanned")}
          </h4>
          {screen.unusedIndexes.length === 0 ? (
            <p className="text-text-secondary text-sm">
              {t(
                "database.noUnusedIndexes",
                "Every index has been used since the statistics were last reset.",
              )}
            </p>
          ) : (
            <ul className="space-y-1 text-sm" data-testid="unused-indexes">
              {screen.unusedIndexes.map((i) => (
                <li key={i.index} className="flex justify-between gap-3">
                  <code className="font-mono text-xs break-all">
                    {`${i.table}.${i.index}`}
                  </code>
                  <span className="text-text-secondary tabular-nums">
                    {formatBytes(i.bytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="space-y-2">
          <h4 className="text-text-primary text-sm font-medium">
            {t("database.seqScanHeavy", "Read most by sequential scan")}
          </h4>
          <ul className="space-y-1 text-sm" data-testid="seq-scan-heavy">
            {screen.seqScanHeavy.map((r) => (
              <li key={r.table} className="flex justify-between gap-3">
                <code className="font-mono text-xs break-all">{r.table}</code>
                <span className="text-text-secondary tabular-nums">
                  {t("database.seqScanLine", "{{scans}} scans · {{size}}", {
                    scans: r.seqScans.toLocaleString(),
                    size: formatBytes(r.totalBytes),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function DatabasePage({
  refreshMs = REFRESH_MS,
}: {
  refreshMs?: number;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const [win, setWin] = useState<WindowKey>("1h");
  const [sort, setSort] = useState<Sort>("total");
  const [screen, setScreen] = useState<Screen | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // A refresh that failed after figures were shown: they stay, marked as possibly out of date.
  const [stale, setStale] = useState(false);
  // A slow answer for a window the user already left never replaces the newer one.
  const sent = useRef(0);
  const shown = useRef(false);

  const load = useCallback(async (w: WindowKey, initial: boolean) => {
    const id = ++sent.current;
    if (initial) {
      setLoading(true);
      shown.current = false;
    }
    const failed = () => {
      if (shown.current) setStale(true);
      else setError(true);
    };
    try {
      const { data, error: err } = await api.api.v1[
        "instance-health"
      ].database.get({
        query: { window: w },
      });
      if (id !== sent.current) return;
      if (err || !data) {
        failed();
        return;
      }
      setError(false);
      setStale(false);
      shown.current = true;
      setScreen(data.database);
    } catch {
      if (id === sent.current) failed();
    } finally {
      // Whichever request is the newest settles the loading state, however it was started: an
      // initial read overtaken by a refresh would otherwise leave the skeleton up for good.
      if (id === sent.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isSuperAdmin) return;
    void load(win, true);
    const timer = setInterval(() => void load(win, false), refreshMs);
    return () => clearInterval(timer);
  }, [isSuperAdmin, load, win, refreshMs]);

  if (user && !isSuperAdmin) return <Navigate to="/admin/users" replace />;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-text-primary text-base font-semibold">
            {t("database.title", "Database")}
          </h2>
          <p className="text-text-secondary text-sm">
            {t(
              "database.subtitle",
              "What the database spends its time on, the statements that hit their budget, and the tables behind them. Snapshots every 5 minutes, kept for DB_STATS_RETENTION_DAYS days.",
            )}{" "}
            <Link
              to="/admin/instance-health"
              className="text-accent hover:underline"
            >
              {t("database.backToHealth", "Instance health")}
            </Link>
          </p>
        </div>
        <SegmentedControl<WindowKey>
          aria-label={t("database.window", "Window")}
          value={win}
          onChange={setWin}
          // A unit, the same in every language: the value is its own label.
          options={WINDOW_KEYS.map((w) => ({ value: w, label: w }))}
        />
      </div>
      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={!screen}
        onRetry={() => void load(win, true)}
        skeleton={<Skeleton className="h-64 w-full" />}
        empty={
          <EmptyState
            icon={Database}
            title={t("database.emptyTitle", "No figures yet")}
            description={t(
              "database.emptyDescription",
              "The first snapshot is taken within 5 minutes of the process starting.",
            )}
          />
        }
      >
        {screen && (
          <>
            {stale && (
              <p
                data-testid="refresh-stale"
                role="status"
                className="border-warning bg-warning-soft text-text-primary rounded-lg border px-4 py-2 text-sm"
              >
                {t(
                  "database.refreshFailed",
                  "The last refresh failed: these figures may be out of date. It tries again every minute.",
                )}
              </p>
            )}
            <Card className="space-y-3" data-testid="section-statements">
              <h3 className="text-text-primary text-sm font-semibold">
                {t("database.statementsTitle", "Query statistics")}
              </h3>
              <StatementsSection
                screen={screen}
                sort={sort}
                setSort={setSort}
              />
            </Card>
            <Card className="space-y-3" data-testid="section-timeouts">
              <h3 className="text-text-primary text-sm font-semibold">
                {t(
                  "database.timeoutsTitle",
                  "Statement timeouts and their plans",
                )}
              </h3>
              <p className="text-text-secondary text-xs">
                {t(
                  "database.timeoutsHelp",
                  "Statements cancelled by their time budget, with the work that ran them. The first one of each statement per hour gets its plan, taken as the role and tenant it ran under (EXPLAIN, without running it).",
                )}
              </p>
              <TimeoutsSection screen={screen} />
            </Card>
            <Card className="space-y-3" data-testid="section-tables">
              <h3 className="text-text-primary text-sm font-semibold">
                {t("database.tablesTitle", "Tables and indexes")}
              </h3>
              <TablesSection screen={screen} />
            </Card>
          </>
        )}
      </DataBoundary>
    </div>
  );
}
