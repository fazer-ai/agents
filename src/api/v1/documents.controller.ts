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
  pageIssuedDocuments,
  revokeIssuedDocument,
} from "@/modules/documents/issue";

// Documents issued from a template. POST issues idempotently (the same idempotencyKey returns the
// same document, no re-render and no second number); GET streams the PDF, authenticated and
// tenant-scoped — the scoped read is the boundary, because the filesystem has no RLS. Served under
// /api, never staticPlugin.

// NOTE: these AppError translationKeys are localized centrally in `onError`, so they are declared
// here for the i18n extractor (keepRemoved: false). They belong to the documents module, but the api
// extractor only scans `src/api/**`, and a missing key silently falls back to English. Keep the
// defaults in sync with src/api/locales/*.json.
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
// translate('errors.slugShape', 'the slug must start with a letter and contain only lowercase letters, digits and underscores')
// translate('errors.slugTooLong', 'the slug must be at most {{max}} characters (it becomes the tool name send_<slug>, and providers cap a tool name)')
// translate('errors.slugBuiltInTool', 'the slug would produce the tool name "{{tool}}", which is already a built-in tool')
// translate('errors.nextNumberRange', 'nextNumber: must be a whole number from 1 to {{max}}.')
// translate('errors.idempotencyKeyReserved', 'idempotencyKey: the prefix "{{prefix}}" is reserved for approved documents.')
// translate('errors.documentToolNameTaken', 'The tool name {{tool}} is already used by the tool "{{holder}}"')
// translate('errors.invalidDocumentTemplateName', 'This document template name is not valid: {{reason}}')
// translate('errors.documentRevoked', 'This document was revoked and cannot be issued again')
// translate('errors.documentNotNumbered', 'This document could not be numbered because its template no longer exists')
// translate('errors.invalidDocumentTemplateDescription', 'This document template description is not valid: {{reason}}')
// translate('errors.documentTemplateUnreadable', 'This template contains content a newer version wrote, so it cannot be saved from here: {{reason}}')
// translate('errors.unstorableReason', '{{field}} contains characters the database cannot store ({{codePoints}}) — a NUL or half of a character, which PostgreSQL refuses in text and JSON columns alike.')
// translate('errors.unprintableReason', '{{field}} contains characters this document cannot print ({{characters}}) — the PDF fonts cover Latin text only, and printing them anyway would put a different character in the document.')
// translate('errors.documentWhereBlock', 'block "{{id}}"')
// translate('errors.documentHalfValidatorSaid', '{{half}}: {{detail}}')
// translate('errors.documentStyleUnknownProperty', 'style: "{{property}}" is not a style property, so it would be stored and never take effect. Check the spelling against document_template_schema, or remove it.')
// translate('errors.documentUnknownProperty', '{{half}}: "{{property}}" is not a property this version understands, so it would be stored and never take effect. Check the spelling against document_template_schema, or remove it.')
// translate('errors.documentTooManyFields', 'fields: at most {{max}} per document, got {{count}} — the declared fields become the agent\'s tool schema, published on every turn.')
// translate('errors.documentNothingPrints', 'blocks: a document needs at least one block that can print something (header, text, fields, lineItems or totals) — as written, every issued document would be a numbered blank page.')
// translate('errors.documentBlocksValidatorSaid', 'blocks: {{detail}} — blocks are {"type":"header"|"text"|"fields"|"lineItems"|"totals"|"divider", "id":"…"}.')
// translate('errors.documentTooManyBlocks', 'blocks: at most {{max}} per document, got {{count}}.')
// translate('errors.documentDuplicateBlockId', 'blocks: duplicate block id "{{id}}" — ids address a block across reorders, so two blocks cannot share one.')
// translate('errors.documentDuplicateFieldName', 'fields: duplicate field name "{{name}}".')
// translate('errors.documentReservedFieldPrefix', 'fields: "{{name}}" starts with a reserved prefix (company_, empresa_, doc_, documento_) — those names already resolve to the company profile or the document itself, and a field would shadow them silently.')
// translate('errors.documentBlockFieldUndeclared', 'blocks: {{type}} block "{{id}}" points {{prop}} at "{{name}}", which is not a declared field.')
// translate('errors.documentBlockFieldWrongType', 'blocks: {{type}} block "{{id}}" needs {{prop}} to name a field of type {{types}}, but "{{name}}" is {{actual}}.')
// translate('errors.documentTooManyTokens', 'blocks: at most {{max}} {{token}} per document, counting repeats, got {{count}} — each one expands to a value of up to 2000 characters when the document is issued.')
// translate('errors.documentTokenMalformed', '{{half}}: {{where}} uses {{token}}, which is not a readable token: a name must start with a lowercase letter and contain only lowercase letters, digits and underscores. As written it would print with its braces in the customer\'s document.')
// translate('errors.documentTokenNotScalar', '{{half}}: {{where}} uses {{token}}, which is a lineItems field. A table cannot be printed as a token — it renders as a blank. Use a lineItems block to show those items.')
// translate('errors.documentTokenUnknown', '{{half}}: {{where}} uses {{token}}, which is neither a declared field nor a reserved name. Declare it in fields, or remove it — an unresolved token renders as a blank space in the customer\'s document.')
// translate('errors.documentValueTextTooLong', 'must be a string of at most {{max}} characters')
// translate('errors.documentValueNotNumber', 'must be a finite number')
// translate('errors.documentValueTooLarge', 'must be at most {{max}}')
// translate('errors.documentValueNotDate', 'must be an ISO date (YYYY-MM-DD)')
// translate('errors.documentValueNotList', 'must be a list of line items')
// translate('errors.documentValueTooManyItems', 'must have at most {{max}} line items')
// translate('errors.documentLineItemsValidatorSaid', 'line items: {{detail}} — each is {"description":"…","quantity":n,"unitPrice":n}')
// translate('errors.documentLineItemBlankDescription', 'line items: every item needs a description that is not blank once whitespace and control characters are removed')
// translate('errors.documentLineItemFactorTooLarge', 'line items: "{{description}}" has a quantity or unit price above {{max}}')
// translate('errors.documentLineItemTotalTooLarge', 'line items: "{{description}}" totals more than {{max}}')
// translate('errors.documentValuesNotObject', 'values must be an object keyed by field name.')
// translate('errors.documentValueUndeclared', 'values: "{{name}}" is not a declared field of this template (declared: {{declared}}).')
// translate('errors.documentValueUndeclaredNone', 'values: "{{name}}" is not a declared field of this template (declared: none).')
// translate('errors.documentValueRequired', 'values: "{{name}}" ({{label}}) is required.')
// translate('errors.documentValueRequiredItems', 'values: "{{name}}" ({{label}}) is required, so it needs at least one item.')
// translate('errors.documentValueRequiredBlank', 'values: "{{name}}" ({{label}}) is required, and this value is blank once whitespace and control characters are removed.')
// translate('errors.documentValueProblem', 'values: "{{name}}" {{problem}}.')
// translate('errors.documentNameLength', 'name: must be between {{min}} and {{max}} characters.')
// translate('errors.documentDescriptionLength', 'description: must be at most {{max}} characters.')
// translate('errors.documentNumberPrefixLength', 'numberPrefix: must be at most {{max}} characters.')
// translate('errors.documentApprovalTtlRange', 'approvalTtlHours: must be a whole number of hours from {{min}} to {{max}}.')
// translate('errors.documentBlockTextOnCreate', 'blockText: only an update can replace text by block id; when creating, write the text inside blocks.')
// translate('errors.documentBlockTextNotText', 'blockText: "{{id}}" is not a text block of this template.')
// translate('errors.invalidDocumentNumberPrefix', 'This document number prefix is not valid: {{reason}}')
// translate('errors.documentNumberAlreadyUsed', '{{asked}} cannot be the next number: {{used}} was already issued. Choose {{min}} or above, or change the prefix to start a new sequence.')
// translate('errors.invalidDocumentNextNumber', 'This next document number is not valid: {{reason}}')
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

