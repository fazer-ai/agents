import { ChevronDown, ChevronRight, ListChecks } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import type { TrailEntry } from "./conversationTimeline";
import {
  actionSummary,
  type DecisionTickView,
  type ProbabilityRow,
  percent,
  type QuestionView,
  questionViews,
  type RuleView,
  ruleViews,
} from "./decisionTick";

// One decision tick of a "Questions and rules" observer on the conversation timeline (agents#1401).
// Collapsed it says what the tick did; expanded it shows every question's answer with its
// probabilities and every rule's outcome, so an operator can tell a choice at 51% under a 60%
// threshold from a question nobody asked without reading the logs.
export function DecisionTickMarker({ entry }: { entry: TrailEntry }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const tick = entry.decision;
  if (!tick) return null;
  const failed = tick.outcome === "failed";
  const skipped = tick.outcome === "skipped";
  const duration =
    entry.durationMs != null && entry.durationMs >= 0
      ? entry.durationMs < 1000
        ? `${entry.durationMs}ms`
        : `${(entry.durationMs / 1000).toFixed(1)}s`
      : null;
  const model = tick.modelVersion ?? tick.model;
  const label = failed
    ? t("conversation.trail.decision.failed", "Classification failed")
    : skipped
      ? t("conversation.trail.decision.skipped", "Classification skipped")
      : t("conversation.trail.decision.classified", "Classified");
  const why = failed || skipped ? whyText(tick, t) : null;
  const summary = failed || skipped ? null : summaryText(tick, t);
  const hasDetails = tick.answers !== null || tick.actions.length > 0;

  const line = (
    <div
      className="flex flex-wrap items-center justify-center gap-1.5 text-text-muted text-xs"
      data-testid="decision-marker"
    >
      {hasDetails &&
        (expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden="true" />
        ))}
      <ListChecks className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span>{label}</span>
      {model && (
        <>
          <span aria-hidden="true">·</span>
          <span>{model}</span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span
        className={cn(
          failed ? "text-error" : skipped ? "text-text-muted" : "text-success",
        )}
      >
        {failed ? "✗" : skipped ? "–" : "✓"}
      </span>
      {duration && (
        <>
          <span aria-hidden="true">·</span>
          <span>{duration}</span>
        </>
      )}
      {summary && (
        <>
          <span aria-hidden="true">·</span>
          <span>{summary}</span>
        </>
      )}
    </div>
  );
  const reasonLine = why && (
    <span
      className={cn(
        "max-w-md text-center text-xs",
        failed ? "text-error" : "text-text-muted",
      )}
    >
      {why}
    </span>
  );

  if (!hasDetails) {
    return (
      <div className="flex flex-col items-center gap-1">
        {line}
        {reasonLine}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="rounded px-1 py-0.5 hover:bg-bg-tertiary"
      >
        {line}
      </button>
      {reasonLine}
      {expanded && (
        <div className="w-full max-w-xl">
          <DecisionTickDetails tick={tick} />
        </div>
      )}
    </div>
  );
}

type T = ReturnType<typeof useTranslation>["t"];

function summaryText(tick: DecisionTickView, t: T): string {
  if (tick.actions.length === 0) {
    return t("conversation.trail.decision.noRuleFired", "no rule fired");
  }
  const s = actionSummary(tick);
  const parts: string[] = [];
  if (s.labels > 0) {
    parts.push(
      t("conversation.trail.decision.labels", "{{count}} labels", {
        count: s.labels,
      }),
    );
  }
  if (s.attributes > 0) {
    parts.push(
      t("conversation.trail.decision.attributes", "{{count}} attributes", {
        count: s.attributes,
      }),
    );
  }
  if (s.notes > 0) {
    parts.push(
      t("conversation.trail.decision.notes", "{{count}} notes", {
        count: s.notes,
      }),
    );
  }
  if (s.tools > 0) {
    parts.push(
      t("conversation.trail.decision.tools", "{{count}} tools", {
        count: s.tools,
      }),
    );
  }
  if (s.handedOff) {
    parts.push(t("conversation.trail.decision.handedOff", "handed off"));
  }
  return parts.length > 0
    ? parts.join(", ")
    : t("conversation.trail.decision.noActionRan", "no action ran");
}

// Why a tick did not decide, in the screen's words for the reasons the engine writes, and the raw
// code for one this build does not know.
function whyText(tick: DecisionTickView, t: T): string {
  if (tick.skipped === "decisions_config_invalid") {
    return tick.problem
      ? t(
          "conversation.trail.decision.configInvalidAt",
          "The questions and rules are not valid: {{problem}}",
          { problem: tick.problem },
        )
      : t(
          "conversation.trail.decision.configInvalid",
          "The questions and rules are not valid",
        );
  }
  if (tick.skipped === "decisions_credential_unresolved") {
    return t(
      "conversation.trail.decision.credentialUnresolved",
      "The classifier's credential could not be read from the vault",
    );
  }
  if (tick.failed === "decision_call") {
    return tick.failure
      ? t(
          "conversation.trail.decision.callFailedWith",
          "The call to the classifier failed: {{failure}}",
          { failure: tick.failure },
        )
      : t(
          "conversation.trail.decision.callFailed",
          "The call to the classifier failed",
        );
  }
  if (tick.failed === "decision_actions") {
    return t(
      "conversation.trail.decision.actionsUnfinished",
      "The rules' actions did not finish",
    );
  }
  if (tick.skipped === "no_customer_message") {
    return t(
      "conversation.trail.decision.noCustomerMessage",
      "No customer message to read yet",
    );
  }
  const code = tick.skipped ?? tick.failed ?? tick.failure;
  return code
    ? t("conversation.trail.decision.otherReason", "Reason: {{code}}", {
        code,
      })
    : t("conversation.trail.decision.noReason", "No reason recorded");
}

export function DecisionTickDetails({ tick }: { tick: DecisionTickView }) {
  const { t } = useTranslation();
  const questions = questionViews(tick);
  const rules = ruleViews(tick);
  return (
    <div
      className="flex flex-col gap-2 rounded border border-border bg-bg-secondary p-2 text-left text-xs"
      data-testid="decision-details"
    >
      {questions.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="font-medium text-[10px] text-text-muted uppercase tracking-wider">
            {t("conversation.trail.decision.questions", "Questions")}
          </span>
          {questions.map((q) => (
            <QuestionBlock key={q.name} q={q} />
          ))}
        </div>
      )}
      {rules.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-[10px] text-text-muted uppercase tracking-wider">
            {t("conversation.trail.decision.rules", "Rules")}
          </span>
          {rules.map((r) => (
            <RuleRow key={r.rule} r={r} tick={tick} />
          ))}
        </div>
      )}
    </div>
  );
}

