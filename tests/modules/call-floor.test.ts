import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { GROUNDING_DIRECTIVE } from "@/graph/prompt";
import { CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES } from "@/graph/tools/channel-natives";
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
        "integration_instances",
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
    // The name the Tools tab shows, for the client to print instead of the identifier.
    expect(somar?.label).toBe("Somar");
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
    expect(after.instructionsAddedBy.grounding).toBe(
      estimateTokens(GROUNDING_DIRECTIVE),
    );
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

  // An LLM observer runs on a muted client and is never offered what reaches the customer, so the
  // floor it is shown has to leave those schemas out, or it reads high by every one of them.
  test("an LLM observer's floor leaves out what an observation is never offered", async () => {
    const make = async (mode?: "monitoring") =>
      (
        await suDb.agent.create({
          data: {
            tenantId,
            name: `Obs ${mode ?? "reply"}`,
            systemPrompt: PROMPT,
            ...(mode ? { mode } : {}),
            modelConfig: { provider: "openai", model: "gpt-4o-mini" },
            settings: mode ? { monitoring: { engine: "llm" } } : {},
          },
        })
      ).id;
    const observer = await make("monitoring");
    const responder = await make();
    const names = async (id: bigint) => {
      const f = await estimateCallFloor({
        ctx: ctx(),
        agentId: id,
        base: appDb,
      });
      if (f.engine !== "llm") throw new Error("engine");
      return f.tools.map((t) => t.name);
    };
    const delivering = [...CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES] as string[];
    const replying = await names(responder);
    // Positive control: with the default natives, a replying agent is offered some of them.
    expect(replying.some((n) => delivering.includes(n))).toBe(true);
    const observing = await names(observer);
    expect(observing.filter((n) => delivering.includes(n))).toEqual([]);
    expect(observing).toContain("private_note");
  });

  // Two instances of one pack expose the same names and only the first is offered, so a number is
  // tied to its instance; and an observer's pack tools are filtered like its natives.
  test("integration tools carry their instance, and an observer drops a pack's delivering tool", async () => {
    const make = async (mode?: "monitoring") =>
      (
        await suDb.agent.create({
          data: {
            tenantId,
            name: `Pack ${mode ?? "reply"}`,
            systemPrompt: PROMPT,
            ...(mode ? { mode } : {}),
            modelConfig: { provider: "openai", model: "gpt-4o-mini" },
            settings: mode ? { monitoring: { engine: "llm" } } : {},
          },
        })
      ).id;
    const first = await suDb.integrationInstance.create({
      data: { tenantId, catalogType: "RESEND", name: "envio-1" },
    });
    const second = await suDb.integrationInstance.create({
      data: { tenantId, catalogType: "RESEND", name: "envio-2" },
    });
    const floorFor = async (id: bigint) => {
      for (const inst of [first, second]) {
        await suDb.agentToolSelection.create({
          data: {
            tenantId,
            agentId: id,
            source: "INTEGRATION",
            integrationInstanceId: inst.id,
            enabledTools: ["resend_send_email", "resend_email_status"],
            knowledgeBaseIds: [],
          },
        });
      }
      const f = await estimateCallFloor({
        ctx: ctx(),
        agentId: id,
        base: appDb,
      });
      if (f.engine !== "llm") throw new Error("engine");
      return f.tools.filter((t) => t.name.startsWith("resend_"));
    };
    const replying = await floorFor(await make());
    expect(
      replying.map((t) => [t.name, t.integrationInstanceId]).sort(),
    ).toEqual([
      ["resend_email_status", String(first.id)],
      ["resend_send_email", String(first.id)],
    ]);
    const observing = await floorFor(await make("monitoring"));
    expect(observing.map((t) => t.name)).toEqual(["resend_email_status"]);
  });

  // A pack that keeps a tool and reshapes it for a muted turn (Calendar drops the invite argument)
  // has to see the observer's mute too, or the floor measures a schema the observation never sends.
  test("an observer's Calendar create is measured without the invite argument", async () => {
    const cal = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "GOOGLE_CALENDAR",
        name: "agenda",
        config: { inviteCustomer: "agent", calendarIds: ["primary"] },
      },
    });
    const create = async (mode?: "monitoring") => {
      const id = (
        await suDb.agent.create({
          data: {
            tenantId,
            name: `Agenda ${mode ?? "reply"}`,
            systemPrompt: PROMPT,
            ...(mode ? { mode } : {}),
            modelConfig: { provider: "openai", model: "gpt-4o-mini" },
            settings: mode ? { monitoring: { engine: "llm" } } : {},
          },
        })
      ).id;
      await suDb.agentToolSelection.create({
        data: {
          tenantId,
          agentId: id,
          source: "INTEGRATION",
          integrationInstanceId: cal.id,
          enabledTools: ["calendar_create_event"],
          knowledgeBaseIds: [],
        },
      });
      const f = await estimateCallFloor({
        ctx: ctx(),
        agentId: id,
        base: appDb,
      });
      if (f.engine !== "llm") throw new Error("engine");
      return f.tools.find((t) => t.name === "calendar_create_event");
    };
    const replying = await create();
    const observing = await create("monitoring");
    expect(replying).toBeDefined();
    expect(observing).toBeDefined();
    expect(observing?.estimatedTokens ?? 0).toBeLessThan(
      replying?.estimatedTokens ?? 0,
    );
  });

  // A row stored before names were canonicalized keeps its spelling; the build offers the normalized
  // one, so the floor has to classify and label it by that name or it reads as an unknown tool.
  test("a legacy-spelled code tool is classified and labelled by the name it is offered under", async () => {
    const legacy = await suDb.codeToolDefinition.create({
      data: {
        tenantId,
        name: "Consulta_Legada",
        label: "Consulta legada",
        description: "Consulta antiga.",
        inputSchema: { q: { type: "string", description: "q" } },
        code: "return input.q;",
      },
    });
    const sel = await grant({
      source: "CODE",
      codeToolDefinitionId: legacy.id,
    });
    const f = await floorOf();
    const row = f.tools.find((t) => t.name === "consulta_legada");
    expect(row).toMatchObject({ category: "code", label: "Consulta legada" });
    await suDb.agentToolSelection.delete({ where: { id: sel.id } });
  });

  // A handoff pinned to one target on one account is sent without a target to choose; built as "no
  // account" the pin reads as foreign and the tool grows an `assignTo` the model never sees.
  test("a pinned handoff is measured as pinned, not as the agent's choice", async () => {
    const make = async (handoff: {
      mode: string;
      targetAgentId?: number;
      targetInstanceId?: number;
    }) =>
      (
        await suDb.agent.create({
          data: {
            tenantId,
            name: `Handoff ${String(handoff.mode)}`,
            systemPrompt: PROMPT,
            modelConfig: { provider: "openai", model: "gpt-4o-mini" },
            settings: { handoff },
          },
        })
      ).id;
    const schemaOf = async (id: bigint) => {
      const f = await estimateCallFloor({
        ctx: ctx(),
        agentId: id,
        base: appDb,
      });
      if (f.engine !== "llm") throw new Error("engine");
      return f.tools.find((t) => t.name === "handoff_to_human")
        ?.estimatedTokens;
    };
    const pinned = await schemaOf(
      await make({
        mode: "pinned",
        targetAgentId: 3,
        targetInstanceId: 5,
      }),
    );
    const choice = await schemaOf(await make({ mode: "agent_choice" }));
    expect(pinned).toBeDefined();
    expect(choice).toBeDefined();
    expect(pinned ?? 0).toBeLessThan(choice ?? 0);
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
    // The editor's unsaved engine and mode decide, not the saved ones: switched to the model, the
    // observer gets numbers; switched back to answering, it is measured as an answering agent.
    // No NATIVE grant: the default natives, which include what delivers to the customer.
    const natives = { source: "RAG", enabledTools: [] };
    const asModel = await estimateCallFloor({
      ctx: ctx(),
      agentId: id,
      base: appDb,
      grants: [natives],
      settings: { monitoring: { engine: "llm" } },
    });
    expect(asModel.engine).toBe("llm");
    const answering = await estimateCallFloor({
      ctx: ctx(),
      agentId: id,
      base: appDb,
      grants: [natives],
      mode: "production",
    });
    if (asModel.engine !== "llm" || answering.engine !== "llm")
      throw new Error("engine");
    // An observer is offered nothing that delivers to the customer; an answering agent is.
    const delivering = [...CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES] as string[];
    expect(asModel.tools.filter((t) => delivering.includes(t.name))).toEqual(
      [],
    );
    expect(answering.tools.some((t) => delivering.includes(t.name))).toBe(true);
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
  // The editor measures the set on screen, so a switch shows its cost before the save. The draft
  // replaces the saved set whole, writes nothing, and reads its targets inside the tenant.
  test("an unsaved grant set is measured in place of the saved one, and nothing is written", async () => {
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "Rascunho" },
    });
    const mine = await suDb.codeToolDefinition.create({
      data: {
        tenantId,
        name: "so_no_rascunho",
        label: "Só no rascunho",
        description: "Existe só no rascunho.",
        inputSchema: { q: { type: "string", description: "q" } },
        code: "return input.q;",
      },
    });
    const foreign = await suDb.codeToolDefinition.create({
      data: {
        tenantId: otherTenantId,
        name: "de_outro_tenant",
        label: "De outro tenant",
        description: "Pertence a outro tenant.",
        inputSchema: { q: { type: "string", description: "q" } },
        code: "return input.q;",
      },
    });
    const savedBefore = await suDb.agentToolSelection.count({
      where: { agentId },
    });
    const saved = await floorOf();
    const draft = await estimateCallFloor({
      ctx: ctx(),
      agentId,
      base: appDb,
      grants: [
        { source: "NATIVE", enabledTools: [] },
        { source: "CODE", codeToolDefinitionId: String(mine.id) },
        { source: "CODE", codeToolDefinitionId: String(foreign.id) },
        {
          source: "RAG",
          enabledTools: ["suggest_kb_entry"],
          knowledgeBaseIds: [String(kb.id)],
        },
      ],
    });
    if (draft.engine !== "llm") throw new Error("engine");
    // Exactly the draft: the saved tools are gone, the draft's own is there, the foreign one is not.
    expect(draft.tools.map((t) => t.name).sort()).toEqual([
      "so_no_rascunho",
      "suggest_kb_entry",
    ]);
    // Suggestions alone do not ground the answers, so the rules the saved search added are not sent.
    expect(saved.instructionsAddedBy.grounding).toBeGreaterThan(0);
    expect(draft.instructionsAddedBy.grounding).toBe(0);
    expect(await suDb.agentToolSelection.count({ where: { agentId } })).toBe(
      savedBefore,
    );
    expect(await floorOf()).toEqual(saved);
    // A set the save refuses is refused here too, rather than measured as something else.
    await expect(
      estimateCallFloor({
        ctx: ctx(),
        agentId,
        base: appDb,
        grants: [{ source: "NATIVE", enabledTools: ["no_such_tool"] }],
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  // A tool's schema reads the settings too, so a draft measured on the saved ones undercounts.
  test("unsaved settings shape the handoff the draft measures", async () => {
    const handoffOf = async (extra: { settings?: Record<string, unknown> }) => {
      const f = await estimateCallFloor({
        ctx: ctx(),
        agentId,
        base: appDb,
        grants: [{ source: "NATIVE", enabledTools: ["handoff_to_human"] }],
        ...extra,
      });
      if (f.engine !== "llm") throw new Error("engine");
      const tool = f.tools.find((t) => t.name === "handoff_to_human");
      if (!tool) throw new Error("no handoff");
      return tool.estimatedTokens;
    };
    const saved = await handoffOf({});
    const instructed = await handoffOf({
      settings: {
        handoff: {
          instructions:
            "Cobrança vai para o Financeiro; trocas e devoluções para o Pós-venda; entrega para a Logística, com o número do pedido.",
        },
      },
    });
    expect(instructed).toBeGreaterThan(saved);
  });

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
