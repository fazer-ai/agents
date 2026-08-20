import { rateLimit } from "elysia-rate-limit";
import { resolveClientIp } from "@/api/lib/clientIp";
import { translate } from "@/api/lib/i18n";
import config from "@/config";

const STATIC_EXTENSIONS =
  /\.(js|css|html|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json)$/i;

const isStaticRequest = (request: Request): boolean => {
  const url = new URL(request.url);
  const path = url.pathname;

  if (STATIC_EXTENSIONS.test(path)) return true;
  if (path.startsWith("/assets/")) return true;
  if (path.startsWith("/css/")) return true;
  if (path.startsWith("/js/")) return true;
  if (path.startsWith("/locales/")) return true;

  return false;
};

// The MCP transport endpoint gets its own, looser per-IP bucket instead of the global one
// (mcpTransportRateLimitMiddleware): every JSON-RPC call from one MCP client arrives from a single
// IP, so the tighter global bucket would throttle a legitimate client mid-task. The default is a
// runaway-guard ceiling (config.rateLimit.mcpPerMin), not a tight throttle; the real credential gate
// is the OAuth Bearer (verifyAccessToken per request, jti denylist for revoke). A per-token bucket
// was considered but would be single-replica (in-memory) for the MVP, so we key by IP like the rest.
// The OAuth subpaths (/oauth/*) are NOT covered here, they keep the global limit so /token
// brute-force stays bounded.
// NOTE: The plugin's default generator keys on `server.requestIP()`, which is the SOCKET PEER.
// Behind a reverse proxy — what every compose file in this repo puts in front, and what the
// Portainer one ships itself — that is the proxy for every request, so the whole deployment shares
// one bucket and the ceilings below stop being per-client at all. Every limiter takes this one, so
// the keying cannot drift between them; the trust decision behind it lives in api/lib/clientIp.ts.
// NOTE: exported as a factory only so a test can build the key a DECLARED-proxy deployment would
// use; the suite runs with the shipped default, where nothing is declared and the peer is the key.
export const clientKeyFor =
  (trustProxy: boolean, hops: number) =>
  (request: Request, server: { requestIP?: unknown } | null) =>
    resolveClientIp({
      request,
      peer: (
        server as {
          requestIP?: (r: Request) => { address?: string } | null;
        } | null
      )?.requestIP?.(request)?.address,
      trustProxy,
      hops,
    });

const clientKey = clientKeyFor(config.trustProxy, config.trustedProxyHops);

export const isMcpTransport = (request: Request): boolean => {
  const path = new URL(request.url).pathname;
  return path === "/api/v1/mcp" || path === "/api/v1/mcp/";
};

// NOTE: `max` is a parameter only so a test can drive the REAL middleware at a reachable budget;
// production always takes the default. Exercising the shipped limiter is the point — a test that
// rebuilt an equivalent one would pass while this one was mounted without a generator.
export const rateLimitMiddleware = (
  max = config.rateLimit.userPerMin,
  generator = clientKey,
) =>
  rateLimit({
    duration: 60000, // 1 minute
    generator,
    max, // default 600 requests per minute per client
    errorResponse: translate(
      "errors.rateLimitExceeded",
      "Rate limit exceeded. Please try again later.",
    ),
    skip: (request) => isStaticRequest(request) || isMcpTransport(request),
    scoping: "scoped",
  });

// Dedicated per-IP bucket for the MCP JSON-RPC transport. Looser than the global limit because a
// single MCP client funnels all its tool calls through one IP; this is a runaway-guard, not a tight
// throttle (see isMcpTransport). Skips every other path, which keeps its own bucket.
export const mcpTransportRateLimitMiddleware = () =>
  rateLimit({
    duration: 60000, // 1 minute
    generator: clientKey,
    max: config.rateLimit.mcpPerMin, // default 1200 requests per minute per IP
    errorResponse: translate(
      "errors.rateLimitExceeded",
      "Rate limit exceeded. Please try again later.",
    ),
    skip: (request) => !isMcpTransport(request),
    scoping: "scoped",
  });

export const strictRateLimitMiddleware = () =>
  rateLimit({
    duration: 60000, // 1 minute
    generator: clientKey,
    max: 10, // 10 requests per minute
    errorResponse: translate(
      "errors.rateLimitExceeded",
      "Rate limit exceeded. Please try again later.",
    ),
    scoping: "scoped",
  });

export const staticRateLimitMiddleware = () =>
  rateLimit({
    duration: 60000, // 1 minute
    generator: clientKey,
    max: 1000, // 1000 requests per minute
    errorResponse: translate(
      "errors.rateLimitExceeded",
      "Rate limit exceeded. Please try again later.",
    ),
    skip: (request) => !isStaticRequest(request),
    scoping: "scoped",
  });

// Tight per-IP limit dedicated to DCR self-registration (RFC 7591). When the DCR endpoint is open,
// anyone can mint OAuth client rows, so cap it to a low rate to bound abuse / table flooding. Applies
// ONLY to POST /api/v1/mcp/oauth/register (skips every other path, which keeps its own bucket).
export const registerRateLimitMiddleware = () =>
  rateLimit({
    duration: 60000, // 1 minute
    generator: clientKey,
    max: 10, // 10 registrations per minute per IP
    errorResponse: translate(
      "errors.rateLimitExceeded",
      "Rate limit exceeded. Please try again later.",
    ),
    skip: (request) =>
      new URL(request.url).pathname !== "/api/v1/mcp/oauth/register",
    scoping: "scoped",
  });
