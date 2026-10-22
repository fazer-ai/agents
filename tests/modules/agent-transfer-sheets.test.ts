import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { loadToolSelections } from "@/graph/tools/assemble";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { exportAgent, importAgent } from "@/modules/agents/transfer";
import { dbProbeFailed } from "@/tests/db-gate";

// An agent carried to another tenant keeps its Google Sheets integration: the spreadsheet, the tab id
// and which of the three tools it was granted. Read back through the selection the runtime builds
// from, not through the stored rows, since that is where a dropped field would stop the agent.
// Driven on the application role so the import's lookups are tenant-scoped (RLS).

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

const CONFIG = {
  spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  spreadsheetName: "CRM",
  sheetId: 1234,
  sheetTitle: "Leads",
};
const GRANTED = ["sheets_append_row", "sheets_find_rows"];

let srcTenant = 0n;
let dstTenant = 0n;
let srcAgent = 0n;
let dstAgent = 0n;

const ctxFor = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

async function sheetsSelection(tenantId: bigint, agentId: bigint) {
  const sel = await runScopedOn(appDb, ctxFor(tenantId), (db) =>
    loadToolSelections(db, agentId),
  );
  return sel.integrationSelections.filter(
    (s) => s.catalogType === "GOOGLE_SHEETS",
  );
}

describe.skipIf(!dbUp)("a Sheets agent carried to another tenant", () => {
  beforeAll(async () => {
    srcTenant = (
      await suDb.tenant.create({
        data: { name: "ShSrc", slug: `sh-src-1607-${process.pid}` },
      })
    ).id;
    dstTenant = (
      await suDb.tenant.create({
        data: { name: "ShDst", slug: `sh-dst-1607-${process.pid}` },
      })
    ).id;
    const inst = await suDb.integrationInstance.create({
      data: {
        tenantId: srcTenant,
        catalogType: "GOOGLE_SHEETS",
        name: "Planilha de leads",
        config: CONFIG,
      },
    });
    srcAgent = (
      await suDb.agent.create({
        data: {
          tenantId: srcTenant,
          name: "Leads",
          systemPrompt: "Anote os leads.",
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        },
      })
    ).id;
    await suDb.agentToolSelection.create({
      data: {
        agentId: srcAgent,
        tenantId: srcTenant,
        source: "INTEGRATION",
        integrationInstanceId: inst.id,
        knowledgeBaseIds: [],
        enabledTools: GRANTED,
      },
    });
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

  test("the control: the source agent has the selection the import is compared with", async () => {
    const src = await sheetsSelection(srcTenant, srcAgent);
    expect(src.length).toBe(1);
  });

  test("the destination agent works on the same spreadsheet and tab, with the same tools", async () => {
    const [dst] = await sheetsSelection(dstTenant, dstAgent);
    expect(dst?.config).toEqual(CONFIG);
    expect([...(dst?.enabledTools ?? [])].sort()).toEqual([...GRANTED].sort());
    const row = await suDb.integrationInstance.findFirst({
      where: { tenantId: dstTenant, catalogType: "GOOGLE_SHEETS" },
      select: { id: true, name: true },
    });
    expect(row?.name).toBe("Planilha de leads");
    expect(String(dst?.instanceId)).toBe(String(row?.id));
  });
});