function QuestionBlock({ q }: { q: QuestionView }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex flex-col gap-1"
      data-testid={`decision-question-${q.name}`}
    >
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className="font-medium font-mono text-text-primary">
          {q.name}
        </span>
        {q.kind === "unanswered" && (
          <span className="text-text-muted">
            {t("conversation.trail.decision.unanswered", "not answered")}
          </span>
        )}
        {q.kind === "refusal" && (
          <span className="text-text-muted">
            {t(
              "conversation.trail.decision.refusal",
              "the classifier declined to answer",
            )}
          </span>
        )}
        {q.kind === "yes_no" && (
          <span className="text-text-secondary">
            {t("conversation.trail.decision.yesProbability", "yes: {{p}}", {
              p: percent(q.probability),
            })}
          </span>
        )}
        {q.kind === "score" && (
          <span className="text-text-secondary">
            {t(
              "conversation.trail.decision.scoreLevel",
              "level {{level}}{{name}} (score {{score}})",
              {
                level: q.level,
                name: q.levelName ? ` · ${q.levelName}` : "",
                score: q.score.toFixed(2),
              },
            )}
          </span>
        )}
        {(q.kind === "choice" || q.kind === "score") &&
          q.confidence !== null && (
            <span className="text-text-muted">
              {t("conversation.trail.decision.confidence", "confidence {{p}}", {
                p: percent(q.confidence),
              })}
            </span>
          )}
      </div>
      {q.kind === "yes_no" && (
        <>
          <Bar p={q.probability} chosen />
          {q.thresholds.length > 0 && (
            <span className="text-text-muted">
              {q.thresholds
                .map((th) =>
                  t(
                    "conversation.trail.decision.ruleThreshold",
                    "Rule {{n}} asks at least {{p}}",
                    { n: th.rule + 1, p: percent(th.minProbability) },
                  ),
                )
                .join(" · ")}
            </span>
          )}
        </>
      )}
      {(q.kind === "choice" || q.kind === "score") &&
        q.rows.map((row) => <ProbabilityLine key={row.value} row={row} />)}
    </div>
  );
}

