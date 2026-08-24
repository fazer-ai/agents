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

// Reconcile the stored selection against the AUTHORITATIVE list of tenants, returning the id that
// survives (null when nothing is selected any more).
//
// The stored id is the one piece of tenant state that lives in the browser, so it outlives the
// tenant it names: delete that tenant, or point the console at another database, and every request
// keeps carrying a selector for something that is not there. Before this, both readers of the list
// answered the question and neither acted on it: the header switcher fell back to its "Select
// tenant" label, which reads exactly like "you have not picked one yet", the one state it is not.
//
// Only ever called with a list that was actually READ. A failed fetch must not reach here, because
// an empty list is the claim "there are no tenants", and treating a read we could not make as that
// claim would drop a perfectly good selection on any server blip.
export function reconcileActiveTenantId(tenantIds: string[]): string | null {
  // Read at call time, not captured when the request went out: a deep link may have switched the
  // selection while the list was in flight, and that newer choice is not this answer's to discard.
  const active = getActiveTenantId();
  if (!active || tenantIds.includes(active)) return active;
  setActiveTenantId(null);
  return null;
}
