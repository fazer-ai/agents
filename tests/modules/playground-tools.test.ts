import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { SKIP_REPLY_TOOL, skipReplyRan } from "@/graph/silence";
import { buildSimulatedNativeTools } from "@/graph/tools/native";
import type { TenantContext } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  applyToolMocks,
  listPlaygroundTools,
} from "@/modules/playground/service";

// A client whose every method throws if called — proves the simulated tools never touch Chatwoot.
const explodingClient = new Proxy(
  {},
  {
    get() {
      return async () => {
        throw new Error("client should not be called for a simulated tool");
      };
    },
  },
) as unknown as ChatwootClient;

describe("buildSimulatedNativeTools (P4)", () => {
  test("conversation tools are simulated (no client call); utility tools run for real", async () => {
    const tools = buildSimulatedNativeTools(
      { client: explodingClient, conversationId: 0 },
      ["handoff_to_human", "assign_label", "calculator"],
    );
    const handoff = tools.find((t) => t.name === "handoff_to_human");
    const label = tools.find((t) => t.name === "assign_label");
    const calc = tools.find((t) => t.name === "calculator");
    expect(handoff).toBeDefined();
    expect(label).toBeDefined();
    expect(calc).toBeDefined();

    // The conversation tool returns a synthetic success and never reaches the (exploding) client.
    const out = String(
      await handoff?.invoke({ reason: "preciso de um humano" }),
    );
    expect(out.toLowerCase()).toContain("simulated");

    // assign_label is conversation-scoped too → simulated (read/write labels never hit the client).
    const labelOut = String(await label?.invoke({ label: "vip" }));
    expect(labelOut.toLowerCase()).toContain("simulated");

    // The utility tool still computes for real.
    const calcOut = String(await calc?.invoke({ expression: "2 + 3" }));
    expect(calcOut).toContain("5");
  });
});

