import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import {
  parseQueryCount,
  parseQueryEnum,
  parseQueryId,
  parseQueryInstant,
  parseQueryText,
} from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { ACTOR_TYPES } from "@/lib/tenancy/actor";
import { listAudit } from "@/modules/audit/service";

// Audit log read surface (per-tenant). TENANT_ADMIN; RLS-scoped (fleet/global rows are not visible
// here). before/after were allowlist-sanitized at write. Keyset paginated by id desc (pass `cursor`
// back for the next page), and `latestAt` reports the newest row of the WHOLE trail past any filter.

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
      ...(await listAudit(ctxOrThrow(tenantContext), {
        limit: parseQueryCount(query.limit, "limit"),
        cursor: parseQueryId(query.cursor, "cursor"),
        action: parseQueryText(query.action, "action"),
        actorType: parseQueryEnum(query.actorType, "actorType", ACTOR_TYPES),
        actorId: parseQueryId(query.actorId, "actorId"),
        since: parseQueryInstant(query.since, "since"),
        until: parseQueryInstant(query.until, "until"),
      })),
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
        actorType: t.Optional(
          t.String({
            description: `How the actor authenticated: ${ACTOR_TYPES.join(" | ")}.`,
          }),
        ),
        actorId: t.Optional(
          t.String({ description: "Filter by actor id (BigInt string)." }),
        ),
        since: t.Optional(
          t.String({
            description:
              "Lower bound on row time, as an ISO 8601 instant with an offset (2026-01-01T00:00:00Z). A date alone is rejected with 400.",
          }),
        ),
        until: t.Optional(
          t.String({
            description:
              "Upper bound on row time, as an ISO 8601 instant with an offset (2026-01-01T00:00:00Z). A date alone is rejected with 400.",
          }),
        ),
        cursor: t.Optional(
          t.String({
            description:
              "Keyset cursor (id of the last row from the previous page).",
          }),
        ),
      }),
      detail: doc(
        "List audit entries",
        "Lists tenant-scoped audit log entries with keyset pagination.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
