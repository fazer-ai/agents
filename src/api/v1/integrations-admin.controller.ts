import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { listCredentialCalendars } from "@/modules/integrations/google-calendar.service";
import { listCredentialDriveFolders } from "@/modules/integrations/google-drive.service";
import {
  createIntegrationInstance,
  deleteIntegrationInstance,
  getIntegrationInstance,
  listCatalog,
  listIntegrationInstances,
  rotateIntegrationRouteToken,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import { getToolpackToolViews } from "@/modules/integrations/toolpacks";

// The error catalog this controller's routes answer with. `bun i18n:extract` materialises
// src/api/locales/*.json from these lines and prunes anything nothing references, and
// `ErrorTranslationKey` (src/lib/errors.ts) makes a key that is missing here a type error at the
// throw site rather than an English sentence on a pt-BR caller's screen.
//
// NOTE: `errors.badRequest`, `errors.notFound` and `errors.upstream` were here and are gone on
// purpose. One generic sentence per HTTP class read as an answer and was not one: the four sites
// behind `badRequest` said two different things ("not a connected Google account" / "invalid
// credential reference") and the Drive 403 behind `upstream` carried the ONLY instruction that
// resolves it, naming which OAuth scope to reconnect with. Registering the generic key made the
// catalog win over `AppError.message` in `refusalBody`, so those sentences stopped reaching anyone,
// in English too. Each fact now has its own key, and the ones that vary carry params.
// translate('errors.googleCredentialNotConnected', 'This credential is not a connected Google account.')
// translate('errors.googleCredentialNotFound', 'The credential this integration needs was not found.')
// translate('errors.googleDriveScopeDenied', "Google Drive denied the request. Reconnect the credential granting the 'Drive (read-only)' or 'Drive (full access)' scope; 'Drive (app files)' cannot list existing folders.")
// translate('errors.integrationHeaderNameUnusable', 'The "{{field}}" value is not a usable header name: use only letters, digits and !#$%&\'*+-.^_`|~ (no spaces or line breaks).')
// translate('errors.integrationHttpError', '{{provider}} returned HTTP {{status}}.')
// translate('errors.integrationInstanceNotFound', 'Integration instance not found.')
// translate('errors.integrationNoInboundWebhook', 'The {{integration}} integration has no inbound webhook.')
// translate('errors.invalidCredentialRef', 'The credential reference is not valid.')

// Integration-instance management (per-tenant). TENANT_ADMIN. Separate from the PUBLIC inbound
// receptor controller (same /v1/integrations prefix, no path overlap: /catalog + /instances* here
// vs /inbound/:routeToken there) so the high-volume webhook path stays free of the session lookup.
// The opaque routeToken comes back on create and on the single-instance read (the editor shows the
// webhook URL); POST /instances/:id/route-token mints a new one and invalidates the old.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const authStrategy = t.Union(
  [t.Literal("NONE"), t.Literal("STATIC_HEADER"), t.Literal("HMAC_SHA256")],
  {
    description:
      "Inbound webhook auth: NONE, STATIC_HEADER (shared token header), or HMAC_SHA256 (signed body).",
  },
);

