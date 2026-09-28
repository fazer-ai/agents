import config from "@/config";
import { CONSOLE_ROUTES, SWITCH_TENANT_PARAM } from "@/lib/console-params";

// The console links an MCP answer hands back to the operator. A link names its TENANT, because the
// console resolves the tenant from `localStorage`, not the URL, and a fleet-level MCP session picks
// its tenant per call (the parameter is inert for a tenant-scoped user). A link names a route that
// EXISTS (`/resources/vault`, not `/vault`), since the catch-all redirects to `/`. Parameter and
// route names live in `@/lib/console-params`, which imports nothing, because this module needs
// server `config`.

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
