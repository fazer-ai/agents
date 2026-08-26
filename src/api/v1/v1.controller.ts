import { Elysia, t } from "elysia";
import { getUserById, verifyPassword } from "@/api/features/auth/auth.service";
import { createInvite } from "@/api/features/invitations/invitation.service";
import { doc, errors } from "@/api/lib/openapi";
import {
  parseQueryCount,
  parseQueryId,
  parseQueryInstant,
  parseQueryText,
} from "@/api/lib/query-filters";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { AppError, ForbiddenError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import { getLangfuseCosts } from "@/modules/analytics/langfuse-costs";
import {
  getInstanceMetrics,
  getKpis,
  getTimeseries,
} from "@/modules/analytics/service";
import { reengageConversation } from "@/modules/conversations/reengage";
import {
  getConversationDetail,
  getConversationMedia,
  getConversationMessages,
  handoffConversation,
  listConversations,
  replyToConversation,
  returnConversationToAgent,
  setConversationStatus,
} from "@/modules/conversations/service";
import {
  createTenant,
  deleteTenant,
  updateTenant,
} from "./tenants.admin.service";
import { getTenant, listTenants, type TenantUpdate } from "./tenants.service";

// The error catalog this controller's routes answer with. `bun i18n:extract` materialises
// src/api/locales/*.json from these lines and prunes anything nothing references, and
// `ErrorTranslationKey` (src/lib/errors.ts) makes a key that is missing here a type error at the
// throw site rather than an English sentence on a pt-BR caller's screen.
// translate('errors.conversationNotFound', 'Conversation not found.')
// translate('errors.reengageNoAgent', 'No agent is bound to the inbox of this conversation.')
// translate('errors.tenantConfirmMismatch', 'The name confirmation does not match.')

// NOTE: requireAuth guarantees a user, and tenancyPlugin derives tenantContext from it, so
// a null context here is an impossible state — throw (handled by onError as 403) rather
// than return an error body, keeping each success response a single shape for the treaty.
function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  return ctx;
}

// Builds the one-time accept link the operator copies/sends (there is no mailer).
function acceptUrl(token: string): string {
  return `${config.publicUrl.replace(/\/$/, "")}/accept-invite?token=${token}`;
}

