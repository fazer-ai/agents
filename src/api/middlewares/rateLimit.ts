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

// The key every limiter uses. The plugin's default keys on `server.requestIP()`, the socket peer,
// which behind a reverse proxy (what every compose file here puts in front) is the proxy for every
// request, so the whole deployment would share one bucket. The trust decision is in
// api/lib/clientIp.ts. A factory only so a test can build a declared-proxy deployment's key.
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

// Everything the five limiters must agree on, so no setting drifts between them.
// `countFailedRequest: true` is not the plugin default, and the default counts negative: the plugin
// calls `decrement` for a request reaching `onError` outside the codes it charges, even one its
// counting hook never saw, so interleaved failing requests would refill the budget without bound.
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

// Dedicated per-IP bucket for the MCP JSON-RPC transport, looser than the global one because one MCP
// client funnels every tool call through one IP. A runaway guard, not a throttle: the real gate is
// the OAuth Bearer, and a per-token bucket would be in-memory, so single-replica. /oauth/* is not
// covered and keeps the global limit, so /token brute force stays bounded.
export const mcpTransportRateLimitMiddleware = () =>
  rateLimit({
    ...sharedLimiterOptions,
    max: config.rateLimit.mcpPerMin, // default 1200 requests per minute per IP
    skip: (request) => !isMcpTransport(request),
  });

// The routes where guessing is the attack, as method plus path (with /api: matched at the root app).
// `GET /auth/invite` is in because it answers 200 or 404 for a token, an unauthenticated oracle;
// every other GET stays out because a 404 spends the budget, and covering `GET /auth/login` would let
// a crawler burn the IP-shared login budget. The rest of /auth is out on purpose: `/auth/me` is
// polled on every page load, `/auth/password` sits behind a session (a thief could lock the owner
// out), and `/auth/google` needs a token Google signed.
const CREDENTIAL_ROUTES = new Set([
  "POST /api/auth/login",
  "POST /api/auth/signup",
  "POST /api/auth/setup",
  "POST /api/auth/accept-invite",
  "GET /api/auth/invite",
]);

// HEAD folds into GET because Elysia dispatches HEAD to the GET handler, so `HEAD /auth/invite`
// leaks the same status. Every GET in the set covers its HEAD alias; `HEAD /auth/login` still maps
// to a GET that is not in it.
export const isCredentialRequest = (request: Request): boolean => {
  const method = request.method === "HEAD" ? "GET" : request.method;
  return CREDENTIAL_ROUTES.has(`${method} ${canonicalPath(request)}`);
};

// A second, tighter bucket layered on top of the global one: a complementary pair (the global limiter
// skipping these routes) would leave them unlimited once the two budgets collided. The window is
// minutes because a per-minute ceiling resets 60 times an hour (10/min is 600 guesses an hour).
// config.ts rejects a budget that collides with another limiter's or is not tighter than the global.
export const credentialRateLimitMiddleware = () =>
  rateLimit({
    ...sharedLimiterOptions,
    duration: config.rateLimit.credentialWindowMinutes * 60_000,
    max: config.rateLimit.credentialMax,
    skip: (request) => !isCredentialRequest(request),
  });

export const staticRateLimitMiddleware = () =>
  rateLimit({
    ...sharedLimiterOptions,
    max: 1000, // 1000 requests per minute
    skip: (request) => !isStaticRequest(request),
  });

// Elysia answers a path and that path with one trailing slash with the same handler, so a limiter
// comparing the raw pathname is one character from a bypass. No other alias reaches a route (doubled
// slashes, percent-encoding and case all 404; the URL parser collapses `./`), so this is enough.
const canonicalPath = (request: Request): string => {
  const { pathname } = new URL(request.url);
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
};

const REGISTER_PATH = "/api/v1/mcp/oauth/register";

// POST only, because the path exists only as POST: a rejected request is charged, so a crawler's GET
// here would burn the registration budget of everyone sharing the address. Compared through
// `canonicalPath`, since the slashed spelling reaches the same handler.
export const isRegisterRequest = (request: Request): boolean =>
  request.method === "POST" && canonicalPath(request) === REGISTER_PATH;

// Tight per-IP limit dedicated to DCR self-registration (RFC 7591). When the DCR endpoint is open,
// anyone can mint OAuth client rows, so cap it to a low rate to bound abuse / table flooding. Applies
// ONLY to POST /api/v1/mcp/oauth/register (skips every other path, which keeps its own bucket).
export const registerRateLimitMiddleware = () =>
  rateLimit({
    ...sharedLimiterOptions,
    max: 10, // 10 registrations per minute per IP
    skip: (request) => !isRegisterRequest(request),
  });