function ProbabilityLine({ row }: { row: ProbabilityRow }) {
  const { t } = useTranslation();
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)_6rem_2.5rem] items-center gap-2"
      data-testid="decision-option"
      data-chosen={row.chosen ? "true" : "false"}
    >
      <span className="min-w-0 truncate">
        <span
          className={cn(
            "font-mono",
            row.chosen
              ? "font-semibold text-text-primary"
              : "text-text-secondary",
          )}
        >
          {row.value}
        </span>
        {row.chosen && (
          <span className="ml-1 text-accent">
            {t("conversation.trail.decision.chosen", "chosen")}
          </span>
        )}
        {row.description && (
          <span className="ml-1 text-text-muted">{row.description}</span>
        )}
      </span>
      {row.probability === null ? (
        <span />
      ) : (
        <Bar p={row.probability} chosen={row.chosen} />
      )}
      <span className="text-right tabular-nums">
        {row.probability === null ? "—" : percent(row.probability)}
      </span>
    </div>
  );
}

function Bar({ p, chosen }: { p: number; chosen: boolean }) {
  const width = `${Math.max(0, Math.min(100, Math.round(p * 100)))}%`;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-bg-tertiary">
      <div
        className={cn("h-full", chosen ? "bg-accent-solid" : "bg-text-muted")}
        style={{ width }}
      />
    </div>
  );
}

function RuleRow({ r, tick }: { r: RuleView; tick: DecisionTickView }) {
  const { t } = useTranslation();
  const n = r.rule + 1;
  const tool =
    r.kind === "fired" ? r.tool : (tick.block?.rules[r.rule]?.tool ?? null);
  return (
    <div
      className="flex flex-wrap items-baseline gap-1.5"
      data-testid="decision-rule"
    >
      <span className="font-medium text-text-primary">
        {t("conversation.trail.decision.ruleN", "Rule {{n}}", { n })}
      </span>
      {tool && <span className="font-mono text-text-secondary">{tool}</span>}
      <span
        className={cn(
          r.kind === "fired" && r.outcome === "ran"
            ? "text-success"
            : r.kind === "fired"
              ? "text-error"
              : "text-text-muted",
        )}
      >
        {ruleText(r, tick, t)}
      </span>
    </div>
  );
}

function ruleText(r: RuleView, tick: DecisionTickView, t: T): string {
  if (r.kind === "unknown") {
    return t("conversation.trail.decision.noOutcome", "no outcome recorded");
  }
  if (r.kind === "held") {
    const trigger =
      r.trigger === "once"
        ? t("editor.decisionsTriggerOnce", "Once per conversation")
        : r.trigger === "on_start"
          ? t(
              "editor.decisionsTriggerOnStart",
              "When the conditions start holding",
            )
          : (r.trigger ?? "");
    return t(
      "conversation.trail.decision.held",
      "conditions held, but it already acted ({{trigger}})",
      { trigger },
    );
  }
  if (r.kind === "fired") {
    const outcome = firedText(r, t);
    return r.sameAs !== null
      ? t(
          "conversation.trail.decision.sameAs",
          "fired, same action as rule {{n}}: {{outcome}}",
          { n: r.sameAs + 1, outcome },
        )
      : t("conversation.trail.decision.fired", "fired: {{outcome}}", {
          outcome,
        });
  }
  return missText(r.miss, tick, t);
}

