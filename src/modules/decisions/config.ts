// What a monitoring agent on the `decisions` engine asks and does, configured under
// `agent.settings.monitoring.decisions` (docs/decisions.md). The engine itself is chosen by
// `monitoring.engine` (observe/settings.ts); this block is read only when that says `decisions`.
//
// Two readers of one shape: the zod schema below is the WRITE boundary (REST and MCP refuse a block
// the tick could not run, naming the field), and `readDecisionsConfig` is the TICK's reader, which
// answers a problem instead of throwing, because a row written before this schema existed, or by a
// path that skipped it, still reaches the tick and must stop there with a reason rather than act.

import { z } from "zod";
import { NATIVE_TOOL_NAMES, RAG_TOOL_NAMES } from "@/graph/tools/catalog";
import { ANSWER_FIELD_QUESTION, parseFieldSource } from "./tool-args";

export const DECISION_PROVIDERS = ["openai", "typesafe"] as const;
export type DecisionProvider = (typeof DECISION_PROVIDERS)[number];

export const DECISION_QUESTION_TYPES = ["yes_no", "choice", "score"] as const;
export type DecisionQuestionType = (typeof DECISION_QUESTION_TYPES)[number];

// The NATIVE tools a rule may run: the writes a watcher already has, invoked through the same tool
// object the LLM observer calls, so every protection they carry applies unchanged. A rule may also
// run a custom tool granted to the agent (HTTP, code, MCP) by the name the model knows it by, its
// arguments fixed or filled from the observation (./tool-args.ts); the write boundary checks the
// name and the arguments against the tenant's tools (agents/service.ts).
export const DECISION_ACTION_TOOLS = [
  "set_labels",
  "handoff_to_human",
  "private_note",
  "set_custom_attribute",
] as const;
export type DecisionActionTool = (typeof DECISION_ACTION_TOOLS)[number];

export function isNativeDecisionTool(tool: string): tool is DecisionActionTool {
  return (DECISION_ACTION_TOOLS as readonly string[]).includes(tool);
}

// A tool name as the model receives it (normalizeToolName, `mcp__<server>__<tool>`).
export const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// The built-in tools a rule may NOT run: the natives that answer or deliver, and knowledge search.
// A custom tool never carries one of these names: its service refuses a built-in's name.
const BUILT_IN_NOT_A_RULE: ReadonlySet<string> = new Set(
  [...NATIVE_TOOL_NAMES, ...RAG_TOOL_NAMES].filter(
    (n) => !isNativeDecisionTool(n),
  ),
);

// WHEN A RULE ACTS while its conditions keep holding. `each_time`: on every observation
// in which they hold. `on_start`: on the observation where they start holding, and again only after
// one in which they did not. `once`: the first time, never again in that conversation. The default
// follows what the action does: a write that converges (the second identical one changes nothing)
// acts each time; one that adds something (a note, a handoff) would repeat itself, so it acts when
// the conditions start holding.
export const DECISION_TRIGGERS = ["each_time", "on_start", "once"] as const;
export type DecisionTrigger = (typeof DECISION_TRIGGERS)[number];

const CONVERGENT_ACTIONS: ReadonlySet<string> = new Set([
  "set_labels",
  "set_custom_attribute",
]);

export function defaultTriggerFor(tool: string): DecisionTrigger {
  return CONVERGENT_ACTIONS.has(tool) ? "each_time" : "on_start";
}

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

export interface DecisionAction {
  tool: string;
  // Fixed arguments, as written.
  args: Record<string, unknown>;
  // Filled arguments, custom tools only: argument name -> field source (./tool-args.ts).
  fill?: Record<string, string>;
}

export interface DecisionRule {
  when: DecisionCondition[];
  action: DecisionAction;
  // The stored choice; absent, the action's default (`triggerOf`).
  trigger?: DecisionTrigger;
}

export function triggerOf(rule: DecisionRule): DecisionTrigger {
  return rule.trigger ?? defaultTriggerFor(rule.action.tool);
}

export interface DecisionsConfig {
  provider: DecisionProvider;
  model: string;
  credentialRef: string;
  questions: DecisionQuestion[];
  rules: DecisionRule[];
}

