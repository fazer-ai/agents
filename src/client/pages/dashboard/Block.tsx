import { Download, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Card, HelpPopover } from "@/client/components";
import { type CsvCell, downloadCsv } from "./csv";

// What a block shows, as a table: the same rows feed the CSV export and the screen-reader table that
// stands in for a chart, so the file, the chart and what a screen reader hears cannot disagree.
export interface BlockTable {
  // File name without extension.
  name: string;
  header: string[];
  // Raw values, for the file.
  rows: CsvCell[][];
  // The same cells formatted for reading (currency, percent), for the screen-reader table. Defaults
  // to the raw values.
  display?: string[][];
}

// A dashboard block: a titled card with its controls, a CSV export of exactly what it shows, and,
// when its content is a chart, a table a screen reader reads in the chart's place (the chart itself
// is hidden from the accessibility tree, since an SVG of bars says nothing).
export function Block({
  id,
  icon: Icon,
  title,
  help,
  actions,
  table,
  chart,
  error,
  loading,
  onRetry,
  footer,
  children,
}: {
  id?: string;
  icon: LucideIcon;
  title: string;
  help?: ReactNode;
  actions?: ReactNode;
  table?: BlockTable;
  // True when the children are a chart: the table is then rendered for screen readers.
  chart?: boolean;
  // The block's request failed: it says so, with a retry, instead of rendering an empty result
  // that reads as "nothing happened". No CSV either, since there is nothing true to export.
  error?: boolean;
  // The block's figures have not arrived: no CSV and no stand-in table yet, since whatever the
  // table holds now (zeros, an empty list) is not what the block is about to show.
  loading?: boolean;
  onRetry?: () => void;
  // Figures shown under a chart that are not in its table (a period's totals, a second breakdown):
  // rendered for everyone, since hiding them with the chart would leave a screen reader without them.
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const shown = !error;
  const ready = shown && !loading;
  return (
    <Card id={id} className="flex scroll-mt-4 flex-col gap-4 lg:scroll-mt-32">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-medium text-sm text-text-primary">
          <Icon className="h-4 w-4 text-accent" aria-hidden="true" />
          {title}
          {help ? <HelpPopover content={help} label={title} /> : null}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {actions}
          {table && ready && (
            <button
              type="button"
              onClick={() =>
                downloadCsv(`${table.name}.csv`, table.header, table.rows)
              }
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-text-muted text-xs hover:bg-bg-hover hover:text-text-primary"
              aria-label={t(
                "dashboard.exportCsvOf",
                "Export {{title}} as CSV",
                {
                  title,
                },
              )}
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {t("dashboard.exportCsv", "CSV")}
            </button>
          )}
        </div>
      </div>
      {error ? (
        <p className="flex items-center gap-2 py-4 text-sm text-text-muted">
          {t("dashboard.error", "Could not load metrics.")}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="text-accent text-sm hover:underline"
            >
              {t("dashboard.retry", "Try again")}
            </button>
          )}
        </p>
      ) : chart ? (
        <div aria-hidden="true">{children}</div>
      ) : (
        children
      )}
      {shown && footer}
      {/* The wrapper is what hides it: a `<table>` keeps its content width whatever width it is
          given, so `sr-only` on the table itself still widened the page into a horizontal scroll. */}
      {ready && chart && table && (
        <div className="sr-only">
          <table>
            <caption>{title}</caption>
            <thead>
              <tr>
                {table.header.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                table.display ??
                table.rows.map((r) => r.map((c) => String(c ?? "")))
              ).map((r, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id beyond their order
                <tr key={i}>
                  {r.map((c, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// A figure with the previous period beside it. The change is said in words a reader can check: the
// previous value, and the difference in points for a rate or in percent for an amount. No previous
// value (an empty or absent previous period) shows no change at all, never an infinite one.
export function Delta({
  current,
  previous,
  kind,
  format,
  lowerIsBetter,
}: {
  current: number | null;
  previous: number | null | undefined;
  kind: "rate" | "amount";
  format: (v: number) => string;
  lowerIsBetter?: boolean;
}) {
  const { t, i18n } = useTranslation();
  if (previous === null || previous === undefined || current === null)
    return null;
  const diff = current - previous;
  // In the reader's own decimals, and a change that rounds to nothing reads 0, not −0.
  const signed = (v: number, digits: number) =>
    new Intl.NumberFormat(i18n.language, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: "exceptZero",
    }).format(v);
  let change: string | null = null;
  if (kind === "rate") change = `${signed(diff * 100, 1)} pp`;
  else if (previous > 0) change = `${signed((diff / previous) * 100, 0)}%`;
  const better = lowerIsBetter ? diff < 0 : diff > 0;
  const tone =
    diff === 0 ? "text-text-muted" : better ? "text-success" : "text-warning";
  return (
    <span className="text-text-muted text-xs">
      {t("dashboard.previous", "previous: {{value}}", {
        value: format(previous),
      })}
      {change && (
        <span className={`ml-1.5 whitespace-nowrap tabular-nums ${tone}`}>
          {change}
        </span>
      )}
    </span>
  );
}

// A section's title, with the icon its entry carries in the section bar, so the bar and the page
// read as one index. A notch above a block's own title, which it heads.
export function SectionHeading({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <h2 className="flex items-center gap-2.5 font-semibold text-base text-text-primary">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-accent">
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
      {children}
    </h2>
  );
}
