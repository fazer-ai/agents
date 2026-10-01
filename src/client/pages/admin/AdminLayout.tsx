import { Building2, Palette, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import { SectionLayout } from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";

// Admin shell, the same as Settings (SectionLayout). The Tenants and Branding sections are
// SUPER_ADMIN-only (a TENANT_ADMIN has a single tenant and branding is fleet-global), so a tenant
// admin gets no section links, just the Users view scoped to their tenant.
// t('admin.tabUsers', 'Users')
// t('admin.tabTenants', 'Tenants')
// t('admin.tabBranding', 'Branding')
const TABS = [
  { to: "/admin/users", labelKey: "admin.tabUsers", icon: Users },
  { to: "/admin/tenants", labelKey: "admin.tabTenants", icon: Building2 },
  { to: "/admin/branding", labelKey: "admin.tabBranding", icon: Palette },
];

export function AdminLayout() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === "SUPER_ADMIN";

  return (
    <SectionLayout
      title={t("admin.title", "Admin Panel")}
      subtitle={
        isSuperAdmin
          ? t("admin.subtitleFleet", "Manage users, tenants and branding")
          : t("admin.subtitleTenant", "Manage who has access to this tenant")
      }
      navLabel={t("admin.sections", "Admin sections")}
      tabs={
        isSuperAdmin
          ? TABS.map((tab) => ({
              to: tab.to,
              icon: tab.icon,
              // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above TABS
              label: t(tab.labelKey),
            }))
          : null
      }
      contentClassName="gap-6"
    >
      <Outlet />
    </SectionLayout>
  );
}
