import { QUESTIONS_MAX, RULES_MAX } from "@/modules/decisions/config";
import {
  type DecisionQuestionForm,
  type DecisionRuleForm,
  type DecisionsForm,
  emptyCondition,
  freshDecisionKey,
} from "./decisionsFormState";

// The starting points of a decisions agent (agents#1224): a question and its rules, added to the
// DRAFT in one click so a new agent does not open on an empty list. Nothing is written by adding
// one: the stored block keeps requiring at least one question, and the Save is what writes.
// The words (labels, levels, options, the question itself) come from the caller in the console's
// language, so what lands in the conversation reads like the rest of the account.

export const DECISIONS_STARTERS = ["sentiment", "subject", "human"] as const;
export type DecisionsStarter = (typeof DECISIONS_STARTERS)[number];

export interface StarterNames {
  // Five, lowest first, as the operator reads them.
  sentimentLevels: string[];
  // One label per level, in the same order.
  sentimentLabels: string[];
  subjectOptions: string[];
  // The conversation attribute the subject is written to.
  subjectAttribute: string;
  humanLabel: string;
  sentimentQuestion: string;
  subjectQuestion: string;
  humanQuestion: string;
  // How rules and logs name each question. Defaults to English identifiers.
  questionNames?: Partial<Record<DecisionsStarter, string>>;
}

const DEFAULT_QUESTION_NAMES: Record<DecisionsStarter, string> = {
  sentiment: "sentiment",
  subject: "subject",
  human: "asks_human",
};

function questionName(kind: DecisionsStarter, names?: StarterNames): string {
  return names?.questionNames?.[kind] ?? DEFAULT_QUESTION_NAMES[kind];
}

// An option value from a word the operator reads: what a rule matches on, so it is kept plain.
function slug(word: string): string {
  return (
    word
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "option"
  );
}

export function starterApplied(
  form: DecisionsForm,
  kind: DecisionsStarter,
  names?: StarterNames,
): boolean {
  const name = questionName(kind, names);
  return form.questions.some((q) => q.name === name);
}

function rule(
  when: DecisionRuleForm["when"],
  tool: string,
  args: Record<string, unknown>,
): DecisionRuleForm {
  return { key: freshDecisionKey(), origin: null, when, tool, args };
}

function starterOf(
  kind: DecisionsStarter,
  names: StarterNames,
): { question: DecisionQuestionForm; rules: DecisionRuleForm[] } {
  const name = questionName(kind, names);
  const base = {
    key: freshDecisionKey(),
    name,
    options: [] as DecisionQuestionForm["options"],
    levels: [] as DecisionQuestionForm["levels"],
  };
  if (kind === "sentiment") {
    const levels = names.sentimentLevels.map((l) => ({
      value: slug(l),
      description: l,
    }));
    return {
      question: {
        ...base,
        type: "score",
        instructions: names.sentimentQuestion,
        levels,
      },
      rules: names.sentimentLabels.map((label, i) =>
        rule(
          [
            {
              ...emptyCondition(name),
              minLevel: String(i),
              maxLevel: String(i),
            },
          ],
          "set_labels",
          {
            add: [label],
            remove: names.sentimentLabels.filter((_, n) => n !== i),
          },
        ),
      ),
    };
  }
  if (kind === "subject") {
    const options = names.subjectOptions.map((o) => ({
      value: slug(o),
      description: o,
    }));
    return {
      question: {
        ...base,
        type: "choice",
        instructions: names.subjectQuestion,
        options,
      },
      rules: options.map((o) =>
        rule(
          [{ ...emptyCondition(name), equals: o.value, minConfidence: "0.6" }],
          "set_custom_attribute",
          { key: names.subjectAttribute, value: o.value },
        ),
      ),
    };
  }
  return {
    question: {
      ...base,
      type: "yes_no",
      instructions: names.humanQuestion,
    },
    rules: [
      rule([{ ...emptyCondition(name), minProbability: "0.7" }], "set_labels", {
        add: [names.humanLabel],
      }),
    ],
  };
}

// Whether the starter's question and rules fit under the block's limits: a starter that would
// pass them leaves a draft the server refuses, so it is not offered.
export function starterFits(
  form: DecisionsForm,
  kind: DecisionsStarter,
  names: StarterNames,
): boolean {
  return (
    form.questions.length + 1 <= QUESTIONS_MAX &&
    form.rules.length + starterOf(kind, names).rules.length <= RULES_MAX
  );
}

// The form with the starter's question and rules added after what it already holds. Adding one the
// form already has, or one that does not fit, adds nothing: two questions under one name, or a block
// past its limits, is a block the server refuses.
export function withStarter(
  form: DecisionsForm,
  kind: DecisionsStarter,
  names: StarterNames,
): DecisionsForm {
  if (starterApplied(form, kind, names) || !starterFits(form, kind, names)) {
    return form;
  }
  const s = starterOf(kind, names);
  return {
    ...form,
    questions: [...form.questions, s.question],
    rules: [...form.rules, ...s.rules],
  };
}