// THE WRITE BOUNDARY. Loose objects so a key added later round-trips; cross-field checks in one
// refinement, so the 400 names the exact path to fix. Every field is optional to zod and presence is
// asked in the refinement, reported at the object that lacks the field: the boundary compares by value
// at the issue's path, and an absent key equals an absent stored key (docs/decisions.md).
const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const option = z.looseObject({
  value: z.string().min(1).optional(),
  description: z.string().optional(),
});
const question = z.looseObject({
  name: name.optional(),
  type: z.enum(DECISION_QUESTION_TYPES).optional(),
  instructions: z.string().min(1).optional(),
  options: z.array(option).min(2).max(CHOICE_OPTIONS_MAX).optional(),
  levels: z
    .array(option)
    .min(SCORE_LEVELS_MIN)
    .max(SCORE_LEVELS_MAX)
    .optional(),
});
const unit = z.number().min(0).max(1);
const condition = z.looseObject({
  question: name.optional(),
  minProbability: unit.optional(),
  equals: z.string().min(1).optional(),
  minConfidence: unit.optional(),
  // A level is an index into `levels`, so at most the last one.
  minLevel: z
    .number()
    .int()
    .min(0)
    .max(SCORE_LEVELS_MAX - 1)
    .optional(),
  maxLevel: z
    .number()
    .int()
    .min(0)
    .max(SCORE_LEVELS_MAX - 1)
    .optional(),
});
const rule = z.looseObject({
  when: z.array(condition).min(1).optional(),
  action: z
    .looseObject({
      tool: z
        .string()
        .regex(TOOL_NAME)
        .refine((t) => !BUILT_IN_NOT_A_RULE.has(t), {
          message: "a rule runs the watcher's writes or a custom tool",
          params: { problem: "invalid_value" },
        })
        .optional(),
      args: z.record(z.string(), z.unknown()).optional(),
      fill: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  trigger: z.enum(DECISION_TRIGGERS).optional(),
});

// Keys the block no longer has, refused by name rather than kept and ignored like any other unknown
// key, so a client written against the old shape learns why. `apply` (rehearsal or live) went with
// the simulation mode: every rule that fires runs. An import drops it instead (withoutRemovedDecisionFields).
const REMOVED_FIELDS = ["apply"] as const;

// THE MCP PATCH: the same fields without the cross-field refinement, since a patch is merged into
// the stored block before it is whole. The merged block is then asked `decisionsSchema`.
export const decisionsPatchSchema = z
  .looseObject({
    provider: z.enum(DECISION_PROVIDERS).optional(),
    model: z.string().min(1).optional(),
    credentialRef: z.string().min(1).optional(),
    questions: z.array(question).min(1).max(QUESTIONS_MAX).optional(),
    rules: z.array(rule).max(RULES_MAX).optional(),
  })
  .superRefine((v, ctx) => {
    for (const key of REMOVED_FIELDS) {
      if (key in v) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `Unknown field "${key}": the simulation mode was removed, and every rule that fires runs. Remove the field.`,
          params: { problem: "unknown_field" },
        });
      }
    }
  });

export const decisionsSchema = decisionsPatchSchema.superRefine((v, ctx) => {
  for (const p of crossFieldProblems(v as unknown as RawDecisions)) {
    // `wholeBlock`: a cross-field problem is a change wherever the block changed, not only at the
    // path it names (a renamed option breaks the unchanged rule that names it). The write boundary
    // compares at the schema's root, `wholeBlock` levels above the issue's path.
    ctx.addIssue({
      code: "custom",
      path: p.path,
      message: p.message,
      params: { wholeBlock: p.path.length, problem: p.code, ...p.params },
    });
  }
});

type Bag = Record<string, unknown>;
interface RawDecisions {
  provider?: unknown;
  credentialRef?: unknown;
  questions?: {
    name?: unknown;
    type?: unknown;
    instructions?: unknown;
    options?: Bag[];
    levels?: Bag[];
  }[];
  rules?: { when?: Bag[]; action?: Bag }[];
}

