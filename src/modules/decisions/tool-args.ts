// Where a rule's custom-tool arguments come from (docs/decisions.md, "Custom tools"). A classification
// API answers yes or no, an option or a level, and never pulls a value out of the text, so an argument
// is either FIXED in the rule (`action.args`) or FILLED from what the observation already knows
// (`action.fill`, argument name -> field source). Shared by the write boundary, the tick and the
// editor: pure, no server imports.

import { normalizeToolShapes } from "@/modules/tool-definitions/normalize";
import type { DecisionQuestion, DecisionQuestionType } from "./config";
import type { DecisionAnswer } from "./providers";

// THE FIELD SOURCES, as `fill` names them:
//   contact.name | contact.phone | contact.email | contact.identifier | contact.attribute.<key>
//   conversation.display_id | conversation.inbox_id | conversation.link | conversation.attribute.<key>
//   answer.<question>.choice | .level | .level_index | .probability
// `display_id` is the number the operator sees in Chatwoot and in its links; the internal id is not
// offered, since nothing outside Chatwoot's database can use it.
export const CONTACT_FIELDS = ["name", "phone", "email", "identifier"] as const;
export const CONVERSATION_FIELDS = ["display_id", "inbox_id", "link"] as const;
export const ANSWER_FIELDS = [
  "choice",
  "level",
  "level_index",
  "probability",
] as const;
export type AnswerField = (typeof ANSWER_FIELDS)[number];

// What a source yields: text, a whole number or a fraction. An attribute is text: Chatwoot keeps
// what was typed, and the tick turns a number or a flag into its text.
export type FieldSourceType = "string" | "integer" | "number";

export type FieldSource =
  | { kind: "contact"; field: (typeof CONTACT_FIELDS)[number] }
  | { kind: "contact_attribute"; key: string }
  | { kind: "conversation"; field: (typeof CONVERSATION_FIELDS)[number] }
  | { kind: "conversation_attribute"; key: string }
  | { kind: "answer"; question: string; field: AnswerField };

const ATTRIBUTE_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const QUESTION_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function parseFieldSource(raw: unknown): FieldSource | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split(".");
  const [head, second, third] = parts;
  if (head === "contact") {
    if (parts.length === 2 && CONTACT_FIELDS.includes(second as never)) {
      return {
        kind: "contact",
        field: second as (typeof CONTACT_FIELDS)[number],
      };
    }
    if (
      parts.length === 3 &&
      second === "attribute" &&
      ATTRIBUTE_KEY.test(third ?? "")
    ) {
      return { kind: "contact_attribute", key: third as string };
    }
    return null;
  }
  if (head === "conversation") {
    if (parts.length === 2 && CONVERSATION_FIELDS.includes(second as never)) {
      return {
        kind: "conversation",
        field: second as (typeof CONVERSATION_FIELDS)[number],
      };
    }
    if (
      parts.length === 3 &&
      second === "attribute" &&
      ATTRIBUTE_KEY.test(third ?? "")
    ) {
      return { kind: "conversation_attribute", key: third as string };
    }
    return null;
  }
  if (
    head === "answer" &&
    parts.length === 3 &&
    QUESTION_NAME.test(second ?? "") &&
    ANSWER_FIELDS.includes(third as AnswerField)
  ) {
    return {
      kind: "answer",
      question: second as string,
      field: third as AnswerField,
    };
  }
  return null;
}

// The question type an answer field reads: an option is a choice's, a level a score's, a probability
// a yes_no's.
export const ANSWER_FIELD_QUESTION: Record<AnswerField, DecisionQuestionType> =
  {
    choice: "choice",
    level: "score",
    level_index: "score",
    probability: "yes_no",
  };

export function fieldSourceType(source: FieldSource): FieldSourceType {
  if (source.kind === "conversation") {
    return source.field === "link" ? "string" : "integer";
  }
  if (source.kind === "answer") {
    return source.field === "level_index"
      ? "integer"
      : source.field === "probability"
        ? "number"
        : "string";
  }
  return "string";
}

