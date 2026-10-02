import { Elysia, t } from "elysia";
import type { MerchantLeadStatus } from "@/../generated/prisma/client";
import { doc, errors } from "@/api/lib/openapi";
import { parseQueryCount, parseQueryId } from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import { badQueryParam } from "@/lib/query-param";
import type { TenantContext } from "@/lib/tenancy";
import {
  createLeadSource,
  deleteLeadSource,
  getLeadSource,
  LEAD_SOURCE_KINDS,
  type LeadSourceCreate,
  type LeadSourceUpdate,
  listLeadSources,
  runLeadSource,
  updateLeadSource,
} from "@/modules/discovery/sources";
import {
  getLead,
  ingestLead,
  LEAD_STATUSES,
  type LeadIngestInput,
  listLeads,
} from "@/modules/merchant/leads";
import {
  createMerchantOrder,
  getMerchantOrder,
  listMerchantOrders,
  type MerchantOrderCreate,
} from "@/modules/merchant/orders";
import {
  createMerchantProduct,
  deleteMerchantProduct,
  getMerchantProduct,
  listMerchantProducts,
  type MerchantProductCreate,
  type MerchantProductUpdate,
  updateMerchantProduct,
} from "@/modules/merchant/products";

// The error catalog this controller's routes answer with (`bun i18n:extract` reads these lines).
// translate('errors.merchantProductNotFound', 'Product not found.')
// translate('errors.merchantLeadNotFound', 'Lead not found.')
// translate('errors.merchantOrderNotFound', 'Order not found.')
// translate('errors.merchantSourceNotFound', 'Source not found.')
// translate('errors.merchantSourceKindUnsupported', 'Unsupported source kind (supported: {{kinds}}).')
// translate('errors.merchantSourceModeUnsupported', 'Mode {{mode}} is not supported for source kind {{kind}}.')
// translate('errors.merchantSourceCredentialRequired', 'This source needs a credential - point its credentialRef at a filled vault entry.')
// translate('errors.merchantSourceContentMissing', 'This source has no content to import - pass it in the run request or store it in the source config.')

// Merchant MVP: per-tenant catalog, social-lead pipeline (rule-based scoring, no
// LLM) and orders. Reads are for any authenticated member; writes are TENANT_ADMIN.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const idParam = t.Object({
  id: t.String({
    description: "Row primary key (BigInt serialized as a decimal string).",
  }),
});

const pageQuery = t.Object({
  limit: t.Optional(
    t.String({
      description:
        "Optional max number of items to return, parsed as an integer.",
    }),
  ),
  cursor: t.Optional(
    t.String({
      description:
        "Keyset cursor: the id of the last item from the previous page; returns the next page.",
    }),
  ),
});

function parseLeadStatus(
  raw: string | undefined,
): MerchantLeadStatus | undefined {
  if (raw === undefined) return undefined;
  const status = raw.toUpperCase();
  if ((LEAD_STATUSES as readonly string[]).includes(status)) {
    return status as MerchantLeadStatus;
  }
  badQueryParam("status");
}

