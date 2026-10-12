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
import { ASKS_WAIT_MESSAGE, WAIT_MESSAGE_ARG } from "@/graph/tools/http";
import { SERVER_INPUT_VALIDATOR } from "@/graph/tools/mcp";
import { type DecisionQuestion, isNativeDecisionTool } from "./config";
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
  // An HTTP tool with an acknowledgement: its holding message is filled for a rule (withWaitMessage).
  waitMessage?: boolean;
  // A custom tool's zod schema: an argument it does not declare does not fit, as at the save.
  closed?: boolean;
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
  const waitMessage =
    (tool as { [ASKS_WAIT_MESSAGE]?: true })[ASKS_WAIT_MESSAGE] === true;
  return isInteropZodSchema(tool.schema)
    ? {
        zod: tool.schema,
        waitMessage,
        closed: !isNativeDecisionTool(tool.name) && strips(tool.schema),
      }
    : { json: tool.schema, waitMessage };
}

// A schema that cannot be checked (one the validator cannot compile, such as an external `$ref`)
// fits nothing: the call is not sent, and the other rules of the tick still run.
// A zod object that drops the keys it does not declare (the default), rather than keeping them
// (`passthrough`) or refusing them (`strict`, refused by the parse itself).
function strips(schema: unknown): boolean {
  const def = (
    schema as { _zod?: { def?: { type?: unknown; catchall?: unknown } } }
  )?._zod?.def;
  return def?.type === "object" && def.catchall === undefined;
}

export async function argsFit(
  schema: ArgSchema,
  args: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await checkArgs(schema, args);
  } catch {
    return false;
  }
}

async function checkArgs(
  schema: ArgSchema,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (schema.validate) return schema.validate(args);
  if (schema.zod !== undefined && isInteropZodSchema(schema.zod)) {
    // An HTTP or code tool's schema strips a key it does not have, so an argument the tool lost
    // after the rule was saved would be dropped from the call in silence: refused instead.
    const shape = (schema.zod as { shape?: Record<string, unknown> }).shape;
    if (
      schema.closed &&
      shape &&
      Object.keys(args).some((k) => !Object.hasOwn(shape, k))
    ) {
      return false;
    }
    return (await interopSafeParseAsync(schema.zod, args)).success;
  }
  // A JSON Schema with no validator: its `required` list is what can be asked here.
  const required = (schema.json as { required?: unknown } | null)?.required;
  return !(
    Array.isArray(required) &&
    required.some((n) => typeof n === "string" && !Object.hasOwn(args, n))
  );
}

function fieldOf(schema: ArgSchema, arg: string): unknown {
  if (schema.zod !== undefined) {
    const shape = (schema.zod as { shape?: Record<string, unknown> }).shape;
    return shape && Object.hasOwn(shape, arg) ? shape[arg] : undefined;
  }
  return jsonProperty(schema.json, arg);
}

// A property as the server declares it, also when the arguments object itself is a `$ref` or a
// composition (`allOf`, `anyOf`, `oneOf`) of objects. Branches that each declare it give it the
// union of their declarations.
function jsonProperty(root: unknown, arg: string): unknown {
  const found: unknown[] = [];
  const walk = (node: unknown, depth: number) => {
    if (depth > 16) return;
    const n = (deref(root, node) ?? {}) as {
      properties?: Record<string, unknown>;
      allOf?: unknown;
      anyOf?: unknown;
      oneOf?: unknown;
    };
    const own =
      n.properties && Object.hasOwn(n.properties, arg)
        ? n.properties[arg]
        : undefined;
    if (own !== undefined) found.push(own);
    for (const members of [n.allOf, n.anyOf, n.oneOf]) {
      if (Array.isArray(members)) for (const m of members) walk(m, depth + 1);
    }
  };
  walk(root, 0);
  if (found.length === 0) return undefined;
  return found.length === 1 ? found[0] : { anyOf: found };
}

// A zod field under its wrappers (optional, nullable, default): an argument the rule may leave out
// still takes only the values of the schema inside.
function zodInner(field: unknown): unknown {
  let at = field;
  for (let i = 0; i < 8; i++) {
    const def = (at as { _zod?: { def?: { innerType?: unknown } } } | null)
      ?._zod?.def;
    if (!def?.innerType) break;
    at = def.innerType;
  }
  return at;
}

// The allowed values of a field, under zod wrappers or JSON references and compositions (a
// nullable enum is `anyOf: [{enum}, {type: "null"}]`).
function enumOf(root: unknown, field: unknown, depth = 0): unknown[] | null {
  if (depth > 16) return null;
  if (isInteropZodSchema(field)) {
    const options = (zodInner(field) as { options?: unknown }).options;
    return Array.isArray(options) ? options : null;
  }
  const f = (deref(root, field) ?? {}) as {
    enum?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
    allOf?: unknown;
  };
  if (Array.isArray(f.enum)) return f.enum;
  for (const members of [f.anyOf, f.oneOf, f.allOf]) {
    if (!Array.isArray(members)) continue;
    for (const m of members) {
      const found = enumOf(root, m, depth + 1);
      if (found) return found;
    }
  }
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

// An HTTP tool with an acknowledgement asks the model for the holding message it sends the customer.
// A watcher's client is muted and sends none, so a rule is not asked to write one.
function withWaitMessage(
  schema: ArgSchema,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (schema.waitMessage && !Object.hasOwn(args, WAIT_MESSAGE_ARG)) {
    args[WAIT_MESSAGE_ARG] = "-";
  }
  return args;
}

// Filled values that are not text, up to this many, are tried in every mix of as-given and as-text;
// past it only the per-field fit, all as given and all as text are tried.
const MIXES_UP_TO = 8;

// The call with the filled values fitted field by field, then in each mix of as-given and as-text: a
// schema whose branches type arguments apart (`id` text and `n` a number in one, the other way round
// in the other) is fitted by the whole call, not by the first branch that names each argument.
async function fitCall(
  schema: ArgSchema,
  fixed: Record<string, unknown>,
  values: Record<string, unknown>,
): Promise<{ ok: boolean; args: Record<string, unknown> }> {
  const fitted: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    fitted[k] = await fitValue(schema, k, v);
  }
  const loose = Object.keys(values).filter(
    (k) => typeof values[k] !== "string",
  );
  const masks =
    loose.length <= MIXES_UP_TO
      ? Array.from({ length: 2 ** loose.length }, (_, m) => m)
      : [0, 2 ** loose.length - 1];
  const tries = [
    fitted,
    ...masks.map((m) => {
      const mix = { ...values };
      loose.forEach((k, i) => {
        if (m & (1 << i)) mix[k] = String(values[k]);
      });
      return mix;
    }),
  ];
  for (const each of tries) {
    const args = withWaitMessage(schema, { ...fixed, ...each });
    if (await argsFit(schema, args)) return { ok: true, args };
  }
  return { ok: false, args: withWaitMessage(schema, { ...fixed, ...fitted }) };
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
  const found = await fitCall(schema, action.args, resolved.values);
  if (found.ok) return { ok: true, args: found.args };
  const args = found.args;
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
  const samples: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(action.fill ?? {})) {
    const source = parseFieldSource(raw);
    if (!source) continue;
    const type = fieldSourceType(source);
    // A text field into a list of allowed values may hold any of them: one of them stands in.
    const allowed =
      type === "string" ? enumOf(schema.json, fieldOf(schema, k)) : null;
    samples[k] = allowed?.[0] ?? SAMPLE[type];
  }
  const { ok, args } = await fitCall(schema, action.args, samples);
  if (ok) return null;
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
