import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { documentStarters } from "@/modules/documents/starters";
import {
  // translate('errors.invalidId', 'Not a valid {{label}}')
  createDocumentTemplate,
  deleteDocumentTemplate,
  documentTemplateReferences,
  getDocumentTemplate,
  listDocumentTemplates,
  previewDocumentTemplate,
  updateDocumentTemplate,
} from "@/modules/documents/templates";

// Document templates (TENANT_ADMIN). The scoped service is the hard boundary; the deeper validation
// of blocks/fields/style lives there, in modules/documents/validate.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const BLOCKS_DESC =
  'Ordered blocks. Each is {"id":"…","type":…} plus its own fields: header {title?,subtitle?,showLogo?,showCompany?,meta?:[{label,value}]}, text {text,align?,variant?}, fields {rows:[{label,value}],columns?}, lineItems {field,columns?,showHeader?}, totals {field,rows?,discountField?,taxField?}, divider {}. Every block also takes spaceAfter ("none"|"sm"|"md"|"lg"). Text carries {{tokens}}: a declared field by name, or a reserved name (company_name, company_document, company_address, company_phone, company_email, company_website, doc_number, doc_date, doc_title — each with a pt-BR alias: empresa_nome, documento_numero, …). A token that names neither is refused.';

const FIELDS_DESC =
  'Fields an agent fills when it issues this document: [{"name":"…","label":"…","type":"text"|"number"|"date"|"currency"|"lineItems","required"?,"description"?}]. `name` is lowercase letters, digits and underscores, and may not start with company_, empresa_, doc_ or documento_ (those already resolve to the letterhead or the document itself). A lineItems value is [{"description","quantity","unitPrice"}] and is the only field a lineItems or totals block may point at.';

const STYLE_DESC =
  'Rendering style: {"font":"sans"|"serif"|"mono","baseFontSize":8-14,"accentColor":"#rrggbb","margin":"narrow"|"normal"|"wide","pageSize":"A4"|"LETTER","locale":"pt-BR"|"en-US","currency":"BRL","footerText"?,"showPageNumbers":bool}. baseFontSize outside 8-14 is clamped, not refused.';

// Exported for the schema-drift guard in tests: every field the service accepts must appear here, or
// Elysia's `normalize` silently strips it from the request body — which is how a whole block list
// arrives as `[]` and the operator sees a saved template with nothing in it.
export const writeBody = t.Object({
  name: t.Optional(t.String({ maxLength: 120, description: "Template name." })),
  slug: t.Optional(
    t.String({
      maxLength: 40,
      description:
        "Identifier used for the agent tool name (send_<slug>); derived from the name when omitted.",
    }),
  ),
  description: t.Optional(
    t.Union([t.String(), t.Null()], {
      description: "What this template is for, for the operator.",
    }),
  ),
  // NOTE: deliberately permissive Records, not the structural union. Elysia's `normalize` STRIPS
  // what a schema does not declare, and a discriminated union of six block types declared field by
  // field would drop every property it does not name — silently, with a 200. Passing the array
  // through intact is what lets the service refuse it with a message that says what to write.
  blocks: t.Optional(
    t.Array(t.Record(t.String(), t.Unknown()), { description: BLOCKS_DESC }),
  ),
  blockText: t.Optional(
    t.Record(t.String(), t.String(), {
      description:
        "Replace the text of `text` blocks BY ID, leaving the rest of the layout as it stands. Prefer this over sending `blocks` when only the wording changes: a whole-array write makes the caller authoritative over blocks another client may have added or reordered meanwhile.",
    }),
  ),
  fields: t.Optional(
    t.Array(t.Record(t.String(), t.Unknown()), { description: FIELDS_DESC }),
  ),
  style: t.Optional(
    t.Record(t.String(), t.Unknown(), { description: STYLE_DESC }),
  ),
  numberPrefix: t.Optional(
    t.Union([t.String(), t.Null()], {
      description:
        'Prefix for the document number, e.g. "ORC-" produces ORC-0001.',
    }),
  ),
  enabled: t.Optional(
    t.Boolean({ description: "Whether agents may issue this document." }),
  ),
});

