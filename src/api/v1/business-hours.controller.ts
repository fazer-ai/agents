import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  type BusinessHoursCreate,
  type BusinessHoursUpdate,
  createBusinessHours,
  deleteBusinessHours,
  getBusinessHours,
  listBusinessHours,
  updateBusinessHours,
} from "@/modules/business-hours/service";

// The error catalog this controller's routes answer with. `bun i18n:extract` materialises
// src/api/locales/*.json from these lines and prunes anything nothing references, and
// `ErrorTranslationKey` (src/lib/errors.ts) makes a key that is missing here a type error at the
// throw site rather than an English sentence on a pt-BR caller's screen.
// translate('errors.businessHoursNotFound', 'Business hours not found.')
// NOTE: one key per refusal, not one per validator. The three exception checks refuse three
// different things and each names the date or the range it refused, because the operator is
// looking at a form with several of them and a sentence that does not say WHICH is not an answer.
// translate('errors.invalidBusinessHoursDate', '{{date}} is not a calendar date.')
// translate('errors.invalidBusinessHoursRange', 'The range on {{date}} must end after it starts ({{start}} to {{end}}).')
// translate('errors.invalidBusinessHoursSpan', 'The exception starting {{start}} must not end before it ({{end}}).')
// translate('errors.invalidBusinessHoursWindow', 'The window for day {{day}} must end after it starts ({{start}} to {{end}}).')
// translate('errors.invalidTimezone', 'Unknown timezone: {{timezone}}.')

// Business-hours schedules (per-tenant). TENANT_ADMIN.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const windowSchema = t.Object({
  day: t.Integer({
    minimum: 0,
    maximum: 6,
    description: "Day of week, 0 (Sunday) through 6 (Saturday).",
  }),
  start: t.String({
    description:
      'Window start time as "HH:mm" (24-hour, in the schedule timezone).',
  }),
  end: t.String({
    description:
      'Window end time as "HH:mm" (24-hour, in the schedule timezone).',
  }),
});

// A span of the local day inside a date exception. No `day`: the exception's date already fixes it.
const rangeSchema = t.Object({
  start: t.String({
    description:
      'Range start time as "HH:mm" (24-hour, in the schedule timezone).',
  }),
  end: t.String({
    description:
      'Range end time as "HH:mm" (24-hour, in the schedule timezone).',
  }),
});

const exceptionSchema = t.Object({
  date: t.String({
    description:
      'Calendar date the exception applies to, "YYYY-MM-DD". With recurring, only the month and day are compared.',
  }),
  dateEnd: t.Optional(
    t.String({
      description:
        'Inclusive last date of the span, "YYYY-MM-DD". Under recurring, a month-day before the start wraps the year end (e.g. Dec 23 through Jan 2).',
    }),
  ),
  recurring: t.Optional(
    t.Boolean({
      description:
        "Match the same month-day every year. Only for fixed-date holidays; movable ones (Carnival, Good Friday) need a dated entry per year.",
    }),
  ),
  label: t.Optional(
    t.String({ description: "Operator-facing name, e.g. Independence Day." }),
  ),
  ranges: t.Array(rangeSchema, {
    description:
      "Hours in force on the matched dates, REPLACING the weekly windows. Empty = closed all day.",
  }),
});

const writeBody = t.Object({
  name: t.Optional(
    t.String({ description: "Human-readable name of the schedule." }),
  ),
  timezone: t.Optional(
    t.String({
      description:
        "IANA timezone (e.g. America/Sao_Paulo) the windows are evaluated in.",
    }),
  ),
  windows: t.Optional(
    t.Array(windowSchema, {
      description: "Open windows that define the schedule.",
    }),
  ),
  exceptions: t.Optional(
    t.Array(exceptionSchema, {
      description:
        "Date exceptions (holidays, shutdowns, half-days) that replace the weekly windows on the dates they match.",
    }),
  ),
});

// The CREATE route's own body. `writeBody` above describes what a PATCH accepts, where every field
// being optional is correct, and a POST that borrows it lets a request missing a required field
// through the transport: the refusal then comes from the service's zod schema, whose `ZodError`
// src/app.ts has no branch for, so the caller is told the server broke about a field they own
// (issue #301, measured: `POST` with `{}` answered 500 `Something went wrong`).
//
// Composed rather than written out, so the descriptions and the field list stay in one place and a
// field added to `writeBody` cannot be missing here. WHICH fields are required is not written twice
// either: tests/api/v1/write-body-required.test.ts derives that set from the service's create schema
// and fails if the two drift.
const CREATE_REQUIRED = ["name"] as const;
const createBody = t.Composite([
  t.Omit(writeBody, CREATE_REQUIRED),
  t.Required(t.Pick(writeBody, CREATE_REQUIRED)),
]);

export const businessHoursController = new Elysia({
  prefix: "/v1/business-hours",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .get(
    "/",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      businessHours: await listBusinessHours(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List business hours",
        "List all business-hours schedules for the current tenant.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      businessHours: await getBusinessHours(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get business hours",
        "Fetch a single business-hours schedule by id.",
      ),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({
          description: "Business-hours schedule id (BigInt as a string).",
        }),
      }),
    },
  )
  .post(
    "/",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      businessHours: await createBusinessHours(
        ctxOrThrow(tenantContext),
        body as BusinessHoursCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Create business hours",
        "Create a new business-hours schedule for the current tenant.",
      ),
      response: errors(400, 401, 403, 404, 422),
      body: createBody,
    },
  )
  .patch(
    "/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      businessHours: await updateBusinessHours(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as BusinessHoursUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Update business hours",
        "Update a business-hours schedule name, timezone, or windows.",
      ),
      response: errors(400, 401, 403, 404, 422),
      params: t.Object({
        id: t.String({
          description: "Business-hours schedule id (BigInt as a string).",
        }),
      }),
      body: writeBody,
    },
  )
  .delete(
    "/:id",
    async ({ tenantContext, params }) => {
      await deleteBusinessHours(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc("Delete business hours", "Delete a business-hours schedule."),
      response: errors(400, 401, 403, 404),
      params: t.Object({
        id: t.String({
          description: "Business-hours schedule id (BigInt as a string).",
        }),
      }),
    },
  );
