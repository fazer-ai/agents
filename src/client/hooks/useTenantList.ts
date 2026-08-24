import { useEffect, useState } from "react";
import {
  getActiveTenantId,
  reconcileActiveTenantId,
  TENANTS_CHANGED_EVENT,
} from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";

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

  useEffect(() => {
    if (!enabled) return;
    let on = true;
    const fetchTenants = () => {
      api.api.v1.tenants
        .get()
        .then(({ data, error }) => {
          // NOTE: a read that failed is not the empty list. Reconciling against it would clear a
          // perfectly good selection on any server blip, and the operator would lose the tenant they
          // were working in every time the connection hiccuped.
          if (!on || error || !data) return;
          setTenants(data.tenants);
          setActiveId(reconcileActiveTenantId(data.tenants.map((tn) => tn.id)));
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
