import { useAuth } from "@/client/contexts/AuthContext";
import { useTenantList } from "@/client/hooks/useTenantList";

interface NamedUser {
  role?: string;
  tenantId?: string | null;
  tenantName?: string | null;
}

// Whether this session has to be TOLD which tenant it is looking at. A SUPER_ADMIN has no home
// tenant, so the answer lives in a client-side selector and has to be resolved against the fleet
// list; everyone else carries their tenant on the session itself and must not read that list at all.
export function isFleetSession(user: NamedUser | null | undefined): boolean {
  return user?.role === "SUPER_ADMIN" && user.tenantId === null;
}

// The active tenant's display name (e.g. for the {{nome_empresa}} preview variable), from whichever
// of the two sources this session actually has. Null while it is still being resolved, and null when
// a fleet session has nothing selected, which are the same thing to the caller: no name to show yet.
export function resolveActiveTenantName(
  user: NamedUser | null | undefined,
  tenants: { id: string; name: string }[],
  activeId: string | null,
): string | null {
  if (!isFleetSession(user)) return user?.tenantName ?? null;
  return tenants.find((tn) => tn.id === activeId)?.name ?? null;
}

export function useActiveTenantName(): string | null {
  const { user } = useAuth();
  const { tenants, activeId } = useTenantList(isFleetSession(user));
  return resolveActiveTenantName(user, tenants, activeId);
}
