import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { loadToolSelections } from "@/graph/tools/assemble";
import { loadMcpToolsForAgent } from "@/graph/tools/mcp";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { replaceAgentToolSelections } from "@/modules/agents/service";

// ── WHICH TOOL OWNS A CONTESTED NAME IS DECIDED BY THE ORDER OF A READ NOBODY ORDERED (#389) ──
//
// The exposed name of an MCP tool is `mcp__<slug>__<tool>`, and the slug is the connection's display
// name sanitized and cut at 28 characters. Two different names can cut to the same slug, and then
// `namespacedToolName` hands the plain name to whoever asks FIRST and `_2` to the next. The same
// first-wins rule decides which of two instances of one toolpack survives `dropDuplicateToolNames`,
// because a toolpack's names come from the pack and both instances expose exactly the same ones.
//
// "First" is the order `loadToolSelections` reads the grants in, and that read has no `orderBy`, so
// it is the physical order of the rows. `replaceAgentToolSelections` deletes every row and recreates
// the set on every save, in the order the client sent — and the editor's order is the operator's
// CLICK HISTORY (`toggleMcp` appends on toggle-on, filters on toggle-off; `canonicalGrants` sorts
// only for the dirty check, `normalizeGrants` does not sort at all). So toggling one of two
// colliding connections off and back on swaps which one the model sees under the un-suffixed name.
//
// Measured in Postgres before writing this: grants inserted alphabetically read back
// `6727 … 6734`, and after a delete+recreate that sent them reversed they read back `6734 … 6727`.
// Ordering the read by `id` would NOT fix it — the recreated rows are assigned ids in the order the
// client sent, so `ORDER BY id` reproduces the click history exactly. The anchor has to be the
// SOURCE's identity (the connection / instance / definition row), which a grant re-save never
// touches.
//
// SCOPE: this fixes the order, which is the half that moves under a re-save inside one tenant. It
// does NOT make the exposed name stable across an export/import into another tenant, where the
// connection rows themselves are recreated with new ids — a connection whose display name yields no
// ASCII at all falls back to `mcp_<connId>` and comes back named after a different id. That half is
// named in #389 and stays open.

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

// Two display names that are plainly different to a reader and identical to the slug: the cut is at
// 28 characters and they agree on the first 28. This is the shape the operator cannot see coming.
const NAME_A = "Acme CRM production connection alpha";
const NAME_B = "Acme CRM production connection beta";

let tenantId = 0n;
let agentId = 0n;
let connA = 0n;
let connB = 0n;
let instA = 0n;
let instB = 0n;

const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// The MCP server, personified: it answers discovery with one tool called `search`, which is all the
// naming path needs to be exercised. The real connect is the only thing stubbed.
const connectStub = async () => [
  {
    name: "search",
    description: "d",
    schema: { type: "object", properties: {} },
    invoke: async () => "",
  },
];

// The PAIRING, never the bare list of names. Both orders produce the same two names — the plain one
// and the `_2` one — so a test that asserted `tools.map(t => t.name)` passes with the defect in
// place. What moves is which SERVER answers to which name, and that is what the model sees change
// under it. Caught by running the first draft of this file against the unfixed tree.
async function exposedNameByServer(): Promise<Record<string, string>> {
  const sel = await runScopedOn(appDb, ctx(), (db) =>
    loadToolSelections(db, agentId),
  );
  const tools = await loadMcpToolsForAgent(tenantId, sel.mcpSelections, {
    connect: connectStub as never,
    instructionsFor: async () => null,
  });
  const out: Record<string, string> = {};
  for (const t of tools) {
    const meta = (t as { metadata?: { mcpServer?: { label: string } } })
      .metadata;
    const label = meta?.mcpServer?.label;
    if (label) out[label] = t.name;
  }
  return out;
}

async function grantOrder(first: "A" | "B") {
  const mcp = first === "A" ? [connA, connB] : [connB, connA];
  const int = first === "A" ? [instA, instB] : [instB, instA];
  await replaceAgentToolSelections(
    ctx(),
    agentId,
    [
      ...mcp.map((id) => ({
        source: "MCP" as const,
        mcpServerConnectionId: String(id),
        enabledTools: ["search"],
      })),
      ...int.map((id) => ({
        source: "INTEGRATION" as const,
        integrationInstanceId: String(id),
        enabledTools: ["calendar_list_events"],
      })),
    ],
    appDb,
  );
}

