import { afterAll, describe, expect, mock, test } from "bun:test";
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
const listKnowledgeBases = mock(
  async (_ctx: TenantContext, _base?: unknown): Promise<unknown[]> => [],
);
// Spread the real module: the controller imports a dozen other names from it, and replacing the
// whole module with one function would break the route graph at import time.
mock.module("@/modules/rag/service", () => ({
  ...ragService,
  listKnowledgeBases,
}));

const app = (await import("@/app")).default;

// `mock.module` is GLOBAL to the process and outlives this file for every other test in the same
// worker, so put the module back.
afterAll(() => {
  mock.module("@/modules/rag/service", () => ragService);
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
