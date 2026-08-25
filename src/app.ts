import cors from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import Elysia, { NotFoundError, ValidationError } from "elysia";
import { helmet } from "elysia-helmet";
import api from "@/api";
import { cspDirectives } from "@/api/lib/csp";
import logger from "@/api/lib/logger";
import { parseOrigins } from "@/api/lib/origin";
import { refusalBody, refusalHeaders } from "@/api/lib/refusal";
import { schemaRefusal } from "@/api/lib/schema-refusal";
import { errorDetail, isFrameworkRefusal } from "@/api/lib/unhandled-error";
import { localeMiddleware } from "@/api/middlewares/locale";
import {
  credentialRateLimitMiddleware,
  mcpTransportRateLimitMiddleware,
  rateLimitMiddleware,
  registerRateLimitMiddleware,
  staticRateLimitMiddleware,
} from "@/api/middlewares/rateLimit";
import config from "@/config";
import { AppError } from "@/lib/errors";
import {
  authServerMetadata,
  protectedResourceMetadata,
} from "@/modules/mcp/oauth/metadata";

const HASHED_ASSET_PATTERN = /-[a-z0-9]{8,}\.[\w]+$/i;

// NOTE: SPA catch-all for BrowserRouter. Dev hands Elysia the HTMLBundle
// from public/index.html so Bun's bundler resolves the <script> reference
// and HMR keeps working on deep routes; prod serves the pre-built
// dist/index.html via Bun.file. Without this, refreshes on /settings,
// /admin, etc. would 404 because only `/` is registered by staticPlugin.
const indexHandler =
  config.env === "production"
    ? () => Bun.file("dist/index.html")
    : (await import("@/public/index.html")).default;