// `code` and `params` say the same thing as `message` in a form a screen can translate: the console
// runs this schema before a save (docs/decisions.md, "The console") and words each problem in the
// operator's language, so it reads the code and never parses the sentence.
export type DecisionsProblemCode =
  | "required"
  | "repeated_value"
  | "repeated_name"
  | "choice_needs_options"
  | "score_needs_levels"
  | "unknown_question"
  | "needs_min_probability"
  | "needs_equals"
  | "unknown_option"
  | "needs_level_range"
  | "level_out_of_range"
  | "fill_on_native"
  | "arg_twice"
  | "unknown_field_source"
  | "fill_question_type";

interface Problem {
  path: (string | number)[];
  message: string;
  code: DecisionsProblemCode;
  params?: Record<string, string | number>;
}

// What a block can get wrong across fields. Shared by the schema (write) and the reader (tick).
// A MISSING field is reported at the object that lacks it, never at the absent key: the write
// boundary refuses only what a write introduces or changes, compared by value at the issue's path,
// and an absent key compares equal to an absent stored key, so an issue there would never refuse.
function crossFieldProblems(v: RawDecisions): Problem[] {
  const out: Problem[] = [];
  const need = (
    bag: Bag | undefined,
    keys: string[],
    path: (string | number)[],
  ) => {
    for (const k of keys) {
      if (bag?.[k] === undefined) {
        out.push({
          path,
          message: `${k} is required`,
          code: "required",
          params: { key: k },
        });
      }
    }
  };
  need(v as Bag, ["provider", "credentialRef", "questions"], []);
  for (const [i, q] of (v.questions ?? []).entries()) {
    need(q, ["name", "type", "instructions"], ["questions", i]);
    for (const key of ["options", "levels"] as const) {
      for (const [j, o] of (q?.[key] ?? []).entries()) {
        need(o, ["value", "description"], ["questions", i, key, j]);
      }
      const seen = new Set<unknown>();
      for (const [j, o] of (q?.[key] ?? []).entries()) {
        if (typeof o?.value !== "string") continue;
        if (seen.has(o.value)) {
          out.push({
            path: ["questions", i, key, j, "value"],
            message: `"${o.value}" is repeated`,
            code: "repeated_value",
            params: { value: o.value },
          });
        }
        seen.add(o.value);
      }
    }
  }
  for (const [r, rl] of (v.rules ?? []).entries()) {
    need(rl, ["when", "action"], ["rules", r]);
    if (rl?.action) need(rl.action, ["tool"], ["rules", r, "action"]);
    for (const [c, cond] of (rl?.when ?? []).entries()) {
      need(cond, ["question"], ["rules", r, "when", c]);
    }
  }
  const byName = new Map<
    string,
    { type: unknown; size: number; options: Set<unknown> }
  >();
  for (const [i, q] of (v.questions ?? []).entries()) {
    if (typeof q?.name !== "string") continue;
    if (byName.has(q.name)) {
      out.push({
        path: ["questions", i, "name"],
        message: `question name "${q.name}" is repeated`,
        code: "repeated_name",
        params: { value: q.name },
      });
    }
    if (q.type === "choice" && !Array.isArray(q.options)) {
      out.push({
        path: ["questions", i],
        message: "a choice question needs options",
        code: "choice_needs_options",
      });
    }
    if (q.type === "score" && !Array.isArray(q.levels)) {
      out.push({
        path: ["questions", i],
        message: "a score question needs levels",
        code: "score_needs_levels",
      });
    }
    byName.set(q.name, {
      type: q.type,
      size: Array.isArray(q.levels) ? q.levels.length : 0,
      options: new Set(
        Array.isArray(q.options) ? q.options.map((o) => o?.value) : [],
      ),
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
          code: "unknown_question",
          params: { value: String(cond?.question) },
        });
        continue;
      }
      if (q.type === "yes_no" && typeof cond.minProbability !== "number") {
        out.push({
          path: at,
          message: "a yes_no condition needs minProbability",
          code: "needs_min_probability",
        });
      }
      if (q.type === "choice" && typeof cond.equals !== "string") {
        out.push({
          path: at,
          message: "a choice condition needs equals",
          code: "needs_equals",
        });
      } else if (q.type === "choice" && !q.options.has(cond.equals)) {
        out.push({
          path: [...at, "equals"],
          message: `"${String(cond.equals)}" is not one of the question's options`,
          code: "unknown_option",
          params: { value: String(cond.equals) },
        });
      }
      if (q.type === "score") {
        const lo = cond.minLevel;
        const hi = cond.maxLevel;
        if (typeof lo !== "number" || typeof hi !== "number" || lo > hi) {
          out.push({
            path: at,
            message: "a score condition needs minLevel <= maxLevel",
            code: "needs_level_range",
          });
        } else if (hi >= q.size) {
          out.push({
            path: [...at, "maxLevel"],
            message: `the question has ${q.size} levels (0 to ${q.size - 1})`,
            code: "level_out_of_range",
            params: { size: q.size },
          });
        }
      }
    }
  }
  for (const [r, rl] of (v.rules ?? []).entries()) {
    const action = rl?.action;
    const fill = action?.fill;
    if (!fill || typeof fill !== "object") continue;
    const at = ["rules", r, "action", "fill"];
    if (
      typeof action.tool === "string" &&
      isNativeDecisionTool(action.tool) &&
      Object.keys(fill).length > 0
    ) {
      out.push({
        path: at,
        message: `${action.tool} takes its arguments as written; only a custom tool fills them from the observation`,
        code: "fill_on_native",
      });
      continue;
    }
    const args =
      action.args && typeof action.args === "object"
        ? (action.args as Bag)
        : {};
    for (const [arg, raw] of Object.entries(fill as Bag)) {
      if (Object.hasOwn(args, arg)) {
        out.push({
          path: [...at, arg],
          message: `argument "${arg}" is both fixed and filled`,
          code: "arg_twice",
          params: { key: arg },
        });
      }
      const source = parseFieldSource(raw);
      if (!source) {
        out.push({
          path: [...at, arg],
          message: `"${String(raw)}" is not a field the observation knows`,
          code: "unknown_field_source",
          params: { key: arg, value: String(raw) },
        });
        continue;
      }
      if (source.kind !== "answer") continue;
      const q = byName.get(source.question);
      if (!q) {
        out.push({
          path: [...at, arg],
          message: `no question named "${source.question}"`,
          code: "unknown_question",
          params: { key: arg, value: source.question },
        });
      } else if (q.type !== ANSWER_FIELD_QUESTION[source.field]) {
        out.push({
          path: [...at, arg],
          message: `"${source.field}" is the answer of a ${ANSWER_FIELD_QUESTION[source.field]} question, and "${source.question}" is a ${String(q.type)} one`,
          code: "fill_question_type",
          params: { key: arg, value: source.question },
        });
      }
    }
  }
  return out;
}

