import { KeyRound, Server, SlidersHorizontal, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Outlet } from "react-router";
import { SectionLayout } from "@/client/components";

// t('settings.title', 'Settings')
// t('settings.subtitle', 'Manage your account and preferences')
// t('settings.sections', 'Settings sections')
// t('settings.profile', 'Profile')
// t('settings.security', 'Security')
// t('settings.preferences', 'Preferences')
// t('settings.mcp', 'MCP')
const TABS = [
  { to: "/settings/profile", labelKey: "settings.profile", icon: UserRound },
  { to: "/settings/security", labelKey: "settings.security", icon: KeyRound },
  {
    to: "/settings/preferences",
    labelKey: "settings.preferences",
    icon: SlidersHorizontal,
  },
  { to: "/settings/mcp", labelKey: "settings.mcp", icon: Server },
];

export function SettingsLayout() {
  const { t } = useTranslation();

  return (
    <SectionLayout
      title={t("settings.title", "Settings")}
      subtitle={t("settings.subtitle", "Manage your account and preferences")}
      navLabel={t("settings.sections", "Settings sections")}
      tabs={TABS.map((tab) => ({
        to: tab.to,
        icon: tab.icon,
        // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above TABS
        label: t(tab.labelKey),
      }))}
      contentClassName="max-w-2xl gap-8"
    >
      <Outlet />
    </SectionLayout>
  );
}
