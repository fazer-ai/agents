import { Activity, Database, Table2, TimerOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate, useSearchParams } from "react-router";
import {
  Card,
  DataBoundary,
  EmptyState,
  SegmentedControl,
  Skeleton,
  Tabs,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { DatabaseSummary, SummarySkeleton } from "./DatabaseSummary";
import { formatters } from "./format";
import { type Sort, StatementsPanel } from "./StatementsPanel";
import { TablesPanel } from "./TablesPanel";
import { TimeoutsPanel } from "./TimeoutsPanel";
import {
  type Screen,
  SECTION_KEYS,
  WINDOW_KEYS,
  type WindowKey,
} from "./types";

// The database's own figures (docs/logs.md, "Database"), SUPER_ADMIN only, in the order a reader asks:
// is it fine now (the summary), what is slow or blowing up (statements, timeouts), and why (plans,
// tables, indexes). The window and the section live in the URL, so a link opens the same view.
// Read-only: nothing here sends SQL.

const REFRESH_MS = 60_000;

// Read inside another call's options, where the extractor does not look:
// t('database.unlabeled', 'unlabeled work')

function pick<T extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function DatabasePage({
  refreshMs = REFRESH_MS,
}: {
  refreshMs?: number;
}) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";
  const [params, setParams] = useSearchParams();
  const win = pick(params.get("window"), WINDOW_KEYS, "1h");
  const section = pick(params.get("section"), SECTION_KEYS, "statements");
  const [sort, setSort] = useState<Sort>("total");
  const [screen, setScreen] = useState<Screen | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // A refresh that failed after figures were shown: they stay, marked with the time of the last good read.
  const [stale, setStale] = useState(false);
  const [readAt, setReadAt] = useState<string | null>(null);
  // A slow answer for a window the user already left never replaces the newer one.
  const sent = useRef(0);
  const shown = useRef(false);
  const fmt = useMemo(() => formatters(i18n.language), [i18n.language]);

  const setParam = (key: "window" | "section", value: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set(key, value);
      return next;
    });

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
      setReadAt(new Date().toISOString());
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
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 className="text-text-primary text-base font-semibold">
            {t("database.title", "Database")}
          </h2>
          <p className="text-text-secondary max-w-2xl text-sm">
            {t(
              "database.subtitleShort",
              "Where Postgres spends its time, what hit its budget, and the tables behind it.",
            )}{" "}
            <Link
              to="/admin/instance-health"
              className="text-accent hover:underline"
            >
              {t("database.backToHealth", "Instance health")}
            </Link>
          </p>
          {readAt && !stale && (
            <p className="text-text-muted text-xs" data-testid="read-at">
              {t(
                "database.readAt",
                "Read at {{time}}, refreshed every minute",
                {
                  time: new Date(readAt).toLocaleTimeString(i18n.language),
                },
              )}
            </p>
          )}
        </div>
        <div className="shrink-0">
          <SegmentedControl<WindowKey>
            aria-label={t("database.window", "Window")}
            value={win}
            onChange={(w) => setParam("window", w)}
            // A unit, the same in every language: the value is its own label.
            options={WINDOW_KEYS.map((w) => ({ value: w, label: w }))}
          />
        </div>
      </div>
      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={!screen}
        onRetry={() => void load(win, true)}
        skeleton={
          <div className="space-y-6">
            <SummarySkeleton />
            <Skeleton className="h-9 w-80 max-w-full" />
            <Card className="space-y-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-32 w-full" />
            </Card>
          </div>
        }
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
          <div className="space-y-6">
            {stale && (
              <p
                data-testid="refresh-stale"
                role="status"
                className="border-warning bg-warning-soft text-text-primary rounded-lg border px-4 py-2 text-sm"
              >
                {t(
                  "database.refreshFailedAt",
                  "The last refresh failed: these figures are from {{time}} and may be out of date. It tries again every minute.",
                  {
                    time: readAt
                      ? new Date(readAt).toLocaleTimeString(i18n.language)
                      : "",
                  },
                )}
              </p>
            )}
            <DatabaseSummary screen={screen} fmt={fmt} />
            <div className="space-y-4">
              <Tabs
                aria-label={t("database.sections", "Sections")}
                value={section}
                onChange={(key) => setParam("section", key)}
                items={[
                  {
                    key: "statements",
                    label: t("database.tabStatements", "Queries"),
                    icon: Activity,
                  },
                  {
                    key: "timeouts",
                    label: t("database.tabTimeouts", "Timeouts"),
                    icon: TimerOff,
                    badge: screen.timeouts.length,
                  },
                  {
                    key: "tables",
                    label: t("database.tabTables", "Tables and indexes"),
                    icon: Table2,
                  },
                ]}
              />
              <Card
                role="tabpanel"
                data-testid={`section-${section}`}
                className="min-w-0"
              >
                {section === "statements" && (
                  <StatementsPanel
                    screen={screen}
                    fmt={fmt}
                    sort={sort}
                    setSort={setSort}
                  />
                )}
                {section === "timeouts" && (
                  <TimeoutsPanel screen={screen} fmt={fmt} />
                )}
                {section === "tables" && (
                  <TablesPanel screen={screen} fmt={fmt} />
                )}
              </Card>
            </div>
          </div>
        )}
      </DataBoundary>
    </div>
  );
}
