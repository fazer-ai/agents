import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  createVaultEntry,
  deleteVaultEntry,
  formatVaultRef,
  listVaultEntryInfos,
  testStoredVaultEntry,
  testVaultValue,
  updateVaultEntry,
  vaultReferences,
} from "@/modules/vault/service";

// Tenant secret vault (per-tenant). TENANT_ADMIN. The secret VALUE is write-only: it is never
// returned by any endpoint (only the names + their kind + reference usage). Entries are addressed
// by stable numeric id; name is a display label that may be changed freely. The kind drives
// auto-injection (see secret-types.ts) and is immutable after creation.

// NOTE: these AppError translationKeys are localized centrally in `onError` (not via literal
// translate() calls), so they are declared here for the i18n extractor (keepRemoved: false). Keep
// the defaults in sync with src/api/locales/*.json.
// translate('errors.credentialPending', 'The credential {{ref}} has not been filled yet')
// translate('errors.credentialPendingUnsupportedKind', 'This credential type is set up via a connect flow and cannot be created as a pending reference')
// translate('errors.emptyVaultSecret', 'A vault secret must not be empty.')
// translate('errors.invalidSecretType', 'That secret type is not valid.')
// translate('errors.invalidVaultBaseUrl', 'Base URL must be a valid http(s) URL')
// translate('errors.invalidVaultName', 'Name must be 1 to 128 characters')
// translate('errors.invalidVaultParamName', 'Param name contains invalid characters')
// translate('errors.invalidVaultRef', '"{{ref}}" is not a vault reference: expected vault:<id>, not a credential name')
// translate('errors.invalidVaultValue', 'The secret value must be an object for this credential type')
// translate('errors.vaultFieldRequired', 'The "{{field}}" field must not be empty')
// translate('errors.vaultFieldUnknown', 'This credential type has no field called "{{field}}"')
// translate('errors.vaultBaseUrlRequired', 'This credential type requires a base URL.')
// translate('errors.vaultNameInUse', 'A secret with this name and type already exists')
// translate('errors.vaultParamNameRequired', 'Param name is required for this credential type')
// translate('errors.vaultRefNotFound', 'That vault reference does not point to any credential: {{ref}}')
// translate('errors.vaultFieldWhitespace', 'The "{{field}}" field must not begin or end with a space or line break. Remove it and save again.')
// translate('errors.vaultSecretWhitespace', 'A vault secret must not begin or end with a space or line break. Remove it and save again.')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const idParams = t.Object({
  id: t.String({
    description: "Vault entry id (BigInt serialized as a decimal string).",
  }),
});

