import { Elysia, t } from "elysia";
import type { OutreachJobStatus } from "@/../generated/prisma/client";
import { doc, errors } from "@/api/lib/openapi";
import { parseQueryCount, parseQueryId } from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import { badQueryParam } from "@/lib/query-param";
import type { TenantContext } from "@/lib/tenancy";
import {
  createOutreachAccount,
  deleteOutreachAccount,
  getOutreachAccount,
  listOutreachAccounts,
  type OutreachAccountCreate,
  type OutreachAccountUpdate,
  updateOutreachAccount,
} from "@/modules/outreach/accounts";
import {
  approveOutreachJob,
  cancelOutreachJob,
  getOutreachJob,
  listOutreachJobs,
  markOutreachJobSent,
  type OutreachJobCreate,
  outreachStats,
  queueOutreachJob,
  requeueOutreachJob,
} from "@/modules/outreach/jobs";
import { OUTREACH_JOB_STATUSES } from "@/modules/outreach/shared";

// The error catalog this controller's routes answer with (`bun i18n:extract` reads these lines).
// translate('errors.outreachDisabled', 'Outreach is not enabled on this server.')
// translate('errors.outreachAccountNotFound', 'Outreach account not found.')
// translate('errors.outreachAccountDuplicate', 'An outreach account with this platform and handle already exists.')
// translate('errors.outreachAccountBanned', 'This outreach account is banned and cannot take new jobs.')
// translate('errors.outreachJobNotFound', 'Outreach job not found.')
// translate('errors.outreachJobDuplicate', 'This lead already has an outreach job of this kind on this account.')
// translate('errors.outreachJobState', 'This job is {{status}} and cannot make this transition.')
// translate('errors.outreachJobRace', 'This job changed state while the request was in flight.')
// translate('errors.outreachDailyCap', 'This outreach account has reached its daily cap.')

// "Grey rails" outreach: opt-in sends from the tenant's own secondary/personal
// accounts. Every route is TENANT_ADMIN (the payloads are operator-only: account
// handles, message bodies) and every one refuses 403 while OUTREACH_ENABLED is
// off - the assert lives in the services, so nothing reachable from another
// entrypoint bypasses it either.

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

function parseJobStatus(
  raw: string | undefined,
): OutreachJobStatus | undefined {
  if (raw === undefined) return undefined;
  const status = raw.toUpperCase();
  if ((OUTREACH_JOB_STATUSES as readonly string[]).includes(status)) {
    return status as OutreachJobStatus;
  }
  badQueryParam("status");
}

