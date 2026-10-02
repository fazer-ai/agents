import { Elysia, t } from "elysia";
import type { MerchantLeadStatus } from "@/../generated/prisma/client";
import { doc, errors } from "@/api/lib/openapi";
import {
  parseQueryCount,
  parseQueryId,
  parseQueryText,
} from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import {
  AppError,
  ForbiddenError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import { badQueryParam } from "@/lib/query-param";
import type { TenantContext } from "@/lib/tenancy";
import {
  applyMerchantImport,
  csvToRowInputs,
  type ImportRowInput,
  validateImportRows,
} from "@/modules/merchant/import";
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
import { tagMerchantProductWithLlm } from "@/modules/merchant/tagging";

// The error catalog this controller's routes answer with (`bun i18n:extract` reads these lines).
// translate('errors.merchantProductNotFound', 'Product not found.')
// translate('errors.merchantLeadNotFound', 'Lead not found.')
// translate('errors.merchantOrderNotFound', 'Order not found.')
// translate('errors.merchantTaggingFailed', 'The auto-tagger did not return a usable result.')
// translate('errors.merchantImportEmpty', 'The import carried no product rows: send a CSV file or a rows array.')

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
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      products: await listMerchantProducts(ctxOrThrow(tenantContext), {
        q: parseQueryText(query.q, "q"),
        category: parseQueryText(query.category, "category"),
        tags: parseQueryText(query.tags, "tags")
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        priceMax: parseQueryCount(query.priceMax, "priceMax"),
      }),
    }),
    {
      requireAuth: true,
      query: t.Object({
        q: t.Optional(
          t.String({
            description:
              "Free-text match on name/description/tags (diacritics-insensitive). Applied AFTER the structured filters below.",
          }),
        ),
        category: t.Optional(
          t.String({
            description:
              "Category node filter, case-insensitive exact match (e.g. 'thời trang nữ').",
          }),
        ),
        tags: t.Optional(
          t.String({
            description:
              "Comma-separated tag list; a product must carry ALL listed tags to match.",
          }),
        ),
        priceMax: t.Optional(
          t.String({
            description:
              "Keep only products priced at or under this VND amount.",
          }),
        ),
      }),
      detail: doc(
        "List products",
        "List the tenant's merchant catalog products, ordered by name. Structured filters (category, tags, priceMax) narrow the set before the optional free-text q match.",
      ),
      response: errors(400, 401, 403, 404),
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
        category: t.Optional(
          t.Union([t.String({ minLength: 1, maxLength: 200 }), t.Null()], {
            description: "Shop-taxonomy node (e.g. 'thời trang nữ').",
          }),
        ),
        attributes: t.Optional(
          t.Union([
            t.Record(
              t.String(),
              t.Union([t.String({ maxLength: 300 }), t.Number(), t.Boolean()]),
            ),
            t.Null(),
          ]),
        ),
        tagSource: t.Optional(
          t.Union([t.Union([t.Literal("manual"), t.Literal("llm")]), t.Null()]),
        ),
        taggedAt: t.Optional(
          t.Union([t.String({ format: "date-time" }), t.Null()]),
        ),
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
        category: t.Optional(
          t.Union([t.String({ minLength: 1, maxLength: 200 }), t.Null()]),
        ),
        attributes: t.Optional(
          t.Union([
            t.Record(
              t.String(),
              t.Union([t.String({ maxLength: 300 }), t.Number(), t.Boolean()]),
            ),
            t.Null(),
          ]),
        ),
        tagSource: t.Optional(
          t.Union([t.Union([t.Literal("manual"), t.Literal("llm")]), t.Null()]),
        ),
        taggedAt: t.Optional(
          t.Union([t.String({ format: "date-time" }), t.Null()]),
        ),
      }),
      detail: doc(
        "Update product",
        "Update a catalog product's mutable fields by id.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/products/import",
    async ({ tenantContext, body, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as {
        rows?: ImportRowInput[] | string;
        file?: File;
      };
      let inputs: ImportRowInput[] = [];
      if (b.file) {
        inputs = csvToRowInputs(await b.file.text());
      } else if (typeof b.rows === "string") {
        const raw = b.rows.trim();
        // A multipart text field can carry the rows as a JSON string or as
        // raw CSV text; the leading character tells them apart.
        if (raw.startsWith("[")) {
          try {
            inputs = JSON.parse(raw) as ImportRowInput[];
          } catch {
            throw new AppError(
              "The request is not valid.",
              422,
              "errors.invalidRequest",
            );
          }
        } else {
          inputs = csvToRowInputs(raw);
        }
      } else if (Array.isArray(b.rows)) {
        inputs = b.rows;
      }
      if (inputs.length === 0) {
        throw new AppError(
          "The import carried no product rows.",
          422,
          "errors.merchantImportEmpty",
        );
      }
      const preview = validateImportRows(inputs);
      if (query.dryRun === "true") {
        return {
          instance: instanceIdentity,
          dryRun: true,
          ok: preview.ok,
          rows: preview.rows,
        };
      }
      const result = await applyMerchantImport(ctx, preview.rows);
      return {
        instance: instanceIdentity,
        dryRun: false,
        ok: preview.ok,
        rows: preview.rows,
        result,
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        dryRun: t.Optional(
          t.String({
            description:
              "'true' parses and validates only: the parsed rows and their errors come back, nothing is written.",
          }),
        ),
      }),
      // JSON {rows:[...]} and multipart {file|rows} share one schema: `file`
      // makes the route accept multipart, `rows` carries the JSON spelling
      // (or a CSV/JSON text field on multipart).
      body: t.Object({
        rows: t.Optional(
          t.Union([t.Array(t.Record(t.String(), t.Any())), t.String()], {
            description:
              "Product rows as objects (name, price, stock, description, tags), or a JSON string / CSV text when sent as a multipart field.",
          }),
        ),
        file: t.Optional(
          t.File({
            description:
              "CSV file with header name,price,stock,description,tags (Vietnamese spellings accepted).",
          }),
        ),
      }),
      detail: doc(
        "Import products",
        "Bulk-upsert catalog rows by (tenant, name) from JSON rows or a CSV file. ?dryRun=true returns the parsed rows and validation errors without writing; a real run also kicks off LLM auto-tagging for each written product.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/products/:id/retag",
    async ({ tenantContext, params }) => {
      const outcome = await tagMerchantProductWithLlm(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      if (!outcome.ok) {
        throw new AppError(
          outcome.detail
            ? `The auto-tagger did not return a usable result (${outcome.detail}).`
            : "The auto-tagger did not return a usable result.",
          502,
          "errors.merchantTaggingFailed",
        );
      }
      return { instance: instanceIdentity, product: outcome.product };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Re-tag product",
        "Re-run the LLM auto-tagger on one product: refreshes category, attributes and merged tags (tagSource=llm, taggedAt=now). Manual tags are preserved.",
      ),
      response: errors(400, 401, 403, 404, 502),
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
  );