const app = new Elysia({
  // NOTE: Tell Bun's native routes table not to intercept /api paths via
  // the catch-all SPA HTMLBundle registered below. Without these
  // carve-outs Bun would serve index.html for /api/* before Elysia's
  // fetch handler ever runs (causa-raiz documentada em
  // elysiajs/elysia#1515 e issues do Bun #17595, #17363, #23999). The
  // bare /api carve-out covers requests without a trailing slash. Re-run
  // the smoke test in CLAUDE.md when upgrading Elysia.
  serve: {
    routes: {
      "/api": false,
      "/api/*": false,
    },
  },
})
  .use(
    helmet({
      contentSecurityPolicy: {
        directives: cspDirectives,
        // NOTE: In dev, run CSP in Report-Only so violations surface in the
        // browser console without blocking. Catches third-party-integration
        // CSP issues (Google Fonts, OAuth, analytics) at `bun dev` time
        // instead of after a deploy to staging/prod.
        reportOnly: config.env !== "production",
      },
      // NOTE: Relax COOP from the helmet default (same-origin) so a document this app serves does
      // not needlessly isolate itself from popups it opens. This helps GSI's "Continue with Google"
      // button (accounts.google.com posts back to window.opener). It applies to Elysia-served
      // responses, which includes the vault OAuth callback popup document (google_oauth/mcp_oauth).
      // It does NOT reach the SPA shell — that HTML is served by Bun's static routes table, BYPASSING
      // Elysia/helmet, so the opener page stays COOP unsafe-none regardless. For the vault OAuth
      // popups we therefore do NOT depend on window.opener.postMessage: the external provider's
      // authorize endpoint answers with its own COOP same-origin, which disowns our popup handle mid
      // -flow (window.opener becomes null AND popup.closed lies). The result is delivered to the
      // opener via BroadcastChannel (origin-scoped, browsing-context-group-independent) plus a
      // server-status poll — see src/client/lib/oauthPopup.ts. This header is correct hygiene, not the
      // load-bearing signal. https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cross-Origin-Opener-Policy
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    }),
  )
  .use(localeMiddleware)
  .onAfterResponse(({ request, set }) => {
    logger.info("%s %s [%s]", request.method, request.url, set.status);
  })
  .onAfterHandle(({ request, set }) => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path.endsWith(".html")) {
      set.headers["cache-control"] = "no-cache";
    } else if (HASHED_ASSET_PATTERN.test(path)) {
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
    } else if (/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?)$/i.test(path)) {
      set.headers["cache-control"] = "public, max-age=86400";
    }
  })
  // NOTE: typed app errors (ForbiddenError 403, TenantTargetRequiredError 400, NotFoundError 404,
  // ...) carry their HTTP status. Logged at warn, since they are expected control-flow and not server
  // faults. When the error carries a translationKey, localize it from the request's Accept-Language
  // (the request ALS may not be in scope here) so user-facing messages are not raw English.
  //
  // NOTE: registered BEFORE the limiters, while everything else below is registered AFTER them, and
  // the split is load-bearing in BOTH directions. An AppError is thrown from a MATCHED route, or from
  // a hook that runs after the limiters' counting hook, so the request has already been charged. The
  // plugin cannot know that: its own `onError` reads `error.status ?? error.statusCode`, where our
  // NotFoundError is indistinguishable from a route that never existed, so it charges a second time.
  // That is not merely an overcharge. Measured with a max of 4 and one request of budget left, a
  // request that should have been admitted and answered 404 came back 429: the second charge crossed
  // the ceiling, and the limiter answers from its own hook without ever reaching the handler below.
  // Answering AppError here keeps it away from the plugin entirely.
  .onError(({ path, error, request, set }) => {
    if (!(error instanceof AppError)) return;
    logger.warn("%s %s", path, error.message);
    const body = refusalBody(error, request.headers.get("accept-language"));
    // NOTE: keep set.status in sync, because the access log in onAfterResponse reads it and a raw
    // Response alone would make a 4xx show up there as a 500.
    set.status = error.statusCode;
    return Response.json(body, {
      status: error.statusCode,
      headers: refusalHeaders(error),
    });
  })
  .use(rateLimitMiddleware())
  .use(mcpTransportRateLimitMiddleware())
  .use(registerRateLimitMiddleware())
  .use(credentialRateLimitMiddleware())
  .use(staticRateLimitMiddleware())
  // NOTE: everything the AppError handler above does not answer, registered AFTER the limiters ON
  // PURPOSE. This is the mirror image of that split: a request rejected BEFORE the handler never
  // reaches the plugin's counting hook, so the plugin charges those from its own `onError`, and
  // Elysia stops at the first error handler that RETURNS A VALUE. With this registered first the
  // NOT_FOUND branch below answered and the plugin never ran: measured on the real app, `POST
  // /api/nope` and any request to a missing non-/api path came back 404 with no `RateLimit-*` header
  // and no budget spent. An unknown GET under /api looked metered only because the `.get("/api/*")`
  // guard below turns it into a MATCHED route, which the normal hook counts.
  // PARSE still is not affected either way, because the `default:` branch below returns `undefined`
  // for it and the chain continues to the plugin regardless of order. VALIDATION is answered here
  // now (issue #255) and so DOES depend on this placement: the plugin has already charged it by the
  // time this handler returns.
  .onError(({ path, error, request, set }) => {
    // NOTE: Handle BigInt parsing errors as 400 Bad Request
    if (error instanceof SyntaxError && error.message.includes("BigInt")) {
      set.status = 400;
      return new Response("Invalid ID format", { status: 400 });
    }

    // NOTE: a schema refusal, answered in the app's own vocabulary instead of TypeBox's. Registered
    // HERE, after the limiters, and not next to the AppError branch above: the rate-limit plugin
    // charges request-side VALIDATION from its own `onError` (see the note in middlewares/rateLimit
    // .ts on 4.6.3), and Elysia stops at the first handler that RETURNS A VALUE, so answering it
    // before the plugin would hand back an uncharged budget to anyone willing to send a body the
    // schema refuses. Everything about the body and the log line is decided in api/lib/schema
    // -refusal.ts, including why the submitted value reaches neither.
    //
    // Keyed on IDENTITY, not on `code`. Elysia forwards the thrown value's own `code` property when
    // it has one, so `code === "VALIDATION"` is also true of any plain error that happens to carry
    // that string — measured: such an error was answered 422 in the app's schema vocabulary, and the
    // `as ValidationError` cast this replaces was simply false about it. Issue #263 has the long
    // version; the rule is that a branch deciding what a failure IS cannot read a property the
    // failure sets.
    if (error instanceof ValidationError) {
      const refusal = schemaRefusal(
        error,
        request.headers.get("accept-language"),
      );
      const line = "%s %s";
      if (refusal.severity === "error") {
        logger.error(line, path, refusal.log);
      } else {
        logger.warn(line, path, refusal.log);
      }
      set.status = refusal.status;
      return Response.json(refusal.body, { status: refusal.status });
    }

    logger.error("%s\n%s", path, error);

    if (error instanceof NotFoundError) {
      // NOTE: API endpoints respond with JSON 404. SPA paths normally
      // don't reach here because the /* catch-all below serves
      // index.html for any non-API, non-asset request.
      set.status = 404;
      if (path === "/api" || path.startsWith("/api/")) {
        return Response.json({ error: "Not Found" }, { status: 404 });
      }
      return new Response("Not Found", { status: 404 });
    }

    // NOTE: everything that is not a refusal Elysia itself raised is an unhandled failure, and
    // its text does not reach the client outside development. Stated by exclusion, and decided
    // from the thrown VALUE rather than from `code`, because `code` is a property the value
    // carries and any library can set it. The measurements behind both of those choices are in
    // api/lib/unhandled-error.ts; the short version is that a redact-list keyed on `code` leaked
    // twice, once through a string code and once through a numeric one.
    if (isFrameworkRefusal(error)) return;
    // NOTE: `set.status` too, not just the Response's. The access log in onAfterResponse reads
    // `set.status`, and Elysia seeds it from the thrown value's own `status` property — so an
    // error carrying `status: 401` is answered 500 here and LOGGED as 401 unless this line runs.
    // Same reason the AppError arm above carries the same note; the BigInt arm needed it too.
    set.status = 500;
    const message =
      config.env === "development"
        ? errorDetail(error)
        : "Something went wrong";
    return new Response(message, { status: 500 });
  })
  .use(
    await staticPlugin({
      assets: config.env === "production" ? "dist" : "public",
      prefix: "/",
      alwaysStatic: true,
      // NOTE: @elysiajs/static 1.4.9 renamed `bundleHTML` to `bunFullstack`
      // and flipped the default to `false`. Without this, dev serves
      // `public/index.html` raw and the `<script src="../src/client/frontend.tsx">`
      // reference cannot be resolved. See elysiajs/elysia-static#63.
      bunFullstack: config.env === "development",
    }),
  )
  .group("/api", (app) => app.use(api))
  // NOTE: Catch unmatched GET /api paths so they don't fall through to
  // the /* SPA catch-all below (which would respond with index.html in
  // prod or "{}" in dev — see the Routing section in CLAUDE.md). Non-GET
  // methods are covered by the onError NOT_FOUND handler above, which
  // never reaches the GET-only /*.
  .get("/api", ({ set }) => {
    set.status = 404;
    return { error: "Not Found" };
  })
  .get("/api/*", ({ set }) => {
    set.status = 404;
    return { error: "Not Found" };
  })
  // NOTE: OAuth discovery at the ISSUER ROOT (RFC 8414 / RFC 9728). Registered BEFORE the SPA
  // catch-all so MCP clients get JSON, not index.html. Public (no auth) by design.
  .get("/.well-known/oauth-authorization-server", () => authServerMetadata())
  .get("/.well-known/oauth-protected-resource", () =>
    protectedResourceMetadata(),
  )
  // Path-aware variant (RFC 9728 §3.1): MCP clients probe
  // /.well-known/oauth-protected-resource/<resource-path> before the root. There is a single
  // protected resource, so serve the same metadata for any suffix — otherwise the probe falls
  // through to the SPA catch-all and returns index.html (HTML), which strict clients choke on.
  .get("/.well-known/oauth-protected-resource/*", () =>
    protectedResourceMetadata(),
  )
  .get("/*", indexHandler);

app.use(
  cors(
    config.env === "development"
      ? undefined
      : { origin: parseOrigins(config.corsOrigin) },
  ),
);

export type App = typeof app;
export default app;