export const merchantController = new Elysia({
  prefix: "/v1/merchant",
  tags: ["Merchant"],
})
  .use(tenancyPlugin)
  .get(
    "/products",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      products: await listMerchantProducts(ctxOrThrow(tenantContext)),
    }),
    {
      requireAuth: true,
      detail: doc(
        "List products",
        "List the tenant's merchant catalog products, ordered by name.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/products/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      product: await getMerchantProduct(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireAuth: true,
      params: idParam,
      detail: doc("Get product", "Fetch a single catalog product by id."),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/products",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      product: await createMerchantProduct(
        ctxOrThrow(tenantContext),
        body as MerchantProductCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 300 }),
        description: t.Optional(t.String({ maxLength: 5000 })),
        price: t.Number({
          minimum: 0,
          description: "Unit price in VND (zero-decimal).",
        }),
        stock: t.Optional(t.Integer({ minimum: 0 })),
        tags: t.Optional(
          t.Array(t.String({ minLength: 1, maxLength: 100 }), {
            maxItems: 50,
            description:
              "Search words the lead scorer matches post text against.",
          }),
        ),
        imageUrl: t.Optional(t.String({ maxLength: 2000 })),
        active: t.Optional(t.Boolean()),
      }),
      detail: doc(
        "Create product",
        "Create a catalog product for the current tenant.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .patch(
    "/products/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      product: await updateMerchantProduct(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as MerchantProductUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 300 })),
        description: t.Optional(t.String({ maxLength: 5000 })),
        price: t.Optional(
          t.Number({ minimum: 0, description: "Unit price in VND." }),
        ),
        stock: t.Optional(t.Integer({ minimum: 0 })),
        tags: t.Optional(
          t.Array(t.String({ minLength: 1, maxLength: 100 }), {
            maxItems: 50,
          }),
        ),
        imageUrl: t.Optional(t.String({ maxLength: 2000 })),
        active: t.Optional(t.Boolean()),
      }),
      detail: doc(
        "Update product",
        "Update a catalog product's mutable fields by id.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/products/:id",
    async ({ tenantContext, params }) => {
      await deleteMerchantProduct(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc("Delete product", "Delete a catalog product."),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/leads",
    async ({ tenantContext, query }) => {
      const page = await listLeads(ctxOrThrow(tenantContext), {
        limit: parseQueryCount(query.limit, "limit"),
        cursor: parseQueryId(query.cursor, "cursor"),
        status: parseLeadStatus(query.status),
      });
      return {
        instance: instanceIdentity,
        leads: page.items,
        nextCursor: page.nextCursor,
      };
    },
    {
      requireAuth: true,
      query: t.Composite([
        pageQuery,
        t.Object({
          status: t.Optional(
            t.String({
              description:
                "Optional funnel-stage filter (NEW, CONTACTED, QUALIFIED, CONVERTED, DEAD).",
            }),
          ),
        }),
      ]),
      detail: doc(
        "List leads",
        "Returns a page of scored leads (newest first) with their product matches; use nextCursor to page.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/leads/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      lead: await getLead(ctxOrThrow(tenantContext), requireDbId(params.id)),
    }),
    {
      requireAuth: true,
      params: idParam,
      detail: doc(
        "Get lead",
        "Fetch a single lead with its product matches by id.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/leads/ingest",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      lead: await ingestLead(
        ctxOrThrow(tenantContext),
        body as LeadIngestInput,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        platform: t.String({
          minLength: 1,
          description:
            "Source platform the post was found on (facebook, zalo, threads, tiktok, instagram, whatsapp, telegram, web, other).",
        }),
        authorName: t.String({
          minLength: 1,
          maxLength: 300,
          description: "Display name of the post author.",
        }),
        authorHandle: t.Optional(
          t.String({ maxLength: 300, description: "Platform handle or id." }),
        ),
        text: t.String({
          minLength: 1,
          maxLength: 20000,
          description: "The post text the intent scorer runs on.",
        }),
        groupName: t.Optional(
          t.String({
            maxLength: 300,
            description: "Group/community the post came from.",
          }),
        ),
        sourceUrl: t.Optional(
          t.String({ maxLength: 2000, description: "Permalink to the post." }),
        ),
      }),
      detail: doc(
        "Ingest a lead",
        "Scores a social post for buying intent (rule-based Vietnamese scorer, no LLM), stores it as a lead and writes its product matches.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/orders",
    async ({ tenantContext, query }) => {
      const page = await listMerchantOrders(ctxOrThrow(tenantContext), {
        limit: parseQueryCount(query.limit, "limit"),
        cursor: parseQueryId(query.cursor, "cursor"),
      });
      return {
        instance: instanceIdentity,
        orders: page.items,
        nextCursor: page.nextCursor,
      };
    },
    {
      requireAuth: true,
      query: pageQuery,
      detail: doc(
        "List orders",
        "Returns a page of merchant orders (newest first) with their line items; use nextCursor to page.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/orders",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      order: await createMerchantOrder(
        ctxOrThrow(tenantContext),
        body as MerchantOrderCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        leadId: t.Optional(
          t.String({
            description:
              "Optional lead row id this order converts; the lead's status becomes CONVERTED.",
          }),
        ),
        contactName: t.Optional(t.String({ maxLength: 300 })),
        contactPhone: t.Optional(t.String({ maxLength: 60 })),
        contactAddress: t.Optional(t.String({ maxLength: 1000 })),
        note: t.Optional(t.String({ maxLength: 5000 })),
        items: t.Union(
          [
            t.Array(
              t.Object({
                productId: t.Optional(
                  t.String({
                    description: "Catalog product id; must exist when given.",
                  }),
                ),
                qty: t.Optional(t.Integer({ minimum: 1, maximum: 10000 })),
                unitPrice: t.Optional(
                  t.Number({
                    minimum: 0,
                    description:
                      "VND unit price snapshot; defaults to the product's catalog price.",
                  }),
                ),
              }),
              { minItems: 1, maxItems: 100 },
            ),
            // Agent tool calls supply items as a JSON string (the compact
            // tool-input schema has no array-of-objects type); the service
            // parses it back.
            t.String(),
          ],
          {
            description:
              "Order lines: [{productId, qty?, unitPrice?}] as an array or its JSON-string form.",
          },
        ),
      }),
      detail: doc(
        "Create order",
        "Create a merchant order (DRAFT) with line items; unitPrice defaults to the catalog price, total is computed server-side.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/orders/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      order: await getMerchantOrder(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireAuth: true,
      params: idParam,
      detail: doc(
        "Get order",
        "Fetch a single merchant order with its line items by id.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  // Discovery lead sources: the configured rails that scan social platforms and
  // feed the ingest pipeline. CRUD is TENANT_ADMIN; reads any member.
  .get(
    "/sources",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      sources: await listLeadSources(ctxOrThrow(tenantContext)),
    }),
    {
      requireAuth: true,
      detail: doc(
        "List lead sources",
        "List the tenant's configured discovery sources, newest status first, with per-source lead counts.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/sources/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      source: await getLeadSource(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireAuth: true,
      params: idParam,
      detail: doc("Get lead source", "Fetch a single discovery source by id."),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/sources",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      source: await createLeadSource(
        ctxOrThrow(tenantContext),
        body as LeadSourceCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 200 }),
        kind: t.String({
          minLength: 1,
          maxLength: 60,
          description: `Source kind: ${LEAD_SOURCE_KINDS.join(", ")}.`,
        }),
        config: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              "Kind-specific config object, validated against the kind's schema (file_import: format/platform/content; threads_api: credentialRef/keywords; tiktok_comments: mode/keywords).",
          }),
        ),
        intervalMin: t.Optional(
          t.Integer({
            minimum: 1,
            maximum: 10080,
            description:
              "Scan interval in minutes; honoured when a scheduler is wired (manual run works regardless).",
          }),
        ),
        enabled: t.Optional(t.Boolean()),
      }),
      detail: doc(
        "Create lead source",
        "Create a discovery source: a file_import export rail, a Threads keyword search, or TikTok comment mining (fixture mode).",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .patch(
    "/sources/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      source: await updateLeadSource(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as LeadSourceUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        kind: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 60,
            description: `Source kind: ${LEAD_SOURCE_KINDS.join(", ")}.`,
          }),
        ),
        config: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              "Kind-specific config; replaces the stored config wholesale.",
          }),
        ),
        intervalMin: t.Optional(t.Integer({ minimum: 1, maximum: 10080 })),
        enabled: t.Optional(t.Boolean()),
      }),
      detail: doc(
        "Update lead source",
        "Update a discovery source's mutable fields by id.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/sources/:id",
    async ({ tenantContext, params }) => {
      await deleteLeadSource(ctxOrThrow(tenantContext), requireDbId(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Delete lead source",
        "Delete a discovery source. Its leads are kept (their sourceId is cleared).",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/sources/:id/run",
    async ({ tenantContext, params, body }) => {
      const file = body?.file;
      const content =
        body?.content ?? (file !== undefined ? await file.text() : undefined);
      const result = await runLeadSource(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        {
          content,
          format: body?.format,
        },
      );
      return { instance: instanceIdentity, ...result };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      // Optional body: for file_import, either a `content` string (JSON) or an
      // uploaded `file` (multipart) overrides the stored config for this run.
      body: t.Optional(
        t.Object({
          content: t.Optional(
            t.String({
              description:
                "file_import only: raw JSONL/CSV content to import for this run (overrides config.content).",
            }),
          ),
          format: t.Optional(
            t.Union([t.Literal("auto"), t.Literal("jsonl"), t.Literal("csv")], {
              description: "file_import only: force the parser format.",
            }),
          ),
          file: t.Optional(
            t.File({
              description:
                "file_import only: uploaded JSONL/CSV export (multipart form).",
            }),
          ),
        }),
      ),
      detail: doc(
        "Run a source scan",
        "Runs one scan now: fetch -> normalize -> dedupe on (tenant, platform, externalId) -> ingest with scoring. Returns {scanned, new, deduped, skipped, leads:[ids]} and always writes lastRunAt/lastStatus/lastError.",
      ),
      response: errors(400, 401, 403, 404, 422, 502),
    },
  )
  .get(
    "/sources/:id/leads",
    async ({ tenantContext, params, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = requireDbId(params.id);
      // 404 on a missing source, not an empty page: the caller named a row.
      await getLeadSource(ctx, id);
      const page = await listLeads(ctx, {
        sourceId: id,
        limit: parseQueryCount(query.limit, "limit"),
        cursor: parseQueryId(query.cursor, "cursor"),
        status: parseLeadStatus(query.status),
      });
      return {
        instance: instanceIdentity,
        leads: page.items,
        nextCursor: page.nextCursor,
      };
    },
    {
      requireAuth: true,
      params: idParam,
      query: t.Composite([
        pageQuery,
        t.Object({
          status: t.Optional(
            t.String({
              description:
                "Optional funnel-stage filter (NEW, CONTACTED, QUALIFIED, CONVERTED, DEAD).",
            }),
          ),
        }),
      ]),
      detail: doc(
        "List a source's leads",
        "Returns a page of scored leads (newest first) this discovery source produced; use nextCursor to page.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