// Versioned read API. The same surface serves the React UI and (future) fleet dashboard.
// Every response carries instance identity so a fleet can attribute events. Mounted under
// the /api group, so paths are /api/v1/*.
export const v1Controller = new Elysia({ prefix: "/v1" })
  .use(tenancyPlugin)
  .get("/meta", () => ({ instance: instanceIdentity }), {
    requireAuth: true,
    detail: {
      ...doc(
        "Instance metadata",
        "Returns the identity of the instance serving this request.",
      ),
      tags: ["Tenants"],
    },
    response: errors(401),
  })
  .get(
    "/tenants",
    async ({ tenantContext }) => {
      const tenants = await listTenants(ctxOrThrow(tenantContext));
      return { instance: instanceIdentity, tenants };
    },
    {
      requireAuth: true,
      detail: {
        ...doc(
          "List tenants",
          "Returns the tenants visible to the caller within the current tenant context.",
        ),
        tags: ["Tenants"],
      },
      response: errors(401),
    },
  )
  .get(
    "/tenants/:id",
    async ({ tenantContext, params }) => {
      const tenant = await getTenant(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      );
      return { instance: instanceIdentity, tenant };
    },
    {
      params: t.Object({
        id: t.String({
          description: "Tenant id (BigInt serialized as a decimal string).",
        }),
      }),
      requireAuth: true,
      detail: {
        ...doc("Get tenant", "Returns a single tenant by id."),
        tags: ["Tenants"],
      },
      response: errors(400, 401, 404),
    },
  )
  .patch(
    "/tenants/:id",
    async ({ tenantContext, params, body }) => {
      const tenant = await updateTenant(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
        body as TenantUpdate,
      );
      return { instance: instanceIdentity, tenant };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Tenant id (BigInt serialized as a decimal string).",
        }),
      }),
      body: t.Object({
        name: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 200,
            description: "New tenant display name (1 to 200 characters).",
          }),
        ),
      }),
      detail: {
        ...doc("Update tenant", "Updates a tenant's mutable fields by id."),
        tags: ["Tenants"],
      },
      response: errors(400, 401, 403, 404, 422),
    },
  )
  // Permanently delete a tenant and ALL its data (cascade). HARD-gated: SUPER_ADMIN, re-typed tenant
  // name AND the acting user's password. Irreversible.
  .delete(
    "/tenants/:id",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as { confirmName: string; password: string };
      const id = BigInt(params.id);
      const tenant = await getTenant(ctx, id);
      if (b.confirmName.trim() !== tenant.name) {
        throw new AppError(
          "name confirmation does not match",
          400,
          "errors.tenantConfirmMismatch",
        );
      }
      const user = ctx.userId ? await getUserById(ctx.userId) : null;
      if (
        !user?.passwordHash ||
        !(await verifyPassword(b.password, user.passwordHash))
      ) {
        throw new AppError("Incorrect password", 403, "errors.invalidPassword");
      }
      await deleteTenant(ctx, id);
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "SUPER_ADMIN",
      params: t.Object({
        id: t.String({
          description: "Tenant id (BigInt serialized as a decimal string).",
        }),
      }),
      body: t.Object({
        confirmName: t.String({
          description: "The tenant name, re-typed to confirm.",
        }),
        password: t.String({
          minLength: 1,
          description: "The acting user's password (step-up confirmation).",
        }),
      }),
      detail: {
        ...doc(
          "Delete tenant",
          "Permanently delete a tenant and all its data (cascade). SUPER_ADMIN only; requires re-typing the tenant name and the current password.",
        ),
        tags: ["Tenants"],
      },
      response: errors(400, 401, 403, 404, 422),
    },
  )
  // SUPER_ADMIN provisions a tenant; with adminEmail it also issues the first TENANT_ADMIN invite
  // (the new-tenant + first-user journey in one call), returning the one-time accept link.
  .post(
    "/tenants",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const tenant = await createTenant(ctx, {
        name: body.name,
        slug: body.slug,
      });
      let invite:
        | { email: string; role: string; acceptUrl: string; expiresAt: Date }
        | undefined;
      if (body.adminEmail) {
        const created = await createInvite({
          tenantId: BigInt(tenant.id),
          email: body.adminEmail,
          role: "TENANT_ADMIN",
          invitedById: ctx.userId,
        });
        invite = {
          email: created.email,
          role: created.role,
          acceptUrl: acceptUrl(created.token),
          expiresAt: created.expiresAt,
        };
      }
      return { instance: instanceIdentity, tenant, invite };
    },
    {
      requireRole: "SUPER_ADMIN",
      body: t.Object({
        name: t.String({
          minLength: 1,
          maxLength: 200,
          description: "Tenant display name (1 to 200 characters).",
        }),
        slug: t.String({
          minLength: 1,
          maxLength: 100,
          description:
            "Stable URL/DNS-safe identifier; must be unique across the fleet.",
        }),
        adminEmail: t.Optional(
          t.String({
            format: "email",
            maxLength: 254,
            description:
              "Optional email for the first TENANT_ADMIN invite, issued in the same call.",
          }),
        ),
      }),
      detail: {
        ...doc(
          "Create tenant",
          "Provisions a new tenant and, when adminEmail is given, issues the first TENANT_ADMIN invite and returns its accept link.",
        ),
        tags: ["Tenants"],
      },
      response: errors(400, 401, 403, 409, 422),
    },
  )
  .get(
    "/conversations",
    async ({ tenantContext, query }) => {
      const page = await listConversations(ctxOrThrow(tenantContext), {
        status: query.status,
        limit: parseQueryCount(query.limit, "limit"),
        cursor: parseQueryId(query.cursor, "cursor"),
        q: parseQueryText(query.q, "q"),
      });
      return {
        instance: instanceIdentity,
        conversations: page.items,
        nextCursor: page.nextCursor,
      };
    },
    {
      query: t.Object({
        status: t.Optional(
          t.String({
            description:
              "Optional Chatwoot conversation status filter (e.g. open, pending, resolved).",
          }),
        ),
        limit: t.Optional(
          t.String({
            description:
              "Optional max number of conversations to return, parsed as an integer.",
          }),
        ),
        cursor: t.Optional(
          t.String({
            description:
              "Keyset cursor: the id of the last item from the previous page; returns the next page.",
          }),
        ),
        q: t.Optional(
          t.String({
            description:
              "Optional free-text search matched against the contact name or the Chatwoot conversation id.",
          }),
        ),
      }),
      requireAuth: true,
      detail: {
        ...doc(
          "List conversations",
          "Returns a page of the tenant's conversations (newest first), optionally filtered by status and free-text search; use nextCursor to page.",
        ),
        tags: ["Conversations"],
      },
      response: errors(400, 401, 404),
    },
  )
  .get(
    "/conversations/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      conversation: await getConversationDetail(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      ),
    }),
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          description:
            "Conversation primary key (BigInt serialized as a decimal string), not the Chatwoot display id.",
        }),
      }),
      detail: {
        ...doc(
          "Get conversation",
          "Returns the conversation metadata shell by primary key, without the live message thread.",
        ),
        tags: ["Conversations"],
      },
      response: errors(400, 401, 404),
    },
  )
  // Separate from the metadata above so the slow live thread fetch only blocks the messages area.
  .get(
    "/conversations/:id/messages",
    async ({ tenantContext, params, query }) => {
      const before = parseQueryCount(query.before, "before");
      return {
        instance: instanceIdentity,
        ...(await getConversationMessages(
          ctxOrThrow(tenantContext),
          BigInt(params.id),
          {},
          undefined,
          before,
        )),
      };
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          description:
            "Conversation primary key (BigInt serialized as a decimal string).",
        }),
      }),
      query: t.Object({
        before: t.Optional(
          t.String({
            description:
              "Page backwards: return messages older than this Chatwoot message id (the console's 'load older' on scroll-up). Omit for the most recent page.",
          }),
        ),
      }),
      detail: {
        ...doc(
          "Get conversation messages",
          "Fetches the live message thread from Chatwoot; degrades to an empty thread flagged unavailable when the instance is unreachable. Use ?before=<message_id> to page backwards.",
        ),
        tags: ["Conversations"],
      },
      response: errors(400, 401, 404),
    },
  )
  // Streams an attachment (voice note / image / file) through our origin so it plays/renders under a
  // strict CSP and carries the SUPER_ADMIN tenant selector. The bytes live on the tenant's Chatwoot;
  // the url is origin-locked to that instance (getConversationMedia) so this is never an open proxy.
  .get(
    "/conversations/:id/media",
    async ({ tenantContext, params, query, set }) => {
      const blob = await getConversationMedia(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
        query.url,
      );
      if (!blob) {
        set.status = 404;
        return { error: "Not Found" };
      }
      return new Response(blob.bytes, {
        headers: {
          "content-type": blob.contentType,
          "cache-control": "private, max-age=3600",
        },
      });
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          description:
            "Conversation primary key (BigInt serialized as a decimal string).",
        }),
      }),
      query: t.Object({
        url: t.String({
          description:
            "The attachment data_url to proxy; must be on the conversation's Chatwoot instance origin.",
        }),
      }),
      detail: {
        ...doc(
          "Stream conversation media",
          "Proxies a conversation attachment (voice note, image, or file) from the tenant's Chatwoot through our origin for CSP-clean in-app playback.",
        ),
        tags: ["Conversations"],
      },
      response: errors(400, 401, 404, 422),
    },
  )
  .post(
    "/conversations/:id/reply",
    async ({ tenantContext, params, body }) => {
      await replyToConversation(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
        body.content,
        body.private ?? false,
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          description:
            "Conversation primary key (BigInt serialized as a decimal string).",
        }),
      }),
      body: t.Object({
        content: t.String({
          minLength: 1,
          maxLength: 50_000,
          description: "Message body to send (1 to 50000 characters).",
        }),
        private: t.Optional(
          t.Boolean({
            description:
              "When true, posts a private note visible only to agents instead of a customer-facing reply.",
          }),
        ),
      }),
      detail: {
        ...doc(
          "Reply to conversation",
          "Posts a message to the conversation as a public reply or a private note.",
        ),
        tags: ["Conversations"],
      },
      response: errors(400, 401, 404, 422),
    },
  )
  .post(
    "/conversations/:id/handoff",
    async ({ tenantContext, params, body }) => {
      await handoffConversation(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
        body.assigneeId ?? null,
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          description:
            "Conversation primary key (BigInt serialized as a decimal string).",
        }),
      }),
      body: t.Object({
        assigneeId: t.Optional(
          t.Integer({
            description:
              "Chatwoot agent id to assign; omit to hand off without assigning a specific human.",
          }),
        ),
      }),
      detail: {
        ...doc(
          "Hand off conversation",
          "Optionally assigns a human agent and sets the conversation open so the bot stops handling it.",
        ),
        tags: ["Conversations"],
      },
      response: errors(400, 401, 404, 422),
    },
  )
  .post(
    "/conversations/:id/return",
    async ({ tenantContext, params }) => {
      const outcome = await returnConversationToAgent(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      );
      // The call succeeded either way — the conversation is pending and the mirror is correct. The
      // outcome says whether the unassign happened, because "taken-over" means a human claimed it
      // mid-request and still holds it, and a bare success would read as the agent having it back.
      return { instance: instanceIdentity, success: true, outcome };
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          description:
            "Conversation primary key (BigInt serialized as a decimal string).",
        }),
      }),
      detail: {
        ...doc(
          "Return conversation to agent",
          "Reassigns the conversation back to the bot so it resumes handling.",
        ),
        tags: ["Conversations"],
      },
      response: errors(400, 401, 404),
    },
  )
  .post(
    "/conversations/:id/reengage",
    async ({ tenantContext, params }) => {
      const { outcome } = await reengageConversation(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      );
      return { instance: instanceIdentity, outcome };
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          description:
            "Conversation primary key (BigInt serialized as a decimal string).",
        }),
      }),
      detail: {
        ...doc(
          "Reengage conversation",
          "Triggers a proactive follow-up turn on the conversation and reports the outcome.",
        ),
        tags: ["Conversations"],
      },
      response: errors(400, 401, 404),
    },
  )
  .post(
    "/conversations/:id/status",
    async ({ tenantContext, params, body }) => {
      await setConversationStatus(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
        body.status,
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({
          description:
            "Conversation primary key (BigInt serialized as a decimal string).",
        }),
      }),
      body: t.Object({
        status: t.Union(
          [t.Literal("open"), t.Literal("pending"), t.Literal("resolved")],
          {
            description:
              "Target Chatwoot conversation status: open, pending, or resolved.",
          },
        ),
      }),
      detail: {
        ...doc(
          "Set conversation status",
          "Sets the conversation status to open, pending, or resolved.",
        ),
        tags: ["Conversations"],
      },
      response: errors(400, 401, 404, 422),
    },
  )
  .get(
    "/metrics",
    async ({ tenantContext, query }) => {
      const since = parseQueryInstant(query.since, "since");
      const metrics = await getInstanceMetrics(ctxOrThrow(tenantContext), {
        since,
        source: query.source,
      });
      return { instance: instanceIdentity, metrics };
    },
    {
      query: t.Object({
        since: t.Optional(
          t.String({
            description:
              "Optional ISO start instant (2026-01-01T00:00:00Z). A value that is not one is refused with a 400 naming the parameter.",
          }),
        ),
        // Usage segment: "inbox" (real) | "playground". Omitted → all sources.
        source: t.Optional(
          t.Union([t.Literal("inbox"), t.Literal("playground")], {
            description:
              "Usage segment to scope the metrics: inbox (real traffic) or playground; omit for all sources.",
          }),
        ),
      }),
      requireAuth: true,
      detail: {
        ...doc(
          "Instance metrics",
          "Returns aggregate instance metrics since an optional start time, scoped by usage source.",
        ),
        tags: ["Dashboard"],
      },
      response: errors(400, 401, 404, 422),
    },
  )
  .get(
    "/metrics/kpis",
    async ({ tenantContext, query }) => {
      const since = parseQueryInstant(query.since, "since");
      const kpis = await getKpis(ctxOrThrow(tenantContext), {
        since,
      });
      return { instance: instanceIdentity, kpis };
    },
    {
      query: t.Object({
        since: t.Optional(
          t.String({
            description:
              "Optional ISO start instant (2026-01-01T00:00:00Z). A value that is not one is refused with a 400 naming the parameter.",
          }),
        ),
      }),
      requireAuth: true,
      detail: {
        ...doc(
          "Dashboard KPIs",
          "Returns the headline dashboard KPIs since an optional start time.",
        ),
        tags: ["Dashboard"],
      },
      response: errors(400, 401, 404),
    },
  )
  .get(
    "/metrics/timeseries",
    async ({ tenantContext, query }) => {
      const since = parseQueryInstant(query.since, "since");
      const points = await getTimeseries(ctxOrThrow(tenantContext), {
        since,
        source: query.source,
        tz: query.tz,
      });
      return { instance: instanceIdentity, points };
    },
    {
      query: t.Object({
        since: t.Optional(
          t.String({
            description:
              "Optional ISO start instant (2026-01-01T00:00:00Z). A value that is not one is refused with a 400 naming the parameter.",
          }),
        ),
        source: t.Optional(
          t.Union([t.Literal("inbox"), t.Literal("playground")], {
            description:
              "Usage segment to scope the series: inbox (real traffic) or playground; omit for all sources.",
          }),
        ),
        tz: t.Optional(
          t.String({
            description:
              "IANA timezone (e.g. America/Sao_Paulo) used to bucket days; invalid values fall back to UTC.",
          }),
        ),
      }),
      requireAuth: true,
      detail: {
        ...doc(
          "Metrics timeseries",
          "Returns a timeseries of instance metrics since an optional start time, scoped by usage source.",
        ),
        tags: ["Dashboard"],
      },
      response: errors(400, 401, 404, 422),
    },
  )
  .get(
    "/metrics/costs",
    async ({ tenantContext, query }) => {
      const since = parseQueryInstant(query.since, "since");
      const costs = await getLangfuseCosts(ctxOrThrow(tenantContext), {
        since,
      });
      return { instance: instanceIdentity, costs };
    },
    {
      query: t.Object({
        since: t.Optional(
          t.String({
            description:
              "Optional ISO start instant (2026-01-01T00:00:00Z). A value that is not one is refused with a 400 naming the parameter.",
          }),
        ),
      }),
      requireAuth: true,
      detail: {
        ...doc(
          "Cost metrics",
          "Returns Langfuse-derived cost metrics for the tenant since an optional start time.",
        ),
        tags: ["Dashboard"],
      },
      response: errors(400, 401, 404),
    },
  );
