import { isLangChainTool } from "@langchain/core/utils/function_calling";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

// Gemini tool declarations. @langchain/google-genai declares a tool's parameters in
// `FunctionDeclaration.parameters`, which generativelanguage parses as the OpenAPI 3.03 subset: a
// CLOSED set of 22 fields (the API's own discovery document lists them under `.schemas.Schema
// .properties` at https://generativelanguage.googleapis.com/$discovery/rest?version=v1beta). One
// field outside that set makes the API reject the ENTIRE request with `Invalid JSON payload
// received. Unknown name "<key>"`, before the model is ever reached — issue #64. Two of our own
// generators trip it on every turn: `z.number().int().positive()` emits `exclusiveMinimum` (the
// native `get_current_time`, the Calendar/Drive/Asaas toolpacks) and `z.record(...)` emits
// `propertyNames` (every HTTP tool with an object parameter).
//
// `FunctionDeclaration.parametersJsonSchema` takes a FULL JSON Schema instead, and is mutually
// exclusive with `parameters`. Declaring tools that way sends the schema exactly as authored, so
// nothing is dropped and no bound is approximated. Measured against the live API on
// gemini-3.5-flash, gemini-2.5-flash and gemini-flash-latest: `exclusiveMinimum`, `propertyNames`,
// `additionalProperties`, `$schema`, `$defs`/`$ref`, `const`, `uniqueItems`, `multipleOf`,
// `oneOf`/`allOf`, an object with no properties, a `type` array and a non-string `enum` all pass,
// and the model still answers with correct arguments.
//
// The alternative (rewrite each schema into the subset) was measured working too, but it is lossy
// by construction: `exclusiveMinimum: 0` on a money field can only become `minimum: 0`, which tells
// the model that zero is a legal amount.

// A Gemini FunctionDeclaration as we build it. NOTE: the SDK's own types predate
// `parametersJsonSchema` (@google/generative-ai is the legacy client and stopped being updated),
// but the field is in the API's discovery document and the request body is JSON.stringify'd
// straight through, so it reaches the wire regardless of the local type.
export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parametersJsonSchema?: unknown;
}

export interface GeminiFunctionTool {
  functionDeclarations: GeminiFunctionDeclaration[];
}

// NOTE: guards against a hostile schema from a third-party MCP server; JSON-derived data cannot be
// cyclic, so this only caps absurd nesting instead of preventing a loop. Past the cap the subtree
// travels untransformed, which is exactly what shipped before this module existed.
const MAX_DEPTH = 64;

// The ONE construct the JSON Schema path still rejects (measured: `schema at properties.X.items
// must be a boolean or an object`). Draft-07 writes a tuple as an `items` ARRAY; 2020-12 writes it
// `prefixItems`, and Gemini implements 2020-12. Zod never emits the old form, but an MCP server
// written against draft-07 does and @langchain/mcp-adapters passes it through untouched. The rename
// is the exact 2020-12 translation, so the tuple keeps its meaning.
//
// Always returns fresh objects: `toJsonSchema` memoizes per schema and hands back the SAME object
// on every call, so editing in place would corrupt what the other providers declare for the rest of
// the process.
//
// Keywords whose value is a MAP OF SCHEMAS keyed by a name the tool author chose, not a schema. The
// walk has to change mode there: inside `properties` the key `additionalItems` is a parameter called
// "additionalItems", and translating it as the draft-07 keyword deletes the parameter while
// `required` goes on demanding it — a declaration the model cannot satisfy.
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
]);

function normalizeSchemaMap(node: unknown, depth: number): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node))
    return normalizeTupleItems(node, depth);
  const out: Record<string, unknown> = Object.create(null);
  for (const [name, schema] of Object.entries(
    node as Record<string, unknown>,
  )) {
    out[name] = normalizeTupleItems(schema, depth + 1);
  }
  return out;
}

