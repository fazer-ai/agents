import { treaty } from "@elysiajs/eden";
import type { App } from "@/app";
import { getActiveTenantId } from "@/client/lib/activeTenant";
import i18n from "@/client/lib/i18n";
import { noteServerDate } from "@/client/lib/serverClock";
import { recoverFromRejectedSelector } from "@/client/lib/tenantSelectorRecovery";

// NOTE: `parseDate: false` disables Eden treaty's default JSON reviver that
// auto-converts any string matching an ISO 8601 / RFC 1123 / dd-mm-yyyy regex
// into a `Date`. The conversion is invisible to the type system (Eden infers
// the wire-format shape, where `Date` already flattens to `string`), so call
// sites like `typeof v.expiresAt === "string"` silently start rejecting valid
// responses, and React effects with date fields in deps fire on every fetch
// because each parse yields a new `Date` instance. Keep this `false` and
// always treat date fields on the client as ISO strings. See `docs/eden-treaty.md`.
export const api = treaty<App>(window.location.origin, {
  headers: () => {
    const headers: Record<string, string> = {
      "Accept-Language": i18n.language,
    };
    // SUPER_ADMIN target tenant; honored server-side only for SUPER_ADMIN (anomaly-logged + ignored
    // otherwise), so sending it unconditionally is safe.
    const tenantId = getActiveTenantId();
    if (tenantId) headers["X-Tenant-Id"] = tenantId;
    return headers;
  },
  onResponse: (response) => {
    // First and unconditional: a 401 and a 429 carry the same `Date` as a 200, and the console's
    // debug-window deadline is judged against the server's clock, not the browser's.
    noteServerDate(response);
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent("auth:unauthorized"));
    } else if (response.status === 429) {
      // Surfaced as a coalesced global toast (see GlobalApiToasts) so every page gets clear
      // rate-limit feedback, not just the ones that read err.status into a DataBoundary.
      window.dispatchEvent(new CustomEvent("api:rate-limited"));
    } else {
      // NOTE: keyed on the header the boundary sets and never on the status: a 404 is also how an
      // agent, a document or a tenant the page NAMED comes back missing, and none of those says
      // anything about what the browser is holding. `mediaFetch` answers the same header.
      recoverFromRejectedSelector(response);
    }
  },
  parseDate: false,
});
