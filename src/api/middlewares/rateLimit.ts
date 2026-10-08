import { Elysia } from "elysia";
import { rateLimit } from "elysia-rate-limit";
import { resolveClientIp } from "@/api/lib/clientIp";
import { translate } from "@/api/lib/i18n";
import config from "@/config";
import { CHATWOOT_WEBHOOK_MOUNT } from "@/modules/chatwoot/webhook-mount";

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

// `max` is a parameter only so a test can drive the REAL middleware at a reachable budget;
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
    skip: (request) =>
      isStaticRequest(request) ||
      isMcpTransport(request) ||
      isWebhookReceiver(request),
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

// The machine-to-machine receivers: one source host sends every delivery of a deployment, so a
// per-address budget sized for people throttles all of them at once, and a 429 there is a message the
// sender gives up on. Each authenticates itself (an opaque route token plus a signature or header).
const WEBHOOK_RECEIVER_MOUNTS = [
  CHATWOOT_WEBHOOK_MOUNT,
  "/api/v1/integrations/inbound",
] as const;

// A token the router cannot decode (`%`, `%zz`) is refused before any handler or hook of this
// limiter runs, so it has to stay on the global budget, which charges that refusal.
const decodesAsToken = (segment: string): boolean => {
  try {
    decodeURIComponent(segment);
    return true;
  } catch {
    return false;
  }
};

// POST with exactly one segment (the route token) under a receiver mount, through `canonicalPath`
// like the other limiters: any other spelling routes nowhere and stays on the global budget.
export const isWebhookReceiver = (request: Request): boolean => {
  if (request.method !== "POST") return false;
  const path = canonicalPath(request);
  return WEBHOOK_RECEIVER_MOUNTS.some((mount) => {
    const rest = path.startsWith(`${mount}/`)
      ? path.slice(mount.length + 1)
      : "";
    return rest !== "" && !rest.includes("/") && decodesAsToken(rest);
  });
};

export const WEBHOOK_AUTH_FAILURES_PER_MIN = 60;
const WEBHOOK_LIMIT_KEYS_MAX = 10_000;
const WEBHOOK_ACCEPTED_ROUTES_PER_KEY = 256;

// Bounded the same way for every map: oldest-first eviction (a Map keeps insertion order), so an
// address rotation costs heap only up to the cap, and an evicted address just starts over.
const boundedSet = <V>(map: Map<string, V>, key: string, value: V) => {
  map.delete(key);
  if (map.size >= WEBHOOK_LIMIT_KEYS_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
};

// The 401 is known only after the response, so attempts still in flight count too: an unaccepted
// route has at most ONE attempt in flight per address, and its repeats wait for that attempt's answer
// (up to `waitMs`, inside Chatwoot's ~5 s ack budget) before being judged again, at most `maxWaiting`
// of them per address. A burst of fresh guesses is bounded when it arrives, a repeated guess is tried
// one at a time, and a real sender's burst waits for its first acceptance.
export const WEBHOOK_FIRST_ATTEMPT_WAIT_MS = 4_000;
const WEBHOOK_WAITING_PER_KEY = 256;

// The receivers' own ceiling, charged with what they answered 401: a sender is never refused for its
// volume, while an address guessing tokens is, and each guess would otherwise cost a lookup (the
// Chatwoot receiver's negative cache absorbs repeats of ONE token, not a stream of fresh ones). Past
// the ceiling only routes this address was never accepted on are refused, so a Chatwoot still posting
// to a deleted bot's URL does not take down the bots it serves from the same host. In-memory and per
// process, like every limiter here (single replica, docs/deploy.md).
export const webhookAuthFailureLimitMiddleware = (
  max = WEBHOOK_AUTH_FAILURES_PER_MIN,
  generator = clientKey,
  now: () => number = Date.now,
  waitMs = WEBHOOK_FIRST_ATTEMPT_WAIT_MS,
  maxWaiting = WEBHOOK_WAITING_PER_KEY,
) => {
  const failures = new Map<string, { count: number; resetAt: number }>();
  const accepted = new Map<string, Set<string>>();
  const inFlight = new Map<string, Map<string, PromiseWithResolvers<void>>>();
  const waiting = new Map<string, number>();
  // Who asked and on which route, taken BEFORE the handler and carried on the request's own `set`:
  // after the response the socket is gone, so the peer (the key without a declared proxy) is no
  // longer readable there.
  const seen = new WeakMap<
    object,
    { key: string; route: string; attempt?: PromiseWithResolvers<void> }
  >();
  const failuresOf = (key: string, at: number): number => {
    const entry = failures.get(key);
    return entry !== undefined && entry.resetAt > at ? entry.count : 0;
  };
  const refuse = (
    set: { status?: unknown; headers: Record<string, unknown> },
    key: string,
  ) => {
    const at = now();
    const resetAt = failures.get(key)?.resetAt ?? at + 60_000;
    set.status = 429;
    set.headers["retry-after"] = String(
      Math.max(1, Math.ceil((resetAt - at) / 1000)),
    );
    return sharedLimiterOptions.errorResponse;
  };
  return new Elysia()
    .onBeforeHandle({ as: "scoped" }, async ({ request, server, set }) => {
      if (!isWebhookReceiver(request)) return;
      const key = generator(request, server as { requestIP?: unknown } | null);
      const route = canonicalPath(request);
      const deadline = now() + waitMs;
      for (;;) {
        if (accepted.get(key)?.has(route)) {
          seen.set(set, { key, route });
          return;
        }
        const failed = failuresOf(key, now());
        const routes = inFlight.get(key) ?? new Map();
        const running = routes.get(route);
        if (running === undefined) {
          if (failed + routes.size >= max) return refuse(set, key);
          const attempt = Promise.withResolvers<void>();
          routes.set(route, attempt);
          boundedSet(inFlight, key, routes);
          seen.set(set, { key, route, attempt });
          return;
        }
        const left = deadline - now();
        const queued = waiting.get(key) ?? 0;
        if (left <= 0 || queued >= maxWaiting) return refuse(set, key);
        boundedSet(waiting, key, queued + 1);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            running.promise,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, left);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          const still = (waiting.get(key) ?? 1) - 1;
          if (still > 0) waiting.set(key, still);
          else waiting.delete(key);
        }
      }
    })
    .onAfterResponse({ as: "scoped" }, ({ set }) => {
      const asked = seen.get(set);
      if (asked === undefined) return;
      const { key, route, attempt } = asked;
      const status = typeof set.status === "number" ? set.status : 200;
      if (status === 401) {
        const at = now();
        const entry = failures.get(key);
        if (entry !== undefined && entry.resetAt > at) entry.count += 1;
        else boundedSet(failures, key, { count: 1, resetAt: at + 60_000 });
      } else if (status < 400) {
        const routes = accepted.get(key) ?? new Set<string>();
        routes.delete(route);
        if (routes.size >= WEBHOOK_ACCEPTED_ROUTES_PER_KEY) {
          const oldest = routes.values().next().value;
          if (oldest !== undefined) routes.delete(oldest);
        }
        routes.add(route);
        boundedSet(accepted, key, routes);
      }
      // NOTE: released AFTER the verdict is recorded, so a waiter that wakes reads it.
      if (attempt !== undefined) {
        const routes = inFlight.get(key);
        if (routes?.get(route) === attempt) routes.delete(route);
        if (routes?.size === 0) inFlight.delete(key);
        attempt.resolve();
      }
    });
};
