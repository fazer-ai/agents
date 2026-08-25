// The SUPER_ADMIN's selected target tenant, sent as X-Tenant-Id on every API call. The backend
// honors it ONLY for SUPER_ADMIN (it logs an anomaly + ignores it for anyone else), so a stale
// value in a non-super browser is harmless. Persisted so a reload keeps the selection.

const KEY = "@app:active-tenant";

export function getActiveTenantId(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem(KEY);
}

export function setActiveTenantId(id: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(KEY, id);
  else localStorage.removeItem(KEY);
}

// The set of selectable tenants changed (a tenant was created). Components that cache the list
// (the header TenantSwitcher) listen for this to refetch without a full reload, so a freshly
// created tenant becomes selectable immediately.
export const TENANTS_CHANGED_EVENT = "tenants:changed";

export function notifyTenantsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TENANTS_CHANGED_EVENT));
}

// Reconcile the stored selection against the AUTHORITATIVE list of tenants, reporting the id that
// survives and whether a selection was dropped.
//
// The stored id is the one piece of tenant state that lives in the browser, so it outlives the
// tenant it names: delete that tenant, or point the console at another database, and every request
// keeps carrying a selector for something that is not there. Before this, both readers of the list
// answered the question and neither acted on it: the header switcher fell back to its "Select
// tenant" label, which reads exactly like "you have not picked one yet", the one state it is not.
//
// `cleared` is separate from a null `activeId` because the two mean different things to a caller. A
// null id is also the ordinary state of a fleet operator who has not picked a tenant yet; `cleared`
// is an event, and it is the only one that says the pages currently on screen were built against a
// tenant that is not there.
//
// Only ever called with a list that was actually READ. A failed fetch must not reach here, because
// an empty list is the claim "there are no tenants", and treating a read we could not make as that
// claim would drop a perfectly good selection on any server blip.
export function reconcileActiveTenantId(tenantIds: string[]): {
  activeId: string | null;
  cleared: boolean;
} {
  // Read at call time, not captured when the request went out: a deep link may have switched the
  // selection while the list was in flight, and that newer choice is not this answer's to discard.
  const active = getActiveTenantId();
  if (!active || tenantIds.includes(active))
    return { activeId: active, cleared: false };
  setActiveTenantId(null);
  return { activeId: null, cleared: true };
}

// The same question `reconcileActiveTenantId` asks at page load, asked by a single REFUSED REQUEST.
//
// The list-based reconciliation only runs on mount, so everything that kills a tenant mid-session is
// invisible to it: deleted from another tab or by another operator, `tenant_delete` over MCP, the
// console pointed at a different database. This path finds out on the next request instead of on the
// next page load, from the id the boundary names (REJECTED_TENANT_SELECTOR_HEADER).
//
// Answers whether the refusal is about the selection THIS window is running under. A DIFFERENT id is
// not: the request went out under the old selection and came back after the operator had already
// switched to a live tenant, and that newer choice is not this answer's to discard — the same reason
// the reconciliation reads storage at call time rather than capturing it.
//
// Nothing stored still counts as ours, and that case is the multi-tab one: localStorage is shared
// across tabs, so another tab may have cleared it while this one was still rendered against that
// tenant and still sending it. Reading null as "someone else handled it" is what would leave that tab
// on screen, sending no selector at all. What keeps the reload to one per window is
// src/client/lib/tenantSelectorRecovery.ts, which is window state and not this.
export function dropRejectedSelection(rejectedId: string): boolean {
  const active = getActiveTenantId();
  if (active !== null && active !== rejectedId) return false;
  setActiveTenantId(null);
  return true;
}
