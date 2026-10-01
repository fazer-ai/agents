import { Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Navigate } from "react-router";
import { Badge, Card, ProGate, Skeleton } from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { formatDate } from "@/client/lib/utils";

// Single-tenant Tenants tab: lists the tenant created at /setup, read-only, with an upgrade gate
// where multi-tenant management would be. Creating and managing multiple tenants requires Pro.
type TenantsData = Awaited<
  ReturnType<typeof api.api.admin.tenants.get>
>["data"];
type TenantRow = NonNullable<TenantsData>["tenants"][number];

const TENANT_SKELETON_KEYS = ["tenant-0", "tenant-1", "tenant-2"];

export function AdminTenantsPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.api.admin.tenants.get();
      if (data) setTenants(data.tenants);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchTenants();
  }, [fetchTenants]);

  // The Tenants tab is fleet-level; a tenant admin has no business here.
  if (user && user.role !== "SUPER_ADMIN") {
    return <Navigate to="/admin/users" replace />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <ProGate
          feature="multiTenant"
          triggerLabel={t("admin.createTenant", "Create tenant")}
        />
      </div>

      <Card>
        {loading ? (
          <div className="py-2" role="status">
            <span className="sr-only">{t("common.loading", "Loading…")}</span>
            {TENANT_SKELETON_KEYS.map((key) => (
              <div
                key={key}
                className="flex items-center gap-4 border-border/50 border-b px-2 py-3"
              >
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-4 w-8" />
                <Skeleton className="h-4 w-24" />
                <Skeleton className="ml-auto h-7 w-28 rounded" />
              </div>
            ))}
          </div>
        ) : tenants.length === 0 ? (
          <p className="py-10 text-center text-sm text-text-muted">
            {t("tenant.none", "No tenants yet.")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border border-b text-left">
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("tenant.name", "Name")}
                  </th>
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("tenant.slug", "Slug")}
                  </th>
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("admin.users", "Users")}
                  </th>
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("admin.createdAt", "Created")}
                  </th>
                  <th className="px-2 py-3 font-medium text-text-secondary">
                    {t("admin.actions", "Actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => (
                  <tr
                    key={tenant.id}
                    className="border-border/50 border-b hover:bg-bg-tertiary/50"
                  >
                    <td className="px-2 py-3 text-text-primary">
                      <span className="flex items-center gap-2">
                        {tenant.name}
                        {tenant.demoMode && (
                          <Badge variant="secondary">
                            {t("tenant.demo", "Demo")}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-3 font-mono text-text-secondary text-xs">
                      {tenant.slug}
                    </td>
                    <td className="px-2 py-3 text-text-secondary">
                      {tenant.userCount}
                    </td>
                    <td className="px-2 py-3 text-text-secondary">
                      {formatDate(tenant.createdAt)}
                    </td>
                    <td className="px-2 py-3">
                      <div className="flex items-center gap-1">
                        <Link
                          to={`/admin/users?tenant=${tenant.id}`}
                          className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-medium text-text-secondary text-xs transition-colors hover:bg-bg-hover hover:text-text-primary"
                        >
                          <Users className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("admin.viewUsers", "View users")}
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
