// From answers to actions, the deterministic half of the `decisions` engine: a rule fires when EVERY
// one of its conditions holds (AND), and a condition holds only on an answer that crossed it. What
// did not fire says why, per condition, because "the engine did nothing" is the outcome an operator
// tunes thresholds against.

import { isDeepStrictEqual } from "node:util";
import type {
  DecisionActionTool,
  DecisionCondition,
  DecisionRule,
} from "./config";
import type { DecisionAnswer } from "./providers";

export interface FiredAction {
  rule: number;
  tool: DecisionActionTool;
  args: Record<string, unknown>;
}

export type ConditionMiss =
  | { question: string; why: "unanswered" | "refused" }
  | {
      question: string;
      why: "below_threshold";
      got: number | null;
      threshold: number;
      measure: "probability" | "confidence";
    }
  | { question: string; why: "other_choice"; got: string; expected: string }
  | {
      question: string;
      why: "outside_levels";
      got: number;
      minLevel: number;
      maxLevel: number;
    };

export interface RuleOutcome {
  // One entry per action to run, deduplicated: two rules firing the same tool with the same
  // arguments are one write, not two transfers (the second would be a no-op at best and a second
  // private note at worst).
  fired: FiredAction[];
  // Rules that did not fire, with the first condition that failed.
  missed: { rule: number; miss: ConditionMiss }[];
}

export function evaluateRules(
  rules: DecisionRule[],
  answers: Record<string, DecisionAnswer>,
): RuleOutcome {
  const fired: FiredAction[] = [];
  const missed: RuleOutcome["missed"] = [];
  for (const [i, rule] of rules.entries()) {
    let miss: ConditionMiss | null = null;
    for (const c of rule.when) {
      miss = checkCondition(c, answers[c.question]);
      if (miss) break;
    }
    if (miss) {
      missed.push({ rule: i, miss });
      continue;
    }
    const dup = fired.some(
      (f) =>
        f.tool === rule.action.tool &&
        isDeepStrictEqual(f.args, rule.action.args),
    );
    if (!dup) {
      fired.push({ rule: i, tool: rule.action.tool, args: rule.action.args });
    }
  }
  return { fired, missed };
}

function checkCondition(
  c: DecisionCondition,
  a: DecisionAnswer | undefined,
): ConditionMiss | null {
  if (a === undefined) return { question: c.question, why: "unanswered" };
  if (a.type === "refusal") return { question: c.question, why: "refused" };
  if ("minProbability" in c) {
    if (a.type !== "yes_no") return { question: c.question, why: "unanswered" };
    return a.probability >= c.minProbability
      ? null
      : {
          question: c.question,
          why: "below_threshold",
          got: a.probability,
          threshold: c.minProbability,
          measure: "probability",
        };
  }
  if ("equals" in c) {
    if (a.type !== "choice") return { question: c.question, why: "unanswered" };
    if (a.choice !== c.equals) {
      return {
        question: c.question,
        why: "other_choice",
        got: a.choice,
        expected: c.equals,
      };
    }
    return confidenceMiss(c.question, a.confidence, c.minConfidence);
  }
  if (a.type !== "score") return { question: c.question, why: "unanswered" };
  // The score is a probability-weighted mean of level indices, so it falls between levels: it is read
  // as the nearest level, which is what "levels 1 to 2" means to whoever wrote the rule.
  const level = Math.round(a.score);
  if (level < c.minLevel || level > c.maxLevel) {
    return {
      question: c.question,
      why: "outside_levels",
      got: a.score,
      minLevel: c.minLevel,
      maxLevel: c.maxLevel,
    };
  }
  return confidenceMiss(c.question, a.confidence, c.minConfidence);
}

// A provider that omits confidence does not pass a rule that asks for one: an unknown is not a high.
function confidenceMiss(
  question: string,
  got: number | null,
  min: number | undefined,
): ConditionMiss | null {
  if (min === undefined) return null;
  if (got !== null && got >= min) return null;
  return {
    question,
    why: "below_threshold",
    got,
    threshold: min,
    measure: "confidence",
  };
}