function firedText(r: Extract<RuleView, { kind: "fired" }>, t: T): string {
  switch (r.outcome) {
    case "ran":
      return r.partial
        ? t("conversation.trail.decision.ranPartial", "ran, in part")
        : t("conversation.trail.decision.ran", "ran");
    case "refused":
      return r.fence === "protected_label"
        ? t(
            "conversation.trail.decision.refusedProtected",
            "refused by a protected label",
          )
        : r.fence === "allowed_labels"
          ? t(
              "conversation.trail.decision.refusedAllowed",
              "refused by the allowed labels",
            )
          : r.fence === "precondition"
            ? t(
                "conversation.trail.decision.refusedPrecondition",
                "refused by the tool's condition",
              )
            : t("conversation.trail.decision.refused", "refused");
    case "not_granted":
      return t(
        "conversation.trail.decision.notGranted",
        "not allowed for this agent",
      );
    case "over_budget":
      return t(
        "conversation.trail.decision.overBudget",
        "over the tool call limit",
      );
    case "no_effect":
      return t(
        "conversation.trail.decision.noEffect",
        "nothing to write it on",
      );
    case "failed":
      return r.failure
        ? t("conversation.trail.decision.failedWith", "failed ({{failure}})", {
            failure: r.failure,
          })
        : t("conversation.trail.decision.failedPlain", "failed");
    default:
      return r.outcome;
  }
}

function missText(
  miss: Record<string, unknown>,
  tick: DecisionTickView,
  t: T,
): string {
  const question = typeof miss.question === "string" ? miss.question : "";
  const n = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  if (miss.why === "below_threshold") {
    const got = n(miss.got);
    const threshold = n(miss.threshold);
    const measure =
      miss.measure === "confidence"
        ? t("conversation.trail.decision.measureConfidence", "confidence")
        : t("conversation.trail.decision.measureProbability", "probability");
    return t(
      "conversation.trail.decision.belowThreshold",
      "not fired: {{question}} {{measure}} {{got}} is below {{threshold}}",
      {
        question,
        measure,
        got: got === null ? "—" : percent(got),
        threshold: threshold === null ? "—" : percent(threshold),
      },
    );
  }
  if (miss.why === "other_choice") {
    return t(
      "conversation.trail.decision.otherChoice",
      "not fired: {{question}} answered {{got}}, the rule expects {{expected}}",
      {
        question,
        got: String(miss.got ?? ""),
        expected: String(miss.expected ?? ""),
      },
    );
  }
  if (miss.why === "outside_levels") {
    const levels =
      tick.block?.questions.find((q) => q.name === question)?.type === "score"
        ? (
            tick.block.questions.find((q) => q.name === question) as {
              levels: { value: string }[];
            }
          ).levels
        : null;
    const name = (i: number | null) =>
      i !== null && levels?.[i] ? ` (${levels[i]?.value})` : "";
    const got = n(miss.got);
    const min = n(miss.minLevel);
    const max = n(miss.maxLevel);
    return t(
      "conversation.trail.decision.outsideLevels",
      "not fired: {{question}} reached level {{got}}, the rule asks {{min}} to {{max}}",
      {
        question,
        got: `${got ?? "—"}${name(got)}`,
        min: `${min ?? "—"}${name(min)}`,
        max: `${max ?? "—"}${name(max)}`,
      },
    );
  }
  if (miss.why === "unanswered") {
    return t(
      "conversation.trail.decision.missUnanswered",
      "not fired: {{question}} was not answered",
      { question },
    );
  }
  if (miss.why === "refused") {
    return t(
      "conversation.trail.decision.missRefused",
      "not fired: the classifier declined to answer {{question}}",
      { question },
    );
  }
  return t("conversation.trail.decision.notFired", "not fired");
}