// Every problem the write boundary would refuse a block for, in the shape a form can place and word:
// the path to the field (or to the object lacking one), a stable code, and the numbers a sentence
// about it needs. The SAME parse the boundary runs, so a form that asks this cannot disagree with it.
export interface DecisionsIssue {
  path: (string | number)[];
  code: string;
  message: string;
  params: Record<string, string | number>;
}

export function decisionsIssues(block: unknown): DecisionsIssue[] {
  const parsed = decisionsSchema.safeParse(block);
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => {
    const raw = issue as unknown as Record<string, unknown>;
    const custom = (raw.params ?? {}) as Record<string, unknown>;
    const params: Record<string, string | number> = {};
    const source = issue.code === "custom" ? custom : raw;
    for (const k of ["key", "value", "size", "minimum", "maximum", "origin"]) {
      const v = source[k];
      if (typeof v === "string" || typeof v === "number") params[k] = v;
    }
    return {
      path: issue.path.filter(
        (s): s is string | number =>
          typeof s === "string" || typeof s === "number",
      ),
      code:
        issue.code === "custom" && typeof custom.problem === "string"
          ? custom.problem
          : String(issue.code),
      message: issue.message,
      params,
    };
  });
}

export type DecisionsReading =
  | { ok: true; config: DecisionsConfig }
  | { ok: false; problem: string };