export const vaultController = new Elysia({
  prefix: "/v1/vault",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => {
      const entries = await listVaultEntryInfos(ctxOrThrow(tenantContext));
      return { instance: instanceIdentity, entries };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List vault entries",
        "Returns the tenant's secret names, kinds and reference usage; the secret value is never returned.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => {
      const b = body as {
        name: string;
        value: string | Record<string, string>;
        kind?: string | null;
        baseUrl?: string;
        paramName?: string;
      };
      const { id, ref } = await createVaultEntry(ctxOrThrow(tenantContext), {
        name: b.name,
        value: b.value,
        kind: b.kind,
        baseUrl: b.baseUrl ?? null,
        paramName: b.paramName ?? null,
      });
      return { instance: instanceIdentity, id: String(id), ref };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create vault entry",
        "Stores a new tenant secret and returns its id and reference; the secret value is write-only and never returned.",
      ),
      body: t.Object({
        name: t.String({
          minLength: 1,
          description: "Display label for the secret (1 to 128 characters).",
        }),
        value: t.Union([t.String(), t.Record(t.String(), t.String())], {
          description:
            "Write-only secret value; a single string or a map of named fields. Never returned by any endpoint.",
        }),
        kind: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Credential kind that drives auto-injection (see secret-types). Immutable after creation.",
          }),
        ),
        baseUrl: t.Optional(
          t.String({
            description:
              "Base http(s) URL, required for credential kinds that target a specific host.",
          }),
        ),
        paramName: t.Optional(
          t.String({
            description:
              "Parameter name for credential kinds injected as a named query or header field.",
          }),
        ),
      }),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .put(
    "/:id",
    async ({ tenantContext, params, body }) => {
      const b = body as {
        name?: string;
        value?: string | Record<string, string>;
        baseUrl?: string | null;
        paramName?: string;
      };
      const entryId = requireDbId(params.id);
      const id = await updateVaultEntry(ctxOrThrow(tenantContext), entryId, b);
      return {
        instance: instanceIdentity,
        id: String(id),
        ref: formatVaultRef(id),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update vault entry",
        "Updates an existing tenant secret in place; the secret value is write-only and never returned, and the kind cannot be changed.",
      ),
      params: idParams,
      body: t.Object({
        name: t.Optional(
          t.String({
            minLength: 1,
            description: "New display label (1 to 128 characters).",
          }),
        ),
        value: t.Optional(
          t.Union([t.String(), t.Record(t.String(), t.String())], {
            description:
              "New write-only secret value; omit to keep the current one. Never returned.",
          }),
        ),
        baseUrl: t.Optional(
          t.Nullable(
            t.String({
              description:
                "New base http(s) URL; null clears it where the kind allows.",
            }),
          ),
        ),
        paramName: t.Optional(
          t.String({
            description: "New parameter name for named-field credential kinds.",
          }),
        ),
      }),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .get(
    "/:id/references",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      references: await vaultReferences(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List entry references",
        "Returns where a vault entry is referenced across the tenant's configuration.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404),
    },
  )
  // Test-on-save: probe a typed value (pre-save) or a stored credential by id. Stateless for the
  // typed-value path (no DB read); both run the SSRF-guarded probe and never echo the secret.
  .post(
    "/test",
    async ({ body }) => {
      const b = body as {
        kind: string;
        value: string;
        baseURL?: string | null;
        paramName?: string | null;
      };
      const result = await testVaultValue(
        b.kind,
        b.value,
        b.baseURL ?? null,
        {},
        b.paramName ?? null,
      );
      return { instance: instanceIdentity, ...result };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Test a typed secret value",
        "Runs the SSRF-guarded credential probe against a value supplied in the request, without persisting it; the secret is never echoed back.",
      ),
      body: t.Object({
        kind: t.String({
          description: "Credential kind that selects how the probe is built.",
        }),
        value: t.String({
          minLength: 1,
          description: "Write-only secret value to probe; never echoed back.",
        }),
        baseURL: t.Optional(
          t.Union([t.String(), t.Null()], {
            description: "Base http(s) URL to probe, for host-targeted kinds.",
          }),
        ),
        paramName: t.Optional(
          t.Union([t.String(), t.Null()], {
            description: "Parameter name for named-field credential kinds.",
          }),
        ),
      }),
      response: errors(400, 401, 403, 422),
    },
  )
  .post(
    "/:id/test",
    async ({ tenantContext, params, body }) => {
      const b = (body ?? {}) as { baseURL?: string | null };
      const ref = formatVaultRef(requireDbId(params.id));
      const result = await testStoredVaultEntry(
        ctxOrThrow(tenantContext),
        ref,
        b.baseURL ?? null,
      );
      return { instance: instanceIdentity, ...result };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Test a stored secret",
        "Runs the SSRF-guarded credential probe against a stored vault entry by id; the secret is never echoed back.",
      ),
      params: idParams,
      body: t.Optional(
        t.Object({
          baseURL: t.Optional(
            t.Union([t.String(), t.Null()], {
              description:
                "Override base http(s) URL to probe, for host-targeted kinds.",
            }),
          ),
        }),
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await deleteVaultEntry(ctxOrThrow(tenantContext), requireDbId(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Delete vault entry",
        "Permanently removes a tenant secret by id.",
      ),
      params: idParams,
      response: errors(400, 401, 403, 404),
    },
  );
