import { Elysia } from "elysia";
import { translate } from "@/api/lib/i18n";
import config from "@/config";

export function parseOrigins(originsStr: string): (string | RegExp)[] {
  return originsStr
    .split(",")
    .map((origin) => origin.trim())
    .filter((trimmed) => trimmed.length > 0)
    .map((trimmed) => {
      if (trimmed.startsWith("/") && trimmed.endsWith("/")) {
        try {
          return new RegExp(trimmed.slice(1, -1));
        } catch (err) {
          throw new Error(
            `Invalid regex in CORS_ORIGIN: ${trimmed} (${(err as Error).message})`,
          );
        }
      }
      return trimmed;
    });
}

const allowedPatterns = parseOrigins(config.corsOrigin);

// `CORS_ORIGIN` is written without a scheme (`localhost:3000`), but
// the browser's `Origin` request header always includes one
// (`http://localhost:3000`). Strip the scheme on the way in so the same
// allowlist works for both forms.
const stripScheme = (s: string) => s.replace(/^https?:\/\//i, "");

// Server-side origin check for the WebSocket handshake. CORS already
// covers regular HTTP requests in the browser, but WS upgrade behavior has
// historically varied across browsers, so we re-check here. In non-production
// the check is permissive (mirrors the `cors()` default with no args); in
// production the `Origin` header is required and must match `CORS_ORIGIN`.
export function isOriginAllowed(origin: string | null): boolean {
  if (config.env !== "production") return true;
  if (!origin) return false;
  const stripped = stripScheme(origin);
  for (const pattern of allowedPatterns) {
    if (typeof pattern === "string") {
      if (origin === pattern || stripped === pattern) return true;
    } else if (pattern.test(origin) || pattern.test(stripped)) {
      return true;
    }
  }
  return false;
}

// Mirrors the `requireAuth` macro shape in `auth.ts`. Returning a
// `beforeHandle` from a macro lets us reject the upgrade without fighting
// the WS `response` schema's type inference (which would otherwise force
// any inline `beforeHandle` return to match the message shape).
export const originPlugin = new Elysia({ name: "origin" }).macro({
  requireAllowedOrigin(enabled: boolean) {
    if (!enabled) return;
    return {
      beforeHandle({ request, set }) {
        if (!isOriginAllowed(request.headers.get("Origin"))) {
          set.status = 403;
          return { error: translate("errors.forbidden", "Forbidden") };
        }
      },
    };
  },
});
