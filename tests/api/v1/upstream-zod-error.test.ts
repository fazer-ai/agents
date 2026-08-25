import { afterAll, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { z } from "zod";
import { authPlugin } from "@/api/lib/auth";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// The half of issue #301 that a global "a ZodError means the caller sent something wrong" branch got
// backwards, found by review on PR #309.
//
// `discoverMcpTools` calls `MultiServerMCPClient.getTools()`, and the MCP SDK validates the REMOTE
// server's JSON-RPC results with the same zod package this repo depends on
// (@modelcontextprotocol/sdk, shared/protocol.js: `safeParse(resultSchema, response.result)` then
// `reject(parseResult.error)`; zod 4.4.3 is deduped, so that error IS `instanceof ZodError` here).
// A malformed answer from someone else's server is not the operator's input being wrong, and
// answering it 422 with `field` would name a value the caller never sent, while logging a server
// fault as a warning.
//
// So the refusal is raised where the input is KNOWN to be the caller's — `parseInput` — and a bare
// ZodError keeps the 500 it deserves. That is what this file pins.
const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const mcpService = await import("@/modules/mcp-connections/service");
// A ZodError produced the way the SDK produces one: a schema THIS request never chose, over a value
// the caller never sent.
const upstream = z.object({ tools: z.array(z.object({ name: z.string() })) });
mock.module("@/modules/mcp-connections/service", () => ({
  ...mcpService,
  discoverMcpTools: async () => {
    upstream.parse({ tools: [{ name: 42 }] });
    return { instructions: null, tools: [] };
  },
}));

const app = (await import("@/app")).default;

// `mock.module` is GLOBAL to the process and outlives this file for every other test in the same
// worker, so put the module back.
afterAll(() => {
  mock.module("@/modules/mcp-connections/service", () => mcpService);
});

const admin = { ...mockUser, tenantId: 1n, role: "TENANT_ADMIN" as const };
mockFindUnique.mockImplementation(() => Promise.resolve(admin));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(admin),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

describe("a ZodError raised by something other than this request's input", () => {
  test("is a server fault, not the caller's", async () => {
    const res = await app.handle(
      new BunRequest("http://localhost/api/v1/mcp-connections/1/discover", {
        method: "POST",
        headers: { cookie: `fazerai_auth_token=${token}` },
      }),
    );
    const text = await res.text();
    expect(res.status).toBe(500);
    // …and it does not name a field, which is the half that would have been actively misleading:
    // `tools.0.name` is a path into someone else's answer.
    expect(text).not.toContain("tools.0.name");
  });
});
