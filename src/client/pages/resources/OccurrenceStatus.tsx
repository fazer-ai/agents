import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/client/lib/api";
import { formatRelativeTime } from "@/client/lib/utils";
import { type SkipReason, skipReasonText, stepName } from "./occurrenceWords";

type Run = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.occurrences.runs.get>>["data"]
>["runs"][number];

// Read again this often while the configuration tab is open, so the line follows the rounds.
const STATUS_MS = 60_000;

// Whether a monitor that is on is working, under its switch: the last round (when, and how it went,
// in words when it failed or a step did not complete) and when the next one is expected. The next
// round is armed one cadence after the last one ends (round.ts, occurrenceRoundHandler).
export function OccurrenceStatus({
  monitorId,
  cadenceMinutes,
  reloadKey = 0,
  active = true,
  onShowRounds,
}: {
  monitorId: string;
  cadenceMinutes: number;
  reloadKey?: number;
  active?: boolean;
  onShowRounds?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [last, setLast] = useState<Run | null | undefined>(undefined);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const res = await api.api.v1.occurrences
      .monitors({ id: monitorId })
      .runs.get({ query: { limit: 1 } });
    if (mine !== seq.current) return;
    // A failed read keeps what was shown: this line is a summary, the Rounds tab says the error.
    if (res.error || !res.data) return;
    setLast(res.data.runs[0] ?? null);
  }, [monitorId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the trigger itself.
  useEffect(() => {
    void load();
  }, [load, reloadKey]);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void load(), STATUS_MS);
    return () => clearInterval(id);
  }, [active, load]);

  if (last === undefined) return null;
  const time = (d: Date) =>
    d.toLocaleTimeString(i18n.language, { timeStyle: "short" });

  const lines: string[] = [];
  if (last === null)
    lines.push(
      t(
        "occurrences.status.noneYet",
        "No round has run yet; the first one starts shortly.",
      ),
    );
  else if (last.status === "running")
    lines.push(t("occurrences.status.running", "A round is running now."));
  else {
    const ended = new Date(last.finishedAt ?? last.startedAt);
    const next = new Date(ended.getTime() + cadenceMinutes * 60_000);
    lines.push(
      last.status === "failed"
        ? t(
            "occurrences.status.lastFailed",
            "The last round, {{when}}, failed.",
            {
              when: formatRelativeTime(last.startedAt, i18n.language),
            },
          )
        : t(
            "occurrences.status.lastOk",
            "The last round, {{when}}, finished.",
            {
              when: formatRelativeTime(last.startedAt, i18n.language),
            },
          ),
    );
    // What went wrong, in words: the first step that did not complete, and how many more did.
    const [first, ...more] = last.steps.skipped;
    if (first)
      lines.push(
        t(
          "occurrences.detail.notCompleted",
          "{{step}} did not complete: {{reason}}.",
          {
            step: stepName(t, first.step),
            reason: skipReasonText(t, first.reason as SkipReason, first.inbox),
          },
        ) +
          (more.length > 0
            ? ` ${t("occurrences.status.moreSkipped", "{{count}} more steps did not complete.", { count: more.length })}`
            : ""),
      );
    lines.push(
      next.getTime() <= Date.now()
        ? t("occurrences.status.nextDue", "The next round is due now.")
        : t(
            "occurrences.status.next",
            "The next round is expected around {{time}}.",
            {
              time: time(next),
            },
          ),
    );
  }

  const trouble =
    last !== null &&
    (last.status === "failed" || last.steps.skipped.length > 0);
  return (
    <div
      className={`flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg p-3 text-sm ${
        trouble
          ? "bg-warning-soft text-text-primary"
          : "bg-bg-secondary text-text-secondary"
      }`}
      data-testid="occurrences-status"
    >
      <span>{lines.join(" ")}</span>
      {last !== null && onShowRounds && (
        <button
          type="button"
          className="text-accent font-medium"
          onClick={onShowRounds}
        >
          {t("occurrences.status.seeRounds", "See the rounds")}
        </button>
      )}
    </div>
  );
}
