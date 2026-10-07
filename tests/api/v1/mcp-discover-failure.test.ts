import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// A discovery the MCP server fails answers 502 with the localized sentence the console shows, and
// no stack: the operator reads why, not where in our code it surfaced.
const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const mcpService = await import("@/modules/mcp-connections/service");
const refusedCredential = Object.assign(new Error("upstream said no"), {
  data: { status: 401 },
});
const discoverMcpTools = spyOn(
  mcpService,
  "discoverMcpTools",
).mockImplementation((async () => {
  throw mcpService.__discoveryForTest.discoveryError(refusedCredential);
}) as unknown as typeof mcpService.discoverMcpTools);

const app = (await import("@/app")).default;

afterAll(() => {
  discoverMcpTools.mockRestore();
});

const admin = { ...mockUser, tenantId: 1n, role: "TENANT_ADMIN" as const };
mockFindUnique.mockImplementation(() => Promise.resolve(admin));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(admin, admin.passwordHash),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

describe("a discovery the MCP server fails", () => {
  test("answers 502 with the localized reason and no stack", async () => {
    const res = await app.handle(
      new BunRequest("http://localhost/api/v1/mcp-connections/1/discover", {
        method: "POST",
        headers: {
          cookie: `fazerai_auth_token=${token}`,
          "accept-language": "pt-BR",
        },
      }),
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "O servidor MCP recusou a credencial (HTTP 401). Confira a credencial desta conexão.",
    );
    expect(JSON.stringify(body)).not.toContain("upstream said no");
    expect(JSON.stringify(body)).not.toMatch(/\n\s+at /);
  });
});
