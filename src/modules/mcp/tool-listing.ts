import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

// What `tools/list` publishes for each input schema, minus what carries no meaning there: the
// draft-07 `$schema` the SDK stamps on every tool and the `"additionalProperties":{}` of every loose
// object. An empty `additionalProperties` accepts anything in every dialect, exactly like its absence.
// A schema without `$schema` is read by MCP as JSON Schema 2020-12, so the dialect is dropped only
// while the schema uses nothing 2020-12 reads differently from draft-07 (docs/mcp.md, "Full admin
// surface").

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

// Keywords whose meaning differs between draft-07 and 2020-12: siblings of `$ref` are ignored in
// draft-07 and applied in 2020-12; `definitions`, `dependencies` and `additionalItems` were renamed or
// split; `items` as an array is a draft-07 tuple and invalid in 2020-12.
const DIALECT_SENSITIVE = new Set([
  "$ref",
  "definitions",
  "dependencies",
  "additionalItems",
]);

// Positions whose value is a map of name -> subschema: the names are data, the values are schemas.
const SCHEMA_MAPS = new Set([
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
]);

// Positions whose value is one subschema, or an array of them. Anything else (`enum`, `const`,
// `default`, `examples`, ...) is data and is never walked into.
const SCHEMA_SLOTS = new Set([
  "items",
  "prefixItems",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "anyOf",
  "oneOf",
  "allOf",
]);

type Schema = Record<string, unknown>;

function isSchema(v: unknown): v is Schema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isEmpty(v: unknown): boolean {
  return isSchema(v) && Object.keys(v).length === 0;
}

function walk(node: unknown, sensitive: { hit: boolean }): unknown {
  if (Array.isArray(node)) return node.map((n) => walk(n, sensitive));
  if (!isSchema(node)) return node;
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (DIALECT_SENSITIVE.has(key)) sensitive.hit = true;
    if (key === "items" && Array.isArray(value)) sensitive.hit = true;
    if (key === "additionalProperties" && isEmpty(value)) continue;
    if (SCHEMA_MAPS.has(key) && isSchema(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [
          name,
          walk(sub, sensitive),
        ]),
      );
    } else if (SCHEMA_SLOTS.has(key)) {
      out[key] = walk(value, sensitive);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function compactToolSchema(schema: Schema): Schema {
  const sensitive = { hit: false };
  const out = walk(schema, sensitive) as Schema;
  if (out.$schema === DRAFT_07 && !sensitive.hit) delete out.$schema;
  return out;
}

// Wraps the SDK's own `tools/list` handler, which McpServer installs on the first registerTool, so
// call this before registering any tool. Everything else in the listing goes out as the SDK built it.
export function publishCompactToolSchemas(server: McpServer): void {
  const low = server.server;
  const set = low.setRequestHandler.bind(low) as (
    schema: unknown,
    handler: (request: unknown, extra: unknown) => unknown,
  ) => void;
  const wrapped = (
    schema: unknown,
    handler: (request: unknown, extra: unknown) => unknown,
  ): void => {
    if (schema !== ListToolsRequestSchema) {
      set(schema, handler);
      return;
    }
    set(schema, async (request, extra) => {
      const listed = (await handler(request, extra)) as ListToolsResult;
      return {
        ...listed,
        tools: listed.tools.map((tool) => ({
          ...tool,
          inputSchema: compactToolSchema(
            tool.inputSchema,
          ) as typeof tool.inputSchema,
        })),
      };
    });
  };
  low.setRequestHandler = wrapped as typeof low.setRequestHandler;
}