// THE TICK'S READER: the same rules as the schema, answered as a problem rather than thrown. The
// first problem is enough: the tick stops on it and the operator fixes the block.
// A level only means something on a score question, and `conditionFor` drops it from any other; a
// stray one stored before the levels were capped must not fail the whole block on read.
function withoutInapplicableLevels(bag: unknown): unknown {
  if (!bag || typeof bag !== "object") return bag;
  const b = bag as { questions?: unknown; rules?: unknown };
  if (!Array.isArray(b.rules)) return bag;
  const scored = new Set(
    (Array.isArray(b.questions) ? b.questions : [])
      .filter((q) => q && typeof q === "object" && q.type === "score")
      .map((q) => q.name),
  );
  const rules = b.rules.map((rule) => {
    if (!rule || typeof rule !== "object" || !Array.isArray(rule.when))
      return rule;
    const when = rule.when.map((cond: unknown) => {
      if (!cond || typeof cond !== "object") return cond;
      const c = cond as Record<string, unknown>;
      if (scored.has(c.question)) return cond;
      const { minLevel: _min, maxLevel: _max, ...rest } = c;
      return rest;
    });
    return { ...rule, when };
  });
  return { ...b, rules };
}

export function readDecisionsConfig(monitoring: unknown): DecisionsReading {
  const bag =
    monitoring && typeof monitoring === "object"
      ? (monitoring as Record<string, unknown>).decisions
      : undefined;
  if (bag === undefined || bag === null) {
    return { ok: false, problem: "monitoring.decisions is missing" };
  }
  const parsed = decisionsSchema.safeParse(withoutInapplicableLevels(bag));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = ["monitoring", "decisions", ...(issue?.path ?? [])]
      .map(String)
      .join(".");
    return { ok: false, problem: `${path}: ${issue?.message ?? "invalid"}` };
  }
  // Presence was asked by the refinement, so the `?? ""` below never supplies a value; it only tells
  // the type system what the parse already established.
  const v = parsed.data;
  const provider = v.provider as DecisionProvider;
  const questions: DecisionQuestion[] = (v.questions ?? []).map((q) => {
    const base = { name: q.name ?? "", instructions: q.instructions ?? "" };
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
    when: (r.when ?? []).map((c) =>
      conditionFor(
        { ...c, question: c.question ?? "" },
        types.get(c.question ?? ""),
      ),
    ),
    action: {
      tool: r.action?.tool ?? "",
      args: (r.action?.args ?? {}) as Record<string, unknown>,
      ...(r.action?.fill !== undefined && Object.keys(r.action.fill).length > 0
        ? // Every value is a source the refinement parsed, so a string.
          { fill: r.action.fill as Record<string, string> }
        : {}),
    },
    ...(r.trigger !== undefined ? { trigger: r.trigger } : {}),
  }));
  return {
    ok: true,
    config: {
      provider,
      model: v.model ?? DEFAULT_DECISION_MODEL[provider],
      credentialRef: v.credentialRef ?? "",
      questions,
      rules,
    },
  };
}

// WHICH QUESTIONS AND RULES A TICK RAN, as a short stable mark the tick writes on its log line
// (`block`). A line names a rule by its index, and an index means nothing without the list it
// indexes: a tick that was in flight while the rules were reordered finishes after the save and
// would otherwise be read against the new order. Whoever counts lines (the console's "what it has
// been doing") compares this mark with the block it is showing and counts only the lines that ran
// it. Over the questions and rules alone, so changing the classifier or its key keeps the history.
// Keys are sorted at every level: the stored block comes back from `jsonb` in its own key order.
export function decisionsFingerprint(
  config: Pick<DecisionsConfig, "questions" | "rules">,
): string {
  // A rule's trigger is left out: it changes when the rule acts, not what its index means, so
  // choosing one keeps the history the console counts.
  return markOf(
    canon({
      questions: config.questions,
      rules: config.rules.map(({ when, action }) => ({ when, action })),
    }),
  );
}

function canon(v: unknown): unknown {
  return Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, x]) => [k, canon(x)]),
        )
      : v;
}

function markOf(value: unknown): string {
  const text = JSON.stringify(value);
  // FNV-1a, twice with different offsets: not a secret, only a mark two honest sides compute.
  const fnv = (seed: number) => {
    let h = seed;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  };
  return fnv(0x811c9dc5) + fnv(0x01234567);
}

