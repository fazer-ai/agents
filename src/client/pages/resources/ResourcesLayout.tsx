import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Blocks,
  BookOpen,
  Clock,
  FileText,
  KeyRound,
  LibraryBig,
  Plug,
  SlidersHorizontal,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet } from "react-router";
import { PageContainer } from "@/client/components";
import { usePendingApprovals } from "@/client/contexts/ApprovalsContext";
import { cn } from "@/client/lib/utils";
import { ResourcesContext } from "./ResourcesContext";

// t('resources.tabs.tools', 'Tools')
// t('resources.tabs.mcp', 'MCP servers')
// t('resources.tabs.knowledge', 'Knowledge')
// t('resources.tabs.documents', 'Document templates')
// t('resources.tabs.hours', 'Hours')
// t('resources.tabs.integrations', 'Integrations')
// t('resources.tabs.vault', 'Vault')
// t('resources.tabs.occurrences', 'Occurrences')
// t('resources.tabs.advanced', 'Advanced')
const TABS: { to: string; labelKey: string; icon: LucideIcon; badge?: true }[] =
  [
    { to: "/resources/tools", labelKey: "resources.tabs.tools", icon: Wrench },
    { to: "/resources/mcp", labelKey: "resources.tabs.mcp", icon: Plug },
    {
      to: "/resources/knowledge",
      labelKey: "resources.tabs.knowledge",
      icon: BookOpen,
      badge: true,
    },
    {
      to: "/resources/documents",
      labelKey: "resources.tabs.documents",
      icon: FileText,
    },
    { to: "/resources/hours", labelKey: "resources.tabs.hours", icon: Clock },
    {
      to: "/resources/integrations",
      labelKey: "resources.tabs.integrations",
      icon: Blocks,
    },
    {
      to: "/resources/vault",
      labelKey: "resources.tabs.vault",
      icon: KeyRound,
    },
    {
      to: "/resources/occurrences",
      labelKey: "resources.tabs.occurrences",
      icon: Activity,
    },
    {
      to: "/resources/advanced",
      labelKey: "resources.tabs.advanced",
      icon: SlidersHorizontal,
    },
  ];

export function ResourcesLayout() {
  const { t } = useTranslation();
  // The pending-suggestions count is owned by the shared ApprovalsProvider (it also feeds the sidebar
  // badge), so the Knowledge tab badge and the approval queue stay in sync with it.
  const {
    knowledgeCount: approvalsCount,
    setKnowledgeCount: setApprovalsCount,
  } = usePendingApprovals();

  return (
    <ResourcesContext.Provider value={{ approvalsCount, setApprovalsCount }}>
      <PageContainer className="flex flex-col gap-6">
        <header className="flex items-center gap-3">
          <LibraryBig className="text-accent h-6 w-6" aria-hidden="true" />
          <div>
            <h1 className="text-text-primary text-xl font-semibold">
              {t("resources.title", "Components")}
            </h1>
            <p className="text-text-muted mt-0.5 text-sm">
              {t(
                "resources.subtitle",
                "Reusable tools, knowledge, schedules and credentials your agents draw from.",
              )}
            </p>
          </div>
        </header>

        <nav
          aria-label={t("resources.title", "Components")}
          // NOTE: overflow-y-hidden is load-bearing — overflow-x: auto forces y to auto too (CSS spec),
          // and -mb-px then triggers a spurious vertical scrollbar. Pinning y to hidden prevents it.
          className="border-border -mb-px flex gap-1 overflow-x-auto overflow-y-hidden border-b"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) =>
                  cn(
                    "-mb-px inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                    {
                      "border-accent text-text-primary": isActive,
                      "text-text-muted hover:text-text-secondary border-transparent":
                        !isActive,
                    },
                  )
                }
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {/* biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments above TABS */}
                {t(tab.labelKey)}
                {tab.badge && approvalsCount > 0 && (
                  <span className="bg-accent-solid text-accent-foreground inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[0.6875rem] leading-none font-medium">
                    {approvalsCount}
                  </span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <Outlet />
      </PageContainer>
    </ResourcesContext.Provider>
  );
}
