import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FLOW_LEVELS, FLOW_STAGES } from "@/modules/flowlog/stages";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";

// The log tools' `stage` filter is the closed vocabulary `logs_stages` advertises, not a copy of it.
// The copy had drifted to 8 of the 11 stages (no `vision`, `guardrail` or `normalize`), so a caller
// that asked this server which stages exist and then filtered by one of them was refused by the
// same server. Read off the tool list a real client sees, so what is asserted is what is served.
const principal: VerifiedToken = {
  userId: 1n,
  tenantId: 1n,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read"],
  clientId: "test",
  jti: "test-jti",
};

async function toolSchemas(): Promise<Map<string, Record<string, unknown>>> {
  const server = buildMcpServer(principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "schema-probe", version: "0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return new Map(
    tools.map((t) => [t.name, t.inputSchema as Record<string, unknown>]),
  );
}

describe("MCP log tools filter vocabulary", () => {
  test("logs_query and logs_export accept every stage and level the vocabulary defines", async () => {
    const schemas = await toolSchemas();
    for (const name of ["logs_query", "logs_export"]) {
      const props = (schemas.get(name)?.properties ?? {}) as Record<
        string,
        { enum?: string[] }
      >;
      expect(`${name}:${[...(props.stage?.enum ?? [])].sort().join(",")}`).toBe(
        `${name}:${[...FLOW_STAGES].sort().join(",")}`,
      );
      expect(`${name}:${[...(props.level?.enum ?? [])].sort().join(",")}`).toBe(
        `${name}:${[...FLOW_LEVELS].sort().join(",")}`,
      );
    }
  });
});
