import { suppressUnloadPrompt } from "@/client/lib/unsavedGuard";

// Switching the active tenant does a full reload (the single TOCTOU-safe source of truth). On a
// detail route whose id belongs to the OLD tenant (e.g. /agents/<id>), that id won't exist in the new
// tenant, so reloading in place lands on an error page. tenantSwitchTarget maps such a route to its
// list root; non-detail routes return null (reload in place is correct). Extend DETAIL_ROOTS as new
// id-bearing routes appear ("repetir de acordo com o contexto").
const DETAIL_ROOTS: { pattern: RegExp; root: string }[] = [
  // /agents/:id and /agents/:id/:tab -> /agents
  { pattern: /^\/agents\/[^/]+(?:\/[^/]+)?\/?$/, root: "/agents" },
  // /conversations/:id -> /conversations
  { pattern: /^\/conversations\/[^/]+\/?$/, root: "/conversations" },
];

// Given the current pathname, returns the list root to navigate to after a tenant switch, or null when
// the current route is safe to reload in place (a list, a global/admin page, the dashboard).
export function tenantSwitchTarget(pathname: string): string | null {
  for (const { pattern, root } of DETAIL_ROOTS) {
    if (pattern.test(pathname)) return root;
  }
  return null;
}

// Take the console to a page that survives the effective tenant changing under it, and get out of
// the way of the native unload prompt while doing it.
//
// Three things change the effective tenant, and they were spelling this out separately: the operator
// switching (TenantSwitcher), the fleet list reconciling a selection that is gone (useTenantList),
// and a request coming back refused (tenantSelectorRecovery). Only the first one mapped a detail
// route to its list root, so the other two reloaded `/agents/<id>` in place — and the id belongs to a
// tenant that is not there, which lands on an error page instead of a working list.
export function reloadOntoSafeRoute(): void {
  suppressUnloadPrompt();
  const target = tenantSwitchTarget(window.location.pathname);
  // `assign` is still a full reload, so the TOCTOU-safe single-source-of-truth invariant holds.
  if (target) window.location.assign(target);
  else window.location.reload();
}
