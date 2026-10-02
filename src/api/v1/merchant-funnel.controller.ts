import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import {
  parseQueryCount,
  parseQueryId,
} from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import {
  AppError,
  ForbiddenError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  createBroadcast,
  getBroadcast,
  listBroadcasts,
  sendBroadcast,
  updateBroadcast,
  type BroadcastCreate,
  type BroadcastUpdate,
} from "@/modules/funnel/broadcasts";
import {
  setRecipientStatus,
  type RecipientPatch,
} from "@/modules/funnel/recipients";
import {
  approveReplyDraft,
  createReplyDraft,
  listReplyDrafts,
  markReplyDraftSent,
  rejectReplyDraft,
  type ReplyDraftCreate,
  type ReplyDraftUpdate,
  updateReplyDraft,
} from "@/modules/funnel/drafts";
import { LEAD_STATUSES } from "@/modules/merchant/leads";

// The error catalog this controller's routes answer with (`bun i18n:extract` reads these lines).
// translate('errors.merchantLeadNotFound', 'Lead not found.')
// translate('errors.merchantDraftNotFound', 'Reply draft not found.')
// translate('errors.merchantDraftBadTransition', 'This draft cannot move from {{from}} to {{to}}.')
// translate('errors.merchantDraftGenerateFailed', 'The draft generator did not return a usable reply.')
// translate('errors.merchantBroadcastNotFound', 'Broadcast not found.')
// translate('errors.merchantBroadcastNotEditable', 'A sent broadcast can no longer be edited.')

// Merchant funnel (phase 2): per-lead reply drafts + the broadcast composer.
// Human-in-the-loop rails only - nothing posts outward; SENT means the
// operator copied the text to the platform by hand. Reads any member; writes
// TENANT_ADMIN. Separate file from merchant.controller.ts to keep diffs small.

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

const recipientParams = t.Object({
  id: t.String({ description: "Broadcast id (BigInt as decimal string)." }),
  rid: t.String({ description: "Recipient id (BigInt as decimal string)." }),
});

const audienceFilterBody = t.Object(
  {
    tags: t.Optional(
      t.Array(t.String({ minLength: 1, maxLength: 100 }), {
        maxItems: 50,
        description:
          "Keep leads matched to a product carrying ANY of these tags.",
      }),
    ),
    minScore: t.Optional(
      t.Integer({
        minimum: 0,
        maximum: 1000,
        description: "Minimum lead score (the rule-based scorer's 0-100).",
      }),
    ),
    status: t.Optional(
      t.Union([
        t.Union(LEAD_STATUSES.map((s) => t.Literal(s)), {
          description: "One funnel stage.",
        }),
        t.Array(t.Union(LEAD_STATUSES.map((s) => t.Literal(s))), {
          maxItems: 5,
          description: "…or several funnel stages.",
        }),
      ]),
    ),
  },
  {
    description:
      "Audience selector resolved once at create. Omitting status targets the active funnel (NEW, CONTACTED, QUALIFIED).",
  },
);

