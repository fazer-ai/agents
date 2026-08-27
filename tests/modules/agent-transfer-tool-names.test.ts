import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { loadToolSelections } from "@/graph/tools/assemble";
import { loadMcpToolsForAgent } from "@/graph/tools/mcp";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { exportAgent, importAgent } from "@/modules/agents/transfer";

// ── THE NAME A TOOL IS EXPOSED UNDER HAS TO SURVIVE AN EXPORT/IMPORT (#412) ──
//
// `mcp__<slug>__<tool>` is built from the connection's display name, which the export carries and the
// import matches on — so the name is portable, EXCEPT where the row id leaks into it:
//
//   1. the FALLBACK. A display name that yields no ASCII at all (emoji-only, CJK-only) sanitizes to
//      the empty string, and `mcpServerSlug` fell back to `mcp_<connId>`. The import assigns a new
//      id, so the same connection came back under a different name.
//   2. the `_N` SUFFIX. Two display names that agree on the first 28 characters cut to one slug, and
//      `namespacedToolName` hands the plain name to whichever server is assembled FIRST and `_2` to
//      the next. #410 anchored that order on `mcpServerConnectionId asc`, which is stable inside a
//      tenant and means nothing across one: on the destination the ids are whatever the import
//      assigned, and when the destination ALREADY has one of the two (it is reused, keeping its own
//      id) the pair can invert. Both names still exist and each one now answers to the OTHER server.
//
// (2) is the sharper half and needs no emoji: two ordinary ASCII names are enough. It is also the
// failure that cannot be seen, because nothing is missing — the model calls the name it was given and
// reaches a different backend.
//
// The same sentence holds one row down in the grant order. Two instances of one integration catalog
// expose exactly the same tool names, `dropDuplicateToolNames` keeps whichever is assembled first,
// and that order was `integrationInstanceId asc` for the same reason. An import that inverts it points
// the agent's calendar tools at the other calendar account.
//
// Driven through the REAL exportAgent/importAgent on the application role. NOT the superuser one:
// that role bypasses RLS and the import's component lookup does not filter by tenant (it relies on
// the scope), so it matches the SOURCE tenant's rows, creates nothing, and the whole file reports the
// opposite result.

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

// Plainly different to a reader, identical to the slug: the cut is at 28 characters and they agree on
// the first 28. Alphabetically ALPHA sorts before BETA, and that is the order the fix restores; the
// ids are what put them the other way round on the destination.
const ALPHA = "Acme CRM production connection alpha";
const BETA = "Acme CRM production connection beta";
// No letter, no digit: sanitizes to the empty string and takes the fallback branch.
const EMOJI = "🎯";

let srcTenant = 0n;
let dstTenant = 0n;
let srcAgent = 0n;
let dstAgent = 0n;

const ctxFor = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const connectStub = async () => [
  {
    name: "search",
    description: "d",
    schema: { type: "object", properties: {} },
    invoke: async () => "",
  },
];

// The PAIRING, never the bare list of names: both sides expose the same three names either way, and
// what moves is which server answers to which. A test that asserted the name list would pass with the
// defect in place.
async function exposedNameByServer(
  tenantId: bigint,
  agentId: bigint,
): Promise<Record<string, string>> {
  const sel = await runScopedOn(appDb, ctxFor(tenantId), (db) =>
    loadToolSelections(db, agentId),
  );
  const tools = await loadMcpToolsForAgent(tenantId, sel.mcpSelections, {
    connect: connectStub as never,
    instructionsFor: async () => null,
  });
  const out: Record<string, string> = {};
  for (const t of tools) {
    const label = (t as { metadata?: { mcpServer?: { label: string } } })
      .metadata?.mcpServer?.label;
    if (label) out[label] = t.name;
  }
  return out;
}

// Which integration instance survives the duplicate-name drop is the FIRST one assembled, so the
// order of the selections is the observable. Reading it needs no toolpack build and no credential.
async function integrationOrder(tenantId: bigint, agentId: bigint) {
  const sel = await runScopedOn(appDb, ctxFor(tenantId), (db) =>
    loadToolSelections(db, agentId),
  );
  // The selection carries the instance id, not its name, and the id is exactly the thing that differs
  // between the two tenants — so it is resolved back to the name, which is what both sides share.
  const rows = await suDb.integrationInstance.findMany({
    where: { id: { in: sel.integrationSelections.map((s) => s.instanceId) } },
    select: { id: true, name: true },
  });
  const byId = new Map(rows.map((r) => [String(r.id), r.name]));
  return sel.integrationSelections.map(
    (s) => byId.get(String(s.instanceId)) ?? "?",
  );
}

async function mkConn(tenantId: bigint, name: string, host: string) {
  return (
    await suDb.mcpServerConnection.create({
      data: {
        tenantId,
        name,
        transport: "streamableHttp",
        url: `https://${host}.example.com/mcp`,
      },
    })
  ).id;
}

