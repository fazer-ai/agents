import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, NavLink } from "react-router";

import { useModalController } from "@/client/components/Modal";
import { SupportModal } from "@/client/components/SupportModal";
import { Tooltip } from "@/client/components/Tooltip";
import { usePendingApprovals } from "@/client/contexts/ApprovalsContext";
import { useAuth } from "@/client/contexts/AuthContext";
import { useBranding } from "@/client/contexts/BrandingContext";
import {
  SIDEBAR_COLLAPSED_WIDTH,
  useSidebar,
} from "@/client/contexts/SidebarContext";
import { useUpdates } from "@/client/contexts/UpdatesContext";
import { APP_VERSION, IS_FREE } from "@/client/lib/env";
import {
  AGENTS_REPO_URL,
  type FooterLink,
  filterNavItems,
  NAV_ITEMS,
  type NavItem,
  SECONDARY_LINKS,
  SUPPORT_LINK,
  type SupportContact,
} from "@/client/lib/navigation";
import { cn, isSafeHttpUrl } from "@/client/lib/utils";
import { Logo } from "./Logo";
import { SidebarResizer } from "./SidebarResizer";

type SidebarVariant = "desktop" | "mobile";

interface SidebarNavProps {
  items: NavItem[];
  variant: SidebarVariant;
  collapsed?: boolean;
  onNavigate?: () => void;
  approvalsCount?: number;
}

