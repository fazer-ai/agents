import { Elysia, t } from "elysia";
import type {
  NurtureEnrollmentStatus,
  NurtureOutboxStatus,
} from "@/../generated/prisma/client";
import { doc, errors } from "@/api/lib/openapi";
import { parseQueryCount, parseQueryId } from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import { badQueryParam } from "@/lib/query-param";
import type { TenantContext } from "@/lib/tenancy";
import {
  cancelEnrollment,
  ENROLLMENT_STATUSES,
  enrollLead,
  listNurtureEnrollments,
} from "@/modules/nurture/enrollments";
import {
  cancelOutboxItem,
  listNurtureOutbox,
  markOutboxSent,
  OUTBOX_STATUSES,
} from "@/modules/nurture/outbox";
import {
  createNurtureSequence,
  deleteNurtureSequence,
  getNurtureSequence,
  listNurtureSequences,
  type NurtureSequenceCreate,
  type NurtureSequenceUpdate,
  updateNurtureSequence,
} from "@/modules/nurture/sequences";

// The error catalog this controller's routes answer with (`bun i18n:extract` reads these lines).
// translate('errors.nurtureSequenceNotFound', 'Nurture sequence not found.')
// translate('errors.nurtureSequenceInactive', 'This sequence is paused; reactivate it to enroll leads.')
// translate('errors.nurtureEnrollmentNotFound', 'Nurture enrollment not found.')
// translate('errors.nurtureOutboxNotFound', 'Outbox row not found.')
// translate('errors.nurtureOutboxNotPending', 'The outbox row is no longer pending.')

// Nurture sequences: operator-authored follow-up step lists walked per enrolled
// lead by the NURTURE_DRAIN scheduler job, staged into a human-executed outbox.
// Reads are for any authenticated member; writes are TENANT_ADMIN.

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

const stepsSchema = t.Array(
  t.Object({
    delayMin: t.Integer({
      minimum: 0,
      maximum: 43200,
      description:
        "Minutes to wait after the previous step before staging this one.",
    }),
    bodyTemplate: t.String({
      minLength: 1,
      maxLength: 5000,
      description:
        "Message body; {{name}}, {{product}} and {{platform}} placeholders are rendered per lead.",
    }),
    channel: t.Union([t.Literal("dm"), t.Literal("reply")], {
      description: "Where the operator sends the rendered body.",
    }),
  }),
  { minItems: 1, maxItems: 20 },
);

function parseEnrollmentStatus(
  raw: string | undefined,
): NurtureEnrollmentStatus | undefined {
  if (raw === undefined) return undefined;
  const status = raw.toUpperCase();
  if ((ENROLLMENT_STATUSES as readonly string[]).includes(status)) {
    return status as NurtureEnrollmentStatus;
  }
  badQueryParam("status");
}

function parseOutboxStatus(
  raw: string | undefined,
): NurtureOutboxStatus | undefined {
  if (raw === undefined) return undefined;
  const status = raw.toUpperCase();
  if ((OUTBOX_STATUSES as readonly string[]).includes(status)) {
    return status as NurtureOutboxStatus;
  }
  badQueryParam("status");
}

