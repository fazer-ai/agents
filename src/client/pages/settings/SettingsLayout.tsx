import { KeyRound, Server, SlidersHorizontal, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";
import { PageContainer } from "@/client/components";
import { cn } from "@/client/lib/utils";

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
    <PageContainer size="wide" className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl text-text-primary">
          {t("settings.title", "Settings")}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {t("settings.subtitle", "Manage your account and preferences")}
        </p>
      </header>

      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        <nav
          aria-label={t("settings.sections", "Settings sections")}
          // NOTE: on a phone every section stays visible as a column (icon over label) that grows
          // from its own label width, instead of a strip that scrolls with no hint that more
          // sections exist past the edge. Content-sized, not equal, so a long label is not the one
          // cut.
          className="flex gap-1 md:w-48 md:shrink-0 md:flex-col"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  cn(
                    "flex min-w-0 flex-auto flex-col items-center gap-1 rounded-md px-1 py-2 font-medium text-xs transition-colors md:flex-none md:flex-row md:gap-2 md:px-2.5 md:py-1.5 md:text-sm",
                    {
                      "bg-bg-hover text-text-primary": isActive,
                      "text-text-muted hover:bg-bg-tertiary hover:text-text-primary":
                        !isActive,
                    },
                  )
                }
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="max-w-full truncate">
                  {/* biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above TABS */}
                  {t(tab.labelKey)}
                </span>
              </NavLink>
            );
          })}
        </nav>

        <div className="flex min-w-0 max-w-2xl flex-1 flex-col gap-8">
          <Outlet />
        </div>
      </div>
    </PageContainer>
  );
}