describe.skipIf(!dbUp)("an agent carried to another tenant", () => {
  beforeAll(async () => {
    const s = await suDb.tenant.create({
      data: { name: "TnSrc", slug: `tn-src-412-${process.pid}` },
    });
    const d = await suDb.tenant.create({
      data: { name: "TnDst", slug: `tn-dst-412-${process.pid}` },
    });
    srcTenant = s.id;
    dstTenant = d.id;

    // NOTE: SOURCE: alpha before beta, cal-a before cal-b, by creation order and therefore by id.
    const cAlpha = await mkConn(srcTenant, ALPHA, "alpha");
    await mkConn(srcTenant, BETA, "beta");
    await mkConn(srcTenant, EMOJI, "emoji");
    const iA = await suDb.integrationInstance.create({
      data: {
        tenantId: srcTenant,
        catalogType: "GOOGLE_CALENDAR",
        name: "cal-a",
      },
    });
    await suDb.integrationInstance.create({
      data: {
        tenantId: srcTenant,
        catalogType: "GOOGLE_CALENDAR",
        name: "cal-b",
      },
    });

    // NOTE: DESTINATION, seeded BEFORE the import with the SECOND member of each pair, which is the shape
    // that inverts the ids: beta/cal-b keep these low ids, and alpha/cal-a get whatever the import
    // assigns, which is higher.
    await mkConn(dstTenant, BETA, "beta");
    await suDb.integrationInstance.create({
      data: {
        tenantId: dstTenant,
        catalogType: "GOOGLE_CALENDAR",
        name: "cal-b",
      },
    });

    const a = await suDb.agent.create({
      data: {
        tenantId: srcTenant,
        name: "Carried",
        systemPrompt: "Be helpful.",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    srcAgent = a.id;
    const conns = await suDb.mcpServerConnection.findMany({
      where: { tenantId: srcTenant },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    const insts = await suDb.integrationInstance.findMany({
      where: { tenantId: srcTenant },
      orderBy: { id: "asc" },
      select: { id: true },
    });
    await suDb.agentToolSelection.createMany({
      data: [
        ...conns.map((c) => ({
          agentId: srcAgent,
          tenantId: srcTenant,
          source: "MCP" as const,
          mcpServerConnectionId: c.id,
          knowledgeBaseIds: [],
          enabledTools: ["search"],
        })),
        ...insts.map((i) => ({
          agentId: srcAgent,
          tenantId: srcTenant,
          source: "INTEGRATION" as const,
          integrationInstanceId: i.id,
          knowledgeBaseIds: [],
          enabledTools: ["calendar_list_events"],
        })),
      ],
    });
    // NOTE: The control for the whole file: alpha/cal-a really are the lower ids on the source, so the
    // inversion asserted below is the import's doing and not the seed's.
    expect(conns[0]?.id).toBe(cAlpha);
    expect(insts[0]?.id).toBe(iA.id);

    const payload = await exportAgent(ctxFor(srcTenant), srcAgent, appDb, {
      includeComponents: true,
    });
    const { agent } = await importAgent(ctxFor(dstTenant), payload, appDb);
    dstAgent = BigInt(agent.id);
  });

  afterAll(async () => {
    for (const t of [srcTenant, dstTenant]) {
      if (t) await suDb.tenant.delete({ where: { id: t } });
    }
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("the control: the import really did reassign the ids the other way round", async () => {
    // NOTE: Without this the file could pass on a destination that happened to reproduce the source's id
    // order, which is the one arrangement in which the defect is invisible.
    const src = await suDb.mcpServerConnection.findMany({
      where: { tenantId: srcTenant, name: { in: [ALPHA, BETA] } },
      orderBy: { id: "asc" },
      select: { name: true },
    });
    const dst = await suDb.mcpServerConnection.findMany({
      where: { tenantId: dstTenant, name: { in: [ALPHA, BETA] } },
      orderBy: { id: "asc" },
      select: { name: true },
    });
    expect(src.map((r) => r.name)).toEqual([ALPHA, BETA]);
    expect(dst.map((r) => r.name)).toEqual([BETA, ALPHA]);
  });

  test("each server keeps the name it answered to on the other side", async () => {
    const before = await exposedNameByServer(srcTenant, srcAgent);
    const after = await exposedNameByServer(dstTenant, dstAgent);
    expect(after).toEqual(before);
  });

  test("and the plain name still belongs to the same one of the two colliding servers", async () => {
    // NOTE: Spelled out rather than left to the equality above: this is the pair whose inversion sends a
    // call to the wrong backend under a name that did not change.
    const after = await exposedNameByServer(dstTenant, dstAgent);
    expect(after[ALPHA]).toBe("mcp__acme_crm_production_connecti__search");
    expect(after[BETA]).toBe("mcp__acme_crm_production_connecti__search_2");
  });

  test("and the connection whose name yields no ascii is not named after a row id", async () => {
    const after = await exposedNameByServer(dstTenant, dstAgent);
    const name = after[EMOJI] ?? "";
    const dstConn = await suDb.mcpServerConnection.findFirst({
      where: { tenantId: dstTenant, name: EMOJI },
      select: { id: true },
    });
    expect(name).not.toContain(`mcp_${dstConn?.id}`);
    expect(name).toMatch(/^mcp__mcp_[0-9a-f]{8}__search$/);
  });

  test("and the integration instance that wins the duplicate drop is the same one", async () => {
    const before = await integrationOrder(srcTenant, srcAgent);
    const after = await integrationOrder(dstTenant, dstAgent);
    expect(before[0]).toBe("cal-a");
    expect(after).toEqual(before);
  });
});