export const merchantFunnelController = new Elysia({
  prefix: "/v1/merchant",
  tags: ["Merchant"],
})
  .use(tenancyPlugin)
  // ---- reply drafts -------------------------------------------------------
  .get(
    "/leads/:id/drafts",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      drafts: await listReplyDrafts(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireAuth: true,
      params: idParam,
      detail: doc(
        "List a lead's reply drafts",
        "Every draft written for this lead, newest first, with status (DRAFT/APPROVED/SENT/REJECTED).",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/leads/:id/drafts",
    async ({ tenantContext, params, body }) => {
      const outcome = await createReplyDraft(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as ReplyDraftCreate,
      );
      if (!outcome.ok) {
        throw new AppError(
          outcome.detail
            ? `The draft generator did not return a usable reply (${outcome.detail}).`
            : "The draft generator did not return a usable reply.",
          502,
          "errors.merchantDraftGenerateFailed",
        );
      }
      return { instance: instanceIdentity, draft: outcome.draft };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      body: t.Object({
        kind: t.Union(
          [t.Literal("PUBLIC_REPLY"), t.Literal("DM_OPENER")],
          {
            description:
              "PUBLIC_REPLY: a comment under the lead's post. DM_OPENER: the first private message; approving/sending it moves a NEW lead to CONTACTED.",
          },
        ),
        body: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 4000,
            description:
              "Operator-written copy; when sent, the gateway is skipped and this becomes the draft.",
          }),
        ),
        note: t.Optional(
          t.String({
            maxLength: 1000,
            description:
              "Extra steering for the generator (e.g. 'mention the freeship offer'); folded into the prompt, never stored.",
          }),
        ),
      }),
      detail: doc(
        "Create a reply draft",
        "Drafts an outreach message for one lead. Without `body` the local LLM gateway writes Vietnamese sales copy from the lead text + matched products; a human always approves before anything is copied out.",
      ),
      response: errors(400, 401, 403, 404, 422, 502),
    },
  )
  .patch(
    "/drafts/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      draft: await updateReplyDraft(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as ReplyDraftUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      body: t.Object({
        body: t.String({
          minLength: 1,
          maxLength: 4000,
          description: "Replacement message text; DRAFT rows only.",
        }),
      }),
      detail: doc(
        "Edit a reply draft",
        "Replaces the draft body. Only possible while the draft is still DRAFT.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .post(
    "/drafts/:id/approve",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      draft: await approveReplyDraft(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Approve a reply draft",
        "DRAFT -> APPROVED. Approving a DM_OPENER moves a NEW lead to CONTACTED.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .post(
    "/drafts/:id/reject",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      draft: await rejectReplyDraft(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Reject a reply draft",
        "DRAFT or APPROVED -> REJECTED. The row is kept for the audit trail.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .post(
    "/drafts/:id/mark-sent",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      draft: await markReplyDraftSent(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Mark a draft sent",
        "APPROVED -> SENT, recording sentAt. SENT is the operator's mark that they copied the text to the platform; nothing posts outward.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  // ---- broadcasts ---------------------------------------------------------
  .get(
    "/broadcasts",
    async ({ tenantContext, query }) => {
      const page = await listBroadcasts(ctxOrThrow(tenantContext), {
        limit: parseQueryCount(query.limit, "limit"),
        cursor: parseQueryId(query.cursor, "cursor"),
      });
      return {
        instance: instanceIdentity,
        broadcasts: page.items,
        nextCursor: page.nextCursor,
      };
    },
    {
      requireAuth: true,
      query: t.Object({
        limit: t.Optional(
          t.String({
            description:
              "Optional max number of items to return, parsed as an integer.",
          }),
        ),
        cursor: t.Optional(
          t.String({
            description:
              "Keyset cursor: the id of the last item from the previous page.",
          }),
        ),
      }),
      detail: doc(
        "List broadcasts",
        "Broadcast compositions (newest first) with resolved recipient counts.",
      ),
      response: errors(400, 401, 403),
    },
  )
  .post(
    "/broadcasts",
    async ({ tenantContext, body }) => ({
      instance: instanceIdentity,
      broadcast: await createBroadcast(
        ctxOrThrow(tenantContext),
        body as BroadcastCreate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 200 }),
        body: t.String({
          minLength: 1,
          maxLength: 4000,
          description:
            "Message template; tokens {{authorName}}, {{authorHandle}}, {{platform}}, {{groupName}} resolve per recipient.",
        }),
        audienceFilter: t.Optional(audienceFilterBody),
      }),
      detail: doc(
        "Create a broadcast",
        "Resolves the audience filter into recipient rows (best score first, capped at 500) and renders each one's message body. The send itself is manual: the operator copies each body out.",
      ),
      response: errors(400, 401, 403, 422),
    },
  )
  .get(
    "/broadcasts/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      broadcast: await getBroadcast(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireAuth: true,
      params: idParam,
      detail: doc(
        "Get a broadcast",
        "The broadcast plus every resolved recipient row (lead snapshot + rendered body + per-recipient status).",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .patch(
    "/broadcasts/:id",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      broadcast: await updateBroadcast(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        body as BroadcastUpdate,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        body: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 4000,
            description:
              "New template; re-renders every still-PENDING recipient body and returns the broadcast to DRAFT for re-review.",
          }),
        ),
        status: t.Optional(
          t.Union([t.Literal("DRAFT"), t.Literal("READY")], {
            description: "The review gate: DRAFT <-> READY.",
          }),
        ),
      }),
      detail: doc(
        "Update a broadcast",
        "Edit name/body or move DRAFT <-> READY. A SENT broadcast is the record of what went out and no longer changes.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  )
  .post(
    "/broadcasts/:id/send",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      broadcast: await sendBroadcast(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: idParam,
      detail: doc(
        "Send a broadcast",
        "Marks every PENDING recipient SENT and closes the broadcast. There is no outward transport: the human copies each rendered body to the platform (the zca-bridge / Zalo OA rail plugs in here).",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .patch(
    "/broadcasts/:id/recipients/:rid",
    async ({ tenantContext, params, body }) => ({
      instance: instanceIdentity,
      broadcast: await setRecipientStatus(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
        requireDbId(params.rid, "rid"),
        body as RecipientPatch,
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: recipientParams,
      body: t.Object({
        status: t.Union(
          [t.Literal("PENDING"), t.Literal("SENT"), t.Literal("FAILED")],
          {
            description:
              "Per-recipient bookkeeping as the operator works the list by hand.",
          },
        ),
        error: t.Optional(
          t.String({
            maxLength: 500,
            description: "Why a manual send failed (stored on the recipient).",
          }),
        ),
      }),
      detail: doc(
        "Mark a broadcast recipient",
        "Set one recipient PENDING/SENT/FAILED. When no PENDING rows remain the broadcast reads as SENT.",
      ),
      response: errors(400, 401, 403, 404, 409, 422),
    },
  );
