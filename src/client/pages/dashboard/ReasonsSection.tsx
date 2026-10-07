import { ArrowRightLeft, Tags } from "lucide-react";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/client/components";
import { api } from "@/client/lib/api";
import { Block, type BlockTable } from "./Block";
import type { ChartRow } from "./charts";
import {
  apiQuery,
  type DashboardFilters,
  daysOf,
  type Window,
} from "./filters";
import { useBlock } from "./useBlock";

const StackedBars = lazy(() =>
  import("./charts").then((m) => ({ default: m.StackedBars })),
);

// WHY CONVERSATIONS LEAVE THE AGENT, AND WHAT THEY ARE ABOUT. Handoffs by who decided (the agent,
// its silence by reason, a guardrail, a person), the agent's silences by the reason it picked, and
// volume and outcome by the conversation's labels.

export function ReasonsSection({
  filters,
  win,
}: {
  filters: DashboardFilters;
  win: Window;
}) {
  const { t, i18n } = useTranslation();
  const nf = new Intl.NumberFormat(i18n.language);
  const pf = (v: number) =>
    new Intl.NumberFormat(i18n.language, {
      style: "percent",
      maximumFractionDigits: 1,
    }).format(v);
  const query = apiQuery(filters, win);
  const handoffs = useBlock(JSON.stringify(["handoffs", query]), async () => {
    const res = await api.api.v1.metrics.handoffs.get({ query });
    return { data: res.data?.handoffs ?? null };
  });
  const labels = useBlock(JSON.stringify(["labels", query]), async () => {
    const res = await api.api.v1.metrics.labels.get({ query });
    return { data: res.data?.labels ?? null };
  });

  const causeLabel: Record<string, string> = {
    agent: t("dashboard.cause.agent", "The agent handed over"),
    skip_needs_human: t(
      "dashboard.cause.skipNeedsHuman",
      "The agent stayed silent: needs a person",
    ),
    skip_not_for_us: t(
      "dashboard.cause.skipNotForUs",
      "The agent stayed silent: not for this team",
    ),
    skip_unanswered: t(
      "dashboard.cause.skipUnanswered",
      "The agent ended without answering",
    ),
    guardrail: t("dashboard.cause.guardrail", "A guardrail stopped the reply"),
    person: t("dashboard.cause.person", "A person took over"),
  };
  const silenceLabel: Record<string, string> = {
    acknowledged: t("dashboard.silence.acknowledged", "Nothing to answer"),
    not_for_us: t("dashboard.silence.notForUs", "Not for this team"),
    needs_human: t("dashboard.silence.needsHuman", "Needs a person"),
    unrecorded: t("dashboard.silence.unrecorded", "Reason not recorded"),
  };

  const h = handoffs.data;
  const causes = [...new Set((h?.totals ?? []).map((x) => x.cause))];
  const series = causes.map((c, i) => ({
    key: `c${i}`,
    raw: c,
    label: causeLabel[c] ?? c,
  }));
  const days = daysOf(win, h?.days[0]?.date ?? null);
  const rows: ChartRow[] = days.map((day) => {
    const row: ChartRow = { day };
    for (const s of series)
      row[s.key] =
        h?.days.find((d) => d.date === day && d.cause === s.raw)
          ?.conversations ?? 0;
    return row;
  });
  const handoffTable: BlockTable = {
    name: "dashboard-handoff-causes",
    header: [t("dashboard.col.day", "Day"), ...series.map((s) => s.label)],
    rows: rows.map((r) => [r.day, ...series.map((s) => r[s.key] as number)]),
  };

  const l = labels.data;
  const labelTable: BlockTable = {
    name: "dashboard-outcome-by-label",
    header: [
      t("dashboard.col.label", "Label"),
      t("dashboard.col.conversations", "Conversations"),
      t("dashboard.col.involved", "Handled by the agent"),
      t("dashboard.col.resolution", "Resolution"),
      t("dashboard.col.handoffs", "Handoffs"),
    ],
    rows: (l?.labels ?? []).map((r) => [
      r.label,
      r.conversations,
      r.involved,
      r.resolutionRate,
      r.handoff,
    ]),
  };

  return (
    <section id="reasons" className="flex scroll-mt-4 flex-col gap-3">
      <h2 className="font-medium text-sm text-text-primary">
        {t("dashboard.reasons.title", "Why it hands over, and what people ask")}
      </h2>
      <Block
        error={handoffs.error}
        loading={handoffs.loading && !handoffs.data}
        onRetry={handoffs.reload}
        icon={ArrowRightLeft}
        title={t("dashboard.handoffs.title", "Handoffs by cause")}
        help={t(
          "dashboard.handoffs.help",
          "Conversations that left the agent each day, by who decided: the agent itself, its silence with the reason it gave, a guardrail, or a person who replied or took the conversation. A conversation counts once per cause and day. The agent's free-text reason is in the conversation's private note, not here.",
        )}
        chart
        table={handoffTable}
        footer={
          h &&
          (h.totals.length > 0 || h.silences.length > 0) && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <p className="text-text-muted text-xs">
                  {t(
                    "dashboard.handoffs.totals",
                    "Conversations in the period",
                  )}
                </p>
                <ul className="flex flex-col gap-1">
                  {h.totals.map((x) => (
                    <li
                      key={x.cause}
                      className="flex items-center justify-between gap-4 text-sm"
                    >
                      <span className="text-text-secondary">
                        {causeLabel[x.cause] ?? x.cause}
                      </span>
                      <span className="font-medium text-text-primary tabular-nums">
                        {nf.format(x.conversations)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="flex flex-col gap-1.5">
                <p className="text-text-muted text-xs">
                  {t(
                    "dashboard.handoffs.silences",
                    "Turns the agent chose not to answer, by reason",
                  )}
                </p>
                {h.silences.length === 0 ? (
                  <p className="text-sm text-text-muted">{"\u2014"}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {h.silences.map((s) => (
                      <li
                        key={s.reason}
                        className="flex items-center justify-between gap-4 text-sm"
                      >
                        <span className="text-text-secondary">
                          {silenceLabel[s.reason] ?? s.reason}
                        </span>
                        <span className="font-medium text-text-primary tabular-nums">
                          {nf.format(s.turns)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )
        }
      >
        {handoffs.loading && !h ? (
          <Skeleton className="h-56 w-full" />
        ) : series.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">
            {t("dashboard.handoffs.none", "No handoffs in this period.")}
          </p>
        ) : (
          <Suspense fallback={<Skeleton className="h-56 w-full" />}>
            <StackedBars
              data={rows}
              series={series}
              lang={i18n.language}
              format={(v) => nf.format(v)}
              height={220}
            />
          </Suspense>
        )}
      </Block>

      <Block
        error={labels.error}
        loading={labels.loading && !labels.data}
        onRetry={labels.reload}
        icon={Tags}
        title={t("dashboard.labels.title", "Outcome by label")}
        help={t(
          "dashboard.labels.help",
          "The conversations of the period grouped by their Chatwoot labels, as the last event from Chatwoot stated them. A conversation with two labels counts in both rows. Labels are recorded from the moment this version is running, so older conversations appear here after their next event.",
        )}
        table={labelTable}
      >
        {labels.loading && !l ? (
          <Skeleton className="h-24 w-full" />
        ) : !l || l.labels.length === 0 ? (
          <p className="text-sm text-text-muted">
            {t(
              "dashboard.labels.none",
              "No labelled conversations in this period.",
            )}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted text-xs">
                  {labelTable.header.map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={
                        i === 0
                          ? "py-1.5 pr-3 font-normal"
                          : "py-1.5 pl-3 text-right font-normal"
                      }
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {l.labels.map((r) => (
                  <tr key={r.label} className="border-border border-t">
                    <td className="py-1.5 pr-3 text-text-secondary">
                      {r.label}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {nf.format(r.conversations)}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {nf.format(r.involved)}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {r.resolutionRate === null
                        ? "\u2014"
                        : pf(r.resolutionRate)}
                    </td>
                    <td className="py-1.5 pl-3 text-right tabular-nums">
                      {nf.format(r.handoff)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-text-muted text-xs">
              {t(
                "dashboard.labels.unlabeled",
                "{{n}} conversations with no label",
                {
                  count: l.unlabeled,
                  n: nf.format(l.unlabeled),
                },
              )}
            </p>
          </div>
        )}
      </Block>
    </section>
  );
}
