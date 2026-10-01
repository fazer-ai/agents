import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { PageContainer } from "@/client/components/PageContainer";
import { cn } from "@/client/lib/utils";

export interface SectionTab {
  to: string;
  label: string;
  icon: LucideIcon;
}

// The shell of a page split into sections (Settings, Admin): a title, then the section links beside
// the content on a desktop and above it on a phone. `tabs` null renders the content alone, for a
// reader who can open only one section.
export function SectionLayout({
  title,
  subtitle,
  navLabel,
  tabs,
  contentClassName,
  children,
}: {
  title: string;
  subtitle?: string;
  navLabel: string;
  tabs: SectionTab[] | null;
  contentClassName?: string;
  children: ReactNode;
}) {
  return (
    <PageContainer size="wide" className="flex flex-col gap-6">
      <header>
        <h1 className="font-semibold text-2xl text-text-primary">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-text-muted">{subtitle}</p>}
      </header>

      <div className="flex flex-col gap-6 md:flex-row md:gap-10">
        {tabs && (
          <nav
            aria-label={navLabel}
            // NOTE: on a phone every section stays visible as a column (icon over label) that grows
            // from its own label width, instead of a strip that scrolls with no hint that more
            // sections exist past the edge. Content-sized, not equal, so a long label is not the one
            // cut.
            className="flex gap-1 md:w-48 md:shrink-0 md:flex-col"
          >
            {tabs.map((tab) => {
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
                  <span className="max-w-full truncate">{tab.label}</span>
                </NavLink>
              );
            })}
          </nav>
        )}

        <div className={cn("flex min-w-0 flex-1 flex-col", contentClassName)}>
          {children}
        </div>
      </div>
    </PageContainer>
  );
}
