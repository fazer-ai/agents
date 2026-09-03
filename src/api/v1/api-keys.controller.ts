import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import {
  confirmStepUp,
  requireSession,
  STEP_UP_PASSWORD_DESCRIPTION,
} from "@/api/lib/step-up";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  type ApiKeyCreate,
  createApiKey,
  createFleetApiKey,
  listApiKeys,
  listFleetApiKeys,
  revokeApiKey,
  revokeFleetApiKey,
} from "@/modules/api-keys/service";

// Bearer API keys for external clients of the REST v1 API and the MCP transport, in two scopes: the
// per-tenant key (TENANT_ADMIN-gated, RLS-fenced to the selected tenant) and, under `/fleet`, the
// fleet-scoped key (SUPER_ADMIN, no tenant — the principal a SUPER_ADMIN session is, issue #308).
// The plaintext token is returned ONLY by a POST (once, at creation); list and delete never expose
// the hash or plaintext. Revocation is soft (revokedAt) — a revoked key 401s immediately on the
// next use.
//
// NOTE: the service throws this AppError translationKey; declared here (under src/api/**) so the API
// i18n extractor keeps it — its input glob does not reach src/modules.
// translate('errors.apiKeyNotFound', 'API key not found')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// The fleet routes take no tenant target: a SUPER_ADMIN with or without a selection reaches them
// the same way, and the service ignores the selection. The role is gated by `requireRole` and again
// in the service.
function fleetCtxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  return ctx;
}

export const apiKeysController = new Elysia({
  prefix: "/v1/api-keys",
  tags: ["API keys"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      apiKeys: await listApiKeys(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List API keys",
        "Returns the tenant's API keys (display name, prefix, last-used and revoked timestamps); the hash and plaintext token never cross this surface.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      // A credential is minted by a person: a key is refused (it would outlive the key that minted
      // it), and the session answers its password here, because the key it mints answers every
      // later step-up by itself — a stolen seven-day session must not be able to carry a key past
      // the password the destructive routes ask of it. Rounds 1 and 2 of the review on #308.
      requireSession(ctx);
      await confirmStepUp(ctx, body.password);
      const created = await createApiKey(ctx, {
        displayName: body.displayName,
      } satisfies ApiKeyCreate);
      return {
        instance: instanceIdentity,
        apiKey: created.apiKey,
        // The plaintext token is returned exactly once; it is never retrievable again.
        token: created.token,
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create API key",
        "Creates a per-tenant Bearer API key and returns the plaintext token ONCE (only its hash is stored). Use it as `Authorization: Bearer <token>` against the REST v1 API or the MCP transport. Only a signed-in session may create one, confirmed with its current password (the key it mints answers every later step-up by itself); a Bearer key is refused.",
      ),
      body: t.Object({
        displayName: t.String({
          minLength: 1,
          maxLength: 120,
          description:
            "Human-readable label for the key (1 to 120 characters).",
        }),
        password: t.String({
          minLength: 1,
          description: STEP_UP_PASSWORD_DESCRIPTION,
        }),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await revokeApiKey(ctxOrThrow(tenantContext), requireDbId(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Revoke API key",
        "Soft-revokes an API key by id (sets revoked_at); the key 401s immediately on its next use. The row is kept for the audit trail.",
      ),
      params: t.Object({
        id: t.String({
          description: "API key id (BigInt serialized as a string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  // ── fleet-scoped keys (SUPER_ADMIN) ──
  .get(
    "/fleet",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      apiKeys: await listFleetApiKeys(fleetCtxOrThrow(tenantContext)),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "List fleet API keys",
        "Returns the fleet-scoped API keys (SUPER_ADMIN authority, no tenant). Never listed under any tenant; the hash and plaintext token never cross this surface.",
      ),
      response: errors(401, 403),
    },
  )
  .post(
    "/fleet",
    async ({ tenantContext, body }) => {
      const ctx = fleetCtxOrThrow(tenantContext);
      // A person's act, twice over: a key is refused (`requireSession`), and the person confirms
      // with their password.
      requireSession(ctx);
      await confirmStepUp(ctx, body.password);
      const created = await createFleetApiKey(ctx, {
        displayName: body.displayName,
      });
      return {
        instance: instanceIdentity,
        apiKey: created.apiKey,
        // The plaintext token is returned exactly once; it is never retrievable again.
        token: created.token,
      };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Create fleet API key",
        "Creates a fleet-scoped Bearer API key — SUPER_ADMIN authority with no home tenant — and returns the plaintext token ONCE (only its hash is stored). Use it as `Authorization: Bearer <token>`; select a tenant per request with `X-Tenant-Id` (REST) or the `tenant` argument (MCP), exactly like a SUPER_ADMIN session. Only a signed-in SUPER_ADMIN session may create one, confirmed with the current password; a Bearer key is refused.",
      ),
      body: t.Object({
        displayName: t.String({
          minLength: 1,
          maxLength: 120,
          description:
            "Human-readable label for the key (1 to 120 characters).",
        }),
        password: t.String({
          minLength: 1,
          description:
            "The acting SUPER_ADMIN's password (step-up confirmation).",
        }),
      }),
      response: errors(400, 401, 403, 422),
    },
  )
  .delete(
    "/fleet/:id",
    async ({ tenantContext, params }) => {
      await revokeFleetApiKey(
        fleetCtxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Revoke fleet API key",
        "Soft-revokes a fleet-scoped API key by id (sets revoked_at); the key 401s immediately on its next use. A tenant key is not reachable here (404): it is revoked under its tenant.",
      ),
      params: t.Object({
        id: t.String({
          description: "API key id (BigInt serialized as a string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  );
