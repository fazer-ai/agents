import { Elysia } from "elysia";
import {
  doc,
  ErrorResponse,
  errors,
  jsonResponse,
  type ResponseDoc,
} from "@/api/lib/openapi";
import config from "@/config";
import { verifyApiKey } from "@/modules/api-keys/verify";
import {
  mcpPrincipalFromApiKey,
  verifyAccessToken,
} from "@/modules/mcp/oauth/tokens";
import { handleMcpRequest } from "@/modules/mcp/server";

// The MCP transport endpoint. Authenticated by its OWN OAuth Bearer token (NOT the app cookie) —
// verifyAccessToken re-resolves the principal on every request. As an ALTERNATIVE (OAuth stays the
// default, discoverable path), a per-tenant API key (Bearer fazerai_…) is also accepted: it maps to an
// MCP principal scoped mcp:read+mcp:write (never mcp:admin). A missing/invalid token returns 401 with
// the RFC 9728 resource-metadata pointer so a client can discover the OAuth server.
// This path is exempt from the global per-IP rate limit (isMcpTransport in middlewares/rateLimit);
// per-token throttling is single-replica for the MVP.

function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
}

// NOTE: Doc-only 405 shared by the not-offered GET/DELETE stubs below, carrying the `Allow` header
// the handlers always set.
const methodNotAllowedResponse: ResponseDoc = {
  ...jsonResponse(
    "Always returned: this transport does not offer the method (`Allow: POST`).",
    ErrorResponse,
  ),
  headers: {
    Allow: { description: "Always `POST`.", schema: { type: "string" } },
  },
};

export const mcpController = new Elysia({
  prefix: "/v1/mcp",
  tags: ["MCP"],
})
  .post(
    "/",
    async ({ request, set }) => {
      const token = bearer(request);
      let principal = token ? await verifyAccessToken(token) : null;
      // OAuth access token is the default; fall back to a per-tenant API key (Bearer).
      if (!principal && token) {
        const apiPrincipal = await verifyApiKey(token);
        if (apiPrincipal) principal = mcpPrincipalFromApiKey(apiPrincipal);
      }
      if (!principal) {
        set.status = 401;
        set.headers["WWW-Authenticate"] =
          `Bearer resource_metadata="${config.publicUrl.replace(/\/$/, "")}/.well-known/oauth-protected-resource"`;
        return { error: "invalid_token" };
      }
      return handleMcpRequest(request, principal);
    },
    {
      detail: {
        ...doc(
          "MCP transport endpoint",
          "Model Context Protocol transport, authenticated by its own OAuth Bearer token (not the app cookie); a missing or invalid token returns 401 with the RFC 9728 resource-metadata pointer so a client can discover the auth server.",
        ),
        security: [],
      },
      response: errors(401),
    },
  )
  // NOTE: This Streamable HTTP transport is stateless and tools-only (no server-initiated messages),
  // so the OPTIONAL GET SSE stream (server-to-client) and DELETE session teardown are not offered.
  // Per the MCP spec we answer 405 + `Allow: POST`. Without these routes a client that probes GET to
  // open the stream falls through to the /api/* 404 guard (app.ts) and reconnects in a tight loop.
  .get(
    "/",
    ({ set }) => {
      set.status = 405;
      set.headers.Allow = "POST";
      return { error: "method_not_allowed" };
    },
    {
      detail: {
        ...doc(
          "MCP SSE stream (not offered)",
          "Always 405 with `Allow: POST`. This transport is stateless and tools-only, so the OPTIONAL server-to-client SSE stream does not exist; the route is declared so a probing client gets an explicit 405 instead of falling through to the SPA 404 guard and reconnecting in a loop.",
        ),
        security: [],
        responses: { 405: methodNotAllowedResponse },
      },
    },
  )
  .delete(
    "/",
    ({ set }) => {
      set.status = 405;
      set.headers.Allow = "POST";
      return { error: "method_not_allowed" };
    },
    {
      detail: {
        ...doc(
          "MCP session teardown (not offered)",
          "Always 405 with `Allow: POST`. The transport is stateless, so there is no session to tear down; declared for the same reason as the GET above.",
        ),
        security: [],
        responses: { 405: methodNotAllowedResponse },
      },
    },
  );
