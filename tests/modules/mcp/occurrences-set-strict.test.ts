import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";

// The SDK builds a tool's arguments object from its shape and strips what the shape does not name,
// so a setting the occurrence monitor lacks would be applied as nothing and answered as a success.
// `occurrences_set` refuses it like its REST twin, through the registered tool, for a tenant token and
// for the fleet's (whose `tenant` selector is an argument of the shape).

const tokenOf = (role: VerifiedToken["role"]): VerifiedToken => ({
  userId: 1n,
  tenantId: role === "SUPER_ADMIN" ? null : 1n,
  role,
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
});

async function call(
  role: VerifiedToken["role"],
  args: Record<string, unknown>,
) {
  const server = buildMcpServer(tokenOf(role));
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "strict-check", version: "0" });
  await client.connect(clientT);
  try {
    return await client.callTool({ name: "occurrences_set", arguments: args });
  } finally {
    await client.close();
  }
}

const text = (r: Awaited<ReturnType<typeof call>>) =>
  (r.content as { type: string; text?: string }[])
    .map((c) => c.text ?? "")
    .join(" ");

describe("occurrences_set at the MCP boundary", () => {
  test("refuses an argument the monitor does not have", async () => {
    for (const [role, extra] of [
      ["TENANT_ADMIN", {}],
      ["SUPER_ADMIN", { tenant: "some-tenant" }],
    ] as const) {
      const res = await call(role, {
        ...extra,
        enabled: false,
        digestHour: 9,
        dry_run: false,
      });
      expect([role, res.isError]).toEqual([role, true]);
      expect(text(res)).toContain("digestHour");
    }
  });

  test("refuses the names the monitor had before", async () => {
    for (const old of ["subjectField", "problemField", "models"]) {
      const res = await call("TENANT_ADMIN", {
        enabled: false,
        [old]: old === "models" ? {} : "assunto",
        dry_run: false,
      });
      expect([old, res.isError]).toEqual([old, true]);
      expect(text(res)).toContain(old);
    }
  });
});