export const merchantNurtureController = new Elysia({
  prefix: "/v1/merchant/nurture",
  tags: ["Merchant"],
})
  .use(tenancyPlugin)
  .get(
    "/sequences",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      sequences: await listNurtureSequences(ctxOrThrow(tenantContext)),
    }),
    {
      requireAuth: true,
      detail: doc(
        "List nurture sequences",
        "List the tenant's nurture sequences, newest first, with each one's live enrollment count.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .post(
    "/sequences",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      sequence: await createNurtureSequence(
        ctxOrThrow(tenantContext),
        body as NurtureSequenceCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 200 }),
        steps: stepsSchema,
        active: t.Optional(t.Boolean()),
      }),
      detail: doc(
        "Create nurture sequence",
        "Create a nurture sequence: an ordered list of follow-up steps ({delayMin, bodyTemplate, channel}) staged per enrolled lead.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .get(
    "/sequences/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      sequence: await getNurtureSequence(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireAuth: true,
      params: idParam,
      detail: doc(
        "Get nurture sequence",
        "Fetch a single nurture sequence by id.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .patch(
    "/sequences/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      sequence: await updateNurtureSequence(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as NurtureSequenceUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        steps: t.Optional(stepsSchema),
        active: t.Optional(t.Boolean()),
      }),
      detail: doc(
        "Update nurture sequence",
        "Update a nurture sequence's name, steps or active flag. Active enrollments keep the step list they were created against only in spirit — steps are read at fire time, so an edit applies to steps not yet staged.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/sequences/:id",
    async ({ tenantContext, params }) => {
      await deleteNurtureSequence(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Delete nurture sequence",
        "Delete a nurture sequence; its enrollments and their staged outbox rows go with it (cascade).",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/enrollments",
    async ({ tenantContext, query }) => {
      const page = await listNurtureEnrollments(ctxOrThrow(tenantContext), {
        sequenceId: parseQueryId(query.sequenceId, "sequenceId"),
        leadId: parseQueryId(query.leadId, "leadId"),
        status: parseEnrollmentStatus(query.status),
        limit: parseQueryCount(query.limit, "limit"),
        cursor: parseQueryId(query.cursor, "cursor"),
      });
      return {
        instance: instanceIdentity,
        enrollments: page.items,
        nextCursor: page.nextCursor,
      };
    },
    {
      requireAuth: true,
      query: t.Composite([
        pageQuery,
        t.Object({
          sequenceId: t.Optional(
            t.String({ description: "Filter to one sequence's enrollments." }),
          ),
          leadId: t.Optional(
            t.String({ description: "Filter to one lead's enrollments." }),
          ),
          status: t.Optional(
            t.String({
              description: "Optional status filter (ACTIVE, DONE, CANCELLED).",
            }),
          ),
        }),
      ]),
      detail: doc(
        "List nurture enrollments",
        "Returns a page of nurture enrollments (newest first); use nextCursor to page.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/enrollments",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      enrollment: await enrollLead(ctxOrThrow(tenantContext), body),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        sequenceId: t.String({
          minLength: 1,
          description: "Nurture sequence id (decimal string).",
        }),
        leadId: t.String({
          minLength: 1,
          description: "Lead id (decimal string).",
        }),
      }),
      detail: doc(
        "Enroll a lead",
        "Enroll a lead into a sequence: one ACTIVE enrollment per (tenant, sequence, lead); a repeat call answers the live enrollment. The first step's delayMin sets next_run_at.",
      ),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/enrollments/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      enrollment: await cancelEnrollment(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Cancel a nurture enrollment",
        "Cancel an ACTIVE enrollment (it stops walking the sequence); a DONE or already-cancelled row is answered unchanged.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/outbox",
    async ({ tenantContext, query }) => {
      const page = await listNurtureOutbox(ctxOrThrow(tenantContext), {
        status: parseOutboxStatus(query.status),
        leadId: parseQueryId(query.leadId, "leadId"),
        limit: parseQueryCount(query.limit, "limit"),
        cursor: parseQueryId(query.cursor, "cursor"),
      });
      return {
        instance: instanceIdentity,
        outbox: page.items,
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
                "Optional status filter (PENDING, SENT, CANCELLED). The review queue is status=PENDING.",
            }),
          ),
          leadId: t.Optional(
            t.String({ description: "Filter to one lead's staged messages." }),
          ),
        }),
      ]),
      detail: doc(
        "List nurture outbox",
        "Returns a page of rendered follow-ups staged by the drain (newest first). Nothing is ever sent by the platform: an operator copies each body out and marks it sent.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/outbox/:id/send",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      outbox: await markOutboxSent(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Mark outbox row sent",
        "Record that an operator delivered this staged message by hand (PENDING -> SENT, sentAt=now). 409 when the row is no longer pending.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .post(
    "/outbox/:id/cancel",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      outbox: await cancelOutboxItem(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Cancel outbox row",
        "Drop a staged message the operator decided not to send (PENDING -> CANCELLED). 409 when the row is no longer pending.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  );