export const merchantOutreachController = new Elysia({
  prefix: "/v1/merchant/outreach",
  tags: ["Merchant"],
})
  .use(tenancyPlugin)
  // ── Accounts ──
  .get(
    "/accounts",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      accounts: await listOutreachAccounts(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List outreach accounts",
        "List the tenant's outreach accounts with effective daily-cap usage (sentToday is reset to 0 when its UTC day rolled over).",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/accounts",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      account: await createOutreachAccount(
        ctxOrThrow(tenantContext),
        body as OutreachAccountCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        platform: t.String({
          minLength: 1,
          description:
            "Platform the account lives on (facebook, zalo, threads, tiktok, instagram, whatsapp, telegram, web, other).",
        }),
        handle: t.String({
          minLength: 1,
          maxLength: 300,
          description: "The account's handle/display identifier.",
        }),
        transport: t.Optional(
          t.Union([t.Literal("manual"), t.Literal("zca_bridge")], {
            description:
              "How approved sends leave: 'manual' hands the text to an operator, 'zca_bridge' POSTs to the zca-bridge sidecar. Default 'manual'.",
          }),
        ),
        credentialRef: t.Optional(
          t.String({
            maxLength: 200,
            description:
              "Optional vault:<id> reference to the credential the transport reads (e.g. the zca-bridge token/baseUrl JSON).",
          }),
        ),
        dailyCap: t.Optional(
          t.Integer({
            minimum: 1,
            maximum: 500,
            description: "Max sends per UTC day for this account (default 20).",
          }),
        ),
        cooldownMin: t.Optional(
          t.Integer({
            minimum: 0,
            maximum: 1440,
            description:
              "Minimum minutes between two sends from this account (default 10).",
          }),
        ),
        notes: t.Optional(t.String({ maxLength: 2000 })),
      }),
      detail: doc(
        "Create outreach account",
        "Register a secondary/personal account to send outreach from. The account starts ACTIVE with a zeroed daily counter.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .get(
    "/accounts/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      account: await getOutreachAccount(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc("Get outreach account", "Fetch a single outreach account."),
      response: errors(400, 401, 403, 404),
    },
  )
  .patch(
    "/accounts/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      account: await updateOutreachAccount(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as OutreachAccountUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      body: t.Object({
        platform: t.Optional(t.String({ minLength: 1 })),
        handle: t.Optional(t.String({ minLength: 1, maxLength: 300 })),
        transport: t.Optional(
          t.Union([t.Literal("manual"), t.Literal("zca_bridge")]),
        ),
        credentialRef: t.Optional(
          t.Union([t.String({ maxLength: 200 }), t.Null()], {
            description:
              "A vault:<id> reference to attach, or null to detach the credential.",
          }),
        ),
        dailyCap: t.Optional(t.Integer({ minimum: 1, maximum: 500 })),
        cooldownMin: t.Optional(t.Integer({ minimum: 0, maximum: 1440 })),
        status: t.Optional(
          t.Union(
            [t.Literal("ACTIVE"), t.Literal("PAUSED"), t.Literal("BANNED")],
            {
              description:
                "ACTIVE resumes sends, PAUSED holds them (claimed sends wait), BANNED retires the account.",
            },
          ),
        ),
        notes: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
      }),
      detail: doc(
        "Update outreach account",
        "Patch mutable fields, including pausing (status=PAUSED), resuming (ACTIVE) or retiring (BANNED) the account.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .delete(
    "/accounts/:id",
    async ({ tenantContext, params }) => {
      await deleteOutreachAccount(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Delete outreach account",
        "Delete an outreach account and its jobs (cascade).",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  // ── Jobs ──
  .get(
    "/jobs",
    async ({ tenantContext, query }) => {
      const page = await listOutreachJobs(ctxOrThrow(tenantContext), {
        limit: parseQueryCount(query.limit, "limit"),
        cursor: parseQueryId(query.cursor, "cursor"),
        status: parseJobStatus(query.status),
        accountId:
          query.accountId !== undefined
            ? requireDbId(query.accountId, "accountId")
            : undefined,
      });
      return {
        instance: instanceIdentity,
        jobs: page.items,
        nextCursor: page.nextCursor,
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      query: t.Composite([
        pageQuery,
        t.Object({
          status: t.Optional(
            t.String({
              description:
                "Filter by status (QUEUED, APPROVED, SENDING, READY_FOR_MANUAL, SENT, FAILED, CANCELLED).",
            }),
          ),
          accountId: t.Optional(
            t.String({ description: "Restrict to one account's jobs." }),
          ),
        }),
      ]),
      detail: doc(
        "List outreach jobs",
        "Returns a page of outreach jobs (newest first) with their account and lead snippets; use nextCursor to page.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/jobs",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      job: await queueOutreachJob(
        ctxOrThrow(tenantContext),
        body as OutreachJobCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        accountId: t.String({
          description: "Outreach account row id to send from.",
        }),
        leadId: t.String({
          description: "Lead row id to contact.",
        }),
        kind: t.Union(
          [
            t.Literal("GROUP_COMMENT"),
            t.Literal("FRIEND_REQUEST"),
            t.Literal("DM"),
          ],
          {
            description: "GROUP_COMMENT, FRIEND_REQUEST or DM.",
          },
        ),
        body: t.String({
          minLength: 1,
          maxLength: 5000,
          description: "The message text the operator approves.",
        }),
        scheduledAt: t.Optional(
          t.String({
            format: "date-time",
            description:
              "Optional earliest send time; the job is not claimed before it.",
          }),
        ),
      }),
      detail: doc(
        "Queue an outreach job",
        "Create a QUEUED job (never sent until explicitly approved). Refused when the account is banned, when pending jobs plus today's sends already fill the account's dailyCap, or when the same lead/account/kind pair already exists (409).",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .get(
    "/jobs/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      job: await getOutreachJob(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc("Get outreach job", "Fetch a single outreach job."),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/jobs/:id/approve",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      job: await approveOutreachJob(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Approve an outreach job",
        "QUEUED -> APPROVED: the one transition that makes a job sendable. The worker claims approved jobs as they come due.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .post(
    "/jobs/:id/cancel",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      job: await cancelOutreachJob(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Cancel an outreach job",
        "Cancel a job while it is QUEUED, APPROVED or READY_FOR_MANUAL.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .post(
    "/jobs/:id/mark-sent",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      job: await markOutreachJobSent(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Mark a manual job as sent",
        "READY_FOR_MANUAL -> SENT: the operator confirms the manual send happened. Writes the same effects as a transport send (lead -> CONTACTED, outreach.sent audit).",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .post(
    "/jobs/:id/requeue",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      job: await requeueOutreachJob(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Requeue a failed job",
        "FAILED -> QUEUED: a requeue is a new send decision and needs a fresh explicit approval.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  // ── Stats ──
  .get(
    "/stats",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      stats: await outreachStats(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Outreach stats",
        "Account totals by status, today's sends, and job counts by status.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
