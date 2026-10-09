import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  approveDocumentRequest,
  getApprovalRequest,
  listApprovalRequests,
  listPendingApprovals,
  rejectDocumentRequest,
  renderApprovalPreview,
  requestApprovalAgain,
} from "@/modules/documents/approval";
import { getApprovalContext } from "@/modules/documents/approval-context";

// Document approval requests (docs/documents.md, Approval). Any user of the tenant decides one, the
// AGENT role included: approving is reading a document and saying yes, not configuring anything.

// NOTE: AppError translationKeys localized centrally in `onError`, declared here for the i18n
// extractor, which only scans `src/api/**`. Keep the defaults in sync with src/api/locales/*.json.
// translate('errors.documentApprovalNotFound', 'Document approval request not found')
// translate('errors.documentApprovalNotPending', 'This approval request was already decided ({{status}})')
// translate('errors.documentApprovalExpired', 'This approval request expired, so the document can no longer be issued from it')
// translate('errors.documentApprovalNotExpired', 'Only an expired approval request can be requested again ({{status}})')
// translate('errors.invalidDocumentApprovalTtl', 'This approval validity is not valid: {{reason}}')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const STATUS = t.Union([
  t.Literal("PENDING"),
  t.Literal("APPROVED"),
  t.Literal("REJECTED"),
  t.Literal("EXPIRED"),
  t.Literal("CANCELLED"),
]);

const idParam = t.Object({ id: t.String({ pattern: "^[0-9]+$" }) });

export const documentApprovalsController = new Elysia({
  prefix: "/v1/document-approvals",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext, query }) => ({
      instance: instanceIdentity,
      requests: await listApprovalRequests(ctxOrThrow(tenantContext), {
        status: query.status,
        limit: query.limit ? Number(query.limit) : undefined,
      }),
    }),
    {
      requireRole: "AGENT",
      query: t.Object({
        status: t.Optional(STATUS),
        limit: t.Optional(
          t.String({
            pattern: "^[1-9][0-9]*$",
            description: "Max rows to return (positive integer, at most 200).",
          }),
        ),
      }),
      detail: doc(
        "List document approval requests",
        "Lists the tenant's document approval requests, newest first.",
      ),
      response: errors(401, 403, 404, 422),
    },
  )
  .get(
    "/pending",
    async ({ tenantContext }) => ({
      requests: await listPendingApprovals(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "AGENT",
      detail: doc(
        "List pending document approvals",
        "The requests waiting on the team now: pending and not past their validity, oldest first, with the conversation and the customer's name. The console's approvals queue and its badge read this.",
      ),
      response: errors(401, 403, 404, 422),
    },
  )
  .get(
    "/:id",
    async ({ tenantContext, params }) => ({
      request: await getApprovalRequest(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "AGENT",
      params: idParam,
      detail: doc(
        "Get document approval request",
        "Returns one document approval request.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/:id/context",
    async ({ tenantContext, params }) =>
      getApprovalContext(ctxOrThrow(tenantContext), requireDbId(params.id)),
    {
      requireRole: "AGENT",
      params: idParam,
      detail: doc(
        "Get document approval context",
        "Who the customer is and the conversation's last messages, for the reviewer. Private notes are left out.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/:id/preview",
    async ({ tenantContext, params }) => {
      const { bytes, fileName } = await renderApprovalPreview(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${fileName}"`,
          "Cache-Control": "no-store",
        },
      });
    },
    {
      requireRole: "AGENT",
      params: idParam,
      detail: doc(
        "Preview document approval request",
        "Renders the document the request would issue, with a placeholder where the number goes. Issues nothing and consumes no number.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/:id/approve",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const { request, document } = await approveDocumentRequest({
        ctx,
        requestId: requireDbId(params.id),
        reviewerUserId: ctx.userId,
      });
      return {
        request,
        document: {
          id: document.id,
          number: document.number,
          title: document.title,
          status: document.status,
          fileName: document.fileName,
        },
      };
    },
    {
      requireRole: "AGENT",
      params: idParam,
      detail: doc(
        "Approve document approval request",
        "Issues the frozen document with its number and the date the reviewer saw. Approving an approved request returns the same document.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .post(
    "/:id/reject",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      return {
        request: await rejectDocumentRequest({
          ctx,
          requestId: requireDbId(params.id),
          reviewerUserId: ctx.userId,
          note: body?.note ?? null,
        }),
      };
    },
    {
      requireRole: "AGENT",
      params: idParam,
      body: t.Optional(
        t.Object({
          note: t.Optional(
            t.String({
              maxLength: 2_000,
              description: "Why it was rejected, for the team.",
            }),
          ),
        }),
      ),
      detail: doc(
        "Reject document approval request",
        "Rejects a pending request. Nothing is issued and no number is taken.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .post(
    "/:id/request-again",
    async ({ tenantContext, params }) => ({
      request: await requestApprovalAgain({
        ctx: ctxOrThrow(tenantContext),
        requestId: requireDbId(params.id),
      }),
    }),
    {
      requireRole: "AGENT",
      params: idParam,
      detail: doc(
        "Request a document approval again",
        "On an expired request, freezes the same values again from the template, dated today, as a new pending request for the same conversation. The expired request stays expired; asking twice opens one request.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  );
