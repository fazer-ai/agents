import { useCallback, useEffect, useMemo, useState } from "react";
import { getActiveTenantId } from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { canonicalVaultRef, formatVaultRef } from "@/client/lib/credentialRef";

// Derived from the treaty response, never hand-mirrored (see docs/eden-treaty.md).
export type VaultEntry = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.vault.get>>["data"]
>["entries"][number];

// A page can mount several CredentialPickers at once (the Behavior tab alone has STT + vision + TTS,
// plus the model key on General), and each used to fire its own GET /vault on mount. This is a tiny
// shared cache so those collapse into ONE request: a short per-tenant TTL + an in-flight promise that
// concurrent callers await. Keyed by the SUPER_ADMIN active-tenant selector so a stale value is never
// served across tenants (a tenant SWITCH does a full page reload anyway, which clears this).
const TTL_MS = 30_000;

// Bumped by every announced vault change. Clearing the in-flight map does not cancel the request it
// was tracking, so a read that started before the change is still on the wire and still carries the
// vault as it WAS. Landing last, it would overwrite the cache and every listener with pre-mutation
// data — the created credential reading as deleted, for a whole TTL. The generation is what lets
// such an answer be recognised and dropped.
let generation = 0;

type CacheEntry = { entries: VaultEntry[]; at: number };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<VaultEntry[]>>();

// Mounted pickers listen for this to re-read after a create/update/delete (their own or elsewhere),
// so the list stays coherent without each re-fetching independently.
export const VAULT_CHANGED_EVENT = "vault:changed";

function tenantKey(): string {
  return getActiveTenantId() ?? "";
}

function notifyChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
  }
}

async function fetchVault(k: string, startedAt: number): Promise<VaultEntry[]> {
  // The treaty reports a non-2xx by resolving with `data: null`, not by rejecting, so a 500 and an
  // empty vault arrive in the same shape. Callers already treat a rejection as "unknown" (both
  // catch it), and one of them turns an empty list into "no credential resolves", so a failed
  // load must not pass for a successful one.
  const { data, error } = await api.api.v1.vault.get();
  // Overtaken: the vault changed after this read left, so this answer is about a vault that no
  // longer exists and the caller asked what it holds NOW. Checked BEFORE the response is judged,
  // because a superseded FAILURE is just as irrelevant as a superseded list — reported as the
  // caller's own failure it would drive them to "unknown" on top of the fresh list that already
  // arrived, with nothing coming to put it back. Either way they get the current answer instead,
  // from the cache or from the read that replaced this one.
  if (startedAt !== generation) return loadVault();
  if (error || !data) throw new Error("vault load failed");
  const entries = [...data.entries];
  cache.set(k, { entries, at: Date.now() });
  return entries;
}

// Returns the vault list, served from the per-tenant cache when fresh and de-duplicated across
// concurrent callers (the many pickers a page mounts → one GET, not N).
export function loadVault(): Promise<VaultEntry[]> {
  const k = tenantKey();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.entries);
  const pending = inflight.get(k);
  if (pending) return pending;
  // The in-flight entry is cleared by whoever set it, and only while it is still theirs: an
  // invalidation empties the map, and a request that finished after that must not delete the entry
  // belonging to the read that replaced it.
  const p = fetchVault(k, generation).finally(() => {
    if (inflight.get(k) === p) inflight.delete(k);
  });
  inflight.set(k, p);
  return p;
}

// Force a refetch (after a create/update) and notify listeners once the fresh list is in the cache.
//
// Listeners are told either way, and the failure path is the one that needs saying: the caller has
// just CHANGED the vault and usually pointed a field at the result, so a listener left holding the
// pre-change list would answer from a vault that no longer exists — a credential created a moment
// ago reading as deleted. The notification sends them back to `loadVault`, which either gets the
// fresh list or fails again and leaves them at "not loaded", and both of those are honest.
export async function refreshVault(): Promise<VaultEntry[]> {
  // Announce the drop NOW, through the same call every other mutation uses. The caller has just
  // changed the vault and usually pointed a field at the result, so the seconds between dropping
  // the old list and receiving the new one are exactly when a listener still holding the old one
  // reports the created credential as deleted. Waiting for the GET to announce anything is what
  // left that window open.
  invalidateVault();
  try {
    const entries = await loadVault();
    notifyChanged();
    return entries;
  } catch (err) {
    notifyChanged();
    throw err;
  }
}

// Drop cached vault data (after a mutation, e.g. a VaultPanel delete) and notify listeners; the next
// loadVault re-fetches.
export function invalidateVault(): void {
  generation += 1;
  cache.clear();
  inflight.clear();
  notifyChanged();
}

// The base URL a stored `vault:<id>` ref carries, resolved from the vault itself.
//
// Reading it off a CredentialPicker's `onEntryChange` instead made it a property of what is MOUNTED.
// The agent editor renders one tab at a time, so an editor opened straight on Behavior never mounted
// General, never heard about the model credential, and judged the agent as having no endpoint at
// all: a false "endpoint missing" on the speech rewrite, with Save disabled, for a configuration the
// runtime resolves without trouble. A page needs this answer whether or not the field that displays
// it is on screen.
//
// Costs no request: loadVault() is the same shared, de-duplicated read the pickers already do.
export function useVaultBaseUrls(): (ref: string) => string | null {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const load = useCallback(async () => {
    try {
      setEntries(await loadVault());
    } catch {
      // a failed load leaves the list empty, which reads the same as an unresolvable ref
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const onChanged = () => void load();
    window.addEventListener(VAULT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, onChanged);
  }, [load]);
  return useCallback(
    (ref: string) =>
      (ref
        ? entries.find((e) => formatVaultRef(e.id) === canonicalVaultRef(ref))
            ?.baseUrl
        : null) ?? null,
    [entries],
  );
}

// Which refs the vault holds right now, and which of those are still waiting for their secret. Both
// answers come off the same list the pickers already load, and a page needs them whether or not the
// field that displays them is mounted (the agent editor renders one tab at a time but judges the
// whole configuration on every one of them).
//
// `known` is null until the first list lands, and that distinction is the point: an empty set means
// "the vault holds nothing", which would declare every credential on the page unresolvable for the
// one paint between mount and response. `pending` has no such state because the safe direction is
// the opposite — an unfilled credential simply goes unreported until the list arrives.
export function useVaultRefs(): {
  known: Set<string> | null;
  pending: Set<string>;
  pendingEntries: VaultEntry[];
} {
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const load = useCallback(async () => {
    try {
      setEntries(await loadVault());
    } catch {
      // A failed load stays "not loaded": the vault is unknown, not empty.
      setEntries(null);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    // The announcement means the vault CHANGED, so the list in hand is now known to predate it —
    // and whoever changed it has usually just created the credential a field points at. Dropping to
    // not-loaded for the length of the re-read is what keeps that credential from reading as
    // deleted; every mutation in the app comes through here, so this one line covers all of them.
    const onChanged = () => {
      setEntries(null);
      void load();
    };
    window.addEventListener(VAULT_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, onChanged);
  }, [load]);
  const pendingEntries = useMemo(
    () => (entries ?? []).filter((e) => e.status === "pending"),
    [entries],
  );
  return {
    known: useMemo(
      () =>
        entries ? new Set(entries.map((e) => formatVaultRef(e.id))) : null,
      [entries],
    ),
    pending: useMemo(
      () => new Set(pendingEntries.map((e) => formatVaultRef(e.id))),
      [pendingEntries],
    ),
    pendingEntries,
  };
}
