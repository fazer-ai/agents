// ONE PIPELINE FOR A RULE ACTION'S ARGUMENTS (docs/decisions.md, "Custom tools"): the fills
// resolved, each value fitted to the tool's ORIGINAL schema, and the whole call checked against
// that schema, before anything is charged, latched or sent. The save asks the same check with a
// sample of each field's type in place of the value (`sampleArgsUnfit`), and the tick with the values
// themselves (`prepareArgs`), so a rule the save accepts is refused at the tick only for a value the
// observation did not have.

import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  interopSafeParseAsync,
  isInteropZodSchema,
} from "@langchain/core/utils/types";
import { WAIT_MESSAGE_ARG } from "@/graph/tools/http";
import { SERVER_INPUT_VALIDATOR } from "@/graph/tools/mcp";
import type { DecisionQuestion } from "./config";
import type { DecisionAnswer } from "./providers";
import {
  type FieldSourceType,
  type FillContext,
  fieldSourceType,
  parseFieldSource,
  resolveFill,
} from "./tool-args";

// What a tool checks its input with: a zod schema (native, HTTP and code tools, built from the
// stored input schema), or an MCP tool's server schema with the SDK's own validator.
export interface ArgSchema {
  zod?: unknown;
  json?: unknown;
  validate?: (args: Record<string, unknown>) => Promise<boolean>;
}

export function argSchemaOf(tool: StructuredToolInterface): ArgSchema {
  const t = tool as unknown as {
    [SERVER_INPUT_VALIDATOR]?: {
      schema: unknown;
      validate: (args: Record<string, unknown>) => Promise<boolean>;
    };
  };
  const server = t[SERVER_INPUT_VALIDATOR];
  if (server) return { json: server.schema, validate: server.validate };
  return isInteropZodSchema(tool.schema)
    ? { zod: tool.schema }
    : { json: tool.schema };
}

export async function argsFit(
  schema: ArgSchema,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (schema.validate) return schema.validate(args);
  if (schema.zod !== undefined && isInteropZodSchema(schema.zod)) {
    return (await interopSafeParseAsync(schema.zod, args)).success;
  }
  // A JSON Schema with no validator: its `required` list is what can be asked here.
  const required = (schema.json as { required?: unknown } | null)?.required;
  return !(
    Array.isArray(required) &&
    required.some((n) => typeof n === "string" && !(n in args))
  );
}

function fieldOf(schema: ArgSchema, arg: string): unknown {
  if (schema.zod !== undefined) {
    return (schema.zod as { shape?: Record<string, unknown> }).shape?.[arg];
  }
  return (schema.json as { properties?: Record<string, unknown> } | null)
    ?.properties?.[arg];
}

function enumOf(field: unknown): unknown[] | null {
  const f = field as { options?: unknown; enum?: unknown } | null | undefined;
  if (Array.isArray(f?.enum)) return f.enum;
  if (isInteropZodSchema(field) && Array.isArray(f?.options)) return f.options;
  return null;
}

// A local `$ref` (`#/$defs/id`) read in the schema it belongs to; anything else as it is.
function deref(
  root: unknown,
  node: unknown,
  seen = new Set<string>(),
): unknown {
  const ref = (node as { $ref?: unknown } | null)?.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/") || seen.has(ref)) {
    return node;
  }
  seen.add(ref);
  let at: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    at =
      at && typeof at === "object"
        ? (at as Record<string, unknown>)[key]
        : undefined;
  }
  return at === undefined ? node : deref(root, at, seen);
}

// The JSON types a property takes: its own, and those of its references and composed members.
function jsonTypes(root: unknown, field: unknown, depth = 0): unknown[] {
  if (depth > 16) return [];
  const f = (deref(root, field) ?? {}) as {
    type?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
    allOf?: unknown;
  };
  const own = Array.isArray(f.type) ? f.type : [f.type];
  const members = [
    ...(Array.isArray(f.anyOf) ? f.anyOf : []),
    ...(Array.isArray(f.oneOf) ? f.oneOf : []),
    ...(Array.isArray(f.allOf) ? f.allOf : []),
  ];
  return [...own, ...members.flatMap((m) => jsonTypes(root, m, depth + 1))];
}