// A TOOL'S ARGUMENTS as its input schema declares them: the fields the model would fill (`source`
// "ai"), which are the ones the tool object's schema asks for. Both shapes a tool row may hold, the
// compact map and standard JSON Schema, read the way the tool build reads them.
export type ArgType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "enum"
  | "array"
  | "object";
export interface ToolArgSpec {
  name: string;
  type: ArgType;
  required: boolean;
  description?: string;
  enumValues?: string[];
  itemType?: "string" | "integer" | "number" | "boolean";
}

const ARG_TYPES = new Set<ArgType>([
  "string",
  "integer",
  "number",
  "boolean",
  "enum",
  "array",
  "object",
]);
const SCALARS = new Set(["string", "integer", "number", "boolean"]);

export function argSpecsFrom(inputSchema: unknown): ToolArgSpec[] {
  const { shapes } = normalizeToolShapes({ inputSchema });
  const map = shapes.inputSchema;
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  const out: ToolArgSpec[] = [];
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    const s = (raw ?? {}) as Record<string, unknown>;
    if (s.source === "fixed") continue;
    const type = ARG_TYPES.has(s.type as ArgType)
      ? (s.type as ArgType)
      : "string";
    out.push({
      name,
      type,
      required: !!s.required,
      ...(typeof s.description === "string" && s.description
        ? { description: s.description }
        : {}),
      ...(type === "enum" && Array.isArray(s.enumValues)
        ? {
            enumValues: s.enumValues.filter(
              (v): v is string => typeof v === "string",
            ),
          }
        : {}),
      ...(type === "array"
        ? {
            itemType: SCALARS.has(s.itemType as string)
              ? (s.itemType as ToolArgSpec["itemType"])
              : "string",
          }
        : {}),
    });
  }
  return out;
}

// Whether a source of this type can fill an argument of that type. Text takes anything, since a
// number is written as its digits; a number takes no text; an integer takes only a whole number.
// An enum takes text (an option's value may be one of its values; the tool's schema judges the call).
export function sourceFits(source: FieldSourceType, arg: ArgType): boolean {
  if (arg === "string") return true;
  if (arg === "enum") return source === "string";
  if (arg === "number") return source === "integer" || source === "number";
  if (arg === "integer") return source === "integer";
  return false;
}

function scalarFits(v: unknown, t: string): boolean {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  if (t === "boolean") return typeof v === "boolean";
  return typeof v === "string";
}

