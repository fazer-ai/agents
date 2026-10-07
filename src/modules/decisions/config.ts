// What a monitoring agent on the `decisions` engine asks and does, configured under
// `agent.settings.monitoring.decisions` (docs/decisions.md). The engine itself is chosen by
// `monitoring.engine` (observe/settings.ts); this block is read only when that says `decisions`.
//
// Two readers of one shape: the zod schema below is the WRITE boundary (REST and MCP refuse a block
// the tick could not run, naming the field), and `readDecisionsConfig` is the TICK's reader, which
// answers a problem instead of throwing, because a row written before this schema existed, or by a
// path that skipped it, still reaches the tick and must stop there with a reason rather than act.

import { z } from "zod";

export const DECISION_PROVIDERS = ["openai", "typesafe"] as const;
export type DecisionProvider = (typeof DECISION_PROVIDERS)[number];

export const DECISION_QUESTION_TYPES = ["yes_no", "choice", "score"] as const;
export type DecisionQuestionType = (typeof DECISION_QUESTION_TYPES)[number];

// The tools a rule may run: the native writes a watcher already has, invoked through the same tool
// object the LLM observer calls, so every protection they carry applies unchanged.
export const DECISION_ACTION_TOOLS = [
  "set_labels",
  "handoff_to_human",
  "private_note",
  "set_custom_attribute",
] as const;
export type DecisionActionTool = (typeof DECISION_ACTION_TOOLS)[number];

export const DECISION_APPLY = ["shadow", "enforce"] as const;
export type DecisionApply = (typeof DECISION_APPLY)[number];

export const DEFAULT_DECISION_MODEL: Record<DecisionProvider, string> = {
  openai: "gpt-6-luna",
  typesafe: "jev-latest",
};

// TypeSafe allows up to 255 options per choice and 2-10 score levels (docs.typesafe.ai/api).
// OpenAI documents no limit; the narrower one holds for both so an agent can switch providers.
export const CHOICE_OPTIONS_MAX = 255;
export const SCORE_LEVELS_MIN = 2;
export const SCORE_LEVELS_MAX = 10;
export const QUESTIONS_MAX = 50;
export const RULES_MAX = 50;

export interface DecisionOption {
  value: string;
  description: string;
}

export type DecisionQuestion =
  | { name: string; type: "yes_no"; instructions: string }
  | {
      name: string;
      type: "choice";
      instructions: string;
      options: DecisionOption[];
    }
  | {
      name: string;
      type: "score";
      instructions: string;
      // Ordered lowest first; a level's index is its value.
      levels: DecisionOption[];
    };

export type DecisionCondition =
  | { question: string; minProbability: number }
  | { question: string; equals: string; minConfidence?: number }
  | {
      question: string;
      minLevel: number;
      maxLevel: number;
      minConfidence?: number;
    };

export interface DecisionRule {
  when: DecisionCondition[];
  action: { tool: DecisionActionTool; args: Record<string, unknown> };
}

export interface DecisionsConfig {
  provider: DecisionProvider;
  model: string;
  credentialRef: string;
  questions: DecisionQuestion[];
  rules: DecisionRule[];
  apply: DecisionApply;
}

