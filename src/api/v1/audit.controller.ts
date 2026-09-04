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
import { AUDIT_SCOPES, type AuditScope } from "@/lib/audit/scope";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { ACTOR_TYPES } from "@/lib/tenancy/actor";
import { listAudit } from "@/modules/audit/service";

// Audit log read surface. TENANT_ADMIN for a tenant's own trail; `scope=fleet|all` reaches the rows
// keyed to no tenant and is SUPER_ADMIN's alone (#520). before/after were allowlist-sanitized at
// write. Keyset paginated by id desc (pass `cursor` back for the next page), and `latestAt` reports
// the newest row of whichever trail the scope named, past any filter.

// A TENANT TARGET IS REQUIRED BY THE SCOPE, not by the endpoint. `scope=tenant` reads one tenant's
// trail and cannot say which without one; `fleet` and `all` name their own trail, and a SUPER_ADMIN
// operating fleet-wide has no tenant selected — which is exactly the shape a fleet-scoped API key
// gives. Demanding a target there would refuse the caller the scope exists for.
// Declared where `i18next-parser` reads it: the key is thrown from `modules/audit/service.ts`, which
// is outside the `src/api/**` the API extractor globs, so without this line the catalog entry is
// pruned on the next extract and the 403 answers with a key nothing translates.
// translate('errors.auditScopeForbidden', 'Reading the fleet trail requires SUPER_ADMIN')

function ctxOrThrow(
  ctx: TenantContext | null,
  scope: AuditScope,
): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (scope === "tenant" && ctx.tenantId === null)
    throw new TenantTargetRequiredError();
  return ctx;
}

export const auditController = new Elysia({
  prefix: "/v1/audit",
  tags: ["Audit"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext, query }) => {
      const scope =
        parseQueryEnum(query.scope, "scope", AUDIT_SCOPES) ?? "tenant";
      return {
        instance: instanceIdentity,
        ...(await listAudit(ctxOrThrow(tenantContext, scope), {
          scope,
          limit: parseQueryCount(query.limit, "limit"),
          cursor: parseQueryId(query.cursor, "cursor"),
          action: parseQueryText(query.action, "action"),
          actorType: parseQueryEnum(query.actorType, "actorType", ACTOR_TYPES),
          actorId: parseQueryId(query.actorId, "actorId"),
          since: parseQueryInstant(query.since, "since"),
          until: parseQueryInstant(query.until, "until"),
        })),
      };
    },
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
        scope: t.Optional(
          t.String({
            description: `Which trail to read: ${AUDIT_SCOPES.join(" | ")} (default tenant). \`fleet\` reads only the rows keyed to no tenant, \`all\` reads every tenant plus those; both require SUPER_ADMIN and are refused with 403 otherwise, never narrowed.`,
          }),
        ),
      }),
      detail: doc(
        "List audit entries",
        "Lists audit log entries with keyset pagination. Tenant-scoped by default; `scope=fleet|all` widens to the rows keyed to no tenant and requires SUPER_ADMIN.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