// A filled value as the argument takes it: as given when the schema accepts it, else as its text
// when the argument takes text (a display id into a text argument).
async function fitValue(
  schema: ArgSchema,
  arg: string,
  value: unknown,
): Promise<unknown> {
  if (typeof value === "string") return value;
  const field = fieldOf(schema, arg);
  if (field === undefined) return value;
  if (isInteropZodSchema(field)) {
    if ((await interopSafeParseAsync(field, value)).success) return value;
    const text = String(value);
    return (await interopSafeParseAsync(field, text)).success ? text : value;
  }
  const types = jsonTypes(schema.json, field);
  const takesValue =
    types.includes(typeof value) ||
    (typeof value === "number" &&
      (types.includes("number") ||
        (Number.isInteger(value) && types.includes("integer"))));
  return !takesValue && types.includes("string") ? String(value) : value;
}

export type PreparedArgs =
  | { ok: true; args: Record<string, unknown> }
  | {
      ok: false;
      failure: "missing_value" | "invalid_arguments";
      args: Record<string, unknown>;
      missing?: string[];
    };

// THE TICK: the fixed arguments, the fills resolved for this observation and fitted to the schema,
// then the whole call checked. A field with no value is left out; when the call then does not fit,
// the reason is the value the observation lacked (`missing_value`), otherwise the rule's arguments
// (`invalid_arguments`). Either way nothing was sent.
export async function prepareArgs(
  tool: StructuredToolInterface,
  action: { args: Record<string, unknown>; fill?: Record<string, string> },
  fill: {
    context: FillContext;
    answers: Record<string, DecisionAnswer>;
    questions: readonly DecisionQuestion[];
  } | null,
): Promise<PreparedArgs> {
  const schema = argSchemaOf(tool);
  const filled = action.fill ?? {};
  const resolved =
    Object.keys(filled).length === 0
      ? { values: {}, missing: [] as string[] }
      : fill
        ? resolveFill(filled, fill.context, fill.answers, fill.questions)
        : { values: {}, missing: Object.keys(filled) };
  const args = { ...action.args };
  for (const [k, v] of Object.entries(resolved.values)) {
    args[k] = await fitValue(schema, k, v);
  }
  // An HTTP tool with an acknowledgement asks the model for the holding message it sends the
  // customer. A watcher's client is muted and sends none, so a rule is not asked to write one.
  if (
    fieldOf(schema, WAIT_MESSAGE_ARG) !== undefined &&
    !(WAIT_MESSAGE_ARG in args)
  ) {
    args[WAIT_MESSAGE_ARG] = "-";
  }
  if (await argsFit(schema, args)) return { ok: true, args };
  return resolved.missing.length > 0
    ? { ok: false, failure: "missing_value", args, missing: resolved.missing }
    : { ok: false, failure: "invalid_arguments", args };
}

const SAMPLE: Record<FieldSourceType, string | number> = {
  string: "x",
  integer: 1,
  number: 0.5,
};

// THE SAVE: the same check with a sample of each field's type in place of its value, so a fill
// that could never fit (a text field into a number argument) is refused before any observation.
export async function sampleArgsUnfit(
  schema: ArgSchema,
  action: { args: Record<string, unknown>; fill?: Record<string, string> },
): Promise<string | null> {
  const args = { ...action.args };
  for (const [k, raw] of Object.entries(action.fill ?? {})) {
    const source = parseFieldSource(raw);
    if (!source) continue;
    const type = fieldSourceType(source);
    // A text field into a list of allowed values may hold any of them: one of them stands in.
    const allowed =
      type === "string" ? enumOf(deref(schema.json, fieldOf(schema, k))) : null;
    args[k] = allowed?.[0] ?? (await fitValue(schema, k, SAMPLE[type]));
  }
  if (
    fieldOf(schema, WAIT_MESSAGE_ARG) !== undefined &&
    !(WAIT_MESSAGE_ARG in args)
  ) {
    args[WAIT_MESSAGE_ARG] = "-";
  }
  if (await argsFit(schema, args)) return null;
  // Which argument, asked field by field where the schema has fields to ask.
  for (const [k, v] of Object.entries(args)) {
    const field = fieldOf(schema, k);
    if (
      isInteropZodSchema(field) &&
      !(await interopSafeParseAsync(field, v)).success
    ) {
      return k;
    }
  }
  return Object.keys({ ...action.args, ...action.fill })[0] ?? "";
}
