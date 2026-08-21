import config from "@/config";
import { CONSOLE_ROUTES, SWITCH_TENANT_PARAM } from "@/lib/console-params";

// The console links an MCP answer hands back to the operator, so the two things that make such a
// link work are decided in one place instead of at each call site.
//
// A link needs to name its TENANT. The console resolves the tenant from `localStorage`, never from
// the URL, so a link that carries only a record id resolves against whatever the recipient's browser
// happens to have selected. A fleet-level MCP session picks its tenant per call, so the two diverge
// as a matter of course, and the operator lands on another tenant's list with nothing on screen
// connecting the two (issue #151). The parameter is inert for a tenant-scoped user, since the
// backend already ignores `X-Tenant-Id` for anyone but a SUPER_ADMIN, so the same URL is correct for
// both.
//
// A link also needs to name a route that EXISTS. `/vault` and `/integrations` are not routes: the
// vault panel is `/resources/vault` and integrations is `/resources/integrations` (`App.tsx`), and
// the `path="*"` catch-all redirects to `/`. So two of the four links we hand out dropped the
// operator on the dashboard with no explanation.
//
// The parameter name and the route names live in `@/lib/console-params`, which imports nothing: this
// module needs `config`, and `config` cannot reach the browser (`docs/frontend-env-vars.md`), so a
// constant shared through here would drag the whole server config into the SPA bundle.

export function consoleUrl(
  path: string,
  opts: { tenantId?: bigint | null } = {},
): string {
  const baseUrl = config.publicUrl.replace(/\/+$/, "");
  const rel = path.startsWith("/") ? path : `/${path}`;
  if (opts.tenantId == null) return `${baseUrl}${rel}`;
  const sep = rel.includes("?") ? "&" : "?";
  return `${baseUrl}${rel}${sep}${SWITCH_TENANT_PARAM}=${opts.tenantId}`;
}

// Open the vault list for this tenant, with the fill modal for one pending entry already open.
//
// NOTE: `tenantId` is nullable because `TenantContext` is: a SUPER_ADMIN session with no tenant
// selected has none to name. Such a link is the old, tenant-less one, which is the honest answer —
// there is no tenant to switch the console to.
export function vaultFillUrl(
  tenantId: bigint | null,
  entryId: bigint | number | string,
) {
  return consoleUrl(`${CONSOLE_ROUTES.vault}?fill=${entryId}`, { tenantId });
}

// Open the vault list for this tenant, so the operator can create the entry the tool asked for.
export function vaultCreateUrl(tenantId: bigint | null) {
  return consoleUrl(CONSOLE_ROUTES.vault, { tenantId });
}

export function integrationsUrl(tenantId: bigint | null) {
  return consoleUrl(CONSOLE_ROUTES.integrations, { tenantId });
}
