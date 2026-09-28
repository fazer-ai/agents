import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AnnouncementBanner } from "@/client/components/AnnouncementBanner";
import { Header } from "@/client/components/Header";
import { Sidebar } from "@/client/components/Sidebar";
import { useSidebarShortcut } from "@/client/hooks/useSidebarShortcut";

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const { t } = useTranslation();
  useSidebarShortcut();

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg-primary">
      <a
        href="#main-content"
        className="sr-only rounded-lg bg-accent px-3 py-1.5 text-accent-foreground text-sm focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-(--z-skip-link)"
      >
        {t("nav.skipToContent", "Skip to content")}
      </a>
      <Header />
      <AnnouncementBanner />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        {/* `relative` is load-bearing, for `sr-only` rather than for anything this element
            positions. `sr-only` is `position: absolute`, so with this static a screen-reader label
            deep in the scrolled content resolves against the document, stretches `scrollHeight` past
            the viewport and adds a second scrollbar that scrolls the whole shell away. The scroller's
            `overflow-y: auto` cannot clip it: it only clips descendants whose containing block is
            inside it. Fixing the label instead would fix one of the ~20 files that can reach this. */}
        <main
          id="main-content"
          tabIndex={-1}
          className="relative flex-1 overflow-y-auto p-6 focus:outline-none"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
