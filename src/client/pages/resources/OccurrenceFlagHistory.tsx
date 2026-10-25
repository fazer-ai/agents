import { ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  FormField,
  Input,
  Select,
  Skeleton,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";

type Episode = NonNullable<
  Awaited<
    ReturnType<
      ReturnType<typeof api.api.v1.occurrences.monitors>["flag-episodes"]["get"]
    >
  >["data"]
>["episodes"][number];

// The dashboards' choices (docs/ui.md, "A day is defined by the viewer's browser timezone"), kept here:
// the console's occurrences ship without the dashboards.
const RANGES = ["24h", "today", "yesterday", "7d", "30d"] as const;
type Range = (typeof RANGES)[number];
type Period = Range | "custom";

// Episodes one read shows, newest first; past it the list says how many it leaves out.
const HISTORY_MAX = 200;

function rangeWindow(
  range: Range,
  now = new Date(),
): { since: Date; until: Date } {
  const day = (back: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
  switch (range) {
    case "24h":
      return { since: new Date(now.getTime() - 86_400_000), until: now };
    case "today":
      return { since: day(0), until: now };
    case "yesterday":
      return { since: day(1), until: day(0) };
    case "7d":
      return { since: day(6), until: now };
    case "30d":
      return { since: day(29), until: now };
  }
}

// `datetime-local` holds the operator's own wall clock, without a zone: `new Date` reads it as local.
const localInput = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// The themes flagged during a period (docs/occurrences.md, "Flag history"): every episode that overlaps
// it, newest first, with the title the theme had then, its reference, why it was flagged, from when to
// when (or still flagged), its peak and the theme's conversations in it. `onOpenTheme` opens the theme
// in the open themes list.
export function OccurrenceFlagHistory({
  monitorId,
  active = true,
  onOpenTheme,
}: {
  monitorId: string;
  active?: boolean;
  onOpenTheme?: (themeId: string, title: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const rangeLabels: Record<Range, string> = {
    "24h": t("occurrences.history.range.24h", "Last 24 hours"),
    today: t("occurrences.history.range.today", "Today"),
    yesterday: t("occurrences.history.range.yesterday", "Yesterday"),
    "7d": t("occurrences.history.range.7d", "Last 7 days"),
    "30d": t("occurrences.history.range.30d", "Last 30 days"),
  };
  const [period, setPeriod] = useState<Period>("24h");
  const [from, setFrom] = useState(() =>
    localInput(new Date(Date.now() - 86_400_000)),
  );
  const [to, setTo] = useState(() => localInput(new Date()));
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  // Only the latest request's answer is shown: a period changed while one is on the wire drops it.
  const seq = useRef(0);
  const customSince = new Date(from);
  const customUntil = new Date(to);
  const customBad =
    period === "custom" &&
    (Number.isNaN(customSince.getTime()) ||
      Number.isNaN(customUntil.getTime()) ||
      customUntil.getTime() <= customSince.getTime());

  const load = useCallback(async () => {
    if (customBad) return;
    const span =
      period === "custom"
        ? { since: new Date(from), until: new Date(to) }
        : rangeWindow(period);
    // Right at midnight "today" is empty; a one-second window keeps since before until.
    const until = Math.max(span.until.getTime(), span.since.getTime() + 1000);
    const w = {
      since: span.since.toISOString(),
      until: new Date(until).toISOString(),
    };
    const mine = ++seq.current;
    setFailed(false);
    setEpisodes(null);
    const res = await api.api.v1.occurrences
      .monitors({ id: monitorId })
      ["flag-episodes"].get({
        query: { since: w.since, until: w.until, limit: HISTORY_MAX },
      });
    if (mine !== seq.current) return;
    if (res.error || !res.data) {
      setFailed(true);
      return;
    }
    setEpisodes(res.data.episodes);
    setTotal(res.data.total);
  }, [monitorId, period, from, to, customBad]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      dateStyle: "short",
      timeStyle: "short",
    });
  const flagLabel = (f: string) =>
    f === "new"
      ? t("occurrences.flagNew", "new")
      : f === "above_usual"
        ? t("occurrences.flagAboveUsual", "above its usual")
        : f === "concentrated"
          ? t(
              "occurrences.flagConcentratedReference",
              "concentrated on one reference",
            )
          : f;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="font-medium text-text-primary">
            {t("occurrences.history.title", "Flagged in a period")}
          </h2>
          <p className="text-text-muted text-xs">
            {t(
              "occurrences.history.intro",
              "Every time a theme was flagged during the period, newest first, with the title it had then and from when to when.",
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={load}
          disabled={customBad}
        >
          {t("common.refresh", "Refresh")}
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <FormField label={t("occurrences.history.period", "Period")}>
          <Select
            value={period}
            onChange={(e) => setPeriod(e.target.value as Period)}
          >
            {RANGES.map((r) => (
              <option key={r} value={r}>
                {rangeLabels[r]}
              </option>
            ))}
            <option value="custom">
              {t("occurrences.history.custom", "Custom")}
            </option>
          </Select>
        </FormField>
        {period === "custom" && (
          <>
            <FormField label={t("occurrences.history.from", "From")}>
              <Input
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </FormField>
            <FormField
              label={t("occurrences.history.to", "To")}
              error={
                customBad
                  ? t(
                      "occurrences.history.badRange",
                      "The end has to come after the start.",
                    )
                  : null
              }
            >
              <Input
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </FormField>
          </>
        )}
      </div>
      {failed ? (
        <p className="text-sm text-text-muted">
          {t("occurrences.history.error", "Could not read the flagged themes.")}
        </p>
      ) : customBad ? null : episodes === null ? (
        <div role="status" className="flex flex-col gap-2">
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      ) : episodes.length === 0 ? (
        <p className="text-sm text-text-muted">
          {t(
            "occurrences.history.empty",
            "No theme was flagged during this period.",
          )}
        </p>
      ) : (
        <>
          {total > episodes.length && (
            <p data-history-capped className="text-text-muted text-xs">
              {t(
                "occurrences.history.capped",
                "The newest {{shown}} of {{total}} times a theme was flagged in this period. Pick a shorter period to see the others.",
                { shown: episodes.length, total },
              )}
            </p>
          )}
          <ul className="flex flex-col divide-y divide-border">
            {episodes.map((e) => (
              <li
                key={e.id}
                data-episode={e.id}
                data-open={e.endedAt === null ? "true" : undefined}
                className="flex flex-col gap-1 py-2"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-sm text-text-primary">
                    {e.title}
                  </span>
                  {e.kinds.map((f) => (
                    <Badge
                      key={f}
                      variant={e.endedAt === null ? "warning" : "secondary"}
                    >
                      {flagLabel(f)}
                    </Badge>
                  ))}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-text-muted text-xs">
                  <span data-episode-span>
                    {e.endedAt
                      ? t("occurrences.episodeSpan", "{{from}} to {{to}}", {
                          from: when(e.startedAt),
                          to: when(e.endedAt),
                        })
                      : t(
                          "occurrences.episodeOpen",
                          "{{from}}, still flagged",
                          {
                            from: when(e.startedAt),
                          },
                        )}
                  </span>
                  <span>
                    {t(
                      "occurrences.themeConversationCount",
                      "{{count}} conversations",
                      {
                        count: e.conversations,
                      },
                    )}
                  </span>
                  <span>
                    {t(
                      "occurrences.history.peak",
                      "peak of {{peak}} in the window",
                      { peak: e.peak },
                    )}
                  </span>
                  {e.reference && (
                    <span>
                      {t(
                        "occurrences.themeReference",
                        "Reference: {{reference}}",
                        {
                          reference: e.reference,
                        },
                      )}
                    </span>
                  )}
                </span>
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  {e.themeTitle !== e.title && (
                    <span className="text-text-muted">
                      {t(
                        "occurrences.history.nowCalled",
                        "Now part of “{{theme}}”",
                        {
                          theme: e.themeTitle,
                        },
                      )}
                    </span>
                  )}
                  {e.themeStatus === "open" && onOpenTheme && (
                    <button
                      type="button"
                      className={cn("text-accent hover:underline")}
                      onClick={() => onOpenTheme(e.themeId, e.themeTitle)}
                    >
                      {t("occurrences.history.openTheme", "Open the theme")}
                    </button>
                  )}
                  {e.links.map((l) => (
                    <a
                      key={l.url}
                      href={l.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-accent hover:underline"
                    >
                      {`#${l.chatwootConversationId}`}
                      <ExternalLink className="h-3 w-3" aria-hidden="true" />
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
