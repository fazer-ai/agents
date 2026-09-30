import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// Both transports hand the headers map to the service key for key. A `__proto__` name is dropped by
// t.Record and by z.record on the way in, which would turn a PATCH carrying only that name into
// "clear every header"; the service refuses it by name, so it has to arrive.
const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

setupPrismaMock();

const service = await import("@/modules/mcp-connections/service");
const writes = await import("@/modules/mcp/write-agents");
const seen: unknown[] = [];
const capture = (input: unknown) => {
  seen.push((input as { headers?: unknown }).headers);
  throw new Error("captured");
};
const spies = [
  spyOn(service, "createMcpConnection").mockImplementation(((
    _ctx: unknown,
    input: unknown,
  ) => capture(input)) as unknown as typeof service.createMcpConnection),
  spyOn(service, "updateMcpConnection").mockImplementation(((
    _ctx: unknown,
    _id: unknown,
    input: unknown,
  ) => capture(input)) as unknown as typeof service.updateMcpConnection),
  spyOn(writes, "mcpConnectionCreate").mockImplementation(((
    _eff: unknown,
    args: unknown,
  ) => capture(args)) as unknown as typeof writes.mcpConnectionCreate),
  spyOn(writes, "mcpConnectionUpdate").mockImplementation(((
    _eff: unknown,
    args: unknown,
  ) => capture(args)) as unknown as typeof writes.mcpConnectionUpdate),
];
const app = (await import("@/app")).default;
const { buildMcpServer } = await import("@/modules/mcp/server");

afterAll(() => {
  for (const s of spies) s.mockRestore();
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

const PROTO = '{"__proto__":"v","X-A":"1"}';
const keysOf = (v: unknown) => Object.keys(v as object).sort();

describe("a __proto__ header name reaches the service", () => {
  test("over REST, on create and on update", async () => {
    seen.length = 0;
    for (const [method, path, body] of [
      [
        "POST",
        "/api/v1/mcp-connections",
        `{"name":"p","transport":"sse","url":"https://example.com/sse","headers":${PROTO}}`,
      ],
      ["PATCH", "/api/v1/mcp-connections/1", `{"headers":${PROTO}}`],
    ] as const) {
      await app.handle(
        new BunRequest(`http://localhost${path}`, {
          method,
          headers: {
            cookie: `fazerai_auth_token=${token}`,
            "content-type": "application/json",
          },
          body,
        }),
      );
    }
    expect(seen.map(keysOf)).toEqual([
      ["X-A", "__proto__"],
      ["X-A", "__proto__"],
    ]);
  });

  test("over MCP, on mcp_connection_create and mcp_connection_update", async () => {
    seen.length = 0;
    const server = buildMcpServer({
      userId: 1n,
      tenantId: 1n,
      clientId: "c",
      jti: "j",
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
    } as VerifiedToken);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "proto", version: "0" });
    await client.connect(ct);
    await client.callTool({
      name: "mcp_connection_create",
      arguments: {
        name: "p",
        transport: "sse",
        url: "https://example.com/sse",
        headers: JSON.parse(PROTO),
      },
    });
    await client.callTool({
      name: "mcp_connection_update",
      arguments: { connection_id: "1", headers: JSON.parse(PROTO) },
    });
    await client.close();
    expect(seen.map(keysOf)).toEqual([
      ["X-A", "__proto__"],
      ["X-A", "__proto__"],
    ]);
  });
});
