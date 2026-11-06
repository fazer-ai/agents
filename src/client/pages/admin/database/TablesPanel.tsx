import { Search, SearchX } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Button, Card, EmptyState, Input } from "@/client/components";
import { cn } from "@/client/lib/utils";
import type { Formatters } from "./format";
import { Meter, SectionIntro } from "./parts";
import type { Screen, TableRow } from "./types";

// "Why?" on the storage side: which tables are big, growing or carrying dead rows autovacuum has not
// cleared, which indexes nothing reads, and which tables are read whole.

// How many tables show before "show all": the largest ones, which is where the answers usually are.
const FIRST_TABLES = 25;

const th =
  "text-text-muted px-3 py-2 text-left text-xs font-medium whitespace-nowrap";
const td = "px-3 py-2 align-middle tabular-nums whitespace-nowrap text-sm";

export function TablesPanel({
  screen,
  fmt,
}: {
  screen: Screen;
  fmt: Formatters;
}) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");
  const [all, setAll] = useState(false);
  const needle = filter.trim().toLowerCase();
  const matching = needle
    ? screen.tables.filter((r) => r.table.toLowerCase().includes(needle))
    : screen.tables;
  const shown = all || needle ? matching : matching.slice(0, FIRST_TABLES);
  const largest = Math.max(1, ...screen.tables.map((r) => r.totalBytes));
  const overdue = screen.tables.filter((r) => r.vacuumOverdue).length;

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <SectionIntro
          title={t("database.tablesTitle", "Tables and indexes")}
          aside={
            overdue > 0 ? (
              <span data-testid="vacuum-overdue-count">
                <Badge variant="warning">
                  {t(
                    "database.vacuumOverdueCount",
                    "{{count}} overdue for vacuum",
                    { count: overdue },
                  )}
                </Badge>
              </span>
            ) : null
          }
        >
          {t(
            "database.tablesHelp",
            "Size includes indexes and TOAST. Dead rows are marked when there are more than autovacuum's own trigger allows (autovacuum_vacuum_threshold + scale factor × live rows).",
          )}
        </SectionIntro>
        <div className="relative max-w-sm">
          <Search
            className="text-text-muted pointer-events-none absolute top-1/2 left-2.5 z-10 h-3.5 w-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("database.filterTables", "Filter by table")}
            aria-label={t("database.filterTables", "Filter by table")}
            className="pl-8"
            data-testid="tables-filter"
          />
        </div>
        {shown.length === 0 ? (
          <EmptyState
            icon={SearchX}
            title={t("database.noTableMatchTitle", "No table matches")}
            description={t(
              "database.noTableMatch",
              "No table name contains “{{text}}”.",
              { text: filter.trim() },
            )}
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setFilter("")}
              >
                {t("database.clearFilter", "Clear the filter")}
              </Button>
            }
          />
        ) : (
          <div className="border-border overflow-x-auto rounded-lg border">
            <table
              className="w-full min-w-[48rem] text-sm"
              data-testid="tables-table"
            >
              <thead className="border-border border-b">
                <tr>
                  <th className={th}>{t("database.table", "Table")}</th>
                  <th className={th}>{t("database.size", "Size")}</th>
                  <th className={cn(th, "text-right")}>
                    {t("database.growth", "Growth in the window")}
                  </th>
                  <th className={cn(th, "text-right")}>
                    {t("database.liveTuples", "Live rows")}
                  </th>
                  <th className={cn(th, "text-right")}>
                    {t("database.deadTuples", "Dead rows")}
                  </th>
                  <th className={th}>
                    {t(
                      "database.lastVacuumAnalyze",
                      "Autovacuum / autoanalyze",
                    )}
                  </th>
                  <th className={cn(th, "text-right")}>
                    {t("database.scans", "Seq / index scans")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <TableLine key={r.table} r={r} fmt={fmt} largest={largest} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!all && !needle && matching.length > FIRST_TABLES && (
          <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
            {t("database.showAllTables", "Show all {{count}} tables", {
              count: matching.length,
            })}
          </Button>
        )}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <UnusedIndexes screen={screen} fmt={fmt} />
        <SeqScanHeavy screen={screen} fmt={fmt} />
      </div>
    </div>
  );
}

function When({ iso, fmt }: { iso: string | null; fmt: Formatters }) {
  const { t } = useTranslation();
  if (!iso) {
    return (
      <span className="text-text-muted">{t("database.never", "never")}</span>
    );
  }
  return <span>{fmt.relative(iso)}</span>;
}

