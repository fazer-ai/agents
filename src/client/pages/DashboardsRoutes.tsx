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
        <h1 className="font-bold text-2xl text-text-primary">
          {t("dashboards.title", "Dashboards")}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
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
          "Build your own dashboards (conversations by event, label or outcome, AI cost by model) and share each one by its address. Upgrade to Pro to create them.",
        )}
        action={<ProGate feature="dashboards" size="md" />}
      />
    </PageContainer>
  );
}

// The public address of a dashboard leads nowhere in the Free edition, which has no dashboards to open.
// biome-ignore lint/plugin/require-page-container: a redirect, it renders no page.
export function PublicDashboardRoute() {
  return <Navigate to="/" replace />;
}
