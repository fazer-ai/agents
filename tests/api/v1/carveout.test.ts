import { describe, expect, test } from "bun:test";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// Routing carve-out smoke for the v1 read API. Proves /api/v1/* is routed to Elysia (not
// served the SPA HTMLBundle by Bun's native routes table) for BOTH GET and POST — the
// load-bearing invariant from docs/routing.md, extended to POST per the hardened spec (so a
// future webhook POST never silently receives index.html).
setupPrismaMock();
const app = (await import("@/app")).default;

async function bodyOf(res: Response): Promise<string> {
  return (await res.text()).toLowerCase();
}

describe("read API routing carve-out", () => {
  test("GET /api/v1/meta without auth → 401 JSON, not HTML", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/meta"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
  });

  test("POST /api/v1/tenants → JSON, never the SPA HTMLBundle", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/tenants", { method: "POST" }),
    );
    expect(await bodyOf(res)).not.toContain("<!doctype");
  });

  test("POST /api/v1/integrations/inbound/:token → handled by Elysia, never the SPA HTMLBundle", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/integrations/inbound/sometoken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    // The route reached Elysia (no DB in this mock → not a 200 HTML shell). The load-bearing
    // invariant: a webhook POST must not silently receive index.html (Chatwoot would then
    // auto-escalate pending→open on the non-2xx/HTML ack).
    expect(await bodyOf(res)).not.toContain("<!doctype");
  });

  test("POST /api/v1/chatwoot/webhook/:token → handled by Elysia, never the SPA HTMLBundle", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/chatwoot/webhook/sometoken", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    // A bad/unknown token resolves to a uniform 401 (UnauthorizedError), never index.html — a
    // non-2xx/HTML ack would make Chatwoot auto-escalate the conversation pending→open.
    expect(await bodyOf(res)).not.toContain("<!doctype");
  });

  test("POST /api/v1/knowledge/search without auth → JSON, never the SPA HTMLBundle", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/knowledge/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "x" }),
      }),
    );
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    expect(await bodyOf(res)).not.toContain("<!doctype");
  });

  test("GET an unknown /api/v1 path → JSON 404, not HTML", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/does-not-exist"),
    );
    expect(res.status).toBe(404);
    expect(await bodyOf(res)).not.toContain("<!doctype");
  });

  test("a non-API deep route still serves the SPA shell", async () => {
    const res = await app.handle(
      new Request("http://localhost/settings/profile"),
    );
    expect(res.status).toBe(200);
  });

  // The API docs are mounted in dev (tests run with env=development). The OpenAPI spec is served
  // at /api/docs/json; in production the plugin is disabled (enabled:false in src/api/index.ts).
  test("GET /api/docs/json serves the OpenAPI spec in dev", async () => {
    const res = await app.handle(new Request("http://localhost/api/docs/json"));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body).toContain("openapi");
    expect(body).not.toContain("<!doctype");
  });

  // Regression: every controller must tag its operations and every declared top-level tag
  // must own at least one operation. Otherwise Scalar renders empty groups (declared-but-unused
  // tags) and a pile of loose endpoints (untagged operations) at the bottom of the list.
  test("OpenAPI spec: no untagged operations, no empty tag groups", async () => {
    const res = await app.handle(new Request("http://localhost/api/docs/json"));
    const spec = (await res.json()) as {
      tags?: { name: string }[];
      paths: Record<string, Record<string, { tags?: string[] }>>;
    };
    const declared = new Set((spec.tags ?? []).map((t) => t.name));
    const used = new Set<string>();
    const untagged: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (!op.tags?.length) untagged.push(`${method.toUpperCase()} ${path}`);
        for (const tag of op.tags ?? []) used.add(tag);
      }
    }
    // No operation may be loose (untagged).
    expect(untagged).toEqual([]);
    // No declared tag may be empty (declared but unused).
    const empty = [...declared].filter((t) => !used.has(t));
    expect(empty).toEqual([]);
    // No operation may use a tag that the top-level list does not declare.
    const undeclared = [...used].filter((t) => !declared.has(t));
    expect(undeclared).toEqual([]);
  });
});