export const integrationsAdminController = new Elysia({
  prefix: "/v1/integrations",
  tags: ["Integrations"],
})
  .use(tenancyPlugin)
  .get(
    "/catalog",
    ({ tenantContext }) => {
      ctxOrThrow(tenantContext);
      // Enrich each entry with its toolpack's tools (name + arg specs) so the per-toolpack
      // modal can list what the integration exposes, with args, without a second request.
      const catalog = listCatalog().map((e) => ({
        ...e,
        tools: getToolpackToolViews(e.catalogType),
      }));
      return { instance: instanceIdentity, catalog };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List integration catalog",
        "Returns the available integration catalog entries the tenant can instantiate.",
      ),
      response: errors(401, 403),
    },
  )
  .get(
    "/google/calendars",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const calendars = await listCredentialCalendars(ctx, query.credentialRef);
      return { instance: instanceIdentity, calendars };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List Google calendars for a credential",
        "Lists the calendars a connected google_oauth credential can access, so the operator can pick which agendas the Calendar integration may operate on. Read-only against Google.",
      ),
      query: t.Object({
        credentialRef: t.String({
          description:
            "Vault reference (vault:<id>) of a connected google_oauth credential.",
        }),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/google/drive-folders",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const folders = await listCredentialDriveFolders(
        ctx,
        query.credentialRef,
      );
      return { instance: instanceIdentity, folders };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List Google Drive folders for a credential",
        "Lists the folders a connected google_oauth credential can access, so the operator can pick which folder the Drive integration scopes file search to. Read-only against Google.",
      ),
      query: t.Object({
        credentialRef: t.String({
          description:
            "Vault reference (vault:<id>) of a connected google_oauth credential.",
        }),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/instances",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      instances: await listIntegrationInstances(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List integration instances",
        "Returns the tenant's configured integration instances. The routeToken is omitted here; read a single instance to get it.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/instances/:id",
    async ({ tenantContext, params, set }) => {
      // NOTE: no-store — this is the ONE read that returns the decrypted routeToken, and nothing
      // global sets the header. Keeps the webhook URL out of the browser's disk cache.
      set.headers["cache-control"] = "no-store";
      return {
        instance: instanceIdentity,
        integration: await getIntegrationInstance(
          ctxOrThrow(tenantContext),
          requireDbId(params.id),
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get integration instance",
        "Fetches a single integration instance by id, including its inbound routeToken (null when the entry has no inbound surface, or when the instance predates token storage — rotate to mint a readable one).",
      ),
      params: t.Object({
        id: t.String({
          description:
            "Integration instance id (BigInt serialized as a string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/instances",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as {
        catalogType: string;
        name: string;
        config?: Record<string, unknown>;
        credentialRef?: string | null;
        inboundAuthStrategy?: "NONE" | "STATIC_HEADER" | "HMAC_SHA256";
        inboundSecretRef?: string | null;
        enabled?: boolean;
      };
      const created = await createIntegrationInstance(ctx, b);
      return {
        instance: instanceIdentity,
        id: String(created.id),
        // NOTE: Paste into the upstream provider. Also readable later via GET /instances/:id, so
        // losing this response is no longer a dead end.
        routeToken: created.routeToken,
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create integration instance",
        "Creates an integration instance and returns its id plus the opaque routeToken for the inbound webhook URL. The token stays readable afterwards via GET /instances/:id.",
      ),
      body: t.Object({
        catalogType: t.String({
          description: "Catalog entry type to instantiate, from GET /catalog.",
        }),
        name: t.String({
          minLength: 1,
          maxLength: 200,
          description: "Display label for the instance (1 to 200 characters).",
        }),
        config: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description: "Provider-specific configuration map.",
          }),
        ),
        credentialRef: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Vault reference (`vault:<id>`, from GET /v1/vault) for the outbound credential. Never the secret itself, and never an entry name; null for none.",
          }),
        ),
        inboundAuthStrategy: t.Optional(authStrategy),
        inboundSecretRef: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Vault reference (`vault:<id>`, from GET /v1/vault) for the inbound auth secret. Never the secret itself, and never an entry name; null for none.",
          }),
        ),
        enabled: t.Optional(
          t.Boolean({
            description: "Whether the integration instance is active.",
          }),
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .patch(
    "/instances/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      integration: await updateIntegrationInstance(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as {
          name?: string;
          enabled?: boolean;
          config?: Record<string, unknown>;
          credentialRef?: string | null;
          inboundAuthStrategy?: "NONE" | "STATIC_HEADER" | "HMAC_SHA256";
          inboundSecretRef?: string | null;
        },
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update integration instance",
        "Updates fields of an integration instance by id. The routeToken is not returned here; read the instance or rotate it.",
      ),
      params: t.Object({
        id: t.String({
          description:
            "Integration instance id (BigInt serialized as a string).",
        }),
      }),
      body: t.Object({
        name: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 200,
            description: "New display label (1 to 200 characters).",
          }),
        ),
        enabled: t.Optional(
          t.Boolean({
            description: "Whether the integration instance is active.",
          }),
        ),
        config: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description: "New provider-specific configuration map.",
          }),
        ),
        credentialRef: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "New vault reference (`vault:<id>`) for the outbound credential, or null to clear it.",
          }),
        ),
        inboundAuthStrategy: t.Optional(authStrategy),
        inboundSecretRef: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "New vault reference (`vault:<id>`) for the inbound auth secret, or null to clear it.",
          }),
        ),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  // NOTE: Rotation is a POST because it MUTATES: the old URL stops resolving the moment it commits.
  // It exists for the two cases the stored token cannot cover — an instance created before the
  // token was persisted (hash only), and a URL that leaked.
  .post(
    "/instances/:id/route-token",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      ...(await rotateIntegrationRouteToken(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      )),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Rotate inbound route token",
        "Mints a new inbound webhook token for the instance and returns it. The previous URL stops working immediately, so the provider's dashboard must be updated.",
      ),
      params: t.Object({
        id: t.String({
          description:
            "Integration instance id (BigInt serialized as a string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  .delete(
    "/instances/:id",
    async ({ tenantContext, params }) => {
      await deleteIntegrationInstance(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Delete integration instance",
        "Removes an integration instance by id.",
      ),
      params: t.Object({
        id: t.String({
          description:
            "Integration instance id (BigInt serialized as a string).",
        }),
      }),
      response: errors(400, 401, 403, 404),
    },
  );
