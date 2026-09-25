import { Gauge } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Popover } from "@/client/components/Popover";
import { cn } from "@/client/lib/utils";
import { PRICE_TABLE_READ_AT } from "@/modules/pricing/version";

// The provider's numbers for one or more model calls: the shape `TurnUsage` has on the server, as the
// playground turn and the conversation screen both receive it.
export type TokenUsage = {
  calls: number;
  promptTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  completionTokens: number;
  // Calls by the step that made them, keyed by the ledger's node.
  byNode: Record<string, number>;
  // USD over the calls the price table could price, and how many it could not (issue #863).
  costUsd: number;
  unpricedCalls: number;
};

// How long a turn took and how much of that was spent waiting on a model. Either can be unknown: the
// conversation screen reads them from what the turn recorded, and an old turn recorded neither.
export type TokenTiming = { turnMs: number | null; modelMs: number | null };

type T = (
  key: string,
  fallback: string,
  opts?: Record<string, unknown>,
) => string;

// The words for a ledger node. Static keys, so the extractor sees them; a node not listed here is
// shown as it is stored rather than dropped, since the count beside it is still true.
function nodeLabel(t: T, node: string): string {
  switch (node) {
    case "agent":
      return t("tokenUsage.node.agent", "agent");
    case "nudge":
      return t("tokenUsage.node.nudge", "proactive message");
    case "guardrail":
      return t("tokenUsage.node.guardrail", "guardrail check");
    case "tts_normalize":
      return t("tokenUsage.node.ttsNormalize", "rewrite for speech");
    case "vision":
      return t("tokenUsage.node.vision", "image or document read");
    case "memory_compact":
      return t("tokenUsage.node.memoryCompact", "memory summary");
    case "observer":
      return t("tokenUsage.node.observer", "observer");
    default:
      return node;
  }
}

// The one figure always on screen: the input tokens, which is what a longer history, a bigger prompt
// or a new tool schema moves. Compact, because it sits at the foot of a message.
export function usageFigureText(
  t: T,
  locale: string,
  usage: TokenUsage,
): string {
  const compact = new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(usage.promptTokens);
  return t("tokenUsage.figure", "{{input}} input tokens", { input: compact });
}

// Everything else, for the popover, as data: the card below lays it out, and the tests read the
// numbers without a DOM. The cached share is a part OF the input and never subtracted from it:
// `cachedReadTokens` is a discounted subset, and it is the number a prompt change can zero without
// anything else moving. A cache write (Anthropic's premium) only shows when there was one. Time only
// shows when it was measured.
//
// There is no tokens-per-second figure on purpose: the calls are not streamed, so a call's time is
// prompt processing plus generation with no first-token mark between them, and a turn with a
// guardrail blends two models. The quotient would read as a speed and compare two turns wrongly.
export interface UsageDetail {
  input: string;
  cached: string;
  // Share of the input served from the cache, 0 to 100.
  cachedPct: number;
  cacheWrite: string | null;
  output: string;
  calls: number;
  steps: { node: string; label: string; calls: number }[];
  turn: string | null;
  model: string | null;
  // Share of the turn's time spent waiting on a model, 0 to 100; null unless both are known.
  modelPct: number | null;
  // The priced calls' cost, formatted; null when no call could be priced, which is never shown as
  // a zero. `unpriced` is how many calls the figure leaves out.
  cost: string | null;
  unpriced: number;
  // The day the price table was read, so a reader can tell how old the rates behind the figure are.
  priceTableDate: string;
}

// Dollars to the precision a turn needs: a turn costs fractions of a cent, and "$0.00" would read as
// free. Cents once it is a dollar or more.
export function formatUsd(locale: string, v: number): string {
  const digits = v >= 1 ? 2 : v >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(v);
}

export function usageDetail(
  t: T,
  locale: string,
  usage: TokenUsage,
  timing?: TokenTiming,
): UsageDetail {
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const sec = (ms: number) =>
    new Intl.NumberFormat(locale, {
      style: "unit",
      unit: "second",
      unitDisplay: "narrow",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(ms / 1000);
  const turnMs = timing?.turnMs ?? null;
  const modelMs = timing?.modelMs ?? null;
  return {
    input: n(usage.promptTokens),
    cached: n(usage.cachedReadTokens),
    cachedPct:
      usage.promptTokens > 0
        ? Math.round((usage.cachedReadTokens / usage.promptTokens) * 100)
        : 0,
    cacheWrite:
      usage.cacheCreationTokens > 0 ? n(usage.cacheCreationTokens) : null,
    output: n(usage.completionTokens),
    calls: usage.calls,
    steps: Object.entries(usage.byNode)
      .filter(([, c]) => c > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([node, c]) => ({ node, label: nodeLabel(t, node), calls: c })),
    turn: turnMs != null ? sec(turnMs) : null,
    model: modelMs != null ? sec(modelMs) : null,
    modelPct:
      turnMs != null && modelMs != null && turnMs > 0
        ? Math.min(100, Math.round((modelMs / turnMs) * 100))
        : null,
    cost:
      usage.calls > usage.unpricedCalls
        ? formatUsd(locale, usage.costUsd)
        : null,
    unpriced: usage.unpricedCalls,
    // Noon UTC, so the calendar day is the same in every timezone the console runs in.
    priceTableDate: new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
    }).format(new Date(`${PRICE_TABLE_READ_AT}T12:00:00Z`)),
  };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text-primary tabular-nums">
        {value}
      </span>
    </div>
  );
}

