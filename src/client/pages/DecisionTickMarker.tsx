import { ChevronDown, ChevronRight, ListChecks } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/client/lib/utils";
import type { TrailEntry } from "./conversationTimeline";
import {
  actionSummary,
  answerChanges,
  type DecisionTickView,
  type ProbabilityRow,
  percent,
  type QuestionView,
  questionViews,
  type RuleView,
  ruleGroups,
} from "./decisionTick";

// One decision tick of a "Questions and rules" observer on the conversation timeline (agents#1401).
// Collapsed it says what the tick did; expanded it shows every question's answer with its
// probabilities and every rule's outcome, so an operator can tell a choice at 51% under a 60%
// threshold from a question nobody asked without reading the logs.
export function DecisionTickMarker({
  entry,
  previous,
}: {
  entry: TrailEntry;
  // The previous decided tick of the same agent in this conversation, when there is one: the
  // collapsed marker says which answers moved since.
  previous?: DecisionTickView;
}) {
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
  const changes =
    failed || skipped || !previous ? [] : answerChanges(previous, tick);
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
      {changes.length > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="text-text-secondary" data-testid="decision-changes">
            {changes
              .map((c) => {
                const word = (w: string) =>
                  !c.yesNo
                    ? w
                    : w === "yes"
                      ? t("conversation.trail.decision.yes", "yes")
                      : t("conversation.trail.decision.no", "no");
                return `${c.question}: ${word(c.from)} → ${word(c.to)}`;
              })
              .join("; ")}
          </span>
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
        <div className="w-full">
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
  if (s.labelsAdded !== null && s.labelsRemoved !== null) {
    if (s.labelsAdded > 0) {
      parts.push(
        t("conversation.trail.decision.labelsAdded", "{{count}} labels added", {
          count: s.labelsAdded,
        }),
      );
    }
    if (s.labelsRemoved > 0) {
      parts.push(
        t(
          "conversation.trail.decision.labelsRemoved",
          "{{count}} labels removed",
          { count: s.labelsRemoved },
        ),
      );
    }
    if (s.labelsAdded === 0 && s.labelsRemoved === 0 && s.labelWrites > 0) {
      parts.push(
        t("conversation.trail.decision.labelsUnchanged", "labels unchanged"),
      );
    }
  } else if (s.labelWrites > 0) {
    parts.push(
      t("conversation.trail.decision.labelWrites", "{{count}} label writes", {
        count: s.labelWrites,
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
  const groups = ruleGroups(tick);
  const [restOpen, setRestOpen] = useState(false);
  const hasRules =
    groups.fired.length +
      groups.held.length +
      groups.near.length +
      groups.rest.length >
    0;
  return (
    <div
      className="grid gap-3 rounded border border-border bg-bg-secondary p-2 text-left text-xs lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
      data-testid="decision-details"
    >
      {questions.length > 0 && (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-[10px] text-text-muted uppercase tracking-wider">
            {t("conversation.trail.decision.questions", "Questions")}
          </span>
          {questions.map((q) => (
            <QuestionBlock key={q.name} q={q} />
          ))}
        </div>
      )}
      {hasRules && (
        <div className="flex min-w-0 flex-col gap-2">
          {groups.fired.length > 0 && (
            <RuleGroup
              testId="decision-rules-fired"
              title={t("conversation.trail.decision.groupFired", "Fired")}
            >
              {groups.fired.map((r) => (
                <RuleRow key={r.rule} r={r} tick={tick} />
              ))}
            </RuleGroup>
          )}
          {groups.held.length > 0 && (
            <RuleGroup
              testId="decision-rules-held"
              title={t(
                "conversation.trail.decision.groupHeld",
                "Already acted",
              )}
            >
              {groups.held.map((r) => (
                <RuleRow key={r.rule} r={r} tick={tick} />
              ))}
            </RuleGroup>
          )}
          {groups.near.length > 0 && (
            <RuleGroup
              testId="decision-rules-near"
              title={t("conversation.trail.decision.groupNear", "Almost fired")}
            >
              {groups.near.map((r) => (
                <RuleRow key={r.rule} r={r} tick={tick} near />
              ))}
            </RuleGroup>
          )}
          {groups.rest.length > 0 && (
            <div
              className="flex flex-col gap-1"
              data-testid="decision-rules-rest"
            >
              <button
                type="button"
                onClick={() => setRestOpen((v) => !v)}
                aria-expanded={restOpen}
                className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-text-muted hover:bg-bg-tertiary"
              >
                {restOpen ? (
                  <ChevronDown
                    className="h-3 w-3 shrink-0"
                    aria-hidden="true"
                  />
                ) : (
                  <ChevronRight
                    className="h-3 w-3 shrink-0"
                    aria-hidden="true"
                  />
                )}
                {t(
                  "conversation.trail.decision.restCount",
                  "{{count}} rules did not fire",
                  { count: groups.rest.length },
                )}
              </button>
              {restOpen &&
                groups.rest.map((r) => (
                  <RuleRow key={r.rule} r={r} tick={tick} />
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RuleGroup({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <span className="font-medium text-[10px] text-text-muted uppercase tracking-wider">
        {title}
      </span>
      {children}
    </div>
  );
}

// One line per question: the answer and the confidence, with a close call flagged. The bars for every
// option open on a click, so thirty options do not stand between the operator and the rules.
function QuestionBlock({ q }: { q: QuestionView }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const bars = q.kind === "choice" || q.kind === "score" || q.kind === "yes_no";
  const answer =
    q.kind === "unanswered"
      ? t("conversation.trail.decision.unanswered", "not answered")
      : q.kind === "refusal"
        ? t(
            "conversation.trail.decision.refusal",
            "the classifier declined to answer",
          )
        : q.kind === "yes_no"
          ? t("conversation.trail.decision.yesProbability", "yes: {{p}}", {
              p: percent(q.probability),
            })
          : q.kind === "choice"
            ? (q.choice ?? "—")
            : t(
                "conversation.trail.decision.scoreLevel",
                "level {{level}}{{name}} (score {{score}})",
                {
                  level: q.level,
                  name: q.levelName ? ` · ${q.levelName}` : "",
                  score: q.score.toFixed(2),
                },
              );
  const head = (
    <span className="flex min-w-0 flex-wrap items-baseline gap-1.5">
      {bars &&
        (open ? (
          <ChevronDown
            className="h-3 w-3 shrink-0 self-center"
            aria-hidden="true"
          />
        ) : (
          <ChevronRight
            className="h-3 w-3 shrink-0 self-center"
            aria-hidden="true"
          />
        ))}
      <span className="font-medium font-mono text-text-primary">{q.name}</span>
      <span
        className={cn(
          q.kind === "unanswered" || q.kind === "refusal"
            ? "text-text-muted"
            : "text-text-secondary",
        )}
      >
        {answer}
      </span>
      {(q.kind === "choice" || q.kind === "score") && q.confidence !== null && (
        <span className="text-text-muted">
          {t("conversation.trail.decision.confidence", "confidence {{p}}", {
            p: percent(q.confidence),
          })}
        </span>
      )}
      {(q.kind === "choice" || q.kind === "score") && q.closeCall && (
        <span
          className="rounded bg-warning-soft px-1 text-warning"
          data-testid="decision-close-call"
        >
          {t(
            "conversation.trail.decision.closeCall",
            "close call: {{value}} {{p}}",
            { value: q.closeCall.value, p: percent(q.closeCall.probability) },
          )}
        </span>
      )}
    </span>
  );
  return (
    <div
      className="flex flex-col gap-1"
      data-testid={`decision-question-${q.name}`}
    >
      {bars ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="rounded px-1 py-0.5 text-left hover:bg-bg-tertiary"
        >
          {head}
        </button>
      ) : (
        <div className="px-1 py-0.5">{head}</div>
      )}
      {open && q.kind === "yes_no" && (
        <div className="flex flex-col gap-1 pl-5">
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
        </div>
      )}
      {open && (q.kind === "choice" || q.kind === "score") && (
        <div className="flex flex-col gap-1 pl-5">
          {q.rows.map((row) => (
            <ProbabilityLine key={row.value} row={row} />
          ))}
        </div>
      )}
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

// A near miss is one line on a wide screen: the rule, its action and the short reason side by side,
// the reason cut with an ellipsis (whole in its title) only if a long name still overflows.
function RuleRow({
  r,
  tick,
  near = false,
}: {
  r: RuleView;
  tick: DecisionTickView;
  near?: boolean;
}) {
  const { t } = useTranslation();
  const n = r.rule + 1;
  const tool =
    r.kind === "fired" ? r.tool : (tick.block?.rules[r.rule]?.tool ?? null);
  const text = ruleText(r, tick, t, near);
  return (
    <div
      className={cn(
        "flex flex-wrap items-baseline gap-1.5",
        near && "lg:flex-nowrap",
      )}
      data-testid="decision-rule"
    >
      <span className="shrink-0 font-medium text-text-primary">
        {t("conversation.trail.decision.ruleN", "Rule {{n}}", { n })}
      </span>
      {tool && (
        <span className="shrink-0 font-mono text-text-secondary">{tool}</span>
      )}
      <span
        title={near ? text : undefined}
        className={cn(
          r.kind === "fired" && r.outcome === "ran"
            ? "text-success"
            : r.kind === "fired"
              ? "text-error"
              : "text-text-muted",
          near && "lg:min-w-0 lg:truncate",
        )}
      >
        {text}
      </span>
      {(r.kind === "fired" || r.kind === "held") && (
        <CauseText rule={r.rule} tick={tick} />
      )}
    </div>
  );
}

// What made a fired rule act: its conditions, each with the answer this tick gave. Known only from the
// block the tick ran; a line of another block names the rule and its outcome alone.
function CauseText({ rule, tick }: { rule: number; tick: DecisionTickView }) {
  const { t } = useTranslation();
  const when = tick.block?.rules[rule]?.when;
  if (!when || when.length === 0) return null;
  const answers = tick.answers ?? {};
  const parts = when.map((c) => {
    const a = (answers[c.question] ?? null) as Record<string, unknown> | null;
    const num = (v: unknown) =>
      typeof v === "number" && Number.isFinite(v) ? v : null;
    if ("minProbability" in c) {
      const p = num(a?.probability);
      return t(
        "conversation.trail.decision.causeYes",
        "{{question}} yes {{p}} (at least {{min}})",
        {
          question: c.question,
          p: p === null ? "—" : percent(p),
          min: percent(c.minProbability),
        },
      );
    }
    // The confidence a choice or score condition asks for, beside the one the tick had, so the
    // operator sees every bar the rule cleared and not only the answer it read.
    const sure =
      c.minConfidence === undefined
        ? ""
        : `, ${t(
            "conversation.trail.decision.causeSure",
            "{{confidence}} sure (needs {{min}})",
            {
              confidence:
                num(a?.confidence) === null
                  ? "—"
                  : percent(num(a?.confidence) as number),
              min: percent(c.minConfidence),
            },
          )}`;
    if ("equals" in c) {
      return (
        t(
          "conversation.trail.decision.causeChoice",
          "{{question}} is {{value}}",
          {
            question: c.question,
            // What the tick measured, which is the condition's option whenever the rule fired.
            value: typeof a?.choice === "string" ? a.choice : c.equals,
          },
        ) + sure
      );
    }
    const score = num(a?.score);
    const q = tick.block?.questions.find((x) => x.name === c.question);
    const level = score === null ? null : Math.round(score);
    const name =
      level !== null && q?.type === "score"
        ? q.levels[level]?.value
        : undefined;
    const vars = {
      question: c.question,
      level: `${level ?? "—"}${name ? ` (${name})` : ""}`,
      min: c.minLevel,
      max: c.maxLevel,
    };
    return (
      (c.minLevel === c.maxLevel
        ? t(
            "conversation.trail.decision.causeLevelExact",
            "{{question}} level {{level}}, needs level {{min}}",
            vars,
          )
        : t(
            "conversation.trail.decision.causeLevelRange",
            "{{question}} level {{level}}, needs {{min}} to {{max}}",
            vars,
          )) + sure
    );
  });
  return (
    <span className="text-text-muted" data-testid="decision-rule-cause">
      {t("conversation.trail.decision.because", "because {{cause}}", {
        cause: parts.join("; "),
      })}
    </span>
  );
}

// `bare` drops the "not fired:" lead-in where the group's heading already says it (the near misses),
// so the row fits on one line on a wide screen.
function ruleText(
  r: RuleView,
  tick: DecisionTickView,
  t: T,
  bare = false,
): string {
  if (r.kind === "unknown") {
    return t(
      "conversation.trail.decision.firedNoOutcome",
      "fired with an earlier rule's identical action, no outcome of its own",
    );
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
  const reason = missText(r.miss, tick, t);
  if (reason === null) {
    return t("conversation.trail.decision.notFired", "not fired");
  }
  return bare
    ? reason
    : t(
        "conversation.trail.decision.notFiredBecause",
        "not fired: {{reason}}",
        {
          reason,
        },
      );
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
): string | null {
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
      "{{question}} {{measure}} {{got}} is below {{threshold}}",
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
      "{{question}} answered {{got}}, the rule expects {{expected}}",
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
    // The line stores the score itself (a weighted mean of level indices); the rule read it as the
    // nearest level, so that is the level named, with the score beside it when it fell between two.
    const score = n(miss.got);
    const level = score === null ? null : Math.round(score);
    const min = n(miss.minLevel);
    const max = n(miss.maxLevel);
    const vars = {
      question,
      got: `${level ?? "—"}${name(level)}`,
      min: `${min ?? "—"}${name(min)}`,
      max: `${max ?? "—"}${name(max)}`,
    };
    // One level reads as that level; a real range keeps "from X to Y". The score sits after a comma,
    // so the level's name is the only parenthetical.
    const one = min !== null && min === max;
    const between = score !== null && score !== level;
    if (between) {
      const withScore = { ...vars, score: (score as number).toFixed(2) };
      return one
        ? t(
            "conversation.trail.decision.outsideLevelsScoreOne",
            "{{question}} at level {{got}}, score {{score}}; asks for level {{min}}",
            withScore,
          )
        : t(
            "conversation.trail.decision.outsideLevelsScore",
            "{{question}} at level {{got}}, score {{score}}; asks from {{min}} to {{max}}",
            withScore,
          );
    }
    return one
      ? t(
          "conversation.trail.decision.outsideLevelsOne",
          "{{question}} at level {{got}}; asks for level {{min}}",
          vars,
        )
      : t(
          "conversation.trail.decision.outsideLevels",
          "{{question}} at level {{got}}; asks from {{min}} to {{max}}",
          vars,
        );
  }
  if (miss.why === "unanswered") {
    return t(
      "conversation.trail.decision.missUnanswered",
      "{{question}} was not answered",
      { question },
    );
  }
  if (miss.why === "refused") {
    return t(
      "conversation.trail.decision.missRefused",
      "the classifier declined to answer {{question}}",
      { question },
    );
  }
  return null;
}