// WHICH RULE A TRIGGER'S STATE BELONGS TO (decision_rule_states): its conditions, its action and
// its trigger, not its index. Editing any of them is a different rule whose state starts empty, a
// reorder keeps every rule's state, and editing one rule leaves the others' alone.
export function ruleStateKey(rule: DecisionRule): string {
  return markOf(
    canon({ when: rule.when, action: rule.action, trigger: triggerOf(rule) }),
  );
}

// The same mark for a stored block, or null when the block could not run (no tick ran it).
export function decisionsBlockFingerprint(block: unknown): string | null {
  const read = readDecisionsConfig({ decisions: block });
  return read.ok ? decisionsFingerprint(read.config) : null;
}

function opt(o: { value?: string; description?: string }): DecisionOption {
  return { value: o.value ?? "", description: o.description ?? "" };
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

// THE BLOCK AS EVERY REWRITE OF `monitoring` CARRIES IT (the MCP merge, the console's save, the audit
// projection): the declared fields only, picked by name at every level. The schema is loose, so a
// stored block may hold any key; one the engine does not read (an `apiKey` pasted beside the ref)
// must not travel on into an audit row. `action.args` is the tool's own input and goes as written, and
// `action.fill` names fields, never their values.
const pick = (
  v: unknown,
  keys: readonly string[],
): Record<string, unknown> | null => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const x = (v as Record<string, unknown>)[k];
    if (x !== undefined) out[k] = x;
  }
  return out;
};
const list = (v: unknown, each: (x: unknown) => unknown): unknown =>
  Array.isArray(v) ? v.map(each) : v;
const entry = (x: unknown) => pick(x, ["value", "description"]) ?? x;

export function projectDecisionsBlock(
  raw: unknown,
): Record<string, unknown> | null {
  const top = pick(raw, [
    "provider",
    "model",
    "credentialRef",
    "questions",
    "rules",
  ]);
  if (top === null) return null;
  if (top.questions !== undefined) {
    top.questions = list(top.questions, (q) => {
      const o = pick(q, ["name", "type", "instructions", "options", "levels"]);
      if (o === null) return q;
      if (o.options !== undefined) o.options = list(o.options, entry);
      if (o.levels !== undefined) o.levels = list(o.levels, entry);
      return o;
    });
  }
  if (top.rules !== undefined) {
    top.rules = list(top.rules, (r) => {
      const o = pick(r, ["when", "action", "trigger"]);
      if (o === null) return r;
      if (o.when !== undefined) {
        o.when = list(
          o.when,
          (c) =>
            pick(c, [
              "question",
              "minProbability",
              "equals",
              "minConfidence",
              "minLevel",
              "maxLevel",
            ]) ?? c,
        );
      }
      if (o.action !== undefined) {
        const a = pick(o.action, ["tool", "args", "fill"]);
        if (a !== null) {
          if (a.args !== undefined) a.args = structuredClone(a.args);
          if (a.fill !== undefined) a.fill = structuredClone(a.fill);
          o.action = a;
        }
      }
      return o;
    });
  }
  return structuredClone(top);
}

// A settings bag with the removed decisions keys taken out of `monitoring.decisions`, for a bundle
// exported under an older release: the write boundary refuses them by name, but a restore that fails
// over a key that governs nothing gives the operator nothing to act on. Returns the same bag when
// there is nothing to drop.
export function withoutRemovedDecisionFields(settings: unknown): unknown {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return settings;
  }
  const mon = (settings as Record<string, unknown>).monitoring;
  if (!mon || typeof mon !== "object" || Array.isArray(mon)) return settings;
  const block = (mon as Record<string, unknown>).decisions;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return settings;
  }
  if (!REMOVED_FIELDS.some((k) => k in block)) return settings;
  const kept = { ...(block as Record<string, unknown>) };
  for (const k of REMOVED_FIELDS) delete kept[k];
  return {
    ...(settings as Record<string, unknown>),
    monitoring: { ...(mon as Record<string, unknown>), decisions: kept },
  };
}
