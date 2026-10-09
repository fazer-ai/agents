import type { TFunction } from "i18next";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  ComboBox,
  CredentialPicker,
  FormField,
  Input,
  Select,
  Textarea,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { credentialCompat } from "@/client/lib/credentialCompat";
import { SCOPE_MODEL } from "@/modules/chatwoot/attributes";
import {
  CHOICE_OPTIONS_MAX,
  DECISION_ACTION_TOOLS,
  DECISION_APPLY,
  DECISION_PROVIDERS,
  DECISION_QUESTION_TYPES,
  DEFAULT_DECISION_MODEL,
  type DecisionProvider,
  type DecisionsIssue,
  QUESTIONS_MAX,
  RULES_MAX,
  SCORE_LEVELS_MAX,
} from "@/modules/decisions/config";
import {
  type AnswerSample,
  type DecisionLine,
  type DecisionsActivity,
  type RuleActivity,
  summarizeDecisions,
} from "./decisionsActivity";
import {
  actionGap,
  actionScope,
  conditionFor,
  type DecisionConditionForm,
  type DecisionOptionForm,
  type DecisionQuestionForm,
  type DecisionRuleForm,
  type DecisionsForm,
  decisionsFormIssues,
  decisionTextCap,
  emptyCondition,
  freshDecisionKey,
  issuesUnder,
  moveItem,
  ruleIsBroken,
  withActionScope,
} from "./decisionsFormState";
import { type InboxLabelOption, LabelPicker } from "./LabelPicker";

// The decisions engine's block in the agent editor (docs/decisions.md, "The console"): which
// classification API answers, the typed questions it is asked, and the rules that turn the answers
// into tool calls. Drawn inside the Observation section of a monitoring agent whose engine is
// `decisions`. Every problem shown is one the write boundary's schema reports for this block, at
// the field it reports it for, so the screen and the server cannot disagree about what saves.

// A refusal the SERVER answered a save with, about a field of this block. Shown at that field while
// the block still holds what was sent.
export interface DecisionsServerRefusal {
  // Dotted path inside the block (`rules.0.when.0.question`), or "" for the block itself.
  path: string;
  message: string;
}

const HOW_MANY_LINES = "100";

// Product names, the same in every language.
const PROVIDER_NAMES: Record<DecisionProvider, string> = {
  openai: "OpenAI Decisions",
  typesafe: "TypeSafe (Jev)",
};

function issueText(t: TFunction, issue: DecisionsIssue): string {
  const p = issue.params;
  switch (issue.code) {
    case "required":
      return t("editor.decisionsIssueRequired", "Required.");
    case "repeated_value":
      return t(
        "editor.decisionsIssueRepeatedValue",
        '"{{value}}" is already used in this list.',
        { value: p.value },
      );
    case "repeated_name":
      return t(
        "editor.decisionsIssueRepeatedName",
        'Another question is already named "{{value}}".',
        { value: p.value },
      );
    case "unknown_question":
      return t(
        "editor.decisionsIssueUnknownQuestion",
        'No question is named "{{value}}" anymore. Pick one of the questions above.',
        { value: p.value },
      );
    case "unknown_option":
      return t(
        "editor.decisionsIssueUnknownOption",
        '"{{value}}" is no longer one of the question\'s options.',
        { value: p.value },
      );
    case "level_out_of_range":
      return t(
        "editor.decisionsIssueLevelOutOfRange",
        "The question now has {{size}} levels, and this rule names one past the last.",
        { size: p.size },
      );
    case "needs_min_probability":
      return t(
        "editor.decisionsIssueNeedsProbability",
        "Set the minimum probability, from 0 to 1.",
      );
    case "needs_equals":
      return t("editor.decisionsIssueNeedsEquals", "Pick the option.");
    case "needs_level_range":
      return t(
        "editor.decisionsIssueNeedsLevels",
        "Pick the lowest and the highest level, lowest first.",
      );
    case "choice_needs_options":
    case "score_needs_levels":
      return t("editor.decisionsIssueNeedsList", "Add at least 2.");
    case "too_small":
      return p.origin === "string"
        ? t("editor.decisionsIssueRequired", "Required.")
        : t("editor.decisionsIssueTooSmall", "At least {{minimum}}.", {
            minimum: p.minimum,
          });
    case "too_big":
      return t("editor.decisionsIssueTooBig", "At most {{maximum}}.", {
        maximum: p.maximum,
      });
    case "invalid_format":
      return t(
        "editor.decisionsIssueName",
        "Lowercase letters, digits and underscores, starting with a letter, up to 64 characters.",
      );
    case "invalid_type":
      return t("editor.decisionsIssueNumber", "Must be a number.");
    case "invalid_value":
      return t("editor.decisionsIssueValue", "Not an accepted value.");
    default:
      return issue.message;
  }
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={
        danger
          ? "flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:text-error disabled:opacity-40"
          : "flex h-7 w-7 items-center justify-center rounded text-text-muted transition-colors hover:text-text-primary disabled:opacity-40"
      }
    >
      {children}
    </button>
  );
}

function sampleText(t: TFunction, s: AnswerSample): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (s.type === "yes_no") {
    return t("editor.decisionsAnswerYesNo", "yes {{p}}", {
      p: pct(s.probability),
    });
  }
  if (s.type === "choice") {
    return s.confidence === null
      ? s.choice
      : `${s.choice} (${pct(s.confidence)})`;
  }
  if (s.type === "score") {
    return t("editor.decisionsAnswerScore", "level {{score}}", {
      score: Math.round(s.score * 100) / 100,
    });
  }
  return t("editor.decisionsAnswerRefusal", "refused");
}

