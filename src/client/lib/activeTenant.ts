// The selected tenant, sent as X-Tenant-Id on every API call: any tenant for a SUPER_ADMIN, one of
// the person's memberships for everyone else. The backend refuses a selector outside what the
// session may reach and names it, which is how a stale value gets dropped (tenantSelectorRecovery.ts).
// Remembered PER TAB, with the last choice as a new tab's default: sessionStorage is the tab's own,
// localStorage what the next tab starts from. One shared value would move every other tab to a newly
// chosen tenant on their next request, under pages built for the old one.

const KEY = "@app:active-tenant";

function tabStore(): Storage | null {
  return typeof sessionStorage === "undefined" ? null : sessionStorage;
}

function sharedStore(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function getActiveTenantId(): string | null {
  const tab = tabStore();
  const own = tab?.getItem(KEY) ?? null;
  if (own !== null) return own;
  // A tab that has not chosen starts from the last choice and KEEPS it: pinned to the tab on first
  // read, so a later choice in another tab does not move this one.
  const inherited = sharedStore()?.getItem(KEY) ?? null;
  if (inherited !== null) tab?.setItem(KEY, inherited);
  return inherited;
}

// Pins the tenant THIS TAB is running under without making it the next tab's default. For a person
// whose session resolved their default membership with no selection stored: until the tab holds that
// id, it keeps inheriting the shared default, and a choice made in another tab would move this tab's
// next request to another tenant under a page built for the first one.
export function pinTabTenantId(id: string): void {
  const tab = tabStore();
  if (tab && tab.getItem(KEY) === null) tab.setItem(KEY, id);
}

// What the tab does with the tenant a fresh session reports, a function rather than inline in the
// AuthProvider so the rule can be tested (the provider is module-mocked across the client suite).
// A SUPER_ADMIN gets the fleet's first tenant as a default, only when nothing is selected, so the
// console opens on a real tenant and a deliberate switch is never overridden. A person's session ran
// under the membership the server resolved, and this tab keeps it, so another tab cannot move it.
export function adoptSessionTenant(
  user: { role: string; tenantId: string | null } | null,
  defaultTenantId: string | null,
): void {
  if (!user) return;
  if (user.role === "SUPER_ADMIN") {
    if (defaultTenantId && getActiveTenantId() === null) {
      setActiveTenantId(defaultTenantId);
    }
    return;
  }
  if (user.tenantId) pinTabTenantId(user.tenantId);
}

export function setActiveTenantId(id: string | null): void {
  for (const store of [tabStore(), sharedStore()]) {
    if (!store) continue;
    if (id) store.setItem(KEY, id);
    else store.removeItem(KEY);
  }
}

// The set of selectable tenants changed (a tenant was created). Components that cache the list
// (the header TenantSwitcher) listen for this to refetch without a full reload, so a freshly
// created tenant becomes selectable immediately.
export const TENANTS_CHANGED_EVENT = "tenants:changed";

export function notifyTenantsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TENANTS_CHANGED_EVENT));
}

// Reconcile the stored selection against the AUTHORITATIVE tenant list, reporting the surviving id
// and whether a selection was dropped. The stored id lives in the browser, so it outlives the tenant
// it names (deleted, or the console pointed at another database), and a "Select tenant" fallback
// would read like "not picked yet". `cleared` is separate from a null `activeId`: null is also a
// fleet operator who has not picked, while `cleared` is the event saying the pages on screen were
// built against a tenant that is gone. Only ever called with a list actually READ: an empty list
// claims "there are no tenants", and a failed read taken as that would drop a good selection.
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

// The same question `reconcileActiveTenantId` asks at page load, asked by a single REFUSED REQUEST,
// so a tenant killed mid-session (another tab, `tenant_delete` over MCP, another database) is found
// on the next request, from the id the boundary names (REJECTED_TENANT_SELECTOR_HEADER). Answers
// whether the refusal is about the selection THIS window runs under: a DIFFERENT id is a request
// that went out before the operator switched, and that newer choice is not its to discard. Nothing
// stored still counts as ours: another tab may have cleared the shared value while this one still
// sends it. One reload per window is kept by tenantSelectorRecovery.ts, which is window state.
export function dropRejectedSelection(rejectedId: string): boolean {
  const active = getActiveTenantId();
  if (active !== null && active !== rejectedId) return false;
  setActiveTenantId(null);
  return true;
}
