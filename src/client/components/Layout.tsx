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
        {/* NOTE: `relative` is load-bearing, and it is about `sr-only` rather than about anything
            this element positions. `sr-only` is `position: absolute`, so a screen-reader label
            anywhere in the page tree resolves against the nearest POSITIONED ancestor — and with
            this one static, that was the initial containing block, i.e. the document. A label far
            down the scrolled content stream then landed at that document coordinate and stretched
            `documentElement.scrollHeight` past the viewport, giving the page a SECOND scrollbar that
            scrolled the whole shell (header and sidebar) out of view.

            The scroller's own `overflow-y: auto` could not clip it either, by the same rule read
            from the other side: a scroll container only clips absolutely positioned descendants
            whose containing block is inside it. Measured on /audit with one row expanded, at
            1280x720: `document.scrollHeight` 2529 with this static, 720 with it relative (issue
            #511). Fixing the label instead would fix one instance of a class that ~20 files under
            src/client can reach. */}
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
