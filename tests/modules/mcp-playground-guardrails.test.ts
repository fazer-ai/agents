import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer, playgroundTurnOptions } from "@/modules/mcp/server";

// One core, three transports: the guardrail toggle has to reach the playground through MCP the way
// it reaches it through REST, or every MCP turn pays for a screening it cannot decline. Two halves,
// because they fail separately: the tool has to ADVERTISE the field, and the handler has to FORWARD
// it. A schema that declares it and a handler that drops it is silent.

const principal: VerifiedToken = {
  userId: 1n,
  tenantId: 1n,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read"],
  clientId: "test",
  jti: "test-jti",
};

describe("agent_playground guardrail toggle", () => {
  test("the tool a real client lists advertises the field", async () => {
    const server = buildMcpServer(principal);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "probe", version: "0" });
    await client.connect(clientT);
    const { tools } = await client.listTools();
    await client.close();
    await server.close();
    const props = (
      tools.find((t) => t.name === "agent_playground")?.inputSchema as {
        properties?: Record<string, unknown>;
      }
    )?.properties;
    expect(props).toHaveProperty("guardrails");
  });

  // The mapping the three branches (text / audio / file) share. Read inline in each, the toggle
  // reached one of them and not the others.
  test("the mapping carries it through, and absent stays absent", () => {
    expect(playgroundTurnOptions({ guardrails: false })).toEqual({
      forceAudio: undefined,
      guardrails: false,
    });
    expect(playgroundTurnOptions({ reply_with_audio: true })).toEqual({
      forceAudio: true,
      guardrails: undefined,
    });
  });
});
