import { Menu } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router";
import { Breadcrumbs } from "@/client/components/Breadcrumbs";
import { Logo } from "@/client/components/Logo";
import { TenantIndicator } from "@/client/components/TenantIndicator";
import { UserMenu } from "@/client/components/UserMenu";
import { useSidebar } from "@/client/contexts/SidebarContext";

export function Header() {
  const { t } = useTranslation();
  const { setMobileOpen } = useSidebar();
  const location = useLocation();
  const isHome = location.pathname === "/";

  return (
    <header className="flex min-h-(--header-height) shrink-0 items-center gap-4 border-border border-b px-4 py-2 md:px-6">
      {/* The brand lives in the desktop sidebar; on mobile the sidebar is a drawer, so the header
          keeps the menu button and the logo. */}
      <div className="flex shrink-0 items-center gap-2 md:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label={t("nav.openMenu", "Open menu")}
          className="inline-flex items-center justify-center rounded-md border border-border bg-bg-tertiary p-2 text-text-secondary transition-colors hover:bg-bg-hover hover:text-text-primary md:hidden"
        >
          <Menu className="h-4 w-4" />
        </button>
        <Link
          to="/"
          aria-current={isHome ? "page" : undefined}
          aria-label={t("nav.home", "Home")}
          className="flex items-center gap-3"
        >
          <Logo className="h-7 w-auto" />
        </Link>
      </div>

      <Breadcrumbs />

      <div className="ml-auto flex items-center gap-3">
        <TenantIndicator />
        <UserMenu />
      </div>
    </header>
  );
}
