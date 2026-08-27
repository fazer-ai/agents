import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import {
  ForbiddenError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { TEMPLATE_MESSAGE_MAX } from "@/modules/agents/text-caps";
import { testLangfuseConnection } from "@/modules/analytics/langfuse-test";
import {
  clearCompanyLogo,
  LOGO_CONTENT_TYPE,
  LOGO_MAX_BYTES,
  logoExtOf,
  readCompanyLogo,
  setCompanyLogo,
} from "@/modules/documents/company";
import { spendCeilingUsage } from "@/modules/spend-ceiling/service";
import {
  SPEND_CEILING_NOTICE_COOLDOWN_MAX_SECONDS,
  SPEND_CEILING_TOKENS_MAX,
} from "@/modules/spend-ceiling/settings";
import {
  getTenantSettings,
  updateCompanySettings,
  updateEmbeddingSettings,
  updateLangfuse,
  updateSpendCeiling,
} from "@/modules/tenant-settings/service";

// The error catalog this controller's routes answer with. `bun i18n:extract` materialises
// src/api/locales/*.json from these lines and prunes anything nothing references, and
// `ErrorTranslationKey` (src/lib/errors.ts) makes a key that is missing here a type error at the
// throw site rather than an English sentence on a pt-BR caller's screen.
// translate('errors.invalidCredentialKind', 'This setting requires a credential of kind {{kind}}.')

// Per-tenant feature settings (TENANT_ADMIN). Embedding (provider/model/credential for RAG) and
// Langfuse (tracing) configs live in Tenant.settings. Secret VALUES are never returned. The langfuse
// credential is now a standard vault entry (kind `langfuse`) created via the vault UI — this endpoint
// only stores the reference. GET exposes `credentialRef` (the picker needs it to show the selection).

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const tenantSettingsController = new Elysia({
  prefix: "/v1/tenant-settings",
  tags: ["Settings"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => {
      const { embedding, langfuse, company, spendCeiling } =
        await getTenantSettings(ctxOrThrow(tenantContext));
      return {
        instance: instanceIdentity,
        embedding,
        company,
        spendCeiling,
        langfuse: {
          enabled: langfuse.enabled,
          credentialRef: langfuse.credentialRef,
          sendContent: langfuse.sendContent,
          debug: langfuse.debug,
        },
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get tenant settings",
        "Returns the tenant's embedding, Langfuse, company-profile and token-ceiling settings.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .put(
    "/embedding",
    async ({ tenantContext, body }) => {
      const embedding = await updateEmbeddingSettings(
        ctxOrThrow(tenantContext),
        body,
      );
      return { instance: instanceIdentity, embedding };
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        provider: t.Optional(
          t.Union([t.Literal("openai"), t.Literal("openai_compatible")], {
            description: "Embedding provider.",
          }),
        ),
        model: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 200,
            description: "Embedding model name.",
          }),
        ),
        credentialRef: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Vault reference (`vault:<id>`, from GET /v1/vault) for the provider key. Never the secret itself, and never an entry name; null clears it.",
          }),
        ),
        baseURL: t.Optional(
          t.Union([t.String(), t.Null()], {
            description:
              "Base URL for openai_compatible providers (null clears it).",
          }),
        ),
      }),
      detail: doc(
        "Update embedding settings",
        "Updates the tenant's RAG embedding configuration.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .put(
    "/langfuse",
    async ({ tenantContext, body }) => {
      const langfuse = await updateLangfuse(ctxOrThrow(tenantContext), body);
      return {
        instance: instanceIdentity,
        langfuse: {
          enabled: langfuse.enabled,
          credentialRef: langfuse.credentialRef,
          sendContent: langfuse.sendContent,
          debug: langfuse.debug,
        },
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        enabled: t.Optional(
          t.Boolean({ description: "Whether Langfuse tracing is enabled." }),
        ),
        credentialRef: t.Optional(
          t.Nullable(
            t.String({
              description:
                "Vault reference (`vault:<id>`, from GET /v1/vault) for the Langfuse credential. Never the secret itself, and never an entry name; null clears it.",
            }),
          ),
        ),
        sendContent: t.Optional(
          t.Boolean({
            description: "Whether message content is sent to Langfuse.",
          }),
        ),
        debug: t.Optional(
          t.Boolean({
            description:
              "Debug mode: also send the full tool schemas to every trace (heavy; tool names are always sent).",
          }),
        ),
      }),
      detail: doc(
        "Update Langfuse settings",
        "Updates the tenant's Langfuse tracing configuration.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/spend-ceiling/usage",
    async ({ tenantContext }) => {
      return {
        instance: instanceIdentity,
        ...(await spendCeilingUsage({ ctx: ctxOrThrow(tenantContext) })),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get token-ceiling usage",
        "Tokens spent this calendar month per traffic source, against the configured ceiling. Returned for both sources whether or not a ceiling is set, so the number is available to whoever has to pick one.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .put(
    "/spend-ceiling",
    async ({ tenantContext, body }) => {
      const spendCeiling = await updateSpendCeiling(
        ctxOrThrow(tenantContext),
        body,
      );
      return { instance: instanceIdentity, spendCeiling };
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        enabled: t.Optional(
          t.Boolean({ description: "Whether the token ceiling is enforced." }),
        ),
        monthlyInboxTokens: t.Optional(
          t.Integer({
            minimum: 0,
            maximum: SPEND_CEILING_TOKENS_MAX,
            description:
              "Tokens (prompt + completion) allowed per calendar month for customer traffic. 0 = no ceiling on this half.",
          }),
        ),
        monthlyPlaygroundTokens: t.Optional(
          t.Integer({
            minimum: 0,
            maximum: SPEND_CEILING_TOKENS_MAX,
            description:
              "The same, for playground traffic. Kept apart so testing cannot silence the agent for customers.",
          }),
        ),
        overCeilingMessage: t.Optional(
          t.Union([t.String({ maxLength: TEMPLATE_MESSAGE_MAX }), t.Null()], {
            description:
              "What the customer is told when a turn is refused. null says nothing.",
          }),
        ),
        handoffEnabled: t.Optional(
          t.Boolean({
            description:
              "Whether a refused conversation is opened for humans to pick up.",
          }),
        ),
        noticeCooldownSeconds: t.Optional(
          t.Integer({
            minimum: 0,
            maximum: SPEND_CEILING_NOTICE_COOLDOWN_MAX_SECONDS,
            description:
              "Cooldown on the customer copy and the operator note. Never on the verdict, which is evaluated every message.",
          }),
        ),
        warnAtPercent: t.Optional(
          t.Integer({
            minimum: 0,
            maximum: 100,
            description:
              "Warn through the alert channels once usage crosses this percentage of a ceiling. 0 = no warning.",
          }),
        ),
      }),
      detail: doc(
        "Update token-ceiling settings",
        "Updates the tenant's monthly token ceiling.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/langfuse/test",
    async ({ tenantContext, body }) => {
      // Enforce TENANT_ADMIN + a tenant target, then probe with the supplied (unsaved) keys. The
      // outcome (ok / invalid_credentials / unreachable) is returned as data, not thrown.
      ctxOrThrow(tenantContext);
      return testLangfuseConnection({
        publicKey: body.publicKey,
        secretKey: body.secretKey,
        baseUrl: body.baseUrl ?? null,
      });
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        publicKey: t.String({
          minLength: 1,
          description: "Langfuse public key (pk-lf-...).",
        }),
        secretKey: t.String({
          minLength: 1,
          description: "Langfuse secret key (sk-lf-...).",
        }),
        baseUrl: t.Optional(
          t.Union([t.String(), t.Null()], {
            description: "Instance base URL (defaults to Langfuse Cloud).",
          }),
        ),
      }),
      detail: doc(
        "Test Langfuse connection",
        "Probes the Langfuse instance with the supplied keys without saving them.",
      ),
      response: errors(400, 401, 403, 422),
    },
  )
  .put(
    "/company",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      company: await updateCompanySettings(ctxOrThrow(tenantContext), body),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        name: t.Optional(
          t.String({
            maxLength: 200,
            description: "Legal or trading name printed on issued documents.",
          }),
        ),
        document: t.Optional(
          t.String({
            maxLength: 40,
            description: "Tax id printed on issued documents (CNPJ/CPF/VAT).",
          }),
        ),
        address: t.Optional(
          t.String({ maxLength: 300, description: "Postal address." }),
        ),
        phone: t.Optional(
          t.String({ maxLength: 40, description: "Contact phone." }),
        ),
        email: t.Optional(
          t.String({ maxLength: 200, description: "Contact email." }),
        ),
        website: t.Optional(
          t.String({ maxLength: 200, description: "Website." }),
        ),
      }),
      detail: doc(
        "Update company profile",
        "Updates the letterhead the tenant's issued documents carry.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/company/logo",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      company: await setCompanyLogo(ctxOrThrow(tenantContext), body.file),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        file: t.File({
          maxSize: LOGO_MAX_BYTES,
          description:
            "Letterhead logo. PNG or JPEG only — the PDF renderer decodes neither WebP nor SVG.",
        }),
      }),
      detail: doc(
        "Upload company logo",
        "Stores the letterhead logo used by document templates whose header shows one.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/company/logo",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      company: await clearCompanyLogo(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Remove company logo",
        "Clears the letterhead logo; documents fall back to a typographic header.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/company/logo",
    async ({ tenantContext, set }) => {
      const ctx = ctxOrThrow(tenantContext);
      const { company } = await getTenantSettings(ctx);
      const logo = await readCompanyLogo(company);
      if (!logo) {
        set.status = 404;
        throw new NotFoundError("logo not found", "errors.logoNotFound");
      }
      const ext = logoExtOf(company.logoKey ?? "") ?? "png";
      return new Response(new Uint8Array(logo.data), {
        headers: {
          "Content-Type": LOGO_CONTENT_TYPE[ext],
          // NOT STORED AT ALL, which is the only answer that holds for every principal.
          //
          // The URL carries just `logoVersion`, a millisecond timestamp, so two tenants uploading in
          // the same millisecond share it. `private` keeps proxies out but not the ONE browser that
          // saw both tenants, and `Vary: X-Tenant-Id` — the first fix here — only discriminates for
          // a SUPER_ADMIN: that header selects a tenant for nobody else, so it is absent on both
          // requests when a browser signs out of tenant A and into tenant B, and the cache replays
          // A's letterhead without B's scoped read ever running.
          //
          // What the cache bought was one small image per remount inside a minute. That is not a
          // trade worth making against a tenant seeing another tenant's asset.
          "Cache-Control": "private, no-store",
        },
      });
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Download company logo",
        "Streams the tenant's letterhead logo.",
      ),
      response: errors(401, 403, 404),
    },
  );
