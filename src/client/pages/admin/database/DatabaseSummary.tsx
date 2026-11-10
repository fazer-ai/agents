import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Badge, Card, HelpPopover, Skeleton } from "@/client/components";
import { cn } from "@/client/lib/utils";
import { signalHelp, signalLabel } from "../instance-health/signals";
import { factsLine } from "./facts";
import type { Formatters } from "./format";
import type { DatabaseSignal, Screen } from "./types";

// The answer to "is the database fine right now?": the two statement signals against their
// thresholds, whether query statistics are on, and how big the database is and how fast it grows.
// Every verdict here is the server's (`state`, `available`), so the screen and the MCP tool agree.

type BadgeTone = "success" | "warning" | "error" | "secondary";

const SIGNAL_TONE: Record<DatabaseSignal["state"], BadgeTone> = {
  ok: "success",
  firing: "error",
  stale: "warning",
  muted: "secondary",
  no_data: "secondary",
};

function stateLabel(state: DatabaseSignal["state"], t: TFunction): string {
  switch (state) {
    case "ok":
      return t("database.state.ok", "Within threshold");
    case "firing":
      return t("database.state.firing", "Above threshold");
    case "stale":
      return t("database.state.stale", "Reading failing");
    case "muted":
      return t("database.state.muted", "Not alerting");
    default:
      return t("database.state.noData", "No reading yet");
  }
}

function Tile({
  label,
  help,
  badge,
  tone,
  value,
  children,
  testId,
}: {
  label: string;
  help?: string | null;
  badge: string;
  tone: BadgeTone;
  value: string;
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <Card
      data-testid={testId}
      data-tone={tone}
      className={cn("flex min-w-0 flex-col gap-1.5 border-l-2", {
        "border-l-success": tone === "success",
        "border-l-warning": tone === "warning",
        "border-l-error": tone === "error",
        "border-l-border": tone === "secondary",
      })}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="text-text-secondary text-xs font-medium">
            {label}
          </span>
          {help && <HelpPopover content={help} label={label} />}
        </div>
        <Badge variant={tone} className="shrink-0">
          {badge}
        </Badge>
      </div>
      <div className="text-text-primary text-xl font-semibold tabular-nums">
        {value}
      </div>
      {children && (
        <div className="text-text-muted space-y-0.5 text-xs">{children}</div>
      )}
    </Card>
  );
}

// The statements the drift signal did not count for having too few calls in the hour, though each
// would have outranked the one it reads, so its value is not read as covering them.
function DriftLeftOut({ screen, fmt }: { screen: Screen; fmt: Formatters }) {
  const { t } = useTranslation();
  const floor = screen.driftFloor;
  if (!floor || floor.leftOutCount === 0) return null;
  return (
    <details data-testid="drift-left-out" className="text-text-secondary">
      <summary className="cursor-pointer">
        {t(
          "database.driftLeftOut",
          "{{count}} queries not counted: fewer than {{min}} calls in the last hour",
          { count: floor.leftOutCount, min: fmt.number(floor.minCalls) },
        )}
      </summary>
      <ul className="mt-1 space-y-1">
        {floor.leftOut.map((s) => (
          <li key={`${s.userid}:${s.queryid}`} data-testid="drift-left-out-row">
            <span className="tabular-nums">
              {t(
                "database.driftLeftOutRow",
                "{{calls}} calls, {{mean}} mean, {{share}} of its budget",
                {
                  count: s.calls,
                  calls: fmt.number(s.calls),
                  mean: fmt.ms(s.meanMs),
                  share: fmt.percent(s.meanBudgetPct),
                },
              )}
            </span>
            <code className="line-clamp-2 block font-mono break-all">
              {s.query}
            </code>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function DatabaseSummary({
  screen,
  fmt,
}: {
  screen: Screen;
  fmt: Formatters;
}) {
  const { t } = useTranslation();
  const st = screen.statements;
  const windowLabel = screen.window;
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4"
      data-testid="database-summary"
    >
      {screen.signals.map((s) => (
        <Tile
          key={s.signal}
          testId={`summary-signal-${s.signal}`}
          label={signalLabel(s.signal, t)}
          help={signalHelp(s.signal, t)}
          badge={stateLabel(s.state, t)}
          tone={SIGNAL_TONE[s.state]}
          value={s.value === null ? "—" : fmt.signal(s.value, s.unit)}
        >
          <p>
            {t("database.threshold", "Alerts above {{value}}", {
              value: fmt.signal(s.threshold, s.unit),
            })}
          </p>
          {s.facts && (
            <>
              <p className="text-text-secondary">
                {factsLine(s.facts, fmt, t)}
              </p>
              <p className="text-text-secondary line-clamp-2 font-mono break-all">
                {s.facts.statement}
              </p>
            </>
          )}
          {s.signal === "statement_mean_budget_pct" && (
            <DriftLeftOut screen={screen} fmt={fmt} />
          )}
        </Tile>
      ))}
      {st.available ? (
        <Tile
          testId="summary-extension"
          label={t("database.extension", "Query statistics")}
          badge={t("database.extensionOn", "Active")}
          tone="success"
          value={t("database.snapshotCount", "{{count}} snapshots", {
            count: st.snapshots,
          })}
        >
          <p>
            {st.lastSnapshotAt
              ? t(
                  "database.lastSnapshot",
                  "Last one {{when}}, one every 5 min",
                  {
                    when: fmt.relative(st.lastSnapshotAt),
                  },
                )
              : t(
                  "database.noSnapshotYet",
                  "The first one is taken within 5 min",
                )}
          </p>
        </Tile>
      ) : (
        <Tile
          testId="summary-extension"
          label={t("database.extension", "Query statistics")}
          badge={
            st.reason === "unreadable"
              ? t("database.extensionUnreadable", "Read failed")
              : t("database.extensionOff", "Off")
          }
          tone="warning"
          value="pg_stat_statements"
        >
          <p>
            {st.reason === "unreadable"
              ? t(
                  "database.extensionUnreadableShort",
                  "Installed, but reading it failed",
                )
              : st.reason === "not_loaded"
                ? t(
                    "database.extensionNotLoadedShort",
                    "Installed, but the server does not load it",
                  )
                : t(
                    "database.extensionMissingShort",
                    "Not created in this database",
                  )}
          </p>
        </Tile>
      )}
      <Tile
        testId="summary-size"
        label={t("database.sizeTitle", "Tables and indexes")}
        badge={windowLabel}
        tone="secondary"
        value={fmt.bytes(screen.size.totalBytes)}
      >
        <p>
          {screen.size.growthBytes === null
            ? t(
                "database.growthUnknown",
                "No snapshot old enough to tell growth",
              )
            : t("database.growthInWindow", "{{growth}} in the window", {
                growth: fmt.signedBytes(screen.size.growthBytes),
              })}
        </p>
        <p>
          {t("database.tableCount", "{{count}} tables", {
            count: screen.tables.length,
          })}
        </p>
      </Tile>
    </div>
  );
}

export function SummarySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 2xl:grid-cols-4">
      {["a", "b", "c", "d"].map((k) => (
        <Card key={k} className="space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-3 w-36" />
        </Card>
      ))}
    </div>
  );
}
