import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  // translate('errors.invalidId', 'Not a valid {{label}}')
  getIssuedDocumentPdf,
  issueDocument,
  listIssuedDocuments,
  revokeIssuedDocument,
} from "@/modules/documents/issue";

// Documents issued from a template. POST issues idempotently (the same idempotencyKey returns the
// same document, no re-render and no second number); GET streams the PDF, authenticated and
// tenant-scoped — the scoped read is the boundary, because the filesystem has no RLS. Served under
// /api, never staticPlugin.

// NOTE: these AppError translationKeys are localized centrally in `onError`, not through a literal
// translate() call, so they are declared here for the i18n extractor (keepRemoved: false). They
// belong to the documents MODULE, and they are declared in this controller because the api extractor
// only scans `src/api/**` — a declaration next to the throw site would be invisible to it, and the
// customer-facing effect of a missing key is silent: `onError` falls back to the English message.
// t/translate magic comments — keep defaults in sync with src/api/locales/*.json:
// translate('errors.documentTemplateNotFound', 'Document template not found')
// translate('errors.documentNotFound', 'Document not found')
// translate('errors.documentTemplateDisabled', 'This document template is disabled')
// translate('errors.documentTemplateSlugTaken', 'A document template with the identifier "{{slug}}" already exists')
// translate('errors.documentTemplateSlugTakenBy', 'The identifier "{{slug}}" is already taken by the template "{{name}}"')
// translate('errors.documentTemplateNameTaken', 'You already have a document template called "{{name}}"')
// translate('errors.documentTemplateNameCollides', '"{{name}}" collides with the template "{{existing}}": both produce the tool name {{tool}}')
// translate('errors.documentTemplateNameCollidesUnknown', 'You already have a document template whose name produces the tool {{tool}}. Pick another name.')
// translate('errors.documentNameIsBuiltinTool', '"{{name}}" would produce the tool {{tool}}, which is already a built-in. Pick another name.')
// translate('errors.invalidDocumentTemplate', 'This document template is not valid')
// translate('errors.invalidDocumentTemplateReason', 'This document template is not valid: {{reason}}')
// translate('errors.invalidCompanyField', 'This company profile field is not valid: {{reason}}')
// translate('errors.invalidDocumentValues', 'The values do not match what this template declares: {{reason}}')
// translate('errors.invalidDocumentSlug', 'This identifier is not valid: {{reason}}')
// translate('errors.invalidDocumentTemplateName', 'This document template name is not valid: {{reason}}')
// translate('errors.documentRevoked', 'This document was revoked and cannot be issued again')
// translate('errors.documentNotNumbered', 'This document could not be numbered because its template no longer exists')
// translate('errors.invalidDocumentTemplateDescription', 'This document template description is not valid: {{reason}}')
// translate('errors.documentTemplateUnreadable', 'This template contains content a newer version wrote, so it cannot be saved from here: {{reason}}')
// translate('errors.invalidDocumentNumberPrefix', 'This document number prefix is not valid: {{reason}}')
// translate('errors.invalidIdempotencyKey', 'This idempotency key is not valid: {{reason}}')
// translate('errors.documentNotStored', 'This document could not be stored')
// translate('errors.documentWouldBeBlank', 'This document would be blank: with the values given, no block prints anything.')
// translate('errors.documentWouldBeBlankNoLetterhead', 'This document would be blank: the company letterhead it printed is no longer configured.')
// translate('errors.imageTooManyPixels', 'The image has too many pixels: at most {{max}} in total (about {{dimensions}})')
// translate('errors.imageDimensionsUnreadable', 'The image header could not be read, so its size cannot be checked. Export the file again.')
// translate('errors.logoNotFound', 'Logo not found')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// Ids are constrained HERE, at the transport, rather than left to the global handler that turns a
// BigInt parse error into a 400 by matching the word "BigInt" in an engine's message. That mapping
// was measured and it does work today — but it is a coupling to wording nobody here controls, and a
// malformed id is a validation failure the route can name on its own.
// The conversation key an issued document is bound to, constrained to the SHAPE the runtime writes
// and bounded.
//
// `issued_documents.thread_id` is indexed (tenantId, threadId), so a long enough value is refused by
// POSTGRES with an index-row-size error — a 500 for a field a caller typed, on a route that
// advertises validation. Three numeric ids is what the key IS (tenantId:instanceId:conversationId),
// so anything else was never going to match a conversation anyway, and the length follows from the
// shape rather than being a second guess at it.
export const threadIdSchema = t.String({
  pattern: "^[0-9]{1,20}:[0-9]{1,20}:[0-9]{1,20}$",
  maxLength: 64,
  description:
    "Conversation thread key (tenant:instance:conversation) this document belongs to.",
});

