import { readdir } from "node:fs/promises";
import cors from "@elysiajs/cors";
import { staticPlugin } from "@elysiajs/static";
import Elysia, { NotFoundError, ValidationError } from "elysia";
import { helmet } from "elysia-helmet";
import api from "@/api";
import { cspDirectives } from "@/api/lib/csp";
import logger from "@/api/lib/logger";
import { parseOrigins } from "@/api/lib/origin";
import { refusalBody, refusalHeaders } from "@/api/lib/refusal";
import { loggedPath, loggedUrl } from "@/api/lib/request-target";
import { schemaRefusal } from "@/api/lib/schema-refusal";
import {
  applyStaticCacheControl,
  developmentIndexHandler,
  productionIndexHandler,
} from "@/api/lib/static-cache";
import { isFrameworkRefusal } from "@/api/lib/unhandled-error";
import { localeMiddleware } from "@/api/middlewares/locale";
import {
  credentialRateLimitMiddleware,
  mcpTransportRateLimitMiddleware,
  rateLimitMiddleware,
  registerRateLimitMiddleware,
  staticRateLimitMiddleware,
  webhookAuthFailureLimitMiddleware,
} from "@/api/middlewares/rateLimit";
import config from "@/config";
import { AppError } from "@/lib/errors";
import {
  authServerMetadata,
  protectedResourceMetadata,
} from "@/modules/mcp/oauth/metadata";

// SPA catch-all for BrowserRouter. Dev hands Elysia the HTMLBundle
// from public/index.html so Bun's bundler resolves the <script> reference
// and HMR keeps working on deep routes; prod serves the pre-built
// dist/index.html via Bun.file. Without this, refreshes on /settings,
// /admin, etc. would 404 because only `/` is registered by staticPlugin.
// The production handler also sets the document's cache policy and answers
// 404 for a missing file (see api/lib/static-cache.ts).
const indexHandler =
  config.env === "production"
    ? productionIndexHandler("dist/index.html")
    : (await import("@/public/index.html")).default;

// Elysia's own `/*`. In dev the document goes out through Bun's native routes (below), so this one
// answers only what the carve-outs hand back: a missing asset gets the production 404.
const spaCatchAll =
  config.env === "production"
    ? indexHandler
    : developmentIndexHandler(indexHandler);

// Since Elysia 1.4.30 an HTMLBundle reaches Bun's native router only on a route with no hook
// (createNativeStaticHandler checks the pipeline before isHTMLBundle), and every route here inherits
// helmet and the locale hooks, so `.get("/*", indexHandler)` in dev answers "{}" for every SPA
// path. Dev registers the bundle straight on Bun's routes table instead, GET only, with a
// carve-out for each entry of public/ (favicons, /assets/*), for /api and for the OAuth discovery
// documents, so those still reach Elysia. Served natively, the dev document carries no helmet
// headers; API responses do, and so does the production document, whose handler is a plain function.
const devSpaRoutes: Record<string, false | unknown> =
  config.env === "production"
    ? {}
    : {
        ...Object.fromEntries(
          (await readdir("public", { withFileTypes: true }))
            .filter(
              (entry) => !["index.html", "index.css"].includes(entry.name),
            )
            .map((entry) => [
              entry.isDirectory() ? `/${entry.name}/*` : `/${entry.name}`,
              false,
            ]),
        ),
        "/.well-known/*": false,
        "/*": { GET: indexHandler },
      };

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
        ...devSpaRoutes,
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
    .onAfterResponse(({ request, route, set }) => {
      logger.info(
        "%s %s [%s]",
        request.method,
        loggedUrl(request.url, route),
        set.status,
      );
    })
    .onAfterHandle(applyStaticCacheControl)
    // NOTE: AppErrors carry their HTTP status and log at warn (expected control flow). The message is
    // localized from Accept-Language because the request ALS may not be in scope here.
    // Registered BEFORE the limiters: an AppError comes from a matched route that was already charged,
    // and the plugin's own `onError` cannot tell our NotFoundError from a missing route, so it would
    // charge again and can turn an admitted 404 into a 429.
    .onError(({ path, route, error, request, set }) => {
      if (!(error instanceof AppError)) return;
      logger.warn("%s %s", loggedPath(path, route), error.message);
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
    .use(webhookAuthFailureLimitMiddleware())
    // NOTE: registered AFTER the limiters on purpose. A request rejected before its handler is charged
    // from the plugin's own `onError`, and Elysia stops at the first error handler that returns a
    // value, so answering NOT_FOUND or VALIDATION before the plugin would leave them uncharged.
    // Framework refusals such as PARSE return `undefined` below, so they reach the plugin either way.
    .onError(({ path, route, error, request, set }) => {
      const logged = loggedPath(path, route);
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
          logger.error(line, logged, refusal.log);
        } else {
          logger.warn(line, logged, refusal.log);
        }
        set.status = refusal.status;
        return Response.json(refusal.body, { status: refusal.status });
      }

      logger.error("%s\n%s", logged, error);

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
      // text reaches the log above and never the client, in development too: a dev server receiving
      // Chatwoot webhooks is reachable from outside. Decided from the thrown value, not from
      // `code`, which any library can set (see api/lib/unhandled-error.ts).
      if (isFrameworkRefusal(error)) return;
      // NOTE: `set.status` too: the access log reads it, and Elysia seeds it from the thrown value's
      // own `status`, so an error carrying `status: 401` would be answered 500 but logged as 401.
      set.status = 500;
      return new Response("Something went wrong", { status: 500 });
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
    .get("/*", spaCatchAll);

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
