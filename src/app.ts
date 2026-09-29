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

// A factory so a test that needs its own route gets its own real app: Elysia compiles its router on
// the first request, so a route added to the shared default export afterwards never takes effect and
// falls through to the `/*` SPA handler. A hand-rolled Elysia would test its own `onError` ordering,
// not this file's. Production runs only the default export below.
// Async because the static plugin is awaited inside the chain; the top-level `await` on the default
// export keeps `App` the Elysia type rather than a promise.
export async function buildApp() {
  const app = new Elysia({
    // NOTE: without these carve-outs Bun's native routes table serves the SPA HTMLBundle for /api/*
    // before Elysia's fetch handler runs; the bare /api entry covers requests without a trailing
    // slash. Root cause and the smoke test to re-run on an Elysia upgrade: docs/routing.md.
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
        // NOTE: relaxed from helmet's same-origin so GSI's popup can post back to window.opener. It is
        // hygiene, not the load-bearing signal: the SPA shell is served by Bun's routes table (no
        // helmet), and a provider's own COOP nulls the vault OAuth popup's opener mid-flow, so that
        // result travels by BroadcastChannel plus a status poll (src/client/lib/oauthPopup.ts).
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
    // NOTE: AppErrors carry their HTTP status and log at warn (expected control flow). The message is
    // localized from Accept-Language because the request ALS may not be in scope here.
    // Registered BEFORE the limiters: an AppError comes from a matched route that was already charged,
    // and the plugin's own `onError` cannot tell our NotFoundError from a missing route, so it would
    // charge again and can turn an admitted 404 into a 429.
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
    // NOTE: registered AFTER the limiters on purpose. A request rejected before its handler is charged
    // from the plugin's own `onError`, and Elysia stops at the first error handler that returns a
    // value, so answering NOT_FOUND or VALIDATION before the plugin would leave them uncharged.
    // Framework refusals such as PARSE return `undefined` below, so they reach the plugin either way.
    .onError(({ path, error, request, set }) => {
      // NOTE: a schema refusal in the app's own vocabulary (body and log line: api/lib/schema-refusal.ts).
      // Here and not next to the AppError branch, so the plugin's charge for VALIDATION is not skipped
      // (see middlewares/rateLimit.ts). Keyed on identity, not `code`: Elysia forwards a thrown value's
      // own `code`, so any plain error carrying "VALIDATION" would match.
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

      // NOTE: anything that is not a refusal Elysia itself raised is an unhandled failure, and its
      // text reaches the client only in development. Decided from the thrown value, not from `code`,
      // which any library can set (see api/lib/unhandled-error.ts).
      if (isFrameworkRefusal(error)) return;
      // NOTE: `set.status` too: the access log reads it, and Elysia seeds it from the thrown value's
      // own `status`, so an error carrying `status: 401` would be answered 500 but logged as 401.
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
        // NOTE: `bunFullstack` defaults to false; without it dev serves `public/index.html` raw and
        // its `<script src="../src/client/frontend.tsx">` reference cannot resolve.
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
    // NOTE: MCP clients probe /.well-known/oauth-protected-resource/<resource-path> before the root
    // (RFC 9728 §3.1). There is a single protected resource, so any suffix gets the same metadata
    // instead of falling through to the SPA's HTML, which strict clients reject.
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

  return app;
}

const app = await buildApp();

export type App = typeof app;
export default app;
