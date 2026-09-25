// The selected tenant, sent as X-Tenant-Id on every API call: any tenant for a SUPER_ADMIN, one of
// the person's memberships for everyone else (issue #756). The backend refuses a selector outside
// what the session may reach and names it on the refusal, which is how a stale value (another
// person's, on a shared browser, or a membership since removed) gets dropped
// (src/client/lib/tenantSelectorRecovery.ts).
//
// Remembered PER TAB, with the last choice as the default for a new one: sessionStorage is the tab's
// own, localStorage what the next tab starts from. One shared value would make choosing a tenant in
// one tab move every other tab to it on their next request, under pages built for the old one.

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
// next request to another tenant under a page built for the first one (review round 1, #756).
export function pinTabTenantId(id: string): void {
  const tab = tabStore();
  if (tab && tab.getItem(KEY) === null) tab.setItem(KEY, id);
}

// What the tab does with the tenant a fresh session reports, a function rather than inline in the
// AuthProvider so the rule can be tested (the provider is module-mocked across the client suite).
//
// A SUPER_ADMIN gets the fleet's first tenant as a default, only when nothing is selected, so the
// console opens on a real tenant instead of an empty dashboard and a deliberate switch is never
// overridden. A person's session ran under the membership the server resolved, and this tab keeps it,
// so a choice made in another tab cannot move it (issue #756).
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
