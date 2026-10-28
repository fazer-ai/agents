import { LayoutDashboard } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import { EmptyState, PageContainer, ProGate } from "@/client/components";

// Dashboards in the Free edition: the menu item stays, and every address under /dashboards shows what
// the feature is with an upgrade gate in place of the panels.
export function DashboardsRoutes() {
  const { t } = useTranslation();
  return (
    <PageContainer className="space-y-6">
      <header>
        <h1 className="text-text-primary text-2xl font-bold">
          {t("dashboards.title", "Dashboards")}
        </h1>
        <p className="text-text-secondary mt-1 text-sm">
          {t(
            "dashboards.subtitle",
            "Panels you arrange yourself over your conversations and AI usage, each at its own address.",
          )}
        </p>
      </header>
      <EmptyState
        icon={LayoutDashboard}
        title={t("dashboards.proTitle", "Dashboards are a Pro feature")}
        description={t(
          "upgrade.dashboards.description",
          "Build your own dashboards (conversations by attribute, label or outcome, AI cost by model) and share each one by its address. Upgrade to Pro to create them.",
        )}
        action={<ProGate feature="dashboards" size="md" />}
      />
    </PageContainer>
  );
}

// The public address of a dashboard leads nowhere in the Free edition, which has no dashboards to open.
export function PublicDashboardRoute(_props: { tv?: boolean }) {
  return <Navigate to="/" replace />;
}

// The TV mode of a dashboard, which the Free edition has none of, opens the gate under /dashboards.
// biome-ignore lint/plugin/require-page-container: a redirect, it renders no page.
export function DashboardTvRoute() {
  return <Navigate to="/dashboards" replace />;
}
