import { useAuth } from "@/client/contexts/AuthContext";
import { useTenantList } from "@/client/hooks/useTenantList";

// The active tenant's display name (e.g. for the {{nome_empresa}} preview variable). A tenant-scoped
// user gets it straight from /auth/me (user.tenantName). A SUPER_ADMIN has tenantId null, /auth/me
// returns tenantName null by design, and drives a client-side tenant selector, so we resolve the
// SELECTED tenant's name from the tenant list, the same read the header switcher makes. Returns null
// while still resolving (or when no tenant is selected).
export function useActiveTenantName(): string | null {
  const { user } = useAuth();
  const direct = user?.tenantName ?? null;
  const isSuper = user?.role === "SUPER_ADMIN" && user.tenantId === null;
  const { tenants, activeId } = useTenantList(isSuper);
  if (!isSuper) return direct;
  return tenants.find((tn) => tn.id === activeId)?.name ?? null;
}