function ruleActivityText(
  t: TFunction,
  a: RuleActivity | undefined,
  total: number,
): string {
  if (!a || a.fired === 0) {
    return t(
      "editor.decisionsRuleNeverFired",
      "Fired in 0 of {{total}} decisions.",
      { total },
    );
  }
  const parts = [
    t(
      "editor.decisionsRuleFired",
      "Fired in {{fired}} of {{total}} decisions",
      {
        fired: a.fired,
        total,
      },
    ),
  ];
  if (a.ran > 0) {
    parts.push(t("editor.decisionsRuleRan", "ran {{n}}", { n: a.ran }));
  }
  if (a.shadow > 0) {
    parts.push(
      t("editor.decisionsRuleShadow", "would have run {{n}} (shadow)", {
        n: a.shadow,
      }),
    );
  }
  if (a.merged > 0) {
    parts.push(
      t("editor.decisionsRuleMerged", "same action as an earlier rule {{n}}", {
        n: a.merged,
      }),
    );
  }
  if (a.blocked > 0) {
    parts.push(
      t("editor.decisionsRuleBlocked", "could not run {{n}}", {
        n: a.blocked,
      }),
    );
  }
  return `${parts.join(", ")}.`;
}

type CustomAttribute = { key: string; displayName: string; model: string };

