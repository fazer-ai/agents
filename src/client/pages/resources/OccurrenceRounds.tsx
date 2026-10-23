import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Card, HelpPopover } from "@/client/components";
import { api } from "@/client/lib/api";
import { OccurrencePager } from "./OccurrencePager";
import { type SkipReason, skipReasonText, stepName } from "./occurrenceWords";

type RunsPage = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.occurrences.runs.get>>["data"]
>;
type Run = RunsPage["runs"][number];
type Cost = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.occurrences.cost.get>>["data"]
>;

// Rounds shown per page.
export const ROUNDS_PAGE = 20;
// While the monitor is on and its newest round has not finished (or none ran yet), the first page is
// read again this often, so the first round shows up without a reload; otherwise, while the tab is
// open, every minute.
const WATCH_MS = 5_000;
const IDLE_MS = 60_000;

// The monitor's rounds, newest first, a page at a time, with what the monitor cost over the last 7
// and 30 days above them. Pages are keyed on the last round shown (`nextBefore`), so a round that
// starts while the operator reads never pushes a row onto the next page.
export function OccurrenceRounds({
  monitorOn,
  active,
  reloadKey,
  watchMs = WATCH_MS,
}: {
  monitorOn: boolean;
  active: boolean;
  // Bumped by the page after a save, so a monitor just switched on is watched at once.
  reloadKey: number;
  // How often a watched first page is read again; shortened only by tests.
  watchMs?: number;
}) {
  const { t, i18n } = useTranslation();
  // The cursor of each page shown so far: [null] is the first page.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState<RunsPage | null>(null);
  // The cursor the page on screen was read for: while it differs from the one asked for, the next
  // page is on its way and the pager waits for it.
  const [pageFor, setPageFor] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [cost, setCost] = useState<Cost | null>(null);
  const [costFailed, setCostFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const seq = useRef(0);
  const cursor = cursors[cursors.length - 1] ?? null;

  const load = useCallback(async (before: string | null) => {
    const mine = ++seq.current;
    const [res, costRes] = await Promise.all([
      api.api.v1.occurrences.runs.get({
        query: {
          limit: ROUNDS_PAGE,
          ...(before === null ? {} : { before }),
        },
      }),
      api.api.v1.occurrences.cost.get(),
    ]);
    if (mine !== seq.current) return;
    // A failed cost read drops the totals instead of leaving older ones labeled as the last 7 and
    // 30 days; the rounds stay usable either way.
    const costOk = !costRes.error && !!costRes.data;
    setCost(costOk ? costRes.data : null);
    setCostFailed(!costOk);
    if (res.error || !res.data) {
      setFailed(true);
      return;
    }
    setFailed(false);
    setPage(res.data);
    setPageFor(before);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey is the trigger itself.
  useEffect(() => {
    void load(cursor);
  }, [load, cursor, reloadKey]);

  const newest = page?.runs[0];
  const watching =
    monitorOn &&
    cursor === null &&
    (page === null || page.total === 0 || newest?.status === "running");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `page` re-arms the timer after every read, so the next one is a full interval later.
  useEffect(() => {
    if (cursor !== null || failed || (!watching && !active)) return;
    const id = setTimeout(() => void load(null), watching ? watchMs : IDLE_MS);
    return () => clearTimeout(id);
  }, [watching, active, cursor, failed, load, page, watchMs]);

  const nf = new Intl.NumberFormat(i18n.language);
  const usd = new Intl.NumberFormat(i18n.language, {
    maximumFractionDigits: 6,
  });
  const msf = new Intl.NumberFormat(i18n.language, {
    style: "unit",
    unit: "second",
    maximumFractionDigits: 1,
  });
  const when = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      dateStyle: "short",
      timeStyle: "short",
    });
  const money = (c: number | null, calls: number) =>
    c === null
      ? calls > 0
        ? t("occurrences.costNoPrice", "No price")
        : "—"
      : `US$ ${usd.format(c)}`;
  const statusText = (s: string) =>
    s === "ok"
      ? t("occurrences.runDone", "Done")
      : s === "failed"
        ? t("occurrences.runFailedWord", "Failed")
        : t("occurrences.runRunningWord", "Running");

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium text-text-primary">
            {t("occurrences.runsTitle", "Rounds")}
          </h2>
          <p className="text-text-muted text-xs">
            {t(
              "occurrences.runsIntro",
              "Newest first, {{size}} per page. Open a round to see what each step did.",
              { size: ROUNDS_PAGE },
            )}
          </p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => load(cursor)}>
          {t("common.refresh", "Refresh")}
        </Button>
      </div>

      {costFailed && (
        <p role="alert" className="text-sm text-text-muted">
          {t("occurrences.costError", "Could not read the cost.")}
        </p>
      )}

      {cost && (
        <dl className="grid gap-2 sm:grid-cols-2">
          {(
            [
              ["last7Days", t("occurrences.cost7", "Cost, last 7 days")],
              ["last30Days", t("occurrences.cost30", "Cost, last 30 days")],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="rounded-lg border border-border p-3">
              <dt className="text-text-muted text-xs">{label}</dt>
              <dd className="font-medium text-text-primary">
                {money(cost[k].costUsd, cost[k].calls)}
              </dd>
              <dd className="text-text-muted text-xs">
                {t("occurrences.costCalls", "{{count}} model calls", {
                  count: cost[k].calls,
                })}
                {cost[k].costUsd !== null &&
                  cost[k].unpricedCalls > 0 &&
                  ` · ${t(
                    "occurrences.costUnpriced",
                    "{{count}} calls with no price left out",
                    { count: cost[k].unpricedCalls },
                  )}`}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {failed ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
          <span role="alert">
            {t("occurrences.runsError", "Could not read the rounds.")}
          </span>
          <Button size="sm" variant="secondary" onClick={() => load(cursor)}>
            {t("common.retry", "Retry")}
          </Button>
          {/* A later page that cannot be read still leads back to the newer rounds. */}
          {cursors.length > 1 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setCursors((c) => c.slice(0, -1))}
            >
              {t("occurrences.pager.previous", "Previous")}
            </Button>
          )}
        </div>
      ) : page === null ? null : page.runs.length === 0 ? (
        <p className="text-sm text-text-muted">
          {monitorOn
            ? t(
                "occurrences.runsWaiting",
                "No round has run yet. The first one starts shortly after the monitor is switched on and shows up here by itself.",
              )
            : t("occurrences.runsEmpty", "No round has run yet.")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-text-muted text-xs">
              <tr>
                <th className="py-1 pr-3 font-medium">
                  {t("occurrences.runStarted", "Started")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("occurrences.runStatus", "Result")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("occurrences.runDuration", "Duration")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("occurrences.runRead", "Conversations read")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("occurrences.runWaiting", "Still waiting")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("occurrences.runModelCalls", "Model calls")}
                </th>
                <th className="py-1 pr-3 font-medium">
                  {t("occurrences.runCost", "Cost")}
                </th>
              </tr>
            </thead>
            <tbody>
              {page.runs.map((r) => (
                <Fragment key={r.id}>
                  <tr className="border-border border-t align-top">
                    <td className="py-1 pr-3">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-left"
                        aria-expanded={open === r.id}
                        onClick={() => setOpen(open === r.id ? null : r.id)}
                      >
                        {open === r.id ? (
                          <ChevronDown className="h-4 w-4" aria-hidden="true" />
                        ) : (
                          <ChevronRight
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                        )}
                        {when(r.startedAt)}
                      </button>
                    </td>
                    <td className="py-1 pr-3">
                      {statusText(r.status)}
                      {/* Why it stopped, said in the list in the screen's words; the server's own
                          text is a popover away. */}
                      {r.error && (
                        <span className="flex items-center gap-1 text-text-muted text-xs">
                          {t(
                            "occurrences.detail.stopped",
                            "The round stopped before finishing.",
                          )}
                          <HelpPopover
                            content={r.error}
                            label={t("occurrences.detail.details", "Details")}
                          />
                        </span>
                      )}
                    </td>
                    <td className="py-1 pr-3">
                      {r.durationMs === null
                        ? "—"
                        : msf.format(r.durationMs / 1000)}
                    </td>
                    <td className="py-1 pr-3">
                      {r.steps.reading ? nf.format(r.steps.reading.read) : "—"}
                    </td>
                    <td className="py-1 pr-3">
                      {r.steps.reading
                        ? nf.format(r.steps.reading.pending)
                        : "—"}
                    </td>
                    <td className="py-1 pr-3">{nf.format(r.modelCalls)}</td>
                    <td className="py-1 pr-3">
                      {money(r.costUsd, r.modelCalls)}
                      {r.costUsd !== null && r.unpricedCalls > 0 && (
                        <span className="block text-text-muted text-xs">
                          {t(
                            "occurrences.costUnpriced",
                            "{{count}} calls with no price left out",
                            { count: r.unpricedCalls },
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={7} className="pb-3 pl-6">
                        <RunDetail run={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {page && page.runs.length > 0 && pageFor === cursor && (
        <OccurrencePager
          label={t("occurrences.runsPages", "Round pages")}
          first={(cursors.length - 1) * ROUNDS_PAGE + 1}
          shown={page.runs.length}
          total={page.total}
          onPrevious={
            cursors.length > 1 ? () => setCursors((c) => c.slice(0, -1)) : null
          }
          onNext={() => {
            const next = page.nextBefore;
            if (next !== null) setCursors((c) => [...c, next]);
          }}
          hasNext={page.nextBefore !== null}
        />
      )}
    </Card>
  );
}

// A step's main counts always, its secondary ones only when not zero, so a quiet round reads as one
// short line per step; what a count means, when it is not obvious, is in a popover beside it.
function RunDetail({ run }: { run: Run }) {
  const { t } = useTranslation();
  const s = run.steps;
  const lines: { key: string; text: string; help?: string }[] = [];
  // "<step>: <what it did>." Both halves arrive translated; only the punctuation is put here.
  const add = (
    key: string,
    step: string,
    parts: (string | false)[],
    help?: string,
  ) =>
    lines.push({
      key,
      text: `${step}: ${parts.filter((p): p is string => p !== false).join(", ")}.`,
      ...(help ? { help } : {}),
    });
  if (s.reading) {
    const r = s.reading;
    add(
      "reading",
      stepName(t, "reading"),
      [
        t("occurrences.detail.read", "{{count}} conversations read", {
          count: r.read,
        }),
        r.failed > 0 &&
          t("occurrences.detail.failed", "{{count}} failed", {
            count: r.failed,
          }),
        r.withdrawn > 0 &&
          t("occurrences.detail.dropped", "{{count}} dropped after reading", {
            count: r.withdrawn,
          }),
        r.pending > 0 &&
          t("occurrences.detail.pending", "{{count}} left for the next round", {
            count: r.pending,
          }),
      ],
      r.withdrawn > 0
        ? t(
            "occurrences.detail.droppedHelp",
            "A reading is dropped when the conversation is reset while it is read, or when the round runs out of time before saving it. The conversation is read again in a later round.",
          )
        : undefined,
    );
  }
  if (s.canonical) {
    const c = s.canonical;
    add("canonical", stepName(t, "canonical"), [
      t("occurrences.detail.created", "{{count}} new names", {
        count: c.created,
      }),
      c.asked > 0 &&
        t(
          "occurrences.detail.referencesSent",
          "{{count}} references sent to the model",
          { count: c.asked },
        ),
      c.copied > 0 &&
        t(
          "occurrences.detail.copied",
          "{{count}} written to the conversation in Chatwoot",
          { count: c.copied },
        ),
    ]);
  }
  if (s.assignment) {
    const a = s.assignment;
    add("assignment", stepName(t, "assignment"), [
      t("occurrences.detail.placed", "{{count}} placed in a theme", {
        count: a.assigned,
      }),
      a.sent > 0 &&
        t(
          "occurrences.detail.reasonsSent",
          "{{count}} reasons sent to the model",
          { count: a.sent },
        ),
      a.newThemes > 0 &&
        t("occurrences.detail.newThemes", "{{count}} new themes", {
          count: a.newThemes,
        }),
      a.removed > 0 &&
        t(
          "occurrences.detail.removed",
          "{{count}} conversations left their theme",
          { count: a.removed },
        ),
    ]);
  }
  if (s.consolidation) {
    const c = s.consolidation;
    const parts = [
      c.merges > 0 &&
        t("occurrences.detail.merges", "{{count}} themes merged", {
          count: c.merges,
        }),
      c.splits > 0 &&
        t("occurrences.detail.splits", "{{count}} themes split", {
          count: c.splits,
        }),
      c.renames > 0 &&
        t("occurrences.detail.renames", "{{count}} themes renamed", {
          count: c.renames,
        }),
      c.referenceMerges > 0 &&
        t(
          "occurrences.detail.referenceMerges",
          "{{count}} reference names merged",
          { count: c.referenceMerges },
        ),
    ];
    if (!c.completed)
      lines.push({
        key: "consolidation",
        text: t(
          "occurrences.detail.consolidationIncomplete",
          "Theme consolidation did not finish; the next round tries again.",
        ),
      });
    else if (parts.some((p) => p !== false))
      add("consolidation", stepName(t, "consolidation"), parts);
    else
      lines.push({
        key: "consolidation",
        text: t(
          "occurrences.detail.consolidationNoChange",
          "Theme consolidation found nothing to change.",
        ),
      });
  }
  // Only a round that finished says it was not due: one that stopped earlier never got there.
  else if (s.reading && run.status === "ok")
    lines.push({
      key: "consolidation",
      text: t(
        "occurrences.detail.consolidationNotDue",
        "Theme consolidation was not due this round.",
      ),
    });
  if (s.flags)
    lines.push({
      key: "flags",
      text: t("occurrences.detail.flagged", "{{count}} themes flagged.", {
        count: s.flags.flagged,
      }),
    });
  s.skipped.forEach((k, i) => {
    lines.push({
      key: `skipped-${i}`,
      text:
        t(
          "occurrences.detail.notCompleted",
          "{{step}} did not complete: {{reason}}.",
          {
            step: stepName(t, k.step),
            reason: skipReasonText(t, k.reason as SkipReason, k.inbox),
          },
        ) +
        (k.count > 1
          ? ` ${t("occurrences.detail.times", "({{count}} times)", { count: k.count })}`
          : ""),
      // The provider's own words, for whoever needs them, never as the sentence itself.
      ...(k.message ? { help: k.message } : {}),
    });
  });
  if (run.error)
    lines.push({
      key: "error",
      text: t(
        "occurrences.detail.stopped",
        "The round stopped before finishing.",
      ),
      help: run.error,
    });
  if (lines.length === 0)
    lines.push({
      key: "none",
      text: t(
        "occurrences.detail.none",
        "No step detail for this round: it stopped before reading, or ran before the monitor recorded one.",
      ),
    });
  return (
    <ul className="flex list-disc flex-col gap-1 pl-4 text-sm text-text-secondary">
      {lines.map((l) => (
        <li key={l.key}>
          <span className="inline-flex flex-wrap items-center gap-1">
            {l.text}
            {l.help && (
              <HelpPopover
                content={l.help}
                label={t("occurrences.detail.details", "Details")}
              />
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
