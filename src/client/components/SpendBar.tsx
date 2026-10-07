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

// THE BAR AND ITS CAVEATS, SHARED BY THE TWO SCREENS THAT SHOW THEM. The ceiling is set in the
// Advanced panel and watched on the dashboard, and the two would drift the moment one of them
// learned about a new snapshot state the other did not: the colour thresholds, the "of" phrasing
// and every warning below the bar live here once. What the state MEANS is the gate's own verdict,
// sent by the API, so the screen and the runtime cannot disagree either. With the ceiling off there is
// nothing to fill a bar against: the figure stands alone.
export function SpendBar({
  label,
  entry,
  money,
  enabled,
}: {
  label: string;
  entry: SpendUsageEntry | undefined;
  money: Intl.NumberFormat;
  enabled: boolean;
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
          {!enabled
            ? money.format(used)
            : ceiling === null
              ? t("spendCeiling.usage.noCeiling", "{{used}} (no ceiling)", {
                  used: money.format(used),
                })
              : t("spendCeiling.usage.ofCeiling", "{{used}} of {{ceiling}}", {
                  used: money.format(used),
                  ceiling: money.format(ceiling),
                })}
        </span>
      </div>
      {enabled && (
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
              "bg-accent-solid": state === "allowed",
              "bg-warning": state === "warning",
              "bg-error": state === "over",
            })}
            style={{ width: `${ceiling === null ? 0 : pct}%` }}
          />
        </div>
      )}
    </>
  );
}

// Everything the figure above cannot be trusted for, said beside it or said nowhere: when it was
// last refreshed, whether the poll is failing, and which calls of the month it leaves out for want of
// a price. With the ceiling off the figure is summed at read time, so only that last line applies.
// `briefUnpriced` says only how many calls are left out, for a page that already names the models and
// links to their prices beside the figure.
export function SpendHealthLines({
  entry,
  when,
  enabled,
  briefUnpriced,
}: {
  entry: SpendUsageEntry | undefined;
  when: (iso: string) => string;
  enabled: boolean;
  briefUnpriced?: boolean;
}) {
  const { t } = useTranslation();
  if (!entry) return null;
  return (
    <div className="flex flex-col gap-0.5 text-text-muted text-xs">
      {enabled && entry.polledAt && (
        <span className={cn({ "text-warning": entry.stale })}>
          {entry.stale
            ? t(
                "spendCeiling.usage.stale",
                "Not refreshed since {{when}}. The last figure stands.",
                { when: when(entry.polledAt) },
              )
            : t("spendCeiling.usage.updated", "Refreshed {{when}}", {
                when: when(entry.polledAt),
              })}
        </span>
      )}
      {enabled && entry.polledAt === null && (
        <span className="text-warning">
          {t(
            "spendCeiling.usage.unpolled",
            "The month's cost has not been read yet: calls go through until the first reading lands.",
          )}
        </span>
      )}
      {enabled && entry.pollError && entry.pollFailedAt && (
        <span className="text-warning">
          {t(
            "spendCeiling.usage.pollFailing",
            "Reading the month's cost has been failing since {{when}}: {{error}}",
            { when: when(entry.pollFailedAt), error: entry.pollError },
          )}
        </span>
      )}
      {entry.unpricedCalls > 0 && briefUnpriced && (
        <span className="text-warning">
          {t(
            "spendCeiling.usage.unpricedBrief",
            "{{n}} calls this month have no price and are not in this figure.",
            { count: entry.unpricedCalls, n: entry.unpricedCalls },
          )}
        </span>
      )}
      {entry.unpricedCalls > 0 && !briefUnpriced && (
        <span className="text-warning">
          {t(
            "spendCeiling.usage.unpriced",
            "{{n}} calls this month have no price and are not in the figure: {{models}}. Set this account's own price for the model, then re-price them.",
            {
              count: entry.unpricedCalls,
              n: entry.unpricedCalls,
              models: entry.unpricedModels.join(", "),
            },
          )}
        </span>
      )}
    </div>
  );
}
