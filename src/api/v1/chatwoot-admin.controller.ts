import { Elysia, t } from "elysia";
import { getUserById, verifyPassword } from "@/api/features/auth/auth.service";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { requireDbId } from "@/lib/db-id";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  bindInbox,
  connectChatwootDeployment,
  disconnectChatwootDeployment,
  getChatwootDeployment,
  getChatwootInstance,
  getWidgetInboxHealth,
  listAgentsAndTeams,
  listDeploymentAccounts,
  listInboxCustomAttributes,
  listInboxes,
  listInboxLabels,
  listServiceWindowTemplates,
  reconcileInboxBots,
  reconnectChatwootInstance,
  reconnectInbox,
  removeChatwootInstance,
  removeInbox,
  rotateChatwootDeploymentToken,
  setConnectedAccounts,
  softDisconnectChatwootInstance,
  syncInboxes,
} from "@/modules/chatwoot/management";

// The error catalog this controller's routes answer with. `bun i18n:extract` materialises
// src/api/locales/*.json from these lines and prunes anything nothing references, and
// `ErrorTranslationKey` (src/lib/errors.ts) makes a key that is missing here a type error at the
// throw site rather than an English sentence on a pt-BR caller's screen.
// translate('errors.chatwootAccountDisconnected', 'This account is disconnected. Reconnect it before assigning an agent.')
// translate('errors.chatwootAccountTaken', 'This Chatwoot account is already connected to another tenant; one account belongs to a single tenant.')
// NOTE: the bind and the REbind refuse differently, and so do the two confirmations. One key per
// pair would answer "the confirmation does not match" to someone who typed the domain, with no
// way to tell which of the two fields they got wrong.
// translate('errors.chatwootBindFailed', 'The bot could not be synced with Chatwoot.')
// translate('errors.chatwootDomainConfirmMismatch', 'The domain confirmation does not match.')
// translate('errors.chatwootNameConfirmMismatch', 'The name confirmation does not match.')
// translate('errors.chatwootRebindFailed', 'The bot could not be reconnected to Chatwoot.')
// translate('errors.chatwootDeploymentNotFound', 'No Chatwoot deployment is connected.')
// translate('errors.chatwootDifferentDeployment', 'This tenant is already connected to a different Chatwoot deployment. Disconnect it first to switch servers.')
// translate('errors.chatwootInstanceNotFound', 'Chatwoot instance not found.')
// translate('errors.chatwootProfileFailed', 'Chatwoot could not be reached with the URL and token provided.')
// translate('errors.inboxNotBound', 'This inbox has no agent to reconnect.')
// translate('errors.inboxNotFound', 'Inbox not found.')
// translate('errors.inboxStillExists', 'This inbox still exists in Chatwoot. Delete it there first.')
// translate('errors.chatwootInboxProbeFailed', 'Could not confirm with Chatwoot that this inbox was deleted.')