// THE WRITE BOUNDARY. Loose objects so a key added later round-trips, and cross-field checks (a rule
// naming a question that does not exist, a condition that does not fit its question's type) in one
// refinement, so the 400 names the exact path the operator has to fix.
const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const option = z.looseObject({
  value: z.string().min(1),
  description: z.string(),
});
const question = z.looseObject({
  name,
  type: z.enum(DECISION_QUESTION_TYPES),
  instructions: z.string().min(1),
  options: z.array(option).min(2).max(CHOICE_OPTIONS_MAX).optional(),
  levels: z
    .array(option)
    .min(SCORE_LEVELS_MIN)
    .max(SCORE_LEVELS_MAX)
    .optional(),
});
const unit = z.number().min(0).max(1);
const condition = z.looseObject({
  question: name,
  minProbability: unit.optional(),
  equals: z.string().min(1).optional(),
  minConfidence: unit.optional(),
  minLevel: z.number().int().min(0).optional(),
  maxLevel: z.number().int().min(0).optional(),
});
const rule = z.looseObject({
  when: z.array(condition).min(1),
  action: z.looseObject({
    tool: z.enum(DECISION_ACTION_TOOLS),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const decisionsSchema = z
  .looseObject({
    provider: z.enum(DECISION_PROVIDERS),
    model: z.string().min(1).optional(),
    credentialRef: z.string().min(1),
    questions: z.array(question).min(1).max(QUESTIONS_MAX),
    rules: z.array(rule).max(RULES_MAX).optional(),
    apply: z.enum(DECISION_APPLY).optional(),
  })
  .superRefine((v, ctx) => {
    for (const p of crossFieldProblems(v as unknown as RawDecisions)) {
      ctx.addIssue({ code: "custom", path: p.path, message: p.message });
    }
  });

interface RawDecisions {
  questions?: {
    name?: unknown;
    type?: unknown;
    options?: unknown[];
    levels?: unknown[];
  }[];
  rules?: { when?: Record<string, unknown>[] }[];
}

interface Problem {
  path: (string | number)[];
  message: string;
}

// What a block can get wrong across fields. Shared by the schema (write) and the reader (tick).
// A MISSING field is reported at the object that lacks it, never at the absent key: the write
// boundary refuses only what a write introduces or changes, compared by value at the issue's path,
// and an absent key compares equal to an absent stored key, so an issue there would never refuse.
function crossFieldProblems(v: RawDecisions): Problem[] {
  const out: Problem[] = [];
  const byName = new Map<string, { type: unknown; size: number }>();
  for (const [i, q] of (v.questions ?? []).entries()) {
    if (typeof q?.name !== "string") continue;
    if (byName.has(q.name)) {
      out.push({
        path: ["questions", i, "name"],
        message: `question name "${q.name}" is repeated`,
      });
    }
    if (q.type === "choice" && !Array.isArray(q.options)) {
      out.push({
        path: ["questions", i],
        message: "a choice question needs options",
      });
    }
    if (q.type === "score" && !Array.isArray(q.levels)) {
      out.push({
        path: ["questions", i],
        message: "a score question needs levels",
      });
    }
    byName.set(q.name, {
      type: q.type,
      size: Array.isArray(q.levels) ? q.levels.length : 0,
    });
  }
  for (const [r, rl] of (v.rules ?? []).entries()) {
    for (const [c, cond] of (rl?.when ?? []).entries()) {
      const at = ["rules", r, "when", c];
      const q = byName.get(String(cond?.question));
      if (!q) {
        out.push({
          path: [...at, "question"],
          message: `no question named "${String(cond?.question)}"`,
        });
        continue;
      }
      if (q.type === "yes_no" && typeof cond.minProbability !== "number") {
        out.push({
          path: at,
          message: "a yes_no condition needs minProbability",
        });
      }
      if (q.type === "choice" && typeof cond.equals !== "string") {
        out.push({
          path: at,
          message: "a choice condition needs equals",
        });
      }
      if (q.type === "score") {
        const lo = cond.minLevel;
        const hi = cond.maxLevel;
        if (typeof lo !== "number" || typeof hi !== "number" || lo > hi) {
          out.push({
            path: at,
            message: "a score condition needs minLevel <= maxLevel",
          });
        } else if (hi >= q.size) {
          out.push({
            path: [...at, "maxLevel"],
            message: `the question has ${q.size} levels (0 to ${q.size - 1})`,
          });
        }
      }
    }
  }
  return out;
}

export type DecisionsReading =
  | { ok: true; config: DecisionsConfig }
  | { ok: false; problem: string };

// THE TICK'S READER: the same rules as the schema, answered as a problem rather than thrown. The
// first problem is enough: the tick stops on it and the operator fixes the block.
export function readDecisionsConfig(monitoring: unknown): DecisionsReading {
  const bag =
    monitoring && typeof monitoring === "object"
      ? (monitoring as Record<string, unknown>).decisions
      : undefined;
  if (bag === undefined || bag === null) {
    return { ok: false, problem: "monitoring.decisions is missing" };
  }
  const parsed = decisionsSchema.safeParse(bag);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = ["monitoring", "decisions", ...(issue?.path ?? [])]
      .map(String)
      .join(".");
    return { ok: false, problem: `${path}: ${issue?.message ?? "invalid"}` };
  }
  const v = parsed.data;
  const provider = v.provider as DecisionProvider;
  const questions: DecisionQuestion[] = v.questions.map((q) => {
    const base = { name: q.name, instructions: q.instructions };
    if (q.type === "choice") {
      return { ...base, type: "choice", options: (q.options ?? []).map(opt) };
    }
    if (q.type === "score") {
      return { ...base, type: "score", levels: (q.levels ?? []).map(opt) };
    }
    return { ...base, type: "yes_no" };
  });
  const types = new Map(questions.map((q) => [q.name, q.type]));
  const rules: DecisionRule[] = (v.rules ?? []).map((r) => ({
    when: r.when.map((c) => conditionFor(c, types.get(c.question))),
    action: {
      tool: r.action.tool as DecisionActionTool,
      args: (r.action.args ?? {}) as Record<string, unknown>,
    },
  }));
  return {
    ok: true,
    config: {
      provider,
      model: v.model ?? DEFAULT_DECISION_MODEL[provider],
      credentialRef: v.credentialRef,
      questions,
      rules,
      apply: v.apply === "enforce" ? "enforce" : "shadow",
    },
  };
}

function opt(o: { value: string; description: string }): DecisionOption {
  return { value: o.value, description: o.description };
}

// Only the fields the question's type reads: a stray `equals` on a yes_no condition is not a second
// test the operator thinks is applied.
function conditionFor(
  c: {
    question: string;
    minProbability?: number;
    equals?: string;
    minConfidence?: number;
    minLevel?: number;
    maxLevel?: number;
  },
  type: DecisionQuestionType | undefined,
): DecisionCondition {
  if (type === "choice") {
    return {
      question: c.question,
      equals: c.equals ?? "",
      ...(c.minConfidence !== undefined
        ? { minConfidence: c.minConfidence }
        : {}),
    };
  }
  if (type === "score") {
    return {
      question: c.question,
      minLevel: c.minLevel ?? 0,
      maxLevel: c.maxLevel ?? 0,
      ...(c.minConfidence !== undefined
        ? { minConfidence: c.minConfidence }
        : {}),
    };
  }
  return { question: c.question, minProbability: c.minProbability ?? 1 };
}