describe.skipIf(!dbUp)("the order a turn reads an agent's grants in", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "Ord", slug: `ord-389-${process.pid}` },
    });
    tenantId = t.id;
    const a = await suDb.agent.create({
      data: {
        tenantId,
        name: "Ordered",
        systemPrompt: "Be helpful.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    agentId = a.id;
    // Created A-then-B, so the source's own identity orders them A, B — whatever the click history
    // later says.
    connA = (
      await suDb.mcpServerConnection.create({
        data: {
          tenantId,
          name: NAME_A,
          transport: "streamableHttp",
          url: "https://a.example.com/mcp",
        },
      })
    ).id;
    connB = (
      await suDb.mcpServerConnection.create({
        data: {
          tenantId,
          name: NAME_B,
          transport: "streamableHttp",
          url: "https://b.example.com/mcp",
        },
      })
    ).id;
    instA = (
      await suDb.integrationInstance.create({
        data: { tenantId, catalogType: "GOOGLE_CALENDAR", name: "cal-a" },
      })
    ).id;
    instB = (
      await suDb.integrationInstance.create({
        data: { tenantId, catalogType: "GOOGLE_CALENDAR", name: "cal-b" },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("the control: the two connections really do contest one name", async () => {
    await grantOrder("A");
    const byServer = await exposedNameByServer();
    // Without the collision the rest of this file would pass on a tautology: two tools that never
    // wanted the same name keep their names in any order.
    expect(Object.keys(byServer).sort()).toEqual([NAME_A, NAME_B].sort());
    expect(new Set(Object.values(byServer))).toEqual(
      new Set([
        "mcp__acme_crm_production_connecti__search",
        "mcp__acme_crm_production_connecti__search_2",
      ]),
    );
  });

  test("a re-save that sends the grants the other way round does not move the name", async () => {
    await grantOrder("A");
    const before = await exposedNameByServer();
    // The operator toggles one connection off and on again: same set, other order. Nothing about
    // what the agent is allowed to do has changed.
    await grantOrder("B");
    const after = await exposedNameByServer();
    expect(after).toEqual(before);
  });

  test("and the MCP selections themselves come back in the connections' own order", async () => {
    await grantOrder("B");
    const sel = await runScopedOn(appDb, ctx(), (db) =>
      loadToolSelections(db, agentId),
    );
    expect(sel.mcpSelections.map((s) => s.connId)).toEqual([connA, connB]);
  });

  test("and where no name is contested, the order is invisible either way", async () => {
    // THE SAFETY CLAIM OF THIS CHANGE, measured rather than argued: reordering the read renames
    // nothing for an agent whose connections do not contest a name. Every tool is
    // `mcp__<slug>__<tool>` regardless of who is assembled first, so the exposure is a function of
    // the connection alone. Without this case the PR's "names of tools running today do not move"
    // rests on reading the code, and the one collision case above cannot speak for the population
    // that has no collision — which is the population almost every install is in.
    const distinct = await suDb.mcpServerConnection.create({
      data: {
        tenantId,
        name: "Billing",
        transport: "streamableHttp",
        url: "https://c.example.com/mcp",
      },
    });
    const saveWith = async (order: bigint[]) => {
      await replaceAgentToolSelections(
        ctx(),
        agentId,
        order.map((id) => ({
          source: "MCP" as const,
          mcpServerConnectionId: String(id),
          enabledTools: ["search"],
        })),
        appDb,
      );
      return exposedNameByServer();
    };
    const forward = await saveWith([connA, distinct.id]);
    const reversed = await saveWith([distinct.id, connA]);
    expect(reversed).toEqual(forward);
    expect(forward).toEqual({
      [NAME_A]: "mcp__acme_crm_production_connecti__search",
      Billing: "mcp__billing__search",
    });
    // Neither name carries a suffix: nothing was contested, which is what makes the equality above
    // a statement about the ordinary case and not another collision in disguise.
    expect(Object.values(forward).some((n) => /_\d+$/.test(n))).toBe(false);
    await suDb.mcpServerConnection.delete({ where: { id: distinct.id } });
  });

  test("and so does the integration instance that wins the duplicate drop", async () => {
    await grantOrder("A");
    const first = await runScopedOn(appDb, ctx(), (db) =>
      loadToolSelections(db, agentId),
    );
    await grantOrder("B");
    const second = await runScopedOn(appDb, ctx(), (db) =>
      loadToolSelections(db, agentId),
    );
    // Two instances of one catalog type expose the SAME tool names, so `dropDuplicateToolNames`
    // keeps whichever is assembled first. Which instance that is must not depend on a re-save.
    expect(second.integrationSelections.map((s) => s.instanceId)).toEqual(
      first.integrationSelections.map((s) => s.instanceId),
    );
    expect(first.integrationSelections.map((s) => s.instanceId)).toEqual([
      instA,
      instB,
    ]);
  });
});
