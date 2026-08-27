import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  type ApiKeyCreate,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "@/modules/api-keys/service";

// Per-tenant Bearer API keys for external clients of the REST v1 API and the MCP transport.
// TENANT_ADMIN-gated. The plaintext token is returned ONLY by POST (once, at creation); list and
// delete never expose the hash or plaintext. Revocation is soft (revokedAt) — a revoked key 401s
// immediately on the next use.
//
// NOTE: the service throws this AppError translationKey; declared here (under src/api/**) so the API
// i18n extractor keeps it — its input glob does not reach src/modules.
// translate('errors.apiKeyNotFound', 'API key not found')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
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
      const created = await createApiKey(
        ctxOrThrow(tenantContext),
        body as ApiKeyCreate,
      );
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
        "Creates a per-tenant Bearer API key and returns the plaintext token ONCE (only its hash is stored). Use it as `Authorization: Bearer <token>` against the REST v1 API or the MCP transport.",
      ),
      body: t.Object({
        displayName: t.String({
          minLength: 1,
          maxLength: 120,
          description:
            "Human-readable label for the key (1 to 120 characters).",
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
  );