export function fixedFits(v: unknown, spec: ToolArgSpec): boolean {
  if (spec.type === "enum") {
    return (
      typeof v === "string" &&
      (!spec.enumValues ||
        spec.enumValues.length === 0 ||
        spec.enumValues.includes(v))
    );
  }
  if (spec.type === "array") {
    return (
      Array.isArray(v) && v.every((x) => scalarFits(x, spec.itemType ?? ""))
    );
  }
  if (spec.type === "object") {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
  return scalarFits(v, spec.type);
}

export type ArgIssueCode =
  | "arg_required"
  | "arg_unknown"
  | "arg_type"
  | "arg_source_type";
export interface ArgIssue {
  arg: string;
  // Where the argument is written: fixed (`args`) or filled (`fill`). `arg_required` has neither.
  in: "args" | "fill";
  code: ArgIssueCode;
}

// What a custom-tool action gets wrong against its tool's arguments: a required one with no value,
// one the tool does not have, a fixed value of the wrong type, a source of the wrong type. A source
// the grammar does not know is the block's own problem (config.ts) and is not asked again here.
export function actionArgIssues(
  action: { args?: Record<string, unknown>; fill?: Record<string, unknown> },
  specs: readonly ToolArgSpec[],
): ArgIssue[] {
  const out: ArgIssue[] = [];
  const args = action.args ?? {};
  const fill = action.fill ?? {};
  const byName = new Map(specs.map((s) => [s.name, s]));
  for (const s of specs) {
    if (
      s.required &&
      !Object.hasOwn(args, s.name) &&
      !Object.hasOwn(fill, s.name)
    ) {
      out.push({ arg: s.name, in: "args", code: "arg_required" });
    }
  }
  for (const [name, v] of Object.entries(args)) {
    const s = byName.get(name);
    if (!s) out.push({ arg: name, in: "args", code: "arg_unknown" });
    else if (!fixedFits(v, s))
      out.push({ arg: name, in: "args", code: "arg_type" });
  }
  for (const [name, raw] of Object.entries(fill)) {
    const s = byName.get(name);
    if (!s) {
      out.push({ arg: name, in: "fill", code: "arg_unknown" });
      continue;
    }
    const source = parseFieldSource(raw);
    if (source && !sourceFits(fieldSourceType(source), s.type)) {
      out.push({ arg: name, in: "fill", code: "arg_source_type" });
    }
  }
  return out;
}

// WHAT THE OBSERVATION KNOWS, as the tick hands it over: the mirror's contact and conversation, read
// with the tick's own conversation.
export interface FillContext {
  contact: Partial<Record<(typeof CONTACT_FIELDS)[number], string>>;
  contactAttributes: Record<string, unknown>;
  conversation: {
    display_id: number;
    inbox_id?: number;
    link?: string;
  };
  conversationAttributes: Record<string, unknown>;
}

function attributeText(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "string") return v.trim() === "" ? undefined : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function sourceValue(
  source: FieldSource,
  ctx: FillContext,
  answers: Record<string, DecisionAnswer>,
  questions: readonly DecisionQuestion[],
): string | number | undefined {
  switch (source.kind) {
    case "contact": {
      const v = ctx.contact[source.field];
      return v && v.trim() !== "" ? v : undefined;
    }
    case "contact_attribute":
      return attributeText(ctx.contactAttributes[source.key]);
    case "conversation_attribute":
      return attributeText(ctx.conversationAttributes[source.key]);
    case "conversation":
      return ctx.conversation[source.field];
    case "answer": {
      const a = answers[source.question];
      if (!a) return undefined;
      if (source.field === "probability") {
        return a.type === "yes_no" ? a.probability : undefined;
      }
      if (source.field === "choice") {
        return a.type === "choice" ? a.choice : undefined;
      }
      if (a.type !== "score") return undefined;
      // The score is a probability-weighted mean of the level indices: the level is the nearest
      // one, as a rule's condition reads it (rules.ts).
      const level = Math.round(a.score);
      if (source.field === "level_index") return level;
      const q = questions.find((x) => x.name === source.question);
      return q?.type === "score" ? q.levels[level]?.value : undefined;
    }
  }
}

// The filled arguments of one action as their sources give them (the tick fits each to the tool's own
// schema: a number into a text argument goes as its digits), and the ones the observation had no
// value for. An argument with no value is left out: the tool's schema decides whether it could go
// without.
export function resolveFill(
  fill: Record<string, string>,
  ctx: FillContext,
  answers: Record<string, DecisionAnswer>,
  questions: readonly DecisionQuestion[],
): { values: Record<string, unknown>; missing: string[] } {
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const [arg, raw] of Object.entries(fill)) {
    const source = parseFieldSource(raw);
    const v = source ? sourceValue(source, ctx, answers, questions) : undefined;
    if (v === undefined) {
      missing.push(arg);
      continue;
    }
    values[arg] = v;
  }
  return { values, missing };
}

// The arguments of a custom-tool call as the observe line records them: the fixed ones as written,
// the filled ones as the value only when the agent logs tool values, else by where they came from
// (`{from: "contact.phone"}`), since a filled value is the contact's or the conversation's data.
export function argsForLog(
  args: Record<string, unknown>,
  fill: Record<string, string>,
  logValues: boolean,
): Record<string, unknown> {
  if (logValues) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = Object.hasOwn(fill, k) ? { from: fill[k] } : v;
  }
  for (const [k, from] of Object.entries(fill)) {
    if (!Object.hasOwn(out, k)) out[k] = { from };
  }
  return out;
}
