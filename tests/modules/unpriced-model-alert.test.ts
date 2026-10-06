import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { defaultUsagePersist, type UsageRow } from "@/graph/usage";
import {
  announceUnpricedModel,
  resetUnpricedAnnouncements,
} from "@/modules/pricing/unpriced-alert";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

// A MODEL THE LEDGER COULD NOT PRICE IS SAID OUT LOUD, once per model per month per
// tenant, from the capture itself: no ceiling and no Langfuse are needed for it, which is the point,
// since every call to that model is left out of the cost and of the ceiling until someone sets a
// price. "Once" survives a restart because it is the announcement's own record in the flow log.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantA = 0n;
let tenantB = 0n;

const row = (
  tenantId: bigint,
  model: string,
  costUsd: number | null,
  source: UsageRow["source"] = "inbox",
): UsageRow => ({
  tenantId,
  agentId: null,
  conversationId: null,
  inboxId: null,
  threadId: null,
  turnId: null,
  model,
  node: "agent",
  source,
  promptTokens: 10,
  completionTokens: 5,
  cachedReadTokens: 0,
  cacheCreationTokens: 0,
  durationMs: null,
  costUsd,
  priceTable: "litellm@test",
});

const alerts = (tenantId: bigint) =>
  // flowlog-scope: tenant-wide (the file clears each tenant's rows before every case)
  flowLogRows(suDb, {
    where: { tenantId, stage: "spend_ceiling" },
    orderBy: { id: "asc" },
  });

describe.skipIf(!dbUp)("the unpriced-model alert", () => {
  const persist = () => defaultUsagePersist(appDb);

  beforeAll(async () => {
    tenantA = (
      await suDb.tenant.create({
        data: { name: "UP-A", slug: `up-a-${process.pid}` },
      })
    ).id;
    tenantB = (
      await suDb.tenant.create({
        data: { name: "UP-B", slug: `up-b-${process.pid}` },
      })
    ).id;
  });

  beforeEach(async () => {
    resetUnpricedAnnouncements();
    for (const id of [tenantA, tenantB]) {
      await suDb.llmUsage.deleteMany({ where: { tenantId: id } });
      await clearFlowLog(suDb, { tenantId: id });
    }
  });

  afterAll(async () => {
    for (const id of [tenantA, tenantB]) {
      if (!id) continue;
      await clearFlowLog(suDb, { tenantId: id });
      for (const table of ["llm_usage", "execution_logs"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${id}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the first unpriced call of a model is announced, with no ceiling and no Langfuse", async () => {
    await persist()(row(tenantA, "mystery-1", null));
    const rows = await alerts(tenantA);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.detail).toMatchObject({
      subject: "unpriced",
      models: ["mystery-1"],
    });
    // The fix it names is this app's, not a model definition in Langfuse.
    expect(rows[0]?.errorMessage).toContain("mystery-1");
    expect(rows[0]?.errorMessage).toContain("Model prices");
    expect(rows[0]?.errorMessage).toContain("re-price");
    expect(rows[0]?.errorMessage).not.toContain("Langfuse");
  });

  test("the same model again, in either source, is not news; another model is", async () => {
    await persist()(row(tenantA, "mystery-1", null));
    await persist()(row(tenantA, "mystery-1", null));
    await persist()(row(tenantA, "mystery-1", null, "playground"));
    await persist()(row(tenantA, "mystery-2", null, "playground"));
    const rows = await alerts(tenantA);
    expect(rows.map((r) => (r.detail as { models: string[] }).models)).toEqual([
      ["mystery-1"],
      ["mystery-2"],
    ]);
  });

  test("a priced call announces nothing", async () => {
    await persist()(row(tenantA, "known", 0.01));
    expect(await alerts(tenantA)).toHaveLength(0);
  });

  test("another tenant's announcement is not this one's", async () => {
    await persist()(row(tenantA, "mystery-1", null));
    await persist()(row(tenantB, "mystery-1", null));
    expect(await alerts(tenantA)).toHaveLength(1);
    expect(await alerts(tenantB)).toHaveLength(1);
  });

  // A restart forgets the process set; the ledger still holds the earlier unpriced row, so the
  // model is not announced a second time this month.
  test("a restart does not announce the month's model again", async () => {
    await persist()(row(tenantA, "mystery-1", null));
    // The first line has landed before the process "restarts".
    expect(await alerts(tenantA)).toHaveLength(1);
    resetUnpricedAnnouncements();
    await persist()(row(tenantA, "mystery-1", null));
    expect(await alerts(tenantA)).toHaveLength(1);
  });

  // An upgrade finds unpriced rows written before the alert existed. They are not a warning anyone
  // received, so the first call after the upgrade still announces the model.
  test("unpriced rows from before the alert existed do not silence it", async () => {
    await suDb.llmUsage.create({
      data: { tenantId: tenantA, model: "mystery-1" },
    });
    await persist()(row(tenantA, "mystery-1", null));
    expect(await alerts(tenantA)).toHaveLength(1);
  });

  test("a new month announces the model again", async () => {
    const at = (iso: string) =>
      announceUnpricedModel({
        tenantId: tenantA,
        model: "mystery-1",
        source: "inbox",
        now: new Date(iso),
        base: appDb,
      });
    await at("2026-08-20T00:00:00Z");
    // flowlog-scope: tenant-wide (the file clears each tenant's rows before every case)
    await alerts(tenantA);
    // Settled to land the line, then backdated: the lookup reads the log's own month.
    await suDb.executionLog.updateMany({
      where: { tenantId: tenantA, stage: "spend_ceiling" },
      data: { createdAt: new Date("2026-08-20T00:00:00Z") },
    });
    await at("2026-09-02T00:00:00Z");
    expect(await alerts(tenantA)).toHaveLength(2);
  });
});