// The conversation key an issued document is bound to, constrained at the transport to the shape the
// runtime writes (tenantId:instanceId:conversationId) and bounded by it. `issued_documents.thread_id`
// is indexed, so an unbounded value is refused by Postgres with an index-row-size error, a 500 for a
// field a caller typed. Ids are constrained here rather than left to the global handler that maps a
// BigInt parse error to 400 by matching wording in an engine's message.
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
      ...(await pageIssuedDocuments(ctxOrThrow(tenantContext), {
        limit: query.limit ? Number(query.limit) : undefined,
        // `!== undefined` for the same reason the preview route uses it: `?templateId=0` is a
        // filter, and dropping it answers with EVERY document instead of none. (`limit` above can
        // stay truthy-checked — its pattern refuses "0" at the transport.)
        templateId:
          query.templateId !== undefined
            ? requireDbId(query.templateId, "template id")
            : undefined,
        threadId: query.threadId,
        before:
          query.before !== undefined
            ? requireDbId(query.before, "document id")
            : undefined,
        query: query.q,
      })),
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
        before: t.Optional(
          t.String({
            pattern: "^[0-9]+$",
            description:
              "Only documents older than this id: the next page after the last one read.",
          }),
        ),
        q: t.Optional(
          t.String({
            maxLength: 200,
            description:
              "Part of the printed number (prefix and padded counter, e.g. ORC-0005) or of the title.",
          }),
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
          description: "Document id (BigInt string).",
        }),
      }),
      detail: doc(
        "Revoke document",
        "Revokes an issued document; its PDF stops being served.",
      ),
      response: errors(400, 401, 403, 404),
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
          description: "Document id (BigInt string).",
        }),
      }),
      detail: doc(
        "Download document PDF",
        "Streams the rendered PDF for inline viewing.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
