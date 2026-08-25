import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { listAudit } from "@/modules/audit/service";

// Audit log read surface (per-tenant). TENANT_ADMIN. before/after were allowlist-sanitized at
// write; the RLS scope is the boundary (fleet/global rows are not visible here).

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const auditController = new Elysia({
  prefix: "/v1/audit",
  tags: ["Audit"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      entries: await listAudit(ctxOrThrow(tenantContext), {
        limit: query.limit ? Number(query.limit) : undefined,
        action: query.action,
      }),
    }),
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        limit: t.Optional(
          t.String({
            description: "Max rows to return (positive integer string).",
          }),
        ),
        action: t.Optional(
          t.String({ description: "Filter by audit action name." }),
        ),
      }),
      detail: doc(
        "List audit entries",
        "Lists tenant-scoped audit log entries.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
