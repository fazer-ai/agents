import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { instanceIdentity } from "@/lib/instance";
import {
  type CreateClientInput,
  createClient,
  deleteClient,
  deleteClientApproval,
  listActiveTokens,
  listClientApprovals,
  listClients,
  revokeToken,
  type UpdateClientInput,
  updateClient,
} from "@/modules/mcp/oauth/admin";
import { MCP_SCOPES } from "@/modules/mcp/oauth/tokens";

// Admin surface for OUR MCP server (third transport): manage OAuth clients, see and
// revoke active tokens, and read the connection info. SUPER_ADMIN-only (the mcp_oauth_* tables are
// global, no RLS — the gate is the only fence). The client_secret hash and the JWTs themselves never
// cross this surface. NOT for connecting external MCPs as tools (that is Resources → MCP servers).
//
// NOTE: the service throws these AppError translationKeys; declared here (under src/api/**) so the API
// i18n extractor keeps them — its input glob does not reach src/modules.
// translate('errors.mcpClientNotFound', 'MCP client not found')
// translate('errors.mcpTokenNotFound', 'MCP token not found')
// translate('errors.mcpApprovalNotFound', 'MCP approval not found')

export const mcpAdminController = new Elysia({
  prefix: "/v1/mcp/admin",
  tags: ["MCP"],
})
  .use(tenancyPlugin)
  .get(
    "/connection",
    () => ({
      instance: instanceIdentity,
      url: `${config.publicUrl.replace(/\/$/, "")}/api/v1/mcp`,
      scopes: MCP_SCOPES,
      dcrEnabled: config.mcpDcrEnabled,
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "MCP connection info",
        "Returns the MCP transport URL, the supported scopes and whether Dynamic Client Registration is open — for the admin connection panel.",
      ),
      response: errors(401, 403),
    },
  )
  .get(
    "/clients",
    async () => ({
      instance: instanceIdentity,
      clients: await listClients(),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "List MCP OAuth clients",
        "Returns the registered MCP OAuth clients; the client_secret hash never crosses this surface.",
      ),
      response: errors(401, 403),
    },
  )
  .post(
    "/clients",
    async ({ body }) => ({
      instance: instanceIdentity,
      client: await createClient(body as CreateClientInput),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Register MCP OAuth client",
        "Registers a PUBLIC (PKCE) MCP OAuth client. redirect_uris must be exact https (http allowed only for loopback); scopes are intersected with the supported set.",
      ),
      body: t.Object({
        name: t.String({
          minLength: 1,
          maxLength: 200,
          description: "Human-readable client name.",
        }),
        redirectUris: t.Array(t.String(), {
          minItems: 1,
          description:
            "Exact redirect URIs (https, or http for loopback); no wildcard, no fragment.",
        }),
        scopes: t.Optional(
          t.Array(t.String(), {
            description:
              "Requested scopes, intersected with the supported MCP scopes; defaults to mcp:read.",
          }),
        ),
        firstParty: t.Optional(
          t.Boolean({
            description:
              "Trusted client that skips the consent screen at /authorize (default false).",
          }),
        ),
      }),
      response: errors(400, 401, 403, 422),
    },
  )
  .patch(
    "/clients/:clientId",
    async ({ params, body }) => ({
      instance: instanceIdentity,
      client: await updateClient(params.clientId, body as UpdateClientInput),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Update MCP OAuth client",
        "Updates a client's name, redirect URIs and/or scopes by client_id.",
      ),
      params: t.Object({
        clientId: t.String({ description: "The OAuth client_id." }),
      }),
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1, maxLength: 200 })),
        redirectUris: t.Optional(t.Array(t.String(), { minItems: 1 })),
        scopes: t.Optional(t.Array(t.String())),
        firstParty: t.Optional(t.Boolean()),
      }),
      response: errors(400, 401, 403, 404, 422),
    },
  )
  .delete(
    "/clients/:clientId",
    async ({ params }) => {
      await deleteClient(params.clientId);
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Delete MCP OAuth client",
        "Deletes a client and revokes all of its access and refresh tokens in one transaction.",
      ),
      params: t.Object({
        clientId: t.String({ description: "The OAuth client_id." }),
      }),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/tokens",
    async ({ query }) => ({
      instance: instanceIdentity,
      tokens: await listActiveTokens({
        tenantId:
          query.tenantId != null && query.tenantId !== ""
            ? BigInt(query.tenantId)
            : null,
      }),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "List active MCP tokens",
        "Returns the currently valid MCP access tokens (not revoked, not expired), optionally fenced to one tenant; the JWT itself is never returned.",
      ),
      query: t.Object({
        tenantId: t.Optional(
          t.String({
            description:
              "Filter to one tenant id (BigInt as a string); omit for all tenants.",
          }),
        ),
      }),
      response: errors(401, 403),
    },
  )
  .delete(
    "/tokens/:jti",
    async ({ params }) => {
      await revokeToken(params.jti);
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Revoke MCP token",
        "Revokes an access token by jti (immediate denylist) and every non-revoked refresh token for the same client+user.",
      ),
      params: t.Object({
        jti: t.String({ description: "The access token jti." }),
      }),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/approvals",
    async () => ({
      instance: instanceIdentity,
      approvals: await listClientApprovals(),
    }),
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "List MCP consent approvals",
        "Returns the remembered per-user-per-client consent approvals (what lets /authorize skip the consent screen), enriched with client name and user email.",
      ),
      response: errors(401, 403),
    },
  )
  .delete(
    "/approvals/:id",
    async ({ params }) => {
      await deleteClientApproval(BigInt(params.id));
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "SUPER_ADMIN",
      detail: doc(
        "Revoke an MCP consent approval",
        "Deletes a remembered approval so the next /authorize for that user+client prompts for consent again.",
      ),
      params: t.Object({
        id: t.String({
          pattern: "^[0-9]+$",
          description: "The approval id.",
        }),
      }),
      response: errors(401, 403, 404, 422),
    },
  );
