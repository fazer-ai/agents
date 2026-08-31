import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import type { TenantContext } from "@/lib/tenancy";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// The seam that was broken, over a real request: what the controller HANDS DOWN.
//
// `runScopedOn` verifies an unknown tenant only for a `SUPER_ADMIN` context, so the module has to
// receive the caller's context and not an id lifted out of it. Every route in this controller used
// to call a helper that unwrapped `tenantContext` down to `ctx.tenantId`, which meant the id arrived
// at the module with its provenance gone and was rebuilt as TENANT_ADMIN. Asserted here rather than
// only in `tests/modules/tenant-selector-entry-points.test.ts`, because that file proves the
// FUNCTIONS refuse and says nothing about whether the transport still reaches them with a context.
//
// Driven through the real app so the `X-Tenant-Id` header is parsed by the boundary the browser
// actually talks to. Issue #280.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const ragService = await import("@/modules/rag/service");
// The return type is DERIVED from the real function rather than written as `unknown[]`: `spyOn` is
// typed where a registry rewrite was not, so the shape the route actually receives is checked here
// instead of at runtime in whatever file the leak reached.
const listKnowledgeBases = mock(
  async (
    _ctx: TenantContext,
    _base?: unknown,
  ): Promise<Awaited<ReturnType<typeof ragService.listKnowledgeBases>>> => [],
);
// A SPY ON THE MODULE OBJECT, NOT A REGISTRY REWRITE. A rewrite is process-global and its undo is a
// second rewrite that does not undo anything: `await import()` hands back the LIVE namespace, and
// the mock rewrote it in place, so handing that same object back re-registers the stub while
// reading as a cleanup. tests/lib/module-mock-package.test.ts states this; this file was written
// before it did.
//
// Measured on the four shards: with the rewrite in place, `listKnowledgeBases` went on answering
// `[]` for every file downstream, and tests/modules/tenant-selector-entry-points.test.ts, which
// calls the real one to prove it REFUSES a dead tenant selector, got the stub, so nothing
// was refused and the tenant lookup it counts never happened. Two failures in shard 1/4, neither
// naming this file.
const spy = spyOn(ragService, "listKnowledgeBases").mockImplementation(
  listKnowledgeBases,
);

const app = (await import("@/app")).default;

afterAll(() => {
  spy.mockRestore();
});

// A fleet operator: no home tenant, and a target chosen per request via the header.
const fleetUser = { ...mockUser, tenantId: null, role: "SUPER_ADMIN" as const };
mockFindUnique.mockImplementation(() => Promise.resolve(fleetUser));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(fleetUser),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

async function listBases(selector: string): Promise<Response> {
  return app.handle(
    new BunRequest("http://localhost/api/v1/knowledge/bases", {
      headers: {
        cookie: `fazerai_auth_token=${token}`,
        "X-Tenant-Id": selector,
      },
    }),
  );
}

describe("GET /v1/knowledge/bases carrying a tenant selector", () => {
  test("hands the module the request's context, not an id lifted out of it", async () => {
    listKnowledgeBases.mockClear();
    const res = await listBases("4242");
    expect(res.status).toBe(200);
    expect(listKnowledgeBases).toHaveBeenCalled();
    const ctx = listKnowledgeBases.mock.calls[0]?.[0] as TenantContext;
    expect(ctx.tenantId).toBe(4242n);
    // The half that matters. A bare `4242n` would have been indistinguishable from an id this
    // process read from a row, and `runScopedOn` would have skipped the existence check on it.
    expect(ctx.role).toBe("SUPER_ADMIN");
  });
});