function SidebarNav({
  items,
  variant,
  collapsed = false,
  onNavigate,
  approvalsCount = 0,
}: SidebarNavProps) {
  const { t } = useTranslation();
  const isCollapsed = variant === "desktop" && collapsed;

  return (
    <nav
      aria-label={t("nav.mainNavigation", "Main navigation")}
      className="sidebar-nav flex-1 overflow-y-auto p-2"
    >
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const Icon = item.icon;
          // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in src/client/lib/navigation.tsx
          const label = t(item.labelKey, item.defaultLabel);
          const badgeCount = item.badge === "approvals" ? approvalsCount : 0;
          const link = (
            <NavLink
              to={item.to}
              end={item.to === "/"}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  {
                    "justify-center": isCollapsed,
                    "bg-bg-hover text-text-primary": isActive,
                    "text-text-secondary hover:bg-bg-tertiary hover:text-text-primary":
                      !isActive,
                  },
                )
              }
            >
              <span className="relative flex shrink-0">
                <Icon className="h-4 w-4 shrink-0" />
                {isCollapsed && badgeCount > 0 && (
                  // Collapsed: a dot stands in for the count (no room for a pill); the count is
                  // still announced via the sr-only label below.
                  <span
                    aria-hidden="true"
                    className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-accent ring-2 ring-bg-secondary"
                  />
                )}
              </span>
              {isCollapsed ? (
                // NOTE: accessible name for the icon-only collapsed link; the
                // Tooltip wrapping this link contributes aria-describedby, not
                // a name, so the link still needs its own label.
                <span className="sr-only">
                  {badgeCount > 0 ? `${label} (${badgeCount})` : label}
                </span>
              ) : (
                <>
                  <span className="truncate">{label}</span>
                  {badgeCount > 0 && (
                    <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 py-0.5 font-medium text-[0.6875rem] text-accent-foreground leading-none">
                      {badgeCount}
                    </span>
                  )}
                </>
              )}
            </NavLink>
          );

          return (
            <li key={item.to}>
              {isCollapsed ? (
                // NOTE: wrap in <span> so Radix Tooltip's Slot does not clone
                // the NavLink directly; cloning breaks NavLink's function
                // className (isActive) by stringifying it during prop merge.
                <Tooltip content={label} side="right" sideOffset={10}>
                  <span className="block">{link}</span>
                </Tooltip>
              ) : (
                link
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface SidebarFooterProps {
  collapsed?: boolean;
  onNavigate?: () => void;
}

// Label for a white-labeled website link: the hostname reads like the default
// entry ("fazer.ai") instead of dumping the full URL into the sidebar.
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function SidebarFooter({ collapsed = false, onNavigate }: SidebarFooterProps) {
  const { t } = useTranslation();
  const { config: branding } = useBranding();
  const supportModal = useModalController();

  if (!SUPPORT_LINK && SECONDARY_LINKS.length === 0) return null;

  // White-label overrides (issue #4): the operator's own site/support inbox replace the
  // defaults, and the GitHub entry can be hidden. The server sanitizes what it stores, but
  // the URL still only rides into an href after the same allowlist check we apply to any
  // externally-sourced link (defense in depth against a tampered cache/response).
  const customSiteUrl =
    branding?.siteUrl && isSafeHttpUrl(branding.siteUrl)
      ? branding.siteUrl
      : null;
  const customSupportEmail = branding?.supportEmail?.trim() || null;
  const hideGithub = branding?.hideGithubLink === true;

  const supportEmail = SUPPORT_LINK
    ? (customSupportEmail ??
      // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in src/client/lib/navigation.tsx
      t(SUPPORT_LINK.emailKey, SUPPORT_LINK.defaultEmail))
    : null;
  const supportMailto = supportEmail ? `mailto:${supportEmail}` : null;

  const itemCls = cn(
    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-secondary transition-colors hover:bg-bg-tertiary hover:text-text-primary",
    { "justify-center": collapsed },
  );

  const renderBody = (
    Icon: SupportContact["icon"] | FooterLink["icon"],
    label: string,
  ) => (
    <>
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {collapsed ? (
        <span className="sr-only">{label}</span>
      ) : (
        <span className="truncate">{label}</span>
      )}
    </>
  );

  const wrapLi = (key: string, trigger: ReactNode, label: string) => (
    <li key={key}>
      {collapsed ? (
        <Tooltip content={label} side="right" sideOffset={10}>
          <span className="block">{trigger}</span>
        </Tooltip>
      ) : (
        trigger
      )}
    </li>
  );

  let supportItem: ReactNode = null;
  if (SUPPORT_LINK) {
    // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in src/client/lib/navigation.tsx
    const label = t(SUPPORT_LINK.labelKey, SUPPORT_LINK.defaultLabel);
    const trigger = (
      <button
        type="button"
        onClick={supportModal.open}
        className={cn(itemCls, "w-full")}
      >
        {renderBody(SUPPORT_LINK.icon, label)}
      </button>
    );
    supportItem = wrapLi("__support", trigger, label);
  }

  const secondaryItems = SECONDARY_LINKS.filter(
    (link) => !(link.id === "github" && hideGithub),
  ).map((link) => {
    const isCustomSite = link.id === "website" && customSiteUrl !== null;
    const href = isCustomSite ? customSiteUrl : link.href;
    const label = isCustomSite
      ? hostnameOf(customSiteUrl)
      : // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in src/client/lib/navigation.tsx
        t(link.labelKey, link.defaultLabel);
    const isExternal = /^https?:\/\//.test(href);
    const trigger = (
      <a
        href={href}
        onClick={onNavigate}
        {...(isExternal && { target: "_blank", rel: "noopener noreferrer" })}
        className={itemCls}
      >
        {renderBody(link.icon, label)}
      </a>
    );
    return wrapLi(link.id, trigger, label);
  });

  return (
    <>
      <div className="shrink-0 border-border border-t p-2">
        {supportItem && (
          <>
            {!collapsed && (
              <p className="mb-1 truncate px-3 text-text-muted text-xs uppercase tracking-wide">
                {t("nav.needHelp", "Need help?")}
              </p>
            )}
            <ul className="flex flex-col gap-1">{supportItem}</ul>
          </>
        )}
        {secondaryItems.length > 0 && (
          <ul
            className={cn("flex flex-col gap-1", {
              "mt-3": !collapsed && supportItem !== null,
            })}
          >
            {secondaryItems}
          </ul>
        )}
      </div>
      {supportEmail && supportMailto && (
        <SupportModal
          modal={supportModal}
          email={supportEmail}
          mailtoHref={supportMailto}
        />
      )}
    </>
  );
}

// App version line, pinned at the very bottom of the sidebar (item 2). Independent of the footer
// links (which can be absent). Expanded → "v<version>"; collapsed → a "v" with the full version in a
// tooltip. Renders nothing when no version is known (dev, where BUN_PUBLIC_* isn't inlined).
function SidebarVersion({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const { update } = useUpdates();
  if (!APP_VERSION) return null;
  const full = `v${APP_VERSION}`;
  const hasUpdate = update.available && !!update.latestVersion;
  // Edition marker: only the paid (Pro/full) edition labels itself; Free stays unlabeled.
  const isPro = !IS_FREE;
  const proLabel = t("edition.pro", "Pro");
  // The specific release page when the source provides one (Free/GitHub), else the public repo's
  // releases list. Always fazer-ai/agents — in Pro too (its own repo is private), never the hub.
  // releaseUrl is hub-authored, so only trust an allowlisted http(s) value; otherwise fall back.
  const upgradeHref =
    update.releaseUrl && isSafeHttpUrl(update.releaseUrl)
      ? update.releaseUrl
      : `${AGENTS_REPO_URL}/releases`;
  const versionTooltip = hasUpdate
    ? t("updates.newVersionAvailable", "Version {{version}} available", {
        version: `v${update.latestVersion}`,
      })
    : full;

  const proBadge = isPro ? (
    <span className="rounded bg-accent px-1 font-semibold text-[9px] text-accent-foreground uppercase leading-tight tracking-wide">
      {proLabel}
    </span>
  ) : null;

  return (
    <div
      className={cn("shrink-0 px-3 pb-2 text-[10px] text-text-muted", {
        "text-center": collapsed,
      })}
    >
      {collapsed ? (
        <Tooltip
          content={isPro ? `${versionTooltip} · ${proLabel}` : versionTooltip}
          side="right"
          sideOffset={10}
        >
          {hasUpdate ? (
            // Focusable link so keyboard/SR users can reach the tooltip and act on the update; the
            // dot stays decorative (aria-hidden) and aria-label carries the "new version" state.
            <a
              href={upgradeHref}
              target="_blank"
              rel="noreferrer"
              aria-label={versionTooltip}
              className="relative block truncate text-accent hover:underline"
            >
              {APP_VERSION}
              <span
                className="absolute top-0 right-0 h-1.5 w-1.5 rounded-full bg-accent"
                aria-hidden="true"
              />
            </a>
          ) : (
            <span className="relative block cursor-default truncate">
              {APP_VERSION}
            </span>
          )}
        </Tooltip>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          {proBadge}
          {hasUpdate ? (
            <Tooltip content={versionTooltip} side="top">
              <a
                href={upgradeHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                {full}
                <span
                  className="h-1.5 w-1.5 rounded-full bg-accent"
                  aria-hidden="true"
                />
                {t("updates.update", "update")}
              </a>
            </Tooltip>
          ) : (
            full
          )}
        </span>
      )}
    </div>
  );
}

function SidebarCollapseToggle({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const { toggleCollapsed } = useSidebar();
  const label = collapsed
    ? t("nav.expand", "Expand")
    : t("nav.collapse", "Collapse");
  const Icon = collapsed ? ChevronRight : ChevronLeft;

  return (
    <Tooltip content={label} side="right" sideOffset={10}>
      <button
        type="button"
        onClick={toggleCollapsed}
        aria-pressed={!collapsed}
        aria-controls="app-sidebar"
        aria-label={label}
        className="absolute top-[20%] right-0 z-(--z-sidebar-toggle) flex h-6 w-6 translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-bg-secondary text-text-secondary shadow-sm transition-[background-color,color] hover:bg-bg-hover hover:text-text-primary"
      >
        <Icon className="h-3 w-3" />
      </button>
    </Tooltip>
  );
}

interface MobileSidebarProps {
  items: NavItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  approvalsCount?: number;
}

function MobileSidebar({
  items,
  open,
  onOpenChange,
  approvalsCount = 0,
}: MobileSidebarProps) {
  const { t } = useTranslation();

  // NOTE: avoid mounting a Radix Portal on desktop viewports; only attach the
  // dialog tree while the drawer is actually open.
  if (!open) return null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-(--z-drawer-overlay) bg-black/50 data-[state=closed]:animate-out data-[state=open]:animate-in md:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left fixed inset-y-0 left-0 z-(--z-drawer) flex w-72 max-w-[85vw] flex-col border-border border-r bg-bg-secondary shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in md:hidden"
        >
          <div className="flex shrink-0 items-center justify-between border-border border-b px-4 py-3">
            <DialogPrimitive.Title className="sr-only">
              {t("nav.mainNavigation", "Main navigation")}
            </DialogPrimitive.Title>
            <Link
              to="/"
              onClick={() => onOpenChange(false)}
              aria-label={t("nav.home", "Home")}
              className="flex items-center"
            >
              <Logo className="h-7 w-auto" />
            </Link>
            <DialogPrimitive.Close
              aria-label={t("nav.closeMenu", "Close menu")}
              className="rounded-lg p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>
          <SidebarNav
            items={items}
            variant="mobile"
            onNavigate={() => onOpenChange(false)}
            approvalsCount={approvalsCount}
          />
          <SidebarFooter onNavigate={() => onOpenChange(false)} />
          <SidebarVersion />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Sidebar() {
  const { user } = useAuth();
  const { collapsed, width, mobileOpen, setMobileOpen } = useSidebar();
  const { count: approvalsCount } = usePendingApprovals();
  const items = filterNavItems(NAV_ITEMS, user?.role);
  const effectiveWidth = collapsed ? SIDEBAR_COLLAPSED_WIDTH : width;

  return (
    <>
      <aside
        id="app-sidebar"
        style={{ width: effectiveWidth }}
        className="group/sidebar relative hidden shrink-0 flex-col border-border border-r bg-bg-secondary transition-[width] duration-150 md:flex"
      >
        <SidebarNav
          items={items}
          variant="desktop"
          collapsed={collapsed}
          approvalsCount={approvalsCount}
        />
        <SidebarFooter collapsed={collapsed} />
        <SidebarVersion collapsed={collapsed} />
        <SidebarResizer />
        <SidebarCollapseToggle collapsed={collapsed} />
      </aside>

      <MobileSidebar
        items={items}
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        approvalsCount={approvalsCount}
      />
    </>
  );
}
