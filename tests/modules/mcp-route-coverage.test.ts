import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import api from "@/api";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { ROUTE_COVERAGE } from "@/modules/mcp/route-coverage";
import { buildMcpServer } from "@/modules/mcp/server";

// Every REST route either has an MCP twin, or says why not, or is a named gap. The table is the
// route-coverage module, and its header says what each answer means.

// The routes the mounted API answers, read off the app itself rather than off the controllers' text.
// The table covers the REST API v1 controllers; the branding feature mounts its console endpoints
// under the same `/v1` prefix from outside them, so it is left out by name.
function declaredRoutes(): string[] {
  return (
    api as unknown as { routes: { method: string; path: string }[] }
  ).routes
    .filter((r) => r.path.startsWith("/v1/"))
    .filter((r) => !r.path.startsWith("/v1/branding"))
    .map((r) => `${r.method} ${r.path}`);
}

async function registeredTools(): Promise<Set<string>> {
  const names = new Set<string>();
  // Both ranks: a tenant admin sees the tenant tools, a SUPER_ADMIN also the fleet ones.
  const principals: VerifiedToken[] = [
    {
      userId: 1n,
      tenantId: 1n,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    },
    {
      userId: 1n,
      tenantId: null,
      role: "SUPER_ADMIN",
      // NOTE: `mcp:admin` too: the fleet tools (deployment, tenants) are published only under it, and without it
      // they read as absent.
      scopes: ["mcp:read", "mcp:write", "mcp:admin"],
      clientId: "c",
      jti: "j",
    },
  ];
  for (const principal of principals) {
    const server = buildMcpServer(principal);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "route-coverage", version: "0" });
    await client.connect(clientT);
    for (const t of (await client.listTools()).tools) names.add(t.name);
    await client.close();
  }
  return names;
}

describe("REST routes and their MCP twins", () => {
  const routes = declaredRoutes();

  test("the scan finds the routes it is meant to find", () => {
    // An enumeration that found nothing would make every check below vacuous.
    expect(routes.length).toBeGreaterThan(200);
    expect(routes).toContain("PATCH /v1/knowledge/documents/:id");
    expect(routes).toContain("POST /v1/chatwoot/webhook/:routeToken");
    expect(new Set(routes).size).toBe(routes.length);
  });

  test("every route has an answer: a tool, a reason, or a named gap", () => {
    const unanswered = routes.filter((r) => !(r in ROUTE_COVERAGE));
    // A new route lands here. Give it a `tool`, a `none` with the reason, or a `gap`.
    expect(unanswered).toEqual([]);
  });

  test("no entry names a route that no longer exists", () => {
    const declared = new Set(routes);
    expect(Object.keys(ROUTE_COVERAGE).filter((k) => !declared.has(k))).toEqual(
      [],
    );
  });

  test("every tool named is one the server registers", async () => {
    const tools = await registeredTools();
    const unknown = Object.entries(ROUTE_COVERAGE)
      .filter(([, c]) => "tool" in c && !tools.has(c.tool))
      .map(([route, c]) => `${route} -> ${"tool" in c ? c.tool : ""}`);
    expect(unknown).toEqual([]);
  });

  test("every reason and every gap says something", () => {
    const blank = Object.entries(ROUTE_COVERAGE)
      .filter(([, c]) => {
        if ("tool" in c) return false;
        const text = "none" in c ? c.none : c.gap;
        return text.trim().length < 8;
      })
      .map(([route]) => route);
    expect(blank).toEqual([]);
  });

  // NOTE: Reading and editing a knowledge document, pinned so the table cannot quietly demote them to a gap.
  test("reading and editing a knowledge document have tools", () => {
    expect(ROUTE_COVERAGE["GET /v1/knowledge/documents/:id"]).toEqual({
      tool: "knowledge_document_get",
    });
    expect(ROUTE_COVERAGE["PATCH /v1/knowledge/documents/:id"]).toEqual({
      tool: "knowledge_document_update",
    });
  });
});
