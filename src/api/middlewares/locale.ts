import Elysia from "elysia";
import { getLocaleFromHeader, requestContext } from "@/api/lib/i18n";

export const localeMiddleware = new Elysia({ name: "locale" }).onRequest(
  ({ request }) => {
    const startedAt = Date.now();
    const acceptLanguage = request.headers.get("accept-language");
    const locale = getLocaleFromHeader(acceptLanguage);
    requestContext.enterWith({ locale, startedAt });
  },
);