// Chatwoot instance + inbox management (per-tenant). TENANT_ADMIN. SEPARATE from the public webhook
// receiver controller (same /v1/chatwoot prefix; no path overlap: /instances* + /inboxes* here vs
// /webhook/:routeToken there). Tokens are write-only — never returned. The inbox→agent binding is
// the load-bearing route: it decides which agent answers which inbox.

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const chatwootAdminController = new Elysia({
  prefix: "/v1/chatwoot",
  tags: ["Channels"],
})
  .use(tenancyPlugin)
  // The tenant's single Chatwoot deployment (base URL + shared token) and its accounts. This is the
  // primary read for the Channels screen: the connection is registered once, accounts hang off it.
  .get(
    "/deployment",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      ...(await getChatwootDeployment(ctxOrThrow(tenantContext))),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Get Chatwoot deployment",
        "The tenant's Chatwoot deployment (base URL; admin-token presence) and its accounts. `deployment` is null when none is connected yet.",
      ),
      response: errors(401, 403, 404),
    },
  )
  // Register the deployment from a base URL + admin token, entered ONCE. Validates the credentials by
  // probing /profile and returns the reachable accounts for the pick-list. A second, different base
  // URL is rejected (one deployment per tenant); the same base URL refreshes the stored token.
  .post(
    "/deployment",
    async ({ tenantContext, body }) => {
      const b = body as { baseUrl: string; adminToken: string };
      return {
        instance: instanceIdentity,
        ...(await connectChatwootDeployment(ctxOrThrow(tenantContext), {
          baseUrl: b.baseUrl,
          adminToken: b.adminToken,
        })),
      };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Connect Chatwoot deployment",
        "Register the tenant's Chatwoot deployment (base URL + admin token, entered once). Validates the credentials and returns the accounts they can reach.",
      ),
      body: t.Object({
        baseUrl: t.String({
          description: "Base URL of the Chatwoot installation.",
        }),
        adminToken: t.String({
          minLength: 1,
          description:
            "Chatwoot admin/user access token; encrypted at rest, never returned.",
        }),
      }),
      response: errors(400, 401, 403, 404, 409, 422, 502),
    },
  )
  // Rotate the deployment's admin token (validated against the live deployment before it persists).
  .patch(
    "/deployment",
    async ({ tenantContext, body }) => {
      const b = body as { adminToken: string };
      return {
        instance: instanceIdentity,
        deployment: await rotateChatwootDeploymentToken(
          ctxOrThrow(tenantContext),
          b.adminToken,
        ),
      };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Rotate deployment token",
        "Replace the deployment's admin token. Affects every account under it.",
      ),
      body: t.Object({
        adminToken: t.String({
          minLength: 1,
          description: "New admin token; encrypted at rest, never returned.",
        }),
      }),
      response: errors(400, 401, 403, 404, 422, 502),
    },
  )
  // Tear down the whole Chatwoot connection (the "switch servers" path): wipes the local mirror
  // (accounts/conversations/inboxes/bots/contacts). HARD-gated: SUPER_ADMIN only, the operator must
  // re-type the deployment domain AND confirm with their password (step-up). Irreversible.
  .delete(
    "/deployment",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as { confirmDomain: string; password: string };
      const { deployment } = await getChatwootDeployment(ctx);
      if (!deployment) {
        throw new NotFoundError(
          "no chatwoot deployment connected",
          "errors.chatwootDeploymentNotFound",
        );
      }
      let host = "";
      try {
        host = new URL(deployment.baseUrl).host;
      } catch {
        host = deployment.baseUrl;
      }
      if (b.confirmDomain.trim() !== host) {
        throw new AppError(
          "domain confirmation does not match",
          400,
          "errors.chatwootDomainConfirmMismatch",
        );
      }
      const user = ctx.userId ? await getUserById(ctx.userId) : null;
      if (
        !user?.passwordHash ||
        !(await verifyPassword(b.password, user.passwordHash))
      ) {
        throw new AppError("Incorrect password", 403, "errors.invalidPassword");
      }
      await disconnectChatwootDeployment(ctx);
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Disconnect Chatwoot deployment",
        "Irreversibly disconnect the tenant's Chatwoot and wipe its local mirror (to switch servers). SUPER_ADMIN only; requires re-typing the domain and the current password.",
      ),
      body: t.Object({
        confirmDomain: t.String({
          description: "The deployment host, re-typed to confirm.",
        }),
        password: t.String({
          minLength: 1,
          description: "The acting user's password (step-up confirmation).",
        }),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  // Re-list the accounts the deployment's STORED token can reach (for the "manage accounts" editor —
  // no token re-entry). 502 when Chatwoot is unreachable.
  .get(
    "/deployment/accounts",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      accounts: await listDeploymentAccounts(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "List reachable accounts",
        "List the accounts the deployment's stored token can reach (no token re-entry).",
      ),
      response: errors(400, 401, 403, 404, 502),
    },
  )
  // Apply the operator's account selection as a diff: newly-selected accounts are connected (+ inboxes
  // synced), de-selected active ones are soft-disconnected (history kept).
  .put(
    "/deployment/accounts",
    async ({ tenantContext, body }) => {
      const b = body as { accountIds: number[] };
      return {
        instance: instanceIdentity,
        accounts: await setConnectedAccounts(
          ctxOrThrow(tenantContext),
          b.accountIds,
        ),
      };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Set connected accounts",
        "Connect the selected accounts (syncing their inboxes) and soft-disconnect the de-selected ones, keeping their history.",
      ),
      body: t.Object({
        accountIds: t.Array(t.Integer(), {
          description: "The Chatwoot account ids that should be connected.",
        }),
      }),
      response: errors(400, 401, 403, 404, 422, 502),
    },
  )
  .delete(
    "/instances/:id",
    async ({ tenantContext, params }) => {
      await softDisconnectChatwootInstance(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Disconnect Chatwoot account",
        "Soft-disconnect a Chatwoot account: unbind its inboxes' agents and stop handling its traffic, keeping the conversations/analytics rows for history. Reconnect to resume.",
      ),
      params: t.Object({
        id: t.String({ description: "Chatwoot instance id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/instances/:id/reconnect",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      result: await reconnectChatwootInstance(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Reconnect Chatwoot account",
        "Clear a soft-disconnected account's disconnect flag so it resumes handling traffic. Re-bind agents to its inboxes afterward.",
      ),
      params: t.Object({
        id: t.String({ description: "Chatwoot instance id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  // HARD-remove an account (the "move account to another tenant" path): wipes its local mirror,
  // freeing the (server, account) slot for another tenant. HARD-gated: SUPER_ADMIN, re-typed account
  // name (or id) AND the acting user's password. Irreversible.
  .post(
    "/instances/:id/remove",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const b = body as { confirmName: string; password: string };
      const id = requireDbId(params.id);
      const instance = await getChatwootInstance(ctx, id);
      const expected = instance.accountName ?? String(instance.accountId);
      if (b.confirmName.trim() !== expected) {
        throw new AppError(
          "name confirmation does not match",
          400,
          "errors.chatwootNameConfirmMismatch",
        );
      }
      const user = ctx.userId ? await getUserById(ctx.userId) : null;
      if (
        !user?.passwordHash ||
        !(await verifyPassword(b.password, user.passwordHash))
      ) {
        throw new AppError("Incorrect password", 403, "errors.invalidPassword");
      }
      await removeChatwootInstance(ctx, id);
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Remove Chatwoot account",
        "Permanently remove an account from this tenant (wipes its local mirror), freeing it to be assigned to another tenant. SUPER_ADMIN only; requires re-typing the account name and the current password.",
      ),
      params: t.Object({
        id: t.String({ description: "Chatwoot instance id (BigInt string)." }),
      }),
      body: t.Object({
        confirmName: t.String({
          description: "The account name (or its id), re-typed to confirm.",
        }),
        password: t.String({
          minLength: 1,
          description: "The acting user's password (step-up confirmation).",
        }),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .post(
    "/instances/:id/sync-inboxes",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      result: await syncInboxes(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Sync inboxes",
        "Pull the inbox list from Chatwoot into the local mirror.",
      ),
      params: t.Object({
        id: t.String({ description: "Chatwoot instance id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  .get(
    "/inboxes",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      inboxes: await listInboxes(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List inboxes",
        "List the tenant's mirrored Chatwoot inboxes.",
      ),
      response: errors(401, 403, 404),
    },
  )
  // Live per-inbox bot status for the Channels UI: each bound inbox → "active" | "missing" (its
  // persona bot still exists on Chatwoot, or was deleted out-of-band). Read-only/best-effort; an
  // unreachable instance simply omits its inboxes (the client shows them as unverified).
  .get(
    "/inboxes/bot-status",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      statuses: await reconcileInboxBots(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Reconcile inbox bot status",
        "Per bound inbox, whether its persona's Chatwoot Agent Bot still exists (active) or was deleted out-of-band (missing).",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  // Live health of a web-widget inbox's website_url (the WhatsApp→website-chat redirect target), so
  // the editor's Redirect tab can warn when the configured URL is missing/invalid instead of failing
  // silently. Read-only; a scheme-less URL is reported "recovered" (the runtime repairs it).
  .get(
    "/inboxes/:id/widget-health",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      ...(await getWidgetInboxHealth(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      )),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Web-widget inbox health",
        "For a web-widget inbox, the website_url set on Chatwoot and whether it is a valid redirect target (ok | recovered | invalid | missing | unknown). `unknown` means Chatwoot was unreachable, so the URL could not be verified (no false alert).",
      ),
      params: t.Object({
        id: t.String({ description: "Mirror inbox id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  // Live agents + teams for the handoff-targeting picker, scoped to the accounts the agent serves
  // (via its bound inboxes). `accounts` lists those accounts: 0 ⇒ no inbox bound, 1 ⇒ agents/teams
  // populated from that account, ≥2 ⇒ ambiguous (pinned disabled in the editor). Agents/teams are
  // account-scoped, so a pinned target only makes sense within a single account.
  .get(
    "/agents-teams/:agentId",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      ...(await listAgentsAndTeams(
        ctxOrThrow(tenantContext),
        requireDbId(params.agentId, "agentId"),
      )),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List agents and teams",
        "Read live agents and teams from the accounts an agent serves (for handoff targeting).",
      ),
      params: t.Object({
        agentId: t.String({ description: "Agent id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  // Approved WhatsApp HSM templates available to an agent's inbox(es), for the service-window
  // template picker. Empty for baileys inboxes (no HSM) → the editor keeps a free-text field.
  .get(
    "/service-window-templates/:agentId",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      ...(await listServiceWindowTemplates(
        ctxOrThrow(tenantContext),
        requireDbId(params.agentId, "agentId"),
      )),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List service-window templates",
        "List approved WhatsApp HSM templates for an agent's inboxes.",
      ),
      params: t.Object({
        agentId: t.String({ description: "Agent id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  // Account labels available to an agent's inbox(es), for the follow-up step's label picker. Empty
  // when no inbox is bound or Chatwoot is unreachable → the editor keeps a free-text field.
  .get(
    "/labels/:agentId",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      ...(await listInboxLabels(
        ctxOrThrow(tenantContext),
        requireDbId(params.agentId, "agentId"),
      )),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List inbox labels",
        "List Chatwoot account labels available to an agent's inboxes.",
      ),
      params: t.Object({
        agentId: t.String({ description: "Agent id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  // NOTE: Custom-attribute definitions available to an agent's inbox(es), for the attribute-context
  // picker. Empty when no inbox is bound or Chatwoot is unreachable → the editor keeps free text.
  .get(
    "/custom-attributes/:agentId",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      ...(await listInboxCustomAttributes(
        ctxOrThrow(tenantContext),
        requireDbId(params.agentId, "agentId"),
      )),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List custom attribute definitions",
        "List Chatwoot custom attribute definitions available to an agent's inboxes.",
      ),
      params: t.Object({
        agentId: t.String({ description: "Agent id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404),
    },
  )
  .patch(
    "/inboxes/:id",
    async ({ tenantContext, params, body }) => {
      const b = body as { agentId?: string | null };
      const agentId =
        b.agentId === undefined || b.agentId === null
          ? null
          : BigInt(b.agentId);
      return {
        instance: instanceIdentity,
        inbox: await bindInbox(
          ctxOrThrow(tenantContext),
          requireDbId(params.id),
          agentId,
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Bind inbox to agent",
        "Set or clear which agent answers an inbox. Binding lazily provisions the instance's Agent Bot and connects it to the inbox on Chatwoot; unbinding disconnects it. Unbinding an inbox that was deleted in Chatwoot still succeeds: there is no bot left to disconnect. 502 means Chatwoot was unreachable.",
      ),
      params: t.Object({
        id: t.String({ description: "Inbox id (BigInt string)." }),
      }),
      body: t.Object({
        agentId: t.Union([t.String(), t.Null()], {
          description:
            "Agent id (BigInt string) to bind, or null to unbind the inbox.",
        }),
      }),
      response: errors(400, 401, 403, 404, 422, 502),
    },
  )
  // Remove the mirror row of an inbox that was deleted in Chatwoot. Refuses (409) while the inbox
  // still exists there: the mirror is rebuilt by the next message that inbox sends, so removing a
  // live one silently drops the binding instead of removing anything.
  .delete(
    "/inboxes/:id",
    async ({ tenantContext, params }) => {
      await removeInbox(ctxOrThrow(tenantContext), requireDbId(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Remove inbox mirror",
        "Remove the local mirror of an inbox that was deleted in Chatwoot. Only allowed once Chatwoot answers that the inbox is gone: 409 while it still exists there (delete it in Chatwoot first), 502 when that could not be confirmed. Past conversations are kept and stop naming an inbox; past usage and log lines are kept and keep naming the removed one.",
      ),
      params: t.Object({
        id: t.String({ description: "Inbox id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404, 409, 502),
    },
  )
  // Re-provision + reconnect the bound inbox's persona bot (recovery when the bot was deleted on
  // Chatwoot). ensureAgentBot self-heals; 409 if the inbox has no agent bound, 502 if Chatwoot is down.
  .post(
    "/inboxes/:id/reconnect",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      inbox: await reconnectInbox(
        ctxOrThrow(tenantContext),
        requireDbId(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Reconnect inbox bot",
        "Re-provision and reconnect the bound persona's Chatwoot Agent Bot for an inbox (recovery when it was deleted out-of-band).",
      ),
      params: t.Object({
        id: t.String({ description: "Inbox id (BigInt string)." }),
      }),
      response: errors(400, 401, 403, 404, 409, 502),
    },
  );
