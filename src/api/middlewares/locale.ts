import Elysia from "elysia";
import { getLocaleFromHeader, requestContext } from "@/api/lib/i18n";
import { enterWorkLabel } from "@/lib/work-label";

export const localeMiddleware = new Elysia({ name: "locale" })
  .onRequest(({ request }) => {
    const startedAt = Date.now();
    const acceptLanguage = request.headers.get("accept-language");
    const locale = getLocaleFromHeader(acceptLanguage);
    requestContext.enterWith({ locale, startedAt, signal: request.signal });
  })
  // The matched route (its pattern, never the ids in the path), for a statement that times out while
  // serving it (docs/logs.md, "Database"). Entered once the route is known, in the first transform
  // hook, so the session and API-key lookups the tenancy `derive` runs after it carry it too.
  .onTransform({ as: "global" }, ({ request, route }) => {
    enterWorkLabel(`${request.method} ${route}`);
  });