function TableLine({
  r,
  fmt,
  largest,
}: {
  r: TableRow;
  fmt: Formatters;
  largest: number;
}) {
  return (
    <tr
      className="border-border border-b last:border-0"
      data-testid="table-row"
      data-vacuum-overdue={r.vacuumOverdue}
    >
      <td className={td}>
        <code className="text-text-primary font-mono text-xs">{r.table}</code>
      </td>
      <td className={cn(td, "w-48")}>
        <div className="flex items-center gap-2">
          <Meter
            className="w-16 shrink-0"
            pct={(r.totalBytes / largest) * 100}
            tone="neutral"
          />
          <span>{fmt.bytes(r.totalBytes)}</span>
        </div>
      </td>
      <td
        className={cn(td, "text-right", {
          "text-text-muted": !r.growthBytes,
        })}
      >
        {r.growthBytes === null ? "—" : fmt.signedBytes(r.growthBytes)}
      </td>
      <td className={cn(td, "text-right")}>{fmt.number(r.liveTuples)}</td>
      <td className={cn(td, "text-right")}>
        <span className="inline-flex items-center justify-end gap-2">
          {fmt.number(r.deadTuples)}
          {r.deadRatio !== null && r.deadTuples > 0 && (
            <span data-testid="dead-ratio">
              <Badge variant={r.vacuumOverdue ? "warning" : "secondary"}>
                {fmt.ratio(r.deadRatio)}
              </Badge>
            </span>
          )}
        </span>
      </td>
      <td className={cn(td, "text-xs leading-snug")}>
        <div data-testid="last-autovacuum">
          <When iso={r.lastAutovacuum} fmt={fmt} />
        </div>
        <div className="text-text-muted" data-testid="last-autoanalyze">
          <When iso={r.lastAutoanalyze} fmt={fmt} />
        </div>
      </td>
      <td className={cn(td, "text-text-secondary text-right")}>
        {`${fmt.number(r.seqScans)} / ${fmt.number(r.indexScans)}`}
      </td>
    </tr>
  );
}

function UnusedIndexes({ screen, fmt }: { screen: Screen; fmt: Formatters }) {
  const { t } = useTranslation();
  const largest = Math.max(1, ...screen.unusedIndexes.map((i) => i.bytes));
  return (
    <Card className="space-y-3">
      <SectionIntro
        title={t("database.unusedIndexes", "Indexes never scanned")}
      >
        {t(
          "database.unusedIndexesHelp",
          "Not unique, not primary keys, and not read once since the statistics were last reset: candidates to drop, largest first.",
        )}
      </SectionIntro>
      {screen.unusedIndexes.length === 0 ? (
        <p
          className="text-text-secondary text-sm"
          data-testid="no-unused-indexes"
        >
          {t(
            "database.noUnusedIndexes",
            "Every index has been used since the statistics were last reset.",
          )}
        </p>
      ) : (
        <ul className="space-y-2.5 text-sm" data-testid="unused-indexes">
          {screen.unusedIndexes.map((i) => (
            <li key={i.index} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0">
                  <code className="text-text-primary font-mono text-xs break-all">
                    {i.index}
                  </code>{" "}
                  <span className="text-text-muted text-xs">
                    {t("database.onTable", "on {{table}}", { table: i.table })}
                  </span>
                </span>
                <span className="text-text-secondary shrink-0 text-xs tabular-nums">
                  {fmt.bytes(i.bytes)}
                </span>
              </div>
              <Meter pct={(i.bytes / largest) * 100} tone="neutral" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SeqScanHeavy({ screen, fmt }: { screen: Screen; fmt: Formatters }) {
  const { t } = useTranslation();
  return (
    <Card className="space-y-3">
      <SectionIntro
        title={t("database.seqScanHeavy", "Read most by sequential scan")}
      >
        {t(
          "database.seqScanHeavyHelp",
          "Times the table was read whole, weighted by its size: where a missing index costs the most.",
        )}
      </SectionIntro>
      {screen.seqScanHeavy.length === 0 ? (
        <p
          className="text-text-secondary text-sm"
          data-testid="no-seq-scan-heavy"
        >
          {t(
            "database.noSeqScanHeavy",
            "No table has been read by a sequential scan since the statistics were last reset.",
          )}
        </p>
      ) : (
        <ul
          className="divide-border divide-y text-sm"
          data-testid="seq-scan-heavy"
        >
          {screen.seqScanHeavy.map((r) => (
            <li
              key={r.table}
              className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0"
            >
              <code className="text-text-primary min-w-0 font-mono text-xs break-all">
                {r.table}
              </code>
              <span className="text-text-secondary shrink-0 text-xs tabular-nums">
                {t("database.seqScanLine", "{{scans}} scans · {{size}}", {
                  scans: fmt.number(r.seqScans),
                  size: fmt.bytes(r.totalBytes),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
