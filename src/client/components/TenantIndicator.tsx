import { Building2 } from "lucide-react";
import {
  MembershipSwitcher,
  TenantSwitcher,
} from "@/client/components/TenantSwitcher";
import { useAuth } from "@/client/contexts/AuthContext";

// A SUPER_ADMIN gets the target-tenant switcher, a person who belongs to several tenants gets one over
// their memberships (issue #756), and everyone else sees the tenant-name badge.
export function TenantIndicator() {
  const { user } = useAuth();
  if (user?.role === "SUPER_ADMIN") return <TenantSwitcher />;
  if (user?.tenants && user.tenants.length > 1) {
    return (
      <MembershipSwitcher tenants={user.tenants} activeId={user.tenantId} />
    );
  }
  return user?.tenantName ? (
    <span className="hidden items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-2 py-1.5 text-sm text-text-secondary sm:inline-flex">
      <Building2 className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="max-w-50 truncate">{user.tenantName}</span>
    </span>
  ) : null;
}
