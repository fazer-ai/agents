import { isLangChainTool } from "@langchain/core/utils/function_calling";
import { toJsonSchema } from "@langchain/core/utils/json_schema";

// Gemini tool declarations. @langchain/google-genai puts a tool's parameters in
// `FunctionDeclaration.parameters`, which the API parses as a closed OpenAPI subset (its discovery
// document lists the fields under `.schemas.Schema.properties`). One field outside it rejects the
// whole request (`Unknown name "<key>"`), and zod emits `exclusiveMinimum` and `propertyNames`. So
// tools are declared through `parametersJsonSchema` (full JSON Schema, exclusive with `parameters`),
// which sends the schema as authored. Rewriting schemas into the subset is lossy: `exclusiveMinimum:
// 0` on a money field can only become `minimum: 0`, which tells the model zero is a legal amount.

// A Gemini FunctionDeclaration as we build it. The SDK's own types predate
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

// Caps the nesting of a hostile schema from a third-party MCP server (JSON-derived data cannot be
// cyclic, so there is no loop to prevent). Past the cap the subtree travels untransformed.
const MAX_DEPTH = 64;

// Where a schema may legally sit; the walk descends only into these. "Every object is a schema" is
// wrong: inside `properties` the keys are parameter NAMES (one called "additionalItems" would be
// translated away while `required` still demands it), and `enum`/`const`/`default`/`examples` hold
// instance data that must not be rewritten. Anything unlisted travels verbatim, the safe default for
// a keyword we do not know.
const SCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);
const SCHEMA_LIST_KEYWORDS = new Set([
  "prefixItems",
  "allOf",
  "anyOf",
  "oneOf",
]);
const SCHEMA_KEYWORDS = new Set([
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
]);

function normalizeSchemaMap(node: unknown, depth: number): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const out: Record<string, unknown> = Object.create(null);
  for (const [name, schema] of Object.entries(
    node as Record<string, unknown>,
  )) {
    out[name] = normalizeTupleItems(schema, depth + 1);
  }
  return out;
}

// Rewrites the one construct the JSON Schema path still rejects: a draft-07 tuple (an `items` ARRAY),
// which Gemini, implementing 2020-12, refuses. Zod never emits it, but a draft-07 MCP server does and
// @langchain/mcp-adapters passes it through; `prefixItems` is the exact 2020-12 translation. Always
// returns fresh objects: `toJsonSchema` memoizes per schema, so editing in place would corrupt what
// the other providers declare for the rest of the process.
function normalizeTupleItems(node: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return node;
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const source = node as Record<string, unknown>;
  const isTuple = Array.isArray(source.items);
  const hasPrefixItems = "prefixItems" in source;
  // Null prototype because the keys come from a third-party schema. `out.__proto__ = x` on a
  // normal object runs the prototype setter instead of creating an own key, so a parameter legally
  // named `__proto__` would vanish from the declaration while `required` still demanded it.
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      out[key] = normalizeSchemaMap(value, depth + 1);
      continue;
    }
    if (SCHEMA_LIST_KEYWORDS.has(key)) {
      out[key] = Array.isArray(value)
        ? value.map((v) => normalizeTupleItems(v, depth + 1))
        : normalizeTupleItems(value, depth + 1);
      continue;
    }
    if (SCHEMA_KEYWORDS.has(key)) {
      out[key] = normalizeTupleItems(value, depth + 1);
      continue;
    }
    if (key === "items") {
      if (!Array.isArray(value)) {
        out.items = normalizeTupleItems(value, depth + 1);
        continue;
      }
      if (!hasPrefixItems) {
        out.prefixItems = value.map((v) => normalizeTupleItems(v, depth + 1));
      }
      continue;
    }
    if (key === "additionalItems") {
      // NOTE: the other half of the translation: draft-07 `additionalItems` is the single-schema
      // `items` of 2020-12. Dropping it would widen the contract (`additionalItems: false` means
      // nothing past the tuple). Outside a tuple it means nothing in either draft, so it goes.
      if (isTuple) {
        out.items =
          typeof value === "boolean"
            ? value
            : normalizeTupleItems(value, depth + 1);
      }
      continue;
    }
    // NOTE: not a schema position: instance data (`enum`, `const`, `default`, `examples`) or a plain
    // annotation. Copied by reference, never walked, and never mutated here or downstream.
    out[key] = value;
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

// A parameterless tool is declared WITHOUT `parametersJsonSchema`, the shape @langchain/google-genai
// sends for `z.object({})`. "No properties" alone is not the test: an MCP server can describe its
// arguments with an `additionalProperties` map, a root `$ref` or a union, and omitting those would
// leave the model a tool it must call with no arguments. Parameterless means it accepts nothing: no
// properties, closed to extras, and no keyword that admits any.
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
  // NOTE: one entry holding every declaration, never one entry per tool: Gemini refuses a request
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
      // NOTE: caller's declarations first, the order upstream produces.
      functionDeclarations: [
        ...(existing.functionDeclarations ?? []),
        ...declarations,
      ],
    };
  });
}