export const documentsController = new Elysia({
  prefix: "/v1/documents",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      documents: await listIssuedDocuments(ctxOrThrow(tenantContext), {
        limit: query.limit ? Number(query.limit) : undefined,
        // `!== undefined` for the same reason the preview route uses it: `?templateId=0` is a
        // filter, and dropping it answers with EVERY document instead of none. (`limit` above can
        // stay truthy-checked — its pattern refuses "0" at the transport.)
        templateId:
          query.templateId !== undefined
            ? requireDbId(query.templateId, "template id")
            : undefined,
        threadId: query.threadId,
      }),
    }),
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        // Constrained at the TRANSPORT, because the handler coerces both: `Number("abc")` is NaN and
        // reaches Prisma's `take`, and `BigInt("abc")` throws — a 500 for a malformed query string,
        // where the route advertises a validation response.
        limit: t.Optional(
          t.String({
            pattern: "^[1-9][0-9]*$",
            description: "Max rows to return (positive integer).",
          }),
        ),
        templateId: t.Optional(
          t.String({
            pattern: "^[0-9]+$",
            description: "Only documents from this template.",
          }),
        ),
        threadId: t.Optional(
          t.String({ description: "Only documents issued on this thread." }),
        ),
      }),
      detail: doc(
        "List issued documents",
        "Lists the documents the tenant has issued.",
      ),
      // 400 because `templateId` reaches `requireDbId`: the pattern above admits any run of digits,
      // and one past 2^63-1 is refused by the range check rather than by the transport. A status the
      // route returns and the contract does not name is a status no generated client knows how to
      // handle — the same reason the issue route names 409.
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      return {
        instance: instanceIdentity,
        document: await issueDocument({
          ctx,
          templateId: requireDbId(body.templateId, "template id"),
          idempotencyKey: body.idempotencyKey,
          values: body.values ?? {},
          threadId: body.threadId ?? null,
          conversationId: body.conversationId
            ? requireDbId(body.conversationId, "conversation id")
            : null,
        }),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        templateId: t.String({
          pattern: "^[0-9]+$",
          description: "Template to issue from (BigInt string).",
        }),
        idempotencyKey: t.String({
          minLength: 1,
          maxLength: 200,
          description:
            "Same key returns the same document — no re-render, no second number.",
        }),
        // NOTE: a permissive Record for the same reason the template's blocks are one — Elysia's
        // `normalize` strips undeclared keys, and the keys here are the tenant's own field names,
        // which no static schema can enumerate.
        values: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              'Values keyed by the template\'s declared field names. A lineItems field takes [{"description","quantity","unitPrice"}].',
          }),
        ),
        threadId: t.Optional(threadIdSchema),
        conversationId: t.Optional(
          t.String({
            pattern: "^[0-9]+$",
            description: "Conversation row id (BigInt string).",
          }),
        ),
      }),
      detail: doc(
        "Issue document",
        "Idempotently issues a document from a template and renders its PDF.",
      ),
      // 409 is a real answer here: an idempotency key can land on a row that was revoked, that could
      // not be numbered, or that nobody managed to store. A status the route returns and the
      // contract does not name is a status no generated client knows how to handle.
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .post(
    "/:id/revoke",
    async ({ tenantContext, params }) => {
      await revokeIssuedDocument(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          pattern: "^[0-9]+$",
          description: "Document id (BigInt string).",
        }),
      }),
      detail: doc(
        "Revoke document",
        "Revokes an issued document; its PDF stops being served.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/:id/pdf",
    async ({ tenantContext, params }) => {
      const ctx = tenantContext;
      if (!ctx) throw new ForbiddenError();
      const { bytes, fileName } = await getIssuedDocumentPdf(
        ctx,
        requireDbId(params.id),
      );
      return new Response(bytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${fileName}"`,
          // The document is TENANT-scoped, and the scoped read of the row is the only thing that
          // fences it — the filesystem has none. A shared proxy caching by URL would replay these
          // bytes without that read ever running, handing one tenant's document to another
          // requester. `no-store` rather than the logo route's `private, max-age`: a priced document
          // is worth less caching than a letterhead is.
          "Cache-Control": "private, no-store",
        },
      });
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          pattern: "^[0-9]+$",
          description: "Document id (BigInt string).",
        }),
      }),
      detail: doc(
        "Download document PDF",
        "Streams the rendered PDF for inline viewing.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  );