// A thin share bar: how much of the whole the part is, with the words under it.
function Share({ pct, label }: { pct: number; label: string }) {
  return (
    <div className="space-y-1">
      <div
        className="h-1 overflow-hidden rounded-full bg-bg-tertiary"
        role="img"
        aria-label={label}
      >
        <div
          className="h-full rounded-full bg-accent"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[11px] text-text-muted">{label}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h4 className="font-semibold text-[10px] text-text-muted uppercase tracking-wider">
        {title}
      </h4>
      {children}
    </section>
  );
}

function UsageDetailCard({ title, d }: { title: string; d: UsageDetail }) {
  const { t } = useTranslation();
  return (
    <div className="w-64 space-y-3 text-xs" data-testid="token-usage-detail">
      <p className="flex items-center gap-1.5 font-semibold text-sm text-text-primary">
        <Gauge className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
        {title}
      </p>
      <Section title={t("tokenUsage.tokens", "Tokens used")}>
        <Row label={t("tokenUsage.inputLabel", "Input")} value={d.input} />
        <Share
          pct={d.cachedPct}
          label={t(
            "tokenUsage.cachedShare",
            "{{cached}} from cache ({{pct}}%)",
            {
              cached: d.cached,
              pct: d.cachedPct,
            },
          )}
        />
        {d.cacheWrite && (
          <Row
            label={t("tokenUsage.cacheWriteLabel", "Cache write")}
            value={d.cacheWrite}
          />
        )}
        <Row label={t("tokenUsage.outputLabel", "Output")} value={d.output} />
      </Section>
      <div className="border-border border-t" />
      <Section
        title={t("tokenUsage.callsTitle", "{{count}} model calls", {
          count: d.calls,
        })}
      >
        <div className="flex flex-wrap gap-1">
          {d.steps.map((s) => (
            <span
              key={s.node}
              className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[11px] text-text-secondary"
            >
              {s.label}
              <span className="ml-1 font-medium text-text-primary tabular-nums">
                {t("tokenUsage.stepCalls", "{{count}} calls", {
                  count: s.calls,
                })}
              </span>
            </span>
          ))}
        </div>
      </Section>
      <div className="border-border border-t" />
      <Section title={t("tokenUsage.costTitle", "Cost")}>
        <Row
          label={t("tokenUsage.costLabel", "Model calls")}
          value={d.cost ?? t("tokenUsage.noPrice", "no price")}
        />
        {d.cost !== null && d.unpriced > 0 && (
          <p className="text-[11px] text-warning">
            {t(
              "tokenUsage.unpricedCalls",
              "{{count}} calls with no price are not in it",
              { count: d.unpriced },
            )}
          </p>
        )}
        <p className="text-[11px] text-text-muted">
          {t(
            "tokenUsage.costSource",
            "Estimated from the price table of {{date}}; may differ slightly from the dashboard",
            { date: d.priceTableDate },
          )}
        </p>
      </Section>
      {(d.turn || d.model) && (
        <>
          <div className="border-border border-t" />
          <Section title={t("tokenUsage.timeTitle", "Time")}>
            {d.turn && (
              <Row label={t("tokenUsage.turnLabel", "Turn")} value={d.turn} />
            )}
            {d.model && (
              <Row
                label={t("tokenUsage.modelLabel", "Model")}
                value={d.model}
              />
            )}
            {d.modelPct != null && (
              <Share
                pct={d.modelPct}
                label={t(
                  "tokenUsage.modelShare",
                  "{{pct}}% of the turn waiting on the model",
                  { pct: d.modelPct },
                )}
              />
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// A turn's usage (or a total's) as the input tokens, with the rest one hover or tap away. The
// console's `Popover` and not a tooltip: a Radix tooltip has no route in on touch (Popover.tsx), and
// this is read by an attendant on a phone as much as at a desk. Nothing renders for no call at all: a
// zero would read as a measurement.
export function UsageFigure({
  usage,
  timing,
  label,
  title,
  tone = "muted",
}: {
  usage: TokenUsage | undefined;
  timing?: TokenTiming;
  // Prefixes the figure (a total says whose it is; a turn's needs no name).
  label?: string;
  // The popover's heading; a turn's by default.
  title?: string;
  // On an accent-colored bubble the muted text color would vanish.
  tone?: "muted" | "onAccent";
}) {
  const { t, i18n } = useTranslation();
  if (!usage || usage.calls === 0) return null;
  const tt = t as T;
  const figure = usageFigureText(tt, i18n.language, usage);
  const detail = usageDetail(tt, i18n.language, usage, timing);
  return (
    <Popover
      label={t("tokenUsage.detailLabel", "Usage detail")}
      side="top"
      content={
        <UsageDetailCard
          title={title ?? t("tokenUsage.turnTitle", "This turn's usage")}
          d={detail}
        />
      }
    >
      <button
        type="button"
        data-testid="token-usage"
        className={cn(
          "inline rounded text-[11px] tabular-nums underline decoration-dotted underline-offset-2",
          {
            "text-text-muted hover:text-text-secondary": tone === "muted",
            "text-accent-foreground/70 hover:text-accent-foreground":
              tone === "onAccent",
          },
        )}
      >
        {label ? `${label}: ${figure}` : figure}
      </button>
    </Popover>
  );
}
