import { useTranslation } from "react-i18next";
import { metricsErrorMessage } from "./Block";
import { useCurrentStream } from "./useStream";

// The page-wide line while the view fills: how many of its days are in, and which days the server is
// computing now. Gone once every block is complete, and never shown for a view that completes within
// the stream's grace.
export function StreamProgress() {
  const { t, i18n } = useTranslation();
  const current = useCurrentStream();
  const stream = current?.state;
  const p = stream?.progress;
  if (!current || !stream || !p || stream.done || p.total === 0) return null;
  // Within the stream's grace a view that is about to complete shows no progress at all.
  if (!stream.graced && !stream.failed) return null;
  if (stream.failed)
    return (
      <p
        className="-mt-3 flex items-center gap-2 text-sm text-text-muted"
        role="status"
      >
        {metricsErrorMessage(t, stream.status, stream.field)}
        <button
          type="button"
          onClick={current.reload}
          className="text-accent text-sm hover:underline"
        >
          {t("dashboard.retry", "Try again")}
        </button>
      </p>
    );
  const day = (key: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      day: "numeric",
      month: "short",
    }).format(new Date(`${key}T00:00:00`));
  const pct = Math.round((p.ready / p.total) * 100);
  return (
    <div className="-mt-3 flex flex-col gap-1.5" role="status">
      <p className="text-text-muted text-xs">
        {p.computing
          ? t(
              "dashboard.progress.computing",
              "{{ready}} of {{total}} days ready · computing {{from}} to {{to}}",
              {
                ready: p.ready,
                total: p.total,
                from: day(p.computing[0]),
                to: day(p.computing[1]),
              },
            )
          : t("dashboard.progress.ready", "{{ready}} of {{total}} days ready", {
              ready: p.ready,
              total: p.total,
            })}
      </p>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-bg-tertiary"
        aria-hidden="true"
      >
        <div
          className="h-full bg-accent-solid transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
