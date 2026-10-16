import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { GROUNDING_DIRECTIVE } from "@/graph/prompt";
import type { TenantContext } from "@/lib/tenancy";
import { estimateTokens } from "@/lib/token-estimate";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentCallFloor } from "@/modules/mcp/read";
import { estimateCallFloor } from "@/modules/playground/service";
import { dbProbeFailed } from "@/tests/db-gate";

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

function principal(t: bigint, scopes = ["mcp:read"]): VerifiedToken {
  return {
    userId: 1n,
    tenantId: t,
    role: "TENANT_ADMIN",
    scopes,
    clientId: "c",
    jti: "j",
  };
}

const PROMPT = "Você atende a loja. ".repeat(40);

// The number the agent editor shows next to the history ceiling. Every agent here has NO model
// credential: the estimate needs no key, and an operator sizing a prompt before wiring one in still
// gets an answer instead of the playground's "not runnable".
describe.skipIf(!dbUp)("estimateCallFloor", () => {
  let tenantId = 0n;
  let otherTenantId = 0n;
  let agentId = 0n;
  let nativeId = 0n;
  const ctx = (id = tenantId): TenantContext => ({
    tenantId: id,
    userId: null,
    role: "TENANT_ADMIN",
  });
  const floorOf = async (id = agentId) => {
    const f = await estimateCallFloor({ ctx: ctx(), agentId: id, base: appDb });
    if (f.engine !== "llm") throw new Error(`engine ${f.engine}`);
    return f;
  };
  const grant = (data: Record<string, unknown>) =>
    suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId,
        enabledTools: [],
        knowledgeBaseIds: [],
        ...data,
      } as never,
    });

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Floor", slug: `call-floor-${process.pid}` },
    });
    tenantId = t.id;
    otherTenantId = (
      await suDb.tenant.create({
        data: { name: "Floor B", slug: `call-floor-b-${process.pid}` },
      })
    ).id;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Loja",
          systemPrompt: PROMPT,
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
      })
    ).id;
  });

  afterAll(async () => {
    for (const id of [tenantId, otherTenantId]) {
      if (!id) continue;
      for (const table of [
        "agent_tool_selections",
        "code_tool_definitions",
        "knowledge_bases",
        "agents",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${id}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  // An agent with no native grant row gets the default set; revoking it explicitly is "no tools".
  test("with no tool granted the floor is the instructions, and nothing else", async () => {
    nativeId = (await grant({ source: "NATIVE", enabledTools: [] })).id;
    const f = await floorOf();
    expect(f.tools).toEqual([]);
    expect(f.instructionsAdded).toBe(0);
    expect(f.instructions).toBe(estimateTokens(PROMPT));
    expect(f.instructions).toBeGreaterThan(0);
    expect(f.total).toBe(f.instructions);
  });

  test("granting a tool moves the total by that tool's schema and leaves the instructions alone", async () => {
    const before = await floorOf();
    const code = await suDb.codeToolDefinition.create({
      data: {
        tenantId,
        name: "somar",
        label: "Somar",
        // Long on purpose: the largest schema, assembled AFTER the natives, so the order the
        // breakdown shows is the sort's and not the assembly's.
        description: "Soma dois números informados pelo cliente. ".repeat(40),
        inputSchema: {
          a: { type: "number", description: "primeira parcela" },
          b: { type: "number", description: "segunda parcela" },
        },
        code: "return input.a + input.b;",
      },
    });
    await grant({ source: "CODE", codeToolDefinitionId: code.id });
    await suDb.agentToolSelection.update({
      where: { id: nativeId },
      data: { enabledTools: ["handoff_to_human", "calculator"] },
    });
    const after = await floorOf();
    expect(after.instructions).toBe(before.instructions);
    const names = after.tools.map((t) => t.name);
    expect(names).toContain("somar");
    expect(names).toContain("handoff_to_human");
    const somar = after.tools.find((t) => t.name === "somar");
    expect(somar?.category).toBe("code");
    expect(somar?.estimatedTokens).toBeGreaterThan(10);
    // Largest first, so the breakdown names what to trim before what does not matter.
    const sizes = after.tools.map((t) => t.estimatedTokens);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(after.tools[0]?.name).toBe("somar");
    expect(after.total).toBe(
      after.instructions +
        after.instructionsAdded +
        sizes.reduce((s, n) => s + n, 0),
    );
  });

  test("knowledge search adds the grounding rules the runtime appends", async () => {
    const before = await floorOf();
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "Docs" },
    });
    await grant({
      source: "RAG",
      enabledTools: ["search_knowledge"],
      knowledgeBaseIds: [kb.id],
    });
    const after = await floorOf();
    expect(after.instructionsAdded - before.instructionsAdded).toBe(
      estimateTokens(GROUNDING_DIRECTIVE),
    );
    expect(after.tools.map((t) => t.name)).toContain("search_knowledge");
  });

  // An MCP tool reaches the model under a namespaced, deduplicated name, so the editor finds its row by
  // the grant: the connection and the name on the server's side.
  test("an MCP tool carries its grant, and its server block counts as an addition", async () => {
    const before = await floorOf();
    const conn = await suDb.mcpServerConnection.create({
      data: {
        tenantId,
        name: "Loja",
        transport: "streamableHttp",
        url: "https://loja.example.com/mcp",
      },
    });
    await grant({
      source: "MCP",
      mcpServerConnectionId: conn.id,
      enabledTools: ["estoque"],
    });
    const estoque = tool(async () => "12", {
      name: "estoque",
      description: "Quantas unidades de um produto há em estoque.",
      schema: z.object({ sku: z.string() }),
    });
    const f = await estimateCallFloor({
      ctx: ctx(),
      agentId,
      base: appDb,
      deps: {
        mcp: {
          connect: (async () => [estoque]) as never,
          instructionsFor: async () => "Servidor do estoque da loja.",
        },
      },
    });
    if (f.engine !== "llm") throw new Error("engine");
    const row = f.tools.find((t) => t.mcp);
    expect(row).toMatchObject({
      category: "mcp",
      mcp: { connectionId: String(conn.id), tool: "estoque" },
    });
    expect(row?.name).not.toBe("estoque");
    expect(f.instructionsAdded).toBeGreaterThan(before.instructionsAdded);
    await suDb.agentToolSelection.deleteMany({
      where: { mcpServerConnectionId: conn.id },
    });
    await suDb.mcpServerConnection.delete({ where: { id: conn.id } });
  });

  test("a decisions-engine observer gets no numbers: it never sends this prompt", async () => {
    const id = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Observador",
          systemPrompt: PROMPT,
          mode: "monitoring",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
          settings: {
            monitoring: {
              engine: "decisions",
              decisions: {
                provider: "typesafe",
                questions: [
                  { name: "q", type: "yes_no", instructions: "Pergunta?" },
                ],
                rules: [],
              },
            },
          },
        },
      })
    ).id;
    expect(
      await estimateCallFloor({ ctx: ctx(), agentId: id, base: appDb }),
    ).toEqual({ engine: "decisions" });
  });

  test("another tenant's agent is not found", async () => {
    await expect(
      estimateCallFloor({
        ctx: ctx(otherTenantId),
        agentId,
        base: appDb,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // The same number for a caller that never opens the console, fenced like every MCP read.
  test("agent_call_floor answers the console's number, inside the token's tenant only", async () => {
    const r = await agentCallFloor(
      principal(tenantId),
      { agent_id: String(agentId) },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.floor).toEqual(await floorOf());
    const other = await agentCallFloor(
      principal(otherTenantId),
      { agent_id: String(agentId) },
      { base: appDb },
    );
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.error).toContain("not found");
    const unscoped = await agentCallFloor(
      principal(tenantId, []),
      { agent_id: String(agentId) },
      { base: appDb },
    );
    expect(unscoped.ok).toBe(false);
    if (!unscoped.ok) expect(unscoped.error).toContain("insufficient_scope");
  });
});
