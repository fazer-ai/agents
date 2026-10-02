import { Elysia } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { getMerchantAnalyticsSummary } from "@/modules/merchant/analytics";

// Merchant analytics: the read-only rollup the /analytics console page draws.
// Any authenticated member may read it; nothing here writes.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const merchantAnalyticsController = new Elysia({
  prefix: "/v1/merchant",
  tags: ["Merchant"],
})
  .use(tenancyPlugin)
  .get(
    "/analytics/summary",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      summary: await getMerchantAnalyticsSummary(ctxOrThrow(tenantContext)),
    }),
    {
      requireAuth: true,
      detail: doc(
        "Merchant analytics summary",
        "Read-only rollup: leads by status/platform/source, top matched products, orders count + total by status, lead->order conversion, and leads per day for the last 14 days.",
      ),
      response: errors(401, 403, 404),
    },
  );
