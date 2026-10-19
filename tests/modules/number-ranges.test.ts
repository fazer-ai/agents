import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// Every number a caller can write is refused outside a declared range: a range only a reader
// enforces stores what was sent and runs the clamp. This walks the REAL schemas, not a list someone keeps:
// the settings bag, every REST body and query in the route table, and every MCP tool's input. A number
// declared with no minimum or no maximum fails here, unless it is below with the reason it has none.
//
// Reads are out: a GET's query and a read tool's page size are clamped and never stored, so nothing
// shows one value while running another. An id (`…Id`, `…_id`) needs only its floor of 1, since its
// ceiling is whatever the database issued.

setupPrismaMock();
const app = (await import("@/app")).default;

// Where the walk found the number, in each surface's own vocabulary, mapped to WHY it is unbounded.
// An entry that no longer matches anything fails too, so the list cannot outlive what it excuses.
const UNBOUNDED: Record<string, string> = {
  "PUT /api/v1/instance-health/thresholds/:signal body.threshold":
    "the scale is the signal's own unit (ms, a count, a rate per minute), so one ceiling would be wrong for all but one signal",
};

interface JsonNode {
  type?: string | string[];
  minimum?: number;
  exclusiveMinimum?: number | boolean;
  maximum?: number;
  exclusiveMaximum?: number | boolean;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonNode>;
  additionalProperties?: JsonNode | boolean;
  patternProperties?: Record<string, JsonNode>;
  items?: JsonNode | JsonNode[];
  anyOf?: JsonNode[];
  oneOf?: JsonNode[];
  allOf?: JsonNode[];
}

function numericLeaves(
  node: unknown,
  path: string,
  out: Map<string, JsonNode>,
) {
  if (!node || typeof node !== "object") return;
  const n = node as JsonNode;
  const types = Array.isArray(n.type) ? n.type : [n.type];
  if (types.includes("number") || types.includes("integer")) {
    // A fixed value is its own range.
    if (n.const === undefined && n.enum === undefined) out.set(path, n);
  }
  for (const branch of [
    ...(n.anyOf ?? []),
    ...(n.oneOf ?? []),
    ...(n.allOf ?? []),
  ])
    numericLeaves(branch, path, out);
  for (const [k, v] of Object.entries(n.properties ?? {}))
    numericLeaves(v, `${path}.${k}`, out);
  for (const v of Object.values(n.patternProperties ?? {}))
    numericLeaves(v, `${path}.*`, out);
  if (n.additionalProperties && typeof n.additionalProperties === "object")
    numericLeaves(n.additionalProperties, `${path}.*`, out);
  const items = Array.isArray(n.items) ? n.items : n.items ? [n.items] : [];
  for (const v of items) numericLeaves(v, `${path}[]`, out);
}

// zod writes the safe-integer edge onto every `.int()` it publishes, so a bound AT that edge is no
// bound: counting it would wave through every integer someone forgot to cap.
const finite = (v: unknown) =>
  typeof v === "number" && Math.abs(v) < Number.MAX_SAFE_INTEGER;
const floored = (n: JsonNode) =>
  finite(n.minimum) || finite(n.exclusiveMinimum);
const isId = (path: string) => /(Id|_id)(\[\])?$/.test(path);
const bounded = (n: JsonNode, path: string) =>
  floored(n) &&
  (isId(path)
    ? (n.minimum ?? 0) >= 1 ||
      (typeof n.exclusiveMinimum === "number" && n.exclusiveMinimum >= 0)
    : finite(n.maximum) || finite(n.exclusiveMaximum));

interface RouteEntry {
  method: string;
  path: string;
  hooks?: { body?: unknown; query?: unknown };
}

async function mcpTools(
  scopes: VerifiedToken["scopes"],
): Promise<Map<string, unknown>> {
  const principal: VerifiedToken = {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes,
    clientId: "c",
    jti: "j",
  };
  const server = buildMcpServer(principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "range-check", version: "0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  return new Map(tools.map((tool) => [tool.name, tool.inputSchema]));
}

// The write tools are the ones only `mcp:write` registers.
async function mcpWriteInputs(): Promise<Map<string, unknown>> {
  const all = await mcpTools(["mcp:read", "mcp:write"]);
  for (const name of (await mcpTools(["mcp:read"])).keys()) all.delete(name);
  return all;
}

async function everyNumber(): Promise<Map<string, JsonNode>> {
  const out = new Map<string, JsonNode>();
  numericLeaves(
    z.toJSONSchema(z.object(BEHAVIOR_PATCH_SHAPE), {
      io: "input",
      unrepresentable: "any",
    }),
    "settings",
    out,
  );
  for (const route of app.routes as unknown as RouteEntry[]) {
    if (route.method === "GET") continue;
    const at = `${route.method} ${route.path}`;
    numericLeaves(route.hooks?.body, `${at} body`, out);
    numericLeaves(route.hooks?.query, `${at} query`, out);
  }
  for (const [name, schema] of await mcpWriteInputs())
    numericLeaves(schema, `mcp ${name}`, out);
  return out;
}

describe("every writable number has a range", () => {
  test("no number is declared without a minimum and a maximum", async () => {
    const all = await everyNumber();
    const open = [...all]
      .filter(([path, n]) => !bounded(n, path) && !(path in UNBOUNDED))
      .map(([path]) => path)
      .sort();
    expect(open).toEqual([]);
  });

  test("every excused number is still there and still unbounded", async () => {
    const all = await everyNumber();
    const stale = Object.keys(UNBOUNDED).filter((path) => {
      const n = all.get(path);
      return !n || bounded(n, path);
    });
    expect(stale).toEqual([]);
  });

  // The walk itself: a schema it cannot see into would pass the test above by having no numbers.
  test("the walk reaches the settings, the REST bodies and the MCP inputs", async () => {
    const paths = [...(await everyNumber()).keys()];
    expect(paths).toContain("settings.debounce.windowSeconds");
    expect(paths.some((p) => p.startsWith("PUT /api/v1/knowledge"))).toBe(true);
    expect(paths.some((p) => p.startsWith("mcp agent_settings_set"))).toBe(
      true,
    );
  });
});
