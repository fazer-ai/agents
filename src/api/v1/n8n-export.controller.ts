import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { exportToolWorkflowForTenant } from "@/modules/n8n-export/service";

// n8n workflow export (one of the three transports for the feature; REST here, MCP/UI later).
// Export is a TENANT_ADMIN operation and is tenant-scoped — a tenant can only export its own
// tools, and the service guarantees no credential is ever emitted.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const n8nExportController = new Elysia({
  prefix: "/v1/n8n-export",
  tags: ["Integrations"],
})
  .use(tenancyPlugin)
  .get(
    "/tools/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      export: await exportToolWorkflowForTenant(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Export tool as n8n workflow",
        "Returns an importable n8n workflow for a tenant's tool definition by id; the export never emits any credential value.",
      ),
      params: t.Object({
        id: t.String({
          description:
            "Tool definition id (BigInt serialized as a decimal string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  );