function normalizeTupleItems(node: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return node;
  if (Array.isArray(node))
    return node.map((v) => normalizeTupleItems(v, depth + 1));
  if (!node || typeof node !== "object") return node;
  const source = node as Record<string, unknown>;
  const isTuple = Array.isArray(source.items);
  const hasPrefixItems = "prefixItems" in source;
  // NOTE: null prototype because the keys come from a third-party schema. `out.__proto__ = x` on a
  // normal object runs the prototype setter instead of creating an own key, so a parameter legally
  // named `__proto__` would vanish from the declaration while `required` still demanded it.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] = normalizeSchemaMap(value, depth + 1);
      continue;
    }
    if (key === "items" && Array.isArray(value)) {
      if (!hasPrefixItems) {
        out.prefixItems = value.map((v) => normalizeTupleItems(v, depth + 1));
      }
      continue;
    }
    if (key === "additionalItems") {
      // The other half of the same translation: what draft-07 spelled `additionalItems` is the
      // single-schema form of `items` in 2020-12. Dropping it would silently widen the contract —
      // `additionalItems: false` means "nothing past the tuple", and losing it lets the model send
      // extra elements. Outside a tuple the keyword has no meaning in either draft, so it goes.
      if (isTuple) {
        out.items =
          typeof value === "boolean"
            ? value
            : normalizeTupleItems(value, depth + 1);
      }
      continue;
    }
    out[key] = normalizeTupleItems(value, depth + 1);
  }
  return out;
}

// Keywords that describe arguments without listing a single property, so a schema carrying any of
// them is NOT parameterless even though `properties` is empty.
const ARGUMENT_KEYWORDS = [
  "$ref",
  "anyOf",
  "oneOf",
  "allOf",
  "patternProperties",
  "propertyNames",
];

// A tool that takes no parameters is declared WITHOUT `parametersJsonSchema`, the same shape
// @langchain/google-genai already sends today for `z.object({})` (`resolve_conversation`); an empty
// schema is accepted either way, and keeping the omission means parameterless tools go on the wire
// exactly as they did before this change.
//
// NOTE: "no properties" alone is NOT the test. A third-party MCP server can describe its arguments
// with an `additionalProperties` map, a root `$ref`, or a union, and omitting those would hand the
// model a tool it then has to call with no arguments at all. What makes a schema parameterless is
// that it can accept nothing: no properties, closed to extras, and no keyword that admits any.
function acceptsNoArguments(source: Record<string, unknown>): boolean {
  const properties = source.properties;
  const listsProperties =
    !!properties &&
    typeof properties === "object" &&
    Object.keys(properties).length > 0;
  if (listsProperties || source.additionalProperties !== false) return false;
  return !ARGUMENT_KEYWORDS.some((keyword) => keyword in source);
}

function declaredParameters(schema: unknown): unknown | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  return acceptsNoArguments(schema as Record<string, unknown>)
    ? undefined
    : normalizeTupleItems(schema);
}

// An entry the caller already handed over in Gemini's own shape. Upstream's `processTools` folds the
// LangChain declarations INTO the first of these instead of appending a second entry, precisely
// because Gemini refuses a request carrying more than one. Converting every tool ourselves leaves
// upstream's accumulator empty by the time it checks, so the fold has to happen here or the mixed
// case regresses into `Multiple tools are supported only when they are all search tools`.
function isDeclarationTool(
  candidate: unknown,
): candidate is GeminiFunctionTool {
  return (
    !!candidate &&
    typeof candidate === "object" &&
    "functionDeclarations" in candidate
  );
}

// Rewrites a bindTools argument list into Gemini's own tool shape. LangChain tools become function
// declarations carrying their JSON Schema; anything else (a search or code-execution tool, or an
// already-converted declaration coming back through `invocationParams`) is passed through as is.
export function toGeminiTools<T>(
  tools: readonly T[],
): (T | GeminiFunctionTool)[] {
  const declarations: GeminiFunctionDeclaration[] = [];
  const passthrough: T[] = [];
  for (const candidate of tools) {
    if (!isLangChainTool(candidate)) {
      passthrough.push(candidate);
      continue;
    }
    const parameters = candidate.schema
      ? declaredParameters(toJsonSchema(candidate.schema))
      : undefined;
    declarations.push({
      name: candidate.name,
      description: candidate.description,
      ...(parameters === undefined ? {} : { parametersJsonSchema: parameters }),
    });
  }
  // NOTE: one entry holding every declaration, never one entry per tool — Gemini refuses a request
  // with multiple tool entries unless they are all search tools. Same reason the fold below exists:
  // a declaration entry the caller already passed has to absorb ours instead of sitting beside it.
  if (declarations.length === 0) return [...passthrough];
  const foldInto = passthrough.findIndex(isDeclarationTool);
  if (foldInto < 0)
    return [...passthrough, { functionDeclarations: declarations }];
  return passthrough.map((tool, index) => {
    if (index !== foldInto) return tool;
    const existing = tool as GeminiFunctionTool;
    return {
      ...existing,
      // Caller's declarations first, matching the order upstream produced before this module existed.
      functionDeclarations: [
        ...(existing.functionDeclarations ?? []),
        ...declarations,
      ],
    };
  });
}
