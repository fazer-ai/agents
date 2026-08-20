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

// Everything the five limiters must agree on, in one place. Spelling the options out per instance is
// how a setting drifts: they already differ only in `max` and `skip`, and every difference beyond
// those is a bug waiting to be introduced in one of the five.
//
// `countFailedRequest: true` is NOT the plugin default, and the default is not "counts less" but
// "counts negative": the plugin calls `decrement` for any request that reaches `onError` outside the
// codes it charges there, INCLUDING requests its own counting hook never saw. Measured on 4.6.2
// against the real app: three requests took the budget from 599 to 597, five malformed-JSON POSTs
// carried no `RateLimit-*` header at all, and the next legitimate request reported 601, above where
// it started. Anyone willing to interleave garbage kept an unbounded budget. 4.6.3 charges PARSE and
// request-side VALIDATION in that branch, which closes that specific refill; this flag closes the
// rest, so a request that failed still costs what it cost the server to fail it.
const sharedLimiterOptions = {
  duration: 60000, // 1 minute
  scoping: "scoped",
  generator: clientKey,
  countFailedRequest: true,
  errorResponse: translate(
    "errors.rateLimitExceeded",
    "Rate limit exceeded. Please try again later.",
  ),
} as const;

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
    ...sharedLimiterOptions,
    generator,
    max, // default 600 requests per minute per client
    skip: (request) => isStaticRequest(request) || isMcpTransport(request),
  });

// Dedicated per-IP bucket for the MCP JSON-RPC transport. Looser than the global limit because a
// single MCP client funnels all its tool calls through one IP; this is a runaway-guard, not a tight
// throttle (see isMcpTransport). Skips every other path, which keeps its own bucket.
export const mcpTransportRateLimitMiddleware = () =>
  rateLimit({
    ...sharedLimiterOptions,
    max: config.rateLimit.mcpPerMin, // default 1200 requests per minute per IP
    skip: (request) => !isMcpTransport(request),
  });

export const strictRateLimitMiddleware = () =>
  rateLimit({
    ...sharedLimiterOptions,
    max: 10, // 10 requests per minute
  });

export const staticRateLimitMiddleware = () =>
  rateLimit({
    ...sharedLimiterOptions,
    max: 1000, // 1000 requests per minute
    skip: (request) => !isStaticRequest(request),
  });

const REGISTER_PATH = "/api/v1/mcp/oauth/register";

// NOTE: Elysia answers `/api/v1/mcp/oauth/register` and `.../register/` with the SAME handler, so
// comparing the raw pathname is a one-character bypass of the limiter below: measured before this
// normalization, 14 registrations through the slashed spelling under a ceiling of 10, every one a
// 200 and none carrying a `RateLimit-*` header.
//
// Nothing else in the alias space reaches the route. Measured server-side with `curl --path-as-is`,
// which is the only way to ask the question (a client normalizes the path before it leaves):
// `//api/v1/...`, `/api//v1/...`, `.../register//`, a percent-encoded letter and a different case
// all 404, and `.../oauth/./register` both routes AND is already counted, because the URL parser
// collapses `.` segments before this predicate sees them. One trailing slash is the whole
// normalization needed.
//
// NOTE: POST-only, because the path only EXISTS as POST. Now that a rejected request is charged, a
// 404 spends this budget like anything else, so without the method check a crawler or a broken link
// doing GET here would burn the registration budget for every client sharing that address. Those
// still pay the global limit, which is where an unmatched route belongs.
export const isRegisterRequest = (request: Request): boolean => {
  if (request.method !== "POST") return false;
  const { pathname } = new URL(request.url);
  const canonical =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  return canonical === REGISTER_PATH;
};

// Tight per-IP limit dedicated to DCR self-registration (RFC 7591). When the DCR endpoint is open,
// anyone can mint OAuth client rows, so cap it to a low rate to bound abuse / table flooding. Applies
// ONLY to POST /api/v1/mcp/oauth/register (skips every other path, which keeps its own bucket).
export const registerRateLimitMiddleware = () =>
  rateLimit({
    ...sharedLimiterOptions,
    max: 10, // 10 registrations per minute per IP
    skip: (request) => !isRegisterRequest(request),
  });