describe("applyToolMocks (P4)", () => {
  // Issue #454, review round 3. `skip_reply` is conversation-scoped by category, so it used to be
  // wrapped like the rest — and its RETURN is the whole tool: LangGraph calls the model again after
  // a tool result, and "Produce no message now" is the instruction that makes the follow-up silent.
  // Replaced by the generic `[simulated]` line, the playground writes a message production suppresses,
  // which is the simulation lying about the one decision it exists to show.
  test("skip_reply keeps its real acknowledgement instead of the simulated line", async () => {
    const tools = buildSimulatedNativeTools(
      { client: explodingClient, conversationId: 0 },
      ["skip_reply", "handoff_to_human"],
    );
    const skip = tools.find((t) => t.name === "skip_reply");
    expect(skip).toBeDefined();
    const out = String(await skip?.invoke({}));
    expect(out.toLowerCase()).not.toContain("simulated");
    expect(out).toContain("Produce no message now");
    // With a reason, the real tool echoes it — and it still never reaches the exploding client.
    const withReason = String(
      await skip?.invoke({ reason: "nothing new to say" }),
    );
    expect(withReason).toContain("nothing new to say");
    // The neighbours are untouched: this is an exemption for one tool, not the end of simulation.
    const handoff = tools.find((t) => t.name === "handoff_to_human");
    expect(
      String(await handoff?.invoke({ reason: "x" })).toLowerCase(),
    ).toContain("simulated");
  });

  test("a mock overrides the tool's result; unmatched tools are untouched", async () => {
    const base = buildSimulatedNativeTools(
      { client: explodingClient, conversationId: 0 },
      ["calculator"],
    );
    const mocked = applyToolMocks(base, { calculator: "MOCKED RESULT" });
    const calc = mocked.find((t) => t.name === "calculator");
    expect(String(await calc?.invoke({ expression: "2 + 2" }))).toBe(
      "MOCKED RESULT",
    );

    // No mocks → same tools back (real behavior preserved).
    const untouched = applyToolMocks(base, {});
    const calc2 = untouched.find((t) => t.name === "calculator");
    expect(String(await calc2?.invoke({ expression: "2 + 2" }))).toContain("4");
  });

  // Round 12, and the same exemption as the test at the top of this block, one layer over. The
  // runtime recognises silence by this tool's own acknowledgement (`skipReplyRan`), so a canned
  // result under its name is not a decision to stay quiet: the graph asks the model again and the
  // simulation writes a follow-up production would have suppressed. The protocol is not the
  // operator's to mock.
  test("a mock on skip_reply is refused; its neighbours still take one", async () => {
    const base = buildSimulatedNativeTools(
      { client: explodingClient, conversationId: 0 },
      [SKIP_REPLY_TOOL, "calculator"],
    );
    const mocked = applyToolMocks(
      base,
      { [SKIP_REPLY_TOOL]: "vou responder sim", calculator: "MOCKED RESULT" },
      // Ours is what is bound under that name here.
      new Set([SKIP_REPLY_TOOL]),
    );
    const skip = mocked.find((t) => t.name === SKIP_REPLY_TOOL);
    // Invoked as a TOOL CALL, which is how the graph invokes it: since round 24 the tool identifies
    // itself with a mark only it can set, and there is no `tool_call_id` to hang one on otherwise.
    const out = (await skip?.invoke({
      type: "tool_call",
      id: "c1",
      name: SKIP_REPLY_TOOL,
      args: {},
    } as never)) as ToolMessage;
    expect(String(out.content)).not.toBe("vou responder sim");
    expect(skipReplyRan(out)).toBe(true);
    // Positive control: the mock machinery still works, so the assertion above is about the
    // exemption and not about mocks having quietly stopped applying.
    const calc = mocked.find((t) => t.name === "calculator");
    expect(String(await calc?.invoke({ expression: "2 + 2" }))).toBe(
      "MOCKED RESULT",
    );
  });

  // Round 14, and the other side of the same identity question. With natives revoked, the tool under
  // this name is the OPERATOR'S, and it really calls something: refusing their mock there would have
  // the playground hit the live endpoint — a simulation with side effects, which is the one thing it
  // exists not to have.
  test("a custom tool that merely shares the name still takes its mock", async () => {
    let called = 0;
    const theirs = tool(
      async () => {
        called++;
        return "resposta do endpoint real";
      },
      {
        name: SKIP_REPLY_TOOL,
        description: "an operator's own HTTP tool",
        schema: z.object({}),
      },
    );
    // Nothing of ours is bound under that name, which is what `inertToolsFor` answers for an agent
    // with the natives revoked.
    const mocked = applyToolMocks(
      [theirs],
      { [SKIP_REPLY_TOOL]: "RESULTADO SIMULADO" },
      new Set<string>(),
    );
    const t = mocked.find((x) => x.name === SKIP_REPLY_TOOL);
    expect(String(await t?.invoke({}))).toBe("RESULTADO SIMULADO");
    expect(called).toBe(0);
  });
});

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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

// Issue #363. A code tool runs for REAL in the playground: the sandbox reaches nothing outside the
// thread, so there is no side effect to simulate, and the operator is there to see what their
// function returns. The catalog says so, under a category of its own, or the panel would badge it
// as an external tool and offer to mock what needs no mocking.
describe.skipIf(!dbUp)("listPlaygroundTools with a code tool", () => {
  let tenantId = 0n;
  let agentId = 0n;
  const ctx = (): TenantContext => ({
    tenantId,
    userId: null,
    role: "TENANT_ADMIN",
  });

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PG code", slug: `pg-code-${process.pid}` },
    });
    tenantId = t.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Code",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${key.id}`,
          },
        },
      })
    ).id;
    const code = await suDb.codeToolDefinition.create({
      data: {
        tenantId,
        name: "somar",
        label: "Somar",
        description: "Soma dois números.",
        inputSchema: {
          a: { type: "number", description: "a" },
          b: { type: "number", description: "b" },
        },
        code: "return input.a + input.b;",
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId,
        source: "CODE",
        codeToolDefinitionId: code.id,
        enabledTools: [],
        knowledgeBaseIds: [],
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "agent_tool_selections",
        "code_tool_definitions",
        "agents",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a granted code tool is listed under its own category and runs for real", async () => {
    const tools = await listPlaygroundTools({
      ctx: ctx(),
      agentId,
      base: appDb,
    });
    const somar = tools.find((tl) => tl.name === "somar");
    expect(somar).toMatchObject({
      description: "Soma dois números.",
      category: "code",
      simulated: false,
    });
  });
});
