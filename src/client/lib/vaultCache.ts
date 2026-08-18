import { useCallback, useEffect, useMemo, useState } from "react";
import { getActiveTenantId } from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { formatVaultRef } from "@/client/lib/credentialRef";

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

async function fetchVault(k: string): Promise<VaultEntry[]> {
  try {
    const { data } = await api.api.v1.vault.get();
    const entries = data ? [...data.entries] : [];
    cache.set(k, { entries, at: Date.now() });
    return entries;
  } finally {
    inflight.delete(k);
  }
}

// Returns the vault list, served from the per-tenant cache when fresh and de-duplicated across
// concurrent callers (the many pickers a page mounts → one GET, not N).
export function loadVault(): Promise<VaultEntry[]> {
  const k = tenantKey();
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.entries);
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = fetchVault(k);
  inflight.set(k, p);
  return p;
}

// Force a refetch (after a create/update) and notify listeners once the fresh list is in the cache.
export async function refreshVault(): Promise<VaultEntry[]> {
  const k = tenantKey();
  cache.delete(k);
  inflight.delete(k);
  const entries = await loadVault();
  notifyChanged();
  return entries;
}

// Drop cached vault data (after a mutation, e.g. a VaultPanel delete) and notify listeners; the next
// loadVault re-fetches.
export function invalidateVault(): void {
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
        ? entries.find((e) => formatVaultRef(e.id) === ref)?.baseUrl
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
    const onChanged = () => void load();
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
