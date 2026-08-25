import { useEffect, useRef, useState } from "react";
import {
  getActiveTenantId,
  reconcileActiveTenantId,
  TENANTS_CHANGED_EVENT,
} from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import { reloadOntoSafeRoute } from "@/client/lib/tenantSwitch";

// The SUPER_ADMIN's tenant list, plus the selection that survives it.
//
// One hook rather than a fetch per consumer because the two are the same question asked twice: both
// the header switcher and the active-tenant name look the stored id up in this list, and before this
// each of them answered "not in the list" with its own silent fallback. Reconciling in one place is
// what keeps the next reader of the list from inheriting that.
//
// `enabled` is false for a tenant-scoped user, who has no selector to reconcile and may not read the
// fleet list at all.

type TenantsData = Awaited<ReturnType<typeof api.api.v1.tenants.get>>["data"];
export type TenantListEntry = NonNullable<TenantsData>["tenants"][number];

export interface TenantList {
  tenants: TenantListEntry[];
  // The stored selection, after reconciliation: null once it names a tenant the list does not have.
  activeId: string | null;
}

export function useTenantList(enabled: boolean): TenantList {
  const [tenants, setTenants] = useState<TenantListEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() =>
    getActiveTenantId(),
  );
  // Reads overlap: the one on mount and the one a tenant creation triggers are the same request to
  // the same URL, and nothing orders their answers. An older answer landing last describes a fleet
  // that no longer exists, and acting on it here is destructive in a way a stale label never was: it
  // would clear a selection the newer answer had just confirmed, and reload on top of that. Same
  // guard, and for the same reason, as TenantDeepLink.
  const readId = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let on = true;
    const fetchTenants = () => {
      const id = ++readId.current;
      api.api.v1.tenants
        .get()
        .then(({ data, error }) => {
          // NOTE: a read that failed is not the empty list. Reconciling against it would clear a
          // perfectly good selection on any server blip, and the operator would lose the tenant they
          // were working in every time the connection hiccuped.
          if (!on || id !== readId.current || error || !data) return;
          setTenants(data.tenants);
          const { activeId: surviving, cleared } = reconcileActiveTenantId(
            data.tenants.map((tn) => tn.id),
          );
          setActiveId(surviving);
          // NOTE: this hook mounts in the header, alongside the routed page, so by the time the list
          // comes back that page has already issued its own requests carrying the dead selector, and
          // clearing storage neither remounts nor retries them: a one-shot loader stays in its error
          // state until the operator retries it by hand. A full reload is what a tenant SWITCH
          // already does for the same reason (see TenantSwitcher), and the effective tenant changing
          // out from under the console is the same kind of event, down to landing off a detail route
          // whose id belonged to the tenant that is gone. It cannot loop: nothing is stored any more,
          // so the next reconciliation returns early with cleared false.
          if (cleared) reloadOntoSafeRoute();
        })
        .catch(() => {});
    };
    fetchTenants();
    // A tenant created elsewhere (CreateTenantModal) becomes selectable without a full reload.
    window.addEventListener(TENANTS_CHANGED_EVENT, fetchTenants);
    return () => {
      on = false;
      window.removeEventListener(TENANTS_CHANGED_EVENT, fetchTenants);
    };
  }, [enabled]);

  return { tenants, activeId };
}