export const documentTemplatesController = new Elysia({
  prefix: "/v1/document-templates",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      templates: await listDocumentTemplates(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List document templates",
        "Lists the tenant's document templates.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/starters",
    async ({ tenantContext, query }) => {
      ctxOrThrow(tenantContext);
      return {
        instance: instanceIdentity,
        starters: documentStarters(
          query.locale === "en-US" ? "en-US" : "pt-BR",
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      query: t.Object({
        locale: t.Optional(
          t.String({ description: 'Starter language: "pt-BR" or "en-US".' }),
        ),
      }),
      detail: doc(
        "List starter templates",
        "Ready-made templates (quote, proposal, receipt) to create one from.",
      ),
      response: errors(401, 403),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      template: await createDocumentTemplate(ctxOrThrow(tenantContext), {
        ...body,
        name: body.name ?? "",
      }),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: writeBody,
      detail: doc(
        "Create document template",
        "Creates a document template from blocks, fields and style.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .post(
    "/preview",
    async ({ tenantContext, body }) => {
      const bytes = await previewDocumentTemplate(ctxOrThrow(tenantContext), {
        // `!== undefined`, not truthiness: "0" is a supplied id, and reading it as "no id given"
        // answers a lookup for a template that does not exist with a blank draft preview — telling
        // the operator their template rendered.
        id:
          body.id !== undefined
            ? requireDbId(body.id, "template id")
            : undefined,
        name: body.name,
        blocks: body.blocks,
        blockText: body.blockText,
        fields: body.fields,
        style: body.style,
        numberPrefix: body.numberPrefix,
        values: body.values,
      });
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'inline; filename="preview.pdf"',
          // A preview is a picture of an unsaved decision. Caching one would show the operator the
          // previous draft after an edit, which is the one thing a preview must never do.
          "Cache-Control": "no-store",
        },
      });
    },
    {
      requireRole: "TENANT_ADMIN",
      // POST, not GET: the draft carries the whole block list, which is past any sane URL limit the
      // first time a template has a table in it.
      body: t.Object({
        id: t.Optional(
          t.String({
            pattern: "^[0-9]+$",
            description:
              "Saved template to preview, or to inherit style/name from when previewing a draft.",
          }),
        ),
        name: t.Optional(t.String({ description: "Title shown on the page." })),
        blocks: t.Optional(
          t.Array(t.Record(t.String(), t.Unknown()), {
            description: BLOCKS_DESC,
          }),
        ),
        blockText: t.Optional(
          t.Record(t.String(), t.String(), {
            description:
              "Replace the text of `text` blocks BY ID, over the saved template's layout. The same shape the PATCH takes, so a preview shows what the save will produce.",
          }),
        ),
        fields: t.Optional(
          t.Array(t.Record(t.String(), t.Unknown()), {
            description: FIELDS_DESC,
          }),
        ),
        style: t.Optional(
          t.Record(t.String(), t.Unknown(), { description: STYLE_DESC }),
        ),
        numberPrefix: t.Optional(t.Union([t.String(), t.Null()])),
        values: t.Optional(
          t.Record(t.String(), t.Unknown(), {
            description:
              "Values keyed by field name. Omitted, the preview invents plausible ones from the declared fields.",
          }),
        ),
      }),
      detail: doc(
        "Preview document template",
        "Renders a saved template or an unsaved draft to PDF, without issuing anything.",
      ),
      // 404 included: previewing by `id` LOOKS the template up, and a well-formed id that names
      // nothing in this tenant answers the same way a GET does. Leaving it out publishes a union
      // the endpoint does not honour, and an Eden caller narrowing on the declared statuses is
      // handed a status its types say cannot happen.
      //
      // 409 for the same reason, and it is the one this rule was stated for and then missed: a
      // preview by id alone authored neither blocks nor fields, so it takes the same refusal the
      // write takes for a template a newer build wrote (`documentTemplateUnreadable`). Create and
      // patch both declared it; nothing at runtime told anyone this one did not, because Elysia
      // answers the 409 either way and only the generated client is left holding the wrong union.
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .get(
    "/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      template: await getDocumentTemplate(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Template id (BigInt string).",
        }),
      }),
      detail: doc("Get document template", "Returns one document template."),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/:id/references",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      references: await documentTemplateReferences(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Template id (BigInt string).",
        }),
      }),
      detail: doc(
        "List template references",
        "Agents that were granted this template, so deletion can warn first.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .patch(
    "/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      template: await updateDocumentTemplate(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Template id (BigInt string).",
        }),
      }),
      body: writeBody,
      detail: doc(
        "Update document template",
        "Patches a document template; omitted fields keep their value.",
      ),
      // 409 for a slug already taken, and for a stored template this version cannot read.
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await deleteDocumentTemplate(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Template id (BigInt string).",
        }),
      }),
      detail: doc(
        "Delete document template",
        "Deletes a document template. Documents already issued from it keep their own copy.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
