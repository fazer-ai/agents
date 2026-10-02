import type {
  MerchantLeadStatus,
  MerchantOrderStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { TenantTargetRequiredError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

// Merchant analytics (per-tenant, read-only): the funnel numbers the /analytics
// page draws — leads by status/platform/source, the catalog products posts
// match most, orders and the lead->order conversion, plus a 14-day lead count
// series for the sparkline. All aggregation runs inside the one scoped
// transaction, so the read is consistent and RLS-fenced.

const SPARKLINE_DAYS = 14;
const TOP_PRODUCTS = 10;

export interface MerchantAnalyticsSummary {
  leads: {
    total: number;
    byStatus: { status: MerchantLeadStatus; count: number }[];
    byPlatform: { platform: string; count: number }[];
    // name is null for leads ingested by hand (no source row to name) and for
    // leads whose source was deleted.
    bySource: { sourceId: string | null; name: string | null; count: number }[];
  };
  topProducts: { productId: string; name: string; matches: number }[];
  orders: {
    total: number;
    totalAmount: number;
    // Orders created off a lead (leadId set): the funnel's bottom line.
    fromLeads: number;
    byStatus: {
      status: MerchantOrderStatus;
      count: number;
      totalAmount: number;
    }[];
  };
  conversion: {
    // Leads marked CONVERTED over every lead ever ingested, in percent.
    convertedLeads: number;
    pct: number;
  };
  // One entry per day, oldest first, today last; zero-count days included so a
  // sparkline never has to guess where the gaps are.
  leadsPerDay: { day: string; count: number }[];
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getMerchantAnalyticsSummary(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<MerchantAnalyticsSummary> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  return runScopedOn(base, ctx, async (db) => {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (SPARKLINE_DAYS - 1));

    const [
      leadStatusRows,
      leadPlatformRows,
      leadSourceRows,
      sourceNames,
      topMatchRows,
      productNames,
      orderStatusRows,
      ordersFromLeads,
      perDayRows,
    ] = await Promise.all([
      db.lead.groupBy({ by: ["status"], _count: { _all: true } }),
      db.lead.groupBy({
        by: ["platform"],
        _count: { _all: true },
        orderBy: { _count: { platform: "desc" } },
      }),
      db.lead.groupBy({ by: ["sourceId"], _count: { _all: true } }),
      db.leadSource.findMany({ select: { id: true, name: true } }),
      db.leadProductMatch.groupBy({
        by: ["productId"],
        _count: { _all: true },
        orderBy: { _count: { productId: "desc" } },
        take: TOP_PRODUCTS,
      }),
      db.merchantProduct.findMany({ select: { id: true, name: true } }),
      db.merchantOrder.groupBy({
        by: ["status"],
        _count: { _all: true },
        _sum: { totalAmount: true },
      }),
      db.merchantOrder.count({ where: { leadId: { not: null } } }),
      // UTC buckets, matching the series the page draws. The tenant predicate
      // is spelled out although RLS already holds it: the index needs it.
      db.$queryRaw<{ day: string; count: bigint | number }[]>`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               count(*)::int AS count
          FROM leads
         WHERE tenant_id = ${tenantId}
           AND created_at >= ${since}
         GROUP BY 1`,
    ]);

    const sourceNameById = new Map(
      sourceNames.map((s) => [String(s.id), s.name]),
    );
    const productNameById = new Map(
      productNames.map((p) => [String(p.id), p.name]),
    );
    const countByDay = new Map(perDayRows.map((r) => [r.day, Number(r.count)]));

    const leadsTotal = leadStatusRows.reduce((n, r) => n + r._count._all, 0);
    const converted =
      leadStatusRows.find((r) => r.status === "CONVERTED")?._count._all ?? 0;
    const orderTotalAmount = orderStatusRows.reduce(
      (n, r) => n + Number(r._sum.totalAmount ?? 0),
      0,
    );

    const leadsPerDay: { day: string; count: number }[] = [];
    for (let i = 0; i < SPARKLINE_DAYS; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      const key = dayKey(d);
      leadsPerDay.push({ day: key, count: countByDay.get(key) ?? 0 });
    }

    return {
      leads: {
        total: leadsTotal,
        byStatus: leadStatusRows.map((r) => ({
          status: r.status,
          count: r._count._all,
        })),
        byPlatform: leadPlatformRows.map((r) => ({
          platform: r.platform,
          count: r._count._all,
        })),
        bySource: leadSourceRows
          .map((r) => ({
            sourceId: r.sourceId === null ? null : String(r.sourceId),
            name:
              r.sourceId === null
                ? null
                : (sourceNameById.get(String(r.sourceId)) ?? null),
            count: r._count._all,
          }))
          .sort((a, b) => b.count - a.count),
      },
      topProducts: topMatchRows.map((r) => ({
        productId: String(r.productId),
        name: productNameById.get(String(r.productId)) ?? "",
        matches: r._count._all,
      })),
      orders: {
        total: orderStatusRows.reduce((n, r) => n + r._count._all, 0),
        totalAmount: orderTotalAmount,
        fromLeads: ordersFromLeads,
        byStatus: orderStatusRows.map((r) => ({
          status: r.status,
          count: r._count._all,
          totalAmount: Number(r._sum.totalAmount ?? 0),
        })),
      },
      conversion: {
        convertedLeads: converted,
        pct:
          leadsTotal === 0
            ? 0
            : Math.round((converted / leadsTotal) * 1000) / 10,
      },
      leadsPerDay,
    };
  });
}