export function DecisionsFields({
  agentId,
  savedAt,
  storedBlock,
  storedRuleCount,
  storedDecisions,
  decisions,
  setDecisions,
  credentialError,
  serverRefusal,
}: {
  agentId: string;
  // When the agent was last saved: the activity is read again after every save.
  savedAt: string | null;
  // The mark of the questions and rules as STORED, which is what the engine's lines are matched
  // against (decisionsActivity). Null when the stored block could not run.
  storedBlock: string | null;
  // How many rules that stored block has (a line is read against the list it indexes).
  storedRuleCount: number;
  // The block as stored: an untouched form is judged by it, since it is what a save writes back.
  storedDecisions: Record<string, unknown> | null;
  decisions: DecisionsForm;
  setDecisions: (next: (prev: DecisionsForm) => DecisionsForm) => void;
  credentialError: string | null;
  serverRefusal: DecisionsServerRefusal | null;
}) {
  const { t } = useTranslation();
  const issues = useMemo(
    () => decisionsFormIssues(decisions, storedDecisions),
    [decisions, storedDecisions],
  );

  const [labels, setLabels] = useState<InboxLabelOption[]>([]);
  const [attributes, setAttributes] = useState<CustomAttribute[]>([]);
  const [multiAccount, setMultiAccount] = useState(false);
  const [activity, setActivity] = useState<DecisionsActivity | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLabels([]);
    setAttributes([]);
    setMultiAccount(false);
    void (async () => {
      try {
        const [l, a] = await Promise.all([
          api.api.v1.chatwoot.labels({ agentId }).get(),
          api.api.v1.chatwoot["custom-attributes"]({ agentId }).get(),
        ]);
        if (cancelled) return;
        if (l.data) {
          setLabels(l.data.labels);
          setMultiAccount(l.data.accountCount > 1);
        }
        if (a.data) setAttributes(a.data.attributes);
      } catch {
        // NOTE: best-effort: both pickers still take a typed value
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: savedAt is the trigger: a save is when new lines can match
  useEffect(() => {
    let cancelled = false;
    setActivity(null);
    void (async () => {
      try {
        const { data } = await api.api.v1.logs.get({
          query: {
            source: "inbox",
            stage: "observe",
            agentId,
            limit: HOW_MANY_LINES,
          },
        });
        if (cancelled || !data) return;
        setActivity(
          summarizeDecisions(
            data.items as DecisionLine[],
            storedBlock,
            storedRuleCount,
          ),
        );
      } catch {
        // NOTE: best-effort: the block is editable without its history
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentId, savedAt, storedBlock, storedRuleCount]);

  // Which cards are unfolded. A stored block opens folded, one line per question and per rule, so a
  // block of thirty rules reads as a list; a card with a problem is always open, since the mark is
  // inside it, and a card just added opens for typing.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const unfold = (key: string) => setOpen((prev) => new Set(prev).add(key));
  // A card a problem (or a warning) opened STAYS open once the problem is gone: the operator is
  // typing in it, and folding it on the keystroke that fixes the field takes the input, and the
  // focus, away mid-word. Latched after the render that showed it; folding is the operator's click.
  const forced = [
    ...decisions.questions
      .filter((_, qi) => issuesUnder(issues, `questions.${qi}`).length > 0)
      .map((q) => q.key),
    ...decisions.rules
      .filter(
        (r, ri) =>
          actionGap(r) !== null ||
          issuesUnder(issues, `rules.${ri}`).length > 0,
      )
      .map((r) => r.key),
  ];
  const forcedKey = forced.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `forced` is rebuilt every render; its keys are the dependency
  useEffect(() => {
    if (forced.length === 0) return;
    setOpen((prev) =>
      forced.every((k) => prev.has(k)) ? prev : new Set([...prev, ...forced]),
    );
  }, [forcedKey]);

  const patch = (p: Partial<DecisionsForm>) =>
    setDecisions((prev) => ({ ...prev, ...p }));
  const provider = (decisions.provider || "openai") as DecisionProvider;
  const apply = decisions.apply || "shadow";
  const questionNames = decisions.questions.map((q) => q.name).filter(Boolean);

  // The message at a field: the form's own problem first, then what the server last said about it.
  const at = (path: string): string | null => {
    const issue = issues.get(path);
    if (issue) return issueText(t, issue);
    return serverRefusal && serverRefusal.path === path
      ? serverRefusal.message
      : null;
  };
  const drawnPaths = new Set<string>();
  const field = (path: string): string | null => {
    drawnPaths.add(path);
    return at(path);
  };

  const setQuestion = (i: number, p: Partial<DecisionQuestionForm>) =>
    setDecisions((prev) => ({
      ...prev,
      questions: prev.questions.map((q, n) => (n === i ? { ...q, ...p } : q)),
    }));
  const setRule = (i: number, p: Partial<DecisionRuleForm>) =>
    setDecisions((prev) => ({
      ...prev,
      rules: prev.rules.map((r, n) => (n === i ? { ...r, ...p } : r)),
    }));
  const setCondition = (
    r: number,
    c: number,
    next: (
      prev: DecisionConditionForm,
      form: DecisionsForm,
    ) => DecisionConditionForm,
  ) =>
    setDecisions((prev) => ({
      ...prev,
      rules: prev.rules.map((rule, n) =>
        n === r
          ? {
              ...rule,
              when: rule.when.map((cond, m) =>
                m === c ? next(cond, prev) : cond,
              ),
            }
          : rule,
      ),
    }));
  const setArg = (r: number, key: string, value: unknown) =>
    setDecisions((prev) => ({
      ...prev,
      rules: prev.rules.map((rule, n) => {
        if (n !== r) return rule;
        const args = { ...rule.args };
        // An emptied argument is removed rather than stored empty: `add: []` and no `add` mean the
        // same to the tool, and an optional text the tool would take as given (a handoff reason)
        // must not be sent as an empty one.
        if (value === "" || (Array.isArray(value) && value.length === 0)) {
          delete args[key];
        } else {
          args[key] = value;
        }
        return { ...rule, args };
      }),
    }));

  const toolLabel = (tool: string): string => {
    switch (tool) {
      case "set_labels":
        return t("editor.decisionsToolSetLabels", "Change labels");
      case "handoff_to_human":
        return t("editor.decisionsToolHandoff", "Hand off to a human");
      case "private_note":
        return t("editor.decisionsToolNote", "Leave a private note");
      case "set_custom_attribute":
        return t("editor.decisionsToolAttribute", "Set a custom attribute");
      default:
        return tool;
    }
  };
  const typeLabel = (type: string): string => {
    switch (type) {
      case "yes_no":
        return t("editor.decisionsTypeYesNo", "Yes or no");
      case "choice":
        return t("editor.decisionsTypeChoice", "One of a list");
      case "score":
        return t("editor.decisionsTypeScore", "A level on a scale");
      default:
        return type;
    }
  };

  const optionRows = (
    qi: number,
    key: "options" | "levels",
    rows: DecisionOptionForm[],
    max: number,
  ) => {
    const base = `questions.${qi}.${key}`;
    const setRows = (next: DecisionOptionForm[]) =>
      setQuestion(qi, key === "options" ? { options: next } : { levels: next });
    return (
      <FormField
        group
        label={
          key === "options"
            ? t("editor.decisionsOptions", "Options")
            : t("editor.decisionsLevels", "Levels, lowest first")
        }
        description={
          key === "options"
            ? t(
                "editor.decisionsOptionsHint",
                "The answer is one of these. 2 to {{max}}, each value once.",
                { max },
              )
            : t(
                "editor.decisionsLevelsHint",
                "The answer is a position on this scale. 2 to {{max}}, each value once.",
                { max },
              )
        }
        error={field(base)}
      >
        <div className="flex flex-col gap-2">
          {rows.map((row, oi) => {
            const valueError = field(`${base}.${oi}.value`);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and carry no id; a level's index IS its value
              <div key={oi} className="flex flex-col gap-1">
                <div className="flex items-start gap-2">
                  {key === "levels" && (
                    <span className="mt-2 w-5 shrink-0 text-right text-text-muted text-xs tabular-nums">
                      {oi}
                    </span>
                  )}
                  <Input
                    value={row.value}
                    error={!!valueError}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, n) =>
                          n === oi ? { ...x, value: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder={t("editor.decisionsOptionValue", "Value")}
                    aria-label={t(
                      "editor.decisionsOptionValueAria",
                      "Value {{n}}",
                      { n: oi + 1 },
                    )}
                    wrapperClassName="max-w-44"
                    className="text-sm"
                  />
                  <Input
                    value={row.description}
                    onChange={(e) =>
                      setRows(
                        rows.map((x, n) =>
                          n === oi ? { ...x, description: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder={t(
                      "editor.decisionsOptionDescription",
                      "What it means (optional)",
                    )}
                    aria-label={t(
                      "editor.decisionsOptionDescriptionAria",
                      "Description {{n}}",
                      { n: oi + 1 },
                    )}
                    wrapperClassName="min-w-0 flex-1"
                    className="text-sm"
                  />
                  {key === "levels" && (
                    <>
                      <IconButton
                        label={t("editor.decisionsMoveUp", "Move up")}
                        disabled={oi === 0}
                        onClick={() => setRows(moveItem(rows, oi, oi - 1))}
                      >
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        label={t("editor.decisionsMoveDown", "Move down")}
                        disabled={oi === rows.length - 1}
                        onClick={() => setRows(moveItem(rows, oi, oi + 1))}
                      >
                        <ArrowDown className="h-4 w-4" aria-hidden="true" />
                      </IconButton>
                    </>
                  )}
                  <IconButton
                    danger
                    label={t("editor.decisionsRemove", "Remove")}
                    onClick={() => setRows(rows.filter((_, n) => n !== oi))}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
                {valueError && (
                  <span role="alert" className="text-error text-xs">
                    {valueError}
                  </span>
                )}
              </div>
            );
          })}
          <div>
            <Button
              size="sm"
              variant="secondary"
              disabled={rows.length >= max}
              onClick={() => setRows([...rows, { value: "", description: "" }])}
            >
              <Plus aria-hidden="true" />
              {key === "options"
                ? t("editor.decisionsAddOption", "Add option")
                : t("editor.decisionsAddLevel", "Add level")}
            </Button>
          </div>
        </div>
      </FormField>
    );
  };

  const conditionRow = (
    ri: number,
    ci: number,
    cond: DecisionConditionForm,
  ) => {
    const base = `rules.${ri}.when.${ci}`;
    const name = cond.question;
    const q = decisions.questions.find((x) => x.name === name);
    const questionError = field(`${base}.question`);
    const errors = [
      questionError,
      field(`${base}.minProbability`),
      field(`${base}.equals`),
      field(`${base}.minLevel`),
      field(`${base}.maxLevel`),
      field(`${base}.minConfidence`),
      field(base),
    ].filter((e): e is string => !!e);
    const set = (p: Partial<DecisionConditionForm>) =>
      setCondition(ri, ci, (prev) => ({ ...prev, ...p }));
    const confidence = (
      <span className="flex items-center gap-1.5 text-text-secondary text-xs">
        {t("editor.decisionsMinConfidence", "confidence at least")}
        <Input
          type="number"
          min={0}
          max={1}
          step={0.05}
          value={cond.minConfidence}
          error={!!at(`${base}.minConfidence`)}
          onChange={(e) => set({ minConfidence: e.target.value })}
          placeholder={t("editor.decisionsOptional", "any")}
          aria-label={t(
            "editor.decisionsMinConfidenceAria",
            "Minimum confidence, optional",
          )}
          wrapperClassName="max-w-24"
          className="text-sm"
        />
      </span>
    );
    const options = q?.options.map((o) => o.value).filter(Boolean) ?? [];
    const levels = q?.levels ?? [];
    const levelSelect = (key: "minLevel" | "maxLevel", label: string) => {
      const known = levels.some((_, n) => String(n) === cond[key]);
      return (
        <Select
          value={cond[key]}
          aria-label={label}
          onChange={(e) =>
            set(
              key === "minLevel"
                ? { minLevel: e.target.value }
                : { maxLevel: e.target.value },
            )
          }
          wrapperClassName="max-w-44"
          className="text-sm"
        >
          {!known && (
            <option value={cond[key]}>
              {cond[key] === ""
                ? t("editor.decisionsPick", "Pick…")
                : t("editor.decisionsMissingLevel", "level {{n}} (gone)", {
                    n: cond[key],
                  })}
            </option>
          )}
          {levels.map((l, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a level's index is its value
            <option key={n} value={String(n)}>
              {n}
              {l.value.trim() ? ` · ${l.value.trim()}` : ""}
            </option>
          ))}
        </Select>
      );
    };
    return (
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={q ? name : cond.question}
            aria-label={t("editor.decisionsConditionQuestion", "Question")}
            error={!!questionError}
            onChange={(e) =>
              setCondition(ri, ci, (_prev, form) =>
                conditionFor(form, e.target.value),
              )
            }
            wrapperClassName="max-w-52"
            className="text-sm"
          >
            {!q && (
              <option value={cond.question}>
                {name === ""
                  ? t("editor.decisionsPickQuestion", "Pick a question…")
                  : t("editor.decisionsMissingQuestion", "{{name}} (gone)", {
                      name,
                    })}
              </option>
            )}
            {questionNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          {q?.type === "yes_no" && (
            <span className="flex items-center gap-1.5 text-text-secondary text-xs">
              {t(
                "editor.decisionsMinProbability",
                "probability of yes at least",
              )}
              <Input
                type="number"
                min={0}
                max={1}
                step={0.05}
                value={cond.minProbability}
                error={!!at(`${base}.minProbability`)}
                onChange={(e) => set({ minProbability: e.target.value })}
                aria-label={t(
                  "editor.decisionsMinProbabilityAria",
                  "Minimum probability",
                )}
                wrapperClassName="max-w-24"
                className="text-sm"
              />
            </span>
          )}
          {q?.type === "choice" && (
            <>
              <span className="text-text-secondary text-xs">
                {t("editor.decisionsEquals", "is")}
              </span>
              <Select
                value={cond.equals}
                aria-label={t("editor.decisionsEqualsAria", "Option")}
                error={!!at(`${base}.equals`)}
                onChange={(e) => set({ equals: e.target.value })}
                wrapperClassName="max-w-48"
                className="text-sm"
              >
                {!options.includes(cond.equals) && (
                  <option value={cond.equals}>
                    {cond.equals === ""
                      ? t("editor.decisionsPick", "Pick…")
                      : t("editor.decisionsMissingOption", "{{name}} (gone)", {
                          name: cond.equals,
                        })}
                  </option>
                )}
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
              {confidence}
            </>
          )}
          {q?.type === "score" && (
            <>
              <span className="text-text-secondary text-xs">
                {t("editor.decisionsFromLevel", "from")}
              </span>
              {levelSelect(
                "minLevel",
                t("editor.decisionsMinLevelAria", "Lowest level"),
              )}
              <span className="text-text-secondary text-xs">
                {t("editor.decisionsToLevel", "to")}
              </span>
              {levelSelect(
                "maxLevel",
                t("editor.decisionsMaxLevelAria", "Highest level"),
              )}
              {confidence}
            </>
          )}
          <IconButton
            danger
            label={t("editor.decisionsRemoveCondition", "Remove condition")}
            onClick={() =>
              setRule(ri, {
                when: (decisions.rules[ri]?.when ?? []).filter(
                  (_, n) => n !== ci,
                ),
              })
            }
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
        {errors.map((e) => (
          <span key={e} role="alert" className="text-error text-xs">
            {e}
          </span>
        ))}
      </div>
    );
  };

  const actionFields = (ri: number, rule: DecisionRuleForm) => {
    const strings = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const scope = actionScope(rule);
    const scopeField = (
      <FormField
        label={t("editor.decisionsScope", "Written to")}
        className="sm:col-span-2"
      >
        <Select
          value={scope}
          wrapperClassName="max-w-52"
          onChange={(e) =>
            setDecisions((prev) => ({
              ...prev,
              rules: prev.rules.map((r, n) =>
                n === ri ? withActionScope(r, e.target.value) : r,
              ),
            }))
          }
        >
          {!["conversation", "contact"].includes(scope) && (
            <option value={scope}>{scope}</option>
          )}
          <option value="conversation">
            {t("editor.decisionsScopeConversation", "The conversation")}
          </option>
          <option value="contact">
            {t("editor.decisionsScopeContact", "The contact")}
          </option>
        </Select>
      </FormField>
    );
    if (rule.tool === "set_labels") {
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {scopeField}
          <FormField group label={t("editor.decisionsLabelsAdd", "Add labels")}>
            <LabelPicker
              values={strings(rule.args.add)}
              onChange={(v) => setArg(ri, "add", v)}
              labels={labels}
              multiAccount={multiAccount}
              ariaLabel={t("editor.decisionsLabelsAdd", "Add labels")}
            />
          </FormField>
          <FormField
            group
            label={t("editor.decisionsLabelsRemove", "Remove labels")}
          >
            <LabelPicker
              values={strings(rule.args.remove)}
              onChange={(v) => setArg(ri, "remove", v)}
              labels={labels}
              multiAccount={false}
              ariaLabel={t("editor.decisionsLabelsRemove", "Remove labels")}
            />
          </FormField>
        </div>
      );
    }
    if (rule.tool === "set_custom_attribute") {
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {scopeField}
          <FormField
            group
            label={t("editor.decisionsAttributeKey", "Attribute")}
          >
            <ComboBox
              value={str(rule.args.key)}
              onChange={(v) => setArg(ri, "key", v)}
              items={attributes
                .filter(
                  (d) =>
                    d.model === (SCOPE_MODEL as Record<string, string>)[scope],
                )
                .map((d) => ({
                  id: d.key,
                  label: d.displayName || d.key,
                  hint: d.displayName && d.displayName !== d.key ? d.key : "",
                }))}
              placeholder={t(
                "editor.decisionsAttributeKeyPlaceholder",
                "Pick an attribute…",
              )}
              searchPlaceholder={t(
                "editor.attributeContextSearch",
                "Search attributes…",
              )}
              aria-label={t("editor.decisionsAttributeKey", "Attribute")}
            />
          </FormField>
          <FormField label={t("editor.decisionsAttributeValue", "Value")}>
            <Input
              value={str(rule.args.value)}
              onChange={(e) =>
                setDecisions((prev) => ({
                  ...prev,
                  rules: prev.rules.map((r, n) =>
                    n === ri
                      ? { ...r, args: { ...r.args, value: e.target.value } }
                      : r,
                  ),
                }))
              }
            />
          </FormField>
        </div>
      );
    }
    if (rule.tool === "private_note") {
      return (
        <FormField label={t("editor.decisionsNoteContent", "Note")}>
          <Textarea
            rows={2}
            maxLength={decisionTextCap(str(rule.args.content))}
            value={str(rule.args.content)}
            onChange={(e) => setArg(ri, "content", e.target.value)}
          />
        </FormField>
      );
    }
    if (rule.tool === "handoff_to_human") {
      return (
        <FormField
          label={t("editor.decisionsHandoffReason", "Reason (optional)")}
          description={t(
            "editor.decisionsHandoffReasonHint",
            "Left as a private note for whoever takes the conversation.",
          )}
        >
          <Input
            value={str(rule.args.reason)}
            onChange={(e) => setArg(ri, "reason", e.target.value)}
          />
        </FormField>
      );
    }
    return null;
  };

  // A folded rule in one line: "When <conditions>, then <action>".
  const ruleSummary = (rule: DecisionRuleForm): string => {
    const strings = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [];
    const when = rule.when.map((c) => {
      const name = c.question;
      const q = decisions.questions.find((x) => x.name === name);
      if (q?.type === "yes_no") return `${name} ≥ ${c.minProbability}`;
      if (q?.type === "choice") return `${name} = ${c.equals}`;
      if (q?.type === "score") {
        const level = (v: string) => q.levels[Number(v)]?.value.trim() || v;
        return c.minLevel === c.maxLevel
          ? `${name} = ${level(c.minLevel)}`
          : `${name} = ${level(c.minLevel)}…${level(c.maxLevel)}`;
      }
      return name;
    });
    const a = rule.args;
    const detail =
      rule.tool === "set_labels"
        ? [
            ...strings(a.add).map((l) => `+${l}`),
            ...strings(a.remove).map((l) => `−${l}`),
          ].join(" ")
        : rule.tool === "set_custom_attribute"
          ? `${String(a.key ?? "")} = ${String(a.value ?? "")}`
          : rule.tool === "private_note"
            ? String(a.content ?? "")
            : "";
    const and = t("editor.decisionsAnd", " and ");
    return t(
      "editor.decisionsRuleSummary",
      "When {{conditions}}, then {{action}}",
      {
        conditions: when.join(and),
        action: detail
          ? `${toolLabel(rule.tool)}: ${detail}`
          : toolLabel(rule.tool),
        interpolation: { escapeValue: false },
      },
    );
  };

  const gapText = (rule: DecisionRuleForm): string | null => {
    switch (actionGap(rule)) {
      case "note_empty":
        return t(
          "editor.decisionsGapNote",
          "Without a note this rule fails every time it fires.",
        );
      case "attribute_key_empty":
        return t(
          "editor.decisionsGapAttribute",
          "Without an attribute this rule fails every time it fires.",
        );
      case "labels_empty":
        return t(
          "editor.decisionsGapLabels",
          "With no label to add or remove this rule changes nothing.",
        );
      default:
        return null;
    }
  };

  const body = (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label={t("editor.decisionsProvider", "Classification API")}
          error={field("provider")}
        >
          <Select
            value={decisions.provider}
            onChange={(e) => patch({ provider: e.target.value, model: "" })}
          >
            {!DECISION_PROVIDERS.includes(
              decisions.provider as DecisionProvider,
            ) && (
              <option value={decisions.provider}>
                {decisions.provider === ""
                  ? t("editor.decisionsPick", "Pick…")
                  : decisions.provider}
              </option>
            )}
            <option value="openai">{PROVIDER_NAMES.openai}</option>
            <option value="typesafe">{PROVIDER_NAMES.typesafe}</option>
          </Select>
        </FormField>
        <FormField
          label={t("editor.decisionsModel", "Model")}
          description={t(
            "editor.decisionsModelHint",
            "Empty uses the default, {{model}}.",
            {
              model:
                DEFAULT_DECISION_MODEL[provider] ??
                DEFAULT_DECISION_MODEL.openai,
            },
          )}
          error={field("model")}
        >
          <Input
            value={decisions.model}
            onChange={(e) => patch({ model: e.target.value })}
            placeholder={
              DEFAULT_DECISION_MODEL[provider] ?? DEFAULT_DECISION_MODEL.openai
            }
          />
        </FormField>
        <FormField
          label={t("editor.decisionsCredential", "API key")}
          error={credentialError ?? field("credentialRef")}
          group
        >
          <CredentialPicker
            value={decisions.credentialRef}
            onChange={(v) => patch({ credentialRef: v })}
            required
            compatibleTypes={credentialCompat.decisions(provider)}
            defaultCreateType={credentialCompat.decisions(provider)[0]}
            ariaLabel={t("editor.decisionsCredential", "API key")}
          />
        </FormField>
        <FormField
          label={t("editor.decisionsApply", "What it does with the answers")}
          description={
            apply === "enforce"
              ? t(
                  "editor.decisionsApplyEnforceHint",
                  "Runs each rule that fires: labels, notes, attributes and handoffs are written to the conversation.",
                )
              : t(
                  "editor.decisionsApplyShadowHint",
                  "Decides and logs what each rule would have done. Nothing is written to the conversation. The classification call is still paid for.",
                )
          }
          error={field("apply")}
        >
          <Select
            value={apply}
            onChange={(e) => patch({ apply: e.target.value })}
          >
            {!DECISION_APPLY.includes(apply as "shadow") && (
              <option value={apply}>{apply}</option>
            )}
            <option value="shadow">
              {t("editor.decisionsApplyShadow", "Shadow: only log")}
            </option>
            <option value="enforce">
              {t("editor.decisionsApplyEnforce", "Enforce: run the rules")}
            </option>
          </Select>
        </FormField>
      </div>

      {activity && (
        <p
          className="text-text-muted text-xs"
          data-testid="decisions-activity-total"
        >
          {t(
            "editor.decisionsActivityTotal",
            "{{count}} of this agent's latest decisions ran these questions and rules as saved. The numbers beside each question and rule count those.",
            { count: activity.decisions },
          )}
        </p>
      )}

      <div className="flex flex-col gap-3">
        <div>
          <h4 className="font-medium text-sm text-text-primary">
            {t("editor.decisionsQuestions", "Questions")}
          </h4>
          <p className="text-text-muted text-xs">
            {t(
              "editor.decisionsQuestionsHint",
              "What the API is asked about the conversation on every pass. Up to {{max}}, each answered on its own.",
              { max: QUESTIONS_MAX },
            )}
          </p>
        </div>
        {decisions.questions.map((q, qi) => {
          const samples = activity?.answers.get(q.name) ?? [];
          const qOpen = open.has(q.key) || forced.includes(q.key);
          return (
            <div
              key={q.key}
              data-testid="decisions-question"
              className="flex flex-col gap-3 rounded-lg border border-border p-3"
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  aria-expanded={qOpen}
                  onClick={() => toggle(q.key)}
                  className="flex min-w-0 items-center gap-2 text-left"
                >
                  <ChevronRight
                    className={
                      qOpen
                        ? "h-4 w-4 shrink-0 rotate-90 text-text-muted transition-transform"
                        : "h-4 w-4 shrink-0 text-text-muted transition-transform"
                    }
                    aria-hidden="true"
                  />
                  <h5 className="shrink-0 font-medium text-sm text-text-primary">
                    {t("editor.decisionsQuestionN", "Question {{n}}", {
                      n: qi + 1,
                    })}
                  </h5>
                  {!qOpen && (
                    <span className="truncate font-mono text-text-secondary text-xs">
                      {q.name}
                    </span>
                  )}
                </button>
                <Badge>{typeLabel(q.type)}</Badge>
                <div className="ml-auto flex items-center">
                  <IconButton
                    label={t("editor.decisionsMoveUp", "Move up")}
                    disabled={qi === 0}
                    onClick={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        questions: moveItem(prev.questions, qi, qi - 1),
                      }))
                    }
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t("editor.decisionsMoveDown", "Move down")}
                    disabled={qi === decisions.questions.length - 1}
                    onClick={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        questions: moveItem(prev.questions, qi, qi + 1),
                      }))
                    }
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    danger
                    label={t(
                      "editor.decisionsRemoveQuestion",
                      "Remove question",
                    )}
                    onClick={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        questions: prev.questions.filter((_, n) => n !== qi),
                      }))
                    }
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
              {qOpen && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField
                      label={t("editor.decisionsQuestionName", "Name")}
                      description={t(
                        "editor.decisionsQuestionNameHint",
                        "How rules and logs refer to it, e.g. asks_refund.",
                      )}
                      error={field(`questions.${qi}.name`)}
                    >
                      <Input
                        value={q.name}
                        onChange={(e) =>
                          setQuestion(qi, { name: e.target.value })
                        }
                      />
                    </FormField>
                    <FormField
                      label={t("editor.decisionsQuestionType", "Answer")}
                      error={field(`questions.${qi}.type`)}
                    >
                      <Select
                        value={q.type}
                        onChange={(e) =>
                          setQuestion(qi, { type: e.target.value })
                        }
                      >
                        {!DECISION_QUESTION_TYPES.includes(
                          q.type as "yes_no",
                        ) && (
                          <option value={q.type}>
                            {q.type === ""
                              ? t("editor.decisionsPick", "Pick…")
                              : q.type}
                          </option>
                        )}
                        {DECISION_QUESTION_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {typeLabel(type)}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                  </div>
                  <FormField
                    label={t(
                      "editor.decisionsQuestionInstructions",
                      "Question",
                    )}
                    error={field(`questions.${qi}.instructions`)}
                  >
                    <Textarea
                      rows={2}
                      maxLength={decisionTextCap(q.instructions)}
                      value={q.instructions}
                      onChange={(e) =>
                        setQuestion(qi, { instructions: e.target.value })
                      }
                      placeholder={t(
                        "editor.decisionsQuestionInstructionsPlaceholder",
                        "E.g.: Is the customer asking for their money back?",
                      )}
                    />
                  </FormField>
                  {q.type === "choice" &&
                    optionRows(qi, "options", q.options, CHOICE_OPTIONS_MAX)}
                  {q.type === "score" &&
                    optionRows(qi, "levels", q.levels, SCORE_LEVELS_MAX)}
                  {issuesUnder(issues, `questions.${qi}`)
                    .filter((i) => i.path.length === 2 && i.code !== "required")
                    .map((i) => (
                      <span
                        key={i.code}
                        role="alert"
                        className="text-error text-xs"
                      >
                        {issueText(t, i)}
                      </span>
                    ))}
                </>
              )}
              {!qOpen && q.instructions.trim() && (
                <p className="truncate text-text-secondary text-xs">
                  {q.instructions.trim()}
                </p>
              )}
              {activity && activity.decisions > 0 && (
                <p
                  className="text-text-muted text-xs"
                  data-testid="decisions-question-answers"
                >
                  {samples.length > 0
                    ? t(
                        "editor.decisionsLatestAnswers",
                        "Latest answers: {{answers}}",
                        {
                          answers: samples
                            .map((s) => sampleText(t, s))
                            .join(" · "),
                        },
                      )
                    : t(
                        "editor.decisionsNoAnswers",
                        "No answer under this name yet.",
                      )}
                </p>
              )}
            </div>
          );
        })}
        {field("questions") && (
          <span role="alert" className="text-error text-xs">
            {decisions.questions.length === 0
              ? t(
                  "editor.decisionsNeedsQuestion",
                  "Add at least one question: the engine has nothing to ask.",
                )
              : at("questions")}
          </span>
        )}
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={decisions.questions.length >= QUESTIONS_MAX}
            onClick={() => {
              const key = freshDecisionKey();
              unfold(key);
              setDecisions((prev) => ({
                ...prev,
                questions: [
                  ...prev.questions,
                  {
                    key,
                    name: "",
                    type: "yes_no",
                    instructions: "",
                    options: [
                      { value: "", description: "" },
                      { value: "", description: "" },
                    ],
                    levels: [
                      { value: "", description: "" },
                      { value: "", description: "" },
                    ],
                  },
                ],
              }));
            }}
          >
            <Plus aria-hidden="true" />
            {t("editor.decisionsAddQuestion", "Add question")}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <div>
          <h4 className="font-medium text-sm text-text-primary">
            {t("editor.decisionsRules", "Rules")}
          </h4>
          <p className="text-text-muted text-xs">
            {t(
              "editor.decisionsRulesHint",
              "A rule fires when every one of its conditions holds, and runs one tool with fixed arguments. The agent needs that tool granted on the Tools tab, or the rule cannot run. Up to {{max}}.",
              { max: RULES_MAX },
            )}
          </p>
        </div>
        {decisions.rules.map((rule, ri) => {
          const broken = ruleIsBroken(issues, ri);
          const gap = gapText(rule);
          const rOpen = open.has(rule.key) || forced.includes(rule.key);
          const counted =
            rule.origin === null ? undefined : activity?.rules.get(rule.origin);
          return (
            <div
              key={rule.key}
              data-testid="decisions-rule"
              data-broken={broken ? "true" : "false"}
              className={
                broken
                  ? "flex flex-col gap-3 rounded-lg border border-error p-3"
                  : "flex flex-col gap-3 rounded-lg border border-border p-3"
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  aria-expanded={rOpen}
                  onClick={() => toggle(rule.key)}
                  className="flex items-center gap-2 text-left"
                >
                  <ChevronRight
                    className={
                      rOpen
                        ? "h-4 w-4 shrink-0 rotate-90 text-text-muted transition-transform"
                        : "h-4 w-4 shrink-0 text-text-muted transition-transform"
                    }
                    aria-hidden="true"
                  />
                  <h5 className="font-medium text-sm text-text-primary">
                    {t("editor.decisionsRuleN", "Rule {{n}}", { n: ri + 1 })}
                  </h5>
                </button>
                {broken && (
                  <Badge variant="error">
                    {t("editor.decisionsRuleBroken", "Broken")}
                  </Badge>
                )}
                <div className="ml-auto flex items-center">
                  <IconButton
                    label={t("editor.decisionsMoveUp", "Move up")}
                    disabled={ri === 0}
                    onClick={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        rules: moveItem(prev.rules, ri, ri - 1),
                      }))
                    }
                  >
                    <ArrowUp className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    label={t("editor.decisionsMoveDown", "Move down")}
                    disabled={ri === decisions.rules.length - 1}
                    onClick={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        rules: moveItem(prev.rules, ri, ri + 1),
                      }))
                    }
                  >
                    <ArrowDown className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    danger
                    label={t("editor.decisionsRemoveRule", "Remove rule")}
                    onClick={() =>
                      setDecisions((prev) => ({
                        ...prev,
                        rules: prev.rules.filter((_, n) => n !== ri),
                      }))
                    }
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </div>
              </div>
              {broken && (
                <p role="alert" className="text-error text-xs">
                  {t(
                    "editor.decisionsRuleBrokenHint",
                    "This rule names a question, an option or a level that no longer exists, so the agent cannot be saved until it points at one that does.",
                  )}
                </p>
              )}
              {rOpen && (
                <>
                  <div className="flex flex-col gap-2">
                    <span className="font-medium text-text-secondary text-xs uppercase tracking-wide">
                      {t("editor.decisionsWhen", "When")}
                    </span>
                    {rule.when.map((cond, ci) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional and carry no id
                      <div key={ci}>{conditionRow(ri, ci, cond)}</div>
                    ))}
                    {field(`rules.${ri}.when`) && (
                      <span role="alert" className="text-error text-xs">
                        {t(
                          "editor.decisionsNeedsCondition",
                          "Add at least one condition.",
                        )}
                      </span>
                    )}
                    <div>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={questionNames.length === 0}
                        onClick={() =>
                          setDecisions((prev) => ({
                            ...prev,
                            rules: prev.rules.map((r, n) =>
                              n === ri
                                ? {
                                    ...r,
                                    when: [
                                      ...r.when,
                                      conditionFor(
                                        prev,
                                        prev.questions
                                          .map((x) => x.name)
                                          .find(Boolean) ?? "",
                                      ),
                                    ],
                                  }
                                : r,
                            ),
                          }))
                        }
                      >
                        <Plus aria-hidden="true" />
                        {t("editor.decisionsAddCondition", "Add condition")}
                      </Button>
                    </div>
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="font-medium text-text-secondary text-xs uppercase tracking-wide">
                      {t("editor.decisionsThen", "Then")}
                    </span>
                    <FormField
                      label={t("editor.decisionsAction", "Action")}
                      error={field(`rules.${ri}.action.tool`)}
                    >
                      <Select
                        value={rule.tool}
                        onChange={(e) =>
                          // The attribute tool's schema asks for `value` even when it is empty.
                          setRule(ri, {
                            tool: e.target.value,
                            args:
                              e.target.value === "set_custom_attribute"
                                ? { value: "" }
                                : {},
                          })
                        }
                      >
                        {!DECISION_ACTION_TOOLS.includes(
                          rule.tool as "set_labels",
                        ) && (
                          <option value={rule.tool}>
                            {rule.tool === ""
                              ? t(
                                  "editor.decisionsPickAction",
                                  "Pick an action…",
                                )
                              : rule.tool}
                          </option>
                        )}
                        {DECISION_ACTION_TOOLS.map((tool) => (
                          <option key={tool} value={tool}>
                            {toolLabel(tool)}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    {actionFields(ri, rule)}
                    {gap && (
                      <span className="flex items-start gap-1.5 text-warning text-xs">
                        <TriangleAlert
                          className="mt-0.5 h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        {gap}
                      </span>
                    )}
                  </div>
                </>
              )}
              {!rOpen && (
                <p
                  className="text-text-secondary text-xs"
                  data-testid="decisions-rule-summary"
                >
                  {ruleSummary(rule)}
                </p>
              )}
              {activity && activity.decisions > 0 && (
                <p
                  className="text-text-muted text-xs"
                  data-testid="decisions-rule-activity"
                >
                  {rule.origin === null
                    ? t(
                        "editor.decisionsRuleNew",
                        "Not saved yet, so it has not decided anything.",
                      )
                    : ruleActivityText(t, counted, activity.decisions)}
                </p>
              )}
            </div>
          );
        })}
        {field("rules") && (
          <span role="alert" className="text-error text-xs">
            {at("rules")}
          </span>
        )}
        <div>
          <Button
            size="sm"
            variant="secondary"
            disabled={decisions.rules.length >= RULES_MAX}
            onClick={() =>
              setDecisions((prev) => ({
                ...prev,
                rules: [
                  ...prev.rules,
                  {
                    key: freshDecisionKey(),
                    origin: null,
                    when: [
                      prev.questions.some((x) => x.name)
                        ? conditionFor(
                            prev,
                            prev.questions.map((x) => x.name).find(Boolean) ??
                              "",
                          )
                        : emptyCondition(),
                    ],
                    tool: "set_labels",
                    args: {},
                  },
                ],
              }))
            }
          >
            <Plus aria-hidden="true" />
            {t("editor.decisionsAddRule", "Add rule")}
          </Button>
        </div>
      </div>
    </>
  );

  // Whatever the fields above did not draw is said here, so no problem that blocks the save is
  // silent: a problem at a path this screen has no input for, and a server refusal about one.
  const undrawn = [...issues]
    .filter(([path]) => !drawnPaths.has(path))
    .map(([path, issue]) => `${path}: ${issueText(t, issue)}`);
  const serverUndrawn =
    serverRefusal &&
    !drawnPaths.has(serverRefusal.path) &&
    !issues.has(serverRefusal.path)
      ? serverRefusal.message
      : null;

  return (
    <div className="flex flex-col gap-5" data-testid="decisions-fields">
      {(issues.size > 0 || serverUndrawn) && (
        <div
          role="alert"
          data-testid="decisions-problems"
          className="flex items-start gap-2 rounded-lg border border-error bg-error-soft px-3 py-2 text-text-primary text-xs"
        >
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-error"
            aria-hidden="true"
          />
          <div className="flex flex-col gap-1">
            {issues.size > 0 && (
              <span>
                {t(
                  "editor.decisionsProblems",
                  "{{count}} problems in the decisions engine keep this tab from being saved. Each is marked on its field below.",
                  { count: issues.size },
                )}
              </span>
            )}
            {undrawn.map((line) => (
              <span key={line}>{line}</span>
            ))}
            {serverUndrawn && <span>{serverUndrawn}</span>}
          </div>
        </div>
      )}
      {body}
    </div>
  );
}
