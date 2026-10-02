import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { TenantTargetRequiredError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { getMerchantAnalyticsSummary } from "@/modules/merchant/analytics";

// Merchant analytics: the /analytics summary rollup, exercised against real
// RLS so the tenant fence is the thing under test, not just the SQL. Skips
// when no test database is up.

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
let tenantId = 0n;
let otherTenantId = 0n;
const ctx = (tid: bigint): TenantContext => ({
  tenantId: tid,
  userId: null,
  role: "TENANT_ADMIN",
});

describe("getMerchantAnalyticsSummary input guard", () => {
  test("fleet context cannot read a tenant rollup", async () => {
    await expect(
      getMerchantAnalyticsSummary(
        { tenantId: null, userId: null, role: "SUPER_ADMIN" },
        {} as PrismaClient,
      ),
    ).rejects.toBeInstanceOf(TenantTargetRequiredError);
  });
});

describe.skipIf(!dbUp)("merchant analytics summary", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "Analytics", slug: `analytics-${process.pid}` },
    });
    tenantId = t.id;
    const t2 = await su.tenant.create({
      data: { name: "Analytics Other", slug: `analytics-o-${process.pid}` },
    });
    otherTenantId = t2.id;

    await runScopedOn(appDb, ctx(tenantId), async (db) => {
      const source = await db.leadSource.create({
        data: {
          tenantId,
          name: "FB group",
          kind: "file_import",
          config: {},
        },
      });
      const serum = await db.merchantProduct.create({
        data: {
          tenantId,
          name: "Serum BHA 2%",
          price: 250000,
          tags: ["serum"],
        },
      });
      const dress = await db.merchantProduct.create({
        data: {
          tenantId,
          name: "Váy suông",
          price: 300000,
          tags: ["váy"],
        },
      });
      const newLead = await db.lead.create({
        data: {
          tenantId,
          platform: "facebook",
          authorName: "Lead New",
          text: "cần mua serum",
          sourceId: source.id,
          status: "NEW",
        },
      });
      const convertedLead = await db.lead.create({
        data: {
          tenantId,
          platform: "tiktok",
          authorName: "Lead Converted",
          text: "chốt serum",
          sourceId: source.id,
          status: "CONVERTED",
        },
      });
      const manualLead = await db.lead.create({
        data: {
          tenantId,
          platform: "facebook",
          authorName: "Lead Manual",
          text: "x",
          status: "CONTACTED",
        },
      });
      await db.leadProductMatch.createMany({
        data: [
          { tenantId, leadId: newLead.id, productId: serum.id, score: 0.9 },
          {
            tenantId,
            leadId: convertedLead.id,
            productId: serum.id,
            score: 0.8,
          },
          { tenantId, leadId: manualLead.id, productId: dress.id, score: 0.5 },
        ],
      });
      await db.merchantOrder.createMany({
        data: [
          {
            tenantId,
            leadId: convertedLead.id,
            status: "PAID",
            totalAmount: 250000,
          },
          { tenantId, status: "DRAFT", totalAmount: 120000 },
          { tenantId, status: "CANCELLED", totalAmount: 99000 },
        ],
      });
    });

    // Noise in a second tenant: if RLS ever stops fencing, the counts move.
    await runScopedOn(appDb, ctx(otherTenantId), async (db) => {
      await db.lead.create({
        data: {
          tenantId: otherTenantId,
          platform: "zalo",
          authorName: "Foreign",
          text: "x",
        },
      });
      await db.merchantOrder.create({
        data: { tenantId: otherTenantId, status: "PAID", totalAmount: 999999 },
      });
    });
  });

  afterAll(async () => {
    if (su && tenantId) {
      for (const table of [
        "merchant_order_items",
        "merchant_orders",
        "lead_product_matches",
        "leads",
        "lead_sources",
        "merchant_products",
        "audit_logs",
      ]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id IN (${tenantId}, ${otherTenantId})`,
        );
      }
      await su.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN (${tenantId}, ${otherTenantId})`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("leads break down by status, platform and named source", async () => {
    const s = await getMerchantAnalyticsSummary(ctx(tenantId), appDb);
    expect(s.leads.total).toBe(3);
    const status = new Map(s.leads.byStatus.map((r) => [r.status, r.count]));
    expect(status.get("NEW")).toBe(1);
    expect(status.get("CONTACTED")).toBe(1);
    expect(status.get("CONVERTED")).toBe(1);
    const platform = new Map(
      s.leads.byPlatform.map((r) => [r.platform, r.count]),
    );
    expect(platform.get("facebook")).toBe(2);
    expect(platform.get("tiktok")).toBe(1);
    const bySource = new Map(
      s.leads.bySource.map((r) => [r.name ?? "<manual>", r.count]),
    );
    expect(bySource.get("FB group")).toBe(2);
    // A lead with no source lands in the manual bucket.
    expect(bySource.get("<manual>")).toBe(1);
  });

  test("top products rank by match count and carry product names", async () => {
    const s = await getMerchantAnalyticsSummary(ctx(tenantId), appDb);
    expect(s.topProducts[0]?.name).toBe("Serum BHA 2%");
    expect(s.topProducts[0]?.matches).toBe(2);
    expect(s.topProducts[1]?.name).toBe("Váy suông");
    expect(s.topProducts[1]?.matches).toBe(1);
  });

  test("orders aggregate by status and the conversion is a percent", async () => {
    const s = await getMerchantAnalyticsSummary(ctx(tenantId), appDb);
    expect(s.orders.total).toBe(3);
    expect(s.orders.fromLeads).toBe(1);
    expect(s.orders.totalAmount).toBe(250000 + 120000 + 99000);
    const byStatus = new Map(s.orders.byStatus.map((r) => [r.status, r]));
    expect(byStatus.get("PAID")?.count).toBe(1);
    expect(byStatus.get("PAID")?.totalAmount).toBe(250000);
    // 1 converted of 3 leads.
    expect(s.conversion.convertedLeads).toBe(1);
    expect(s.conversion.pct).toBeCloseTo(33.3, 1);
  });

  test("the 14-day series is complete, zero-padded and UTC-ordered", async () => {
    const s = await getMerchantAnalyticsSummary(ctx(tenantId), appDb);
    expect(s.leadsPerDay).toHaveLength(14);
    const today = new Date().toISOString().slice(0, 10);
    expect(s.leadsPerDay[13]?.day).toBe(today);
    // All three fixture leads were created today; every earlier bucket is 0.
    expect(s.leadsPerDay[13]?.count).toBe(3);
    expect(s.leadsPerDay.slice(0, 13).every((d) => d.count === 0)).toBe(true);
  });

  test("another tenant's rows never leak into the rollup", async () => {
    const s = await getMerchantAnalyticsSummary(ctx(otherTenantId), appDb);
    expect(s.leads.total).toBe(1);
    expect(s.orders.total).toBe(1);
    expect(s.orders.totalAmount).toBe(999999);
    expect(s.leads.bySource.every((r) => r.name !== "FB group")).toBe(true);
  });
});
