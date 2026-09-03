import { useTranslation } from "react-i18next";
import type { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";

type Usage = NonNullable<
  Awaited<
    ReturnType<
      (typeof api.api.v1)["tenant-settings"]["spend-ceiling"]["usage"]["get"]
    >
  >["data"]
>;
export type SpendUsageEntry = Usage["entries"][number];

export const SPEND_NOT_CONFIGURED = "langfuse-not-configured";

// THE BAR AND ITS CAVEATS, SHARED BY THE TWO SCREENS THAT SHOW THEM (issue #427). The ceiling is
// set in the Advanced panel and watched on the dashboard, and the two would drift the moment one of
// them learned about a new snapshot state the other did not: the colour thresholds, the "of"
// phrasing and every warning below the bar live here once. What the state MEANS is the gate's own
// verdict, sent by the API, so the screen and the runtime cannot disagree either.
export function SpendBar({
  label,
  entry,
  money,
}: {
  label: string;
  entry: SpendUsageEntry | undefined;
  money: Intl.NumberFormat;
}) {
  const { t } = useTranslation();
  const used = entry?.usedUsd ?? 0;
  const ceiling = entry?.ceilingUsd ?? null;
  const state = entry?.state ?? "allowed";
  const pct =
    ceiling && ceiling > 0 ? Math.min(100, (used / ceiling) * 100) : 0;
  return (
    <>
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-sm text-text-secondary">{label}</span>
        <span
          className={cn("text-sm tabular-nums", {
            "text-text-muted": state === "allowed",
            "text-warning": state === "warning",
            "text-error": state === "over",
          })}
        >
          {ceiling === null
            ? t("spendCeiling.usage.noCeiling", "{{used}} (no ceiling)", {
                used: money.format(used),
              })
            : t("spendCeiling.usage.ofCeiling", "{{used}} of {{ceiling}}", {
                used: money.format(used),
                ceiling: money.format(ceiling),
              })}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary"
        role="progressbar"
        aria-label={label}
        aria-valuenow={ceiling === null ? undefined : Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full transition-all", {
            "bg-accent": state === "allowed",
            "bg-warning": state === "warning",
            "bg-error": state === "over",
          })}
          style={{ width: `${ceiling === null ? 0 : pct}%` }}
        />
      </div>
    </>
  );
}

// Everything the figure above cannot be trusted for, said beside it or said nowhere: when it was
// last refreshed, whether the poll is failing, whether the row is a sentinel the gate lets through,
// and how much of the month Langfuse actually priced.
export function SpendHealthLines({
  entry,
  when,
  money,
}: {
  entry: SpendUsageEntry | undefined;
  when: (iso: string) => string;
  money: Intl.NumberFormat;
}) {
  const { t } = useTranslation();
  if (!entry) return null;
  const failing =
    entry.pollError && entry.pollError !== SPEND_NOT_CONFIGURED
      ? entry.pollError
      : null;
  const uncosted =
    entry.ledgerCalls > 0 && entry.costedCalls < entry.ledgerCalls;
  return (
    <div className="flex flex-col gap-0.5 text-text-muted text-xs">
      {entry.polledAt && (
        <span className={cn({ "text-warning": entry.stale })}>
          {entry.stale
            ? t(
                "spendCeiling.usage.stale",
                "Not refreshed since {{when}}. The last figure stands, and it can only undercount.",
                { when: when(entry.polledAt) },
              )
            : t("spendCeiling.usage.updated", "Refreshed {{when}}", {
                when: when(entry.polledAt),
              })}
        </span>
      )}
      {entry.pollError === SPEND_NOT_CONFIGURED && (
        <span className="text-warning">
          {t(
            "spendCeiling.usage.unenforced",
            "Not enforced on this half: the last reading found no Langfuse, so calls go through until it is configured and read again.",
          )}
        </span>
      )}
      {entry.polledAt === null && entry.pollError !== SPEND_NOT_CONFIGURED && (
        <span className="text-warning">
          {t(
            "spendCeiling.usage.unpolled",
            "The month's cost has not been read yet: calls go through until the first reading lands.",
          )}
        </span>
      )}
      {failing && entry.pollFailedAt && (
        <span className="text-warning">
          {t(
            "spendCeiling.usage.pollFailing",
            "Reading the cost from Langfuse has been failing since {{when}}: {{error}}",
            { when: when(entry.pollFailedAt), error: failing },
          )}
        </span>
      )}
      {uncosted && (
        <span className="text-warning">
          {t(
            "spendCeiling.usage.coverage",
            "Langfuse priced {{costed}} of the {{ledger}} calls this month, so the figure undercounts.",
            { costed: entry.costedCalls, ledger: entry.ledgerCalls },
          )}
        </span>
      )}
      {entry.carriedUsd > 0 && (
        <span>
          {t(
            "spendCeiling.usage.carried",
            "Includes {{carried}} spent in a Langfuse project this tenant no longer points at, carried over when it switched mid-month, so the figure is higher than the current project's own total.",
            { carried: money.format(entry.carriedUsd) },
          )}
        </span>
      )}
      {entry.unpricedModels.length > 0 && (
        <span className="text-warning">
          {t(
            "spendCeiling.usage.unpriced",
            "No price in Langfuse for: {{models}}",
            {
              models: entry.unpricedModels.join(", "),
            },
          )}
        </span>
      )}
    </div>
  );
}
