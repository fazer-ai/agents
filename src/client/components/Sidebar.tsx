import * as DialogPrimitive from "@radix-ui/react-dialog";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { type ReactNode, useId } from "react";
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
  groupNavItems,
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
  const groupIdPrefix = useId();

  const renderItem = (item: NavItem) => {
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
            // NOTE: never re-centered when collapsed. The icon keeps its left-aligned position (see
            // SIDEBAR_COLLAPSED_WIDTH), which is already the rail's center, so nothing jumps when
            // the label goes.
            "flex items-center gap-3 rounded-md px-4 py-1.5 font-medium text-sm transition-colors",
            {
              "bg-bg-hover text-text-primary": isActive,
              "text-text-muted hover:bg-bg-tertiary hover:text-text-primary":
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
              className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-accent-solid ring-2 ring-bg-primary"
            />
          )}
        </span>
        {isCollapsed ? (
          // NOTE: accessible name for the icon-only collapsed link; the Tooltip wrapping this link
          // contributes aria-describedby, not a name, so the link still needs its own label.
          <span className="sr-only">
            {badgeCount > 0 ? `${label} (${badgeCount})` : label}
          </span>
        ) : (
          <>
            <span className="truncate">{label}</span>
            {badgeCount > 0 && (
              <span className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-accent-solid px-1.5 py-0.5 font-medium text-[0.6875rem] text-accent-foreground leading-none">
                {badgeCount}
              </span>
            )}
          </>
        )}
      </NavLink>
    );

    return (
      <li key={item.to}>
        {/* Wrapped in <span> so Radix Tooltip's Slot does not clone the NavLink, whose function
            className (isActive) it would stringify. Always wrapped, only disabled while expanded, so
            ⌘B does not remount a focused link. */}
        <Tooltip
          content={label}
          side="right"
          sideOffset={10}
          disabled={!isCollapsed}
        >
          <span className="block">{link}</span>
        </Tooltip>
      </li>
    );
  };

  return (
    <nav
      aria-label={t("nav.mainNavigation", "Main navigation")}
      className="sidebar-nav flex flex-1 flex-col gap-3 overflow-y-auto p-2"
    >
      {groupNavItems(items).map((group, index) => {
        const headingId = `${groupIdPrefix}-${index}`;
        const heading = group.section
          ? // biome-ignore lint/plugin/no-dynamic-i18n-key: extracted via magic comments in src/client/lib/navigation.tsx
            t(group.section.labelKey, group.section.defaultLabel)
          : null;
        return (
          <div key={group.section?.labelKey ?? `__root-${index}`}>
            {heading &&
              (isCollapsed ? (
                // NOTE: collapsed, a heading has no room; a hairline keeps the groups apart and the
                // heading stays for screen readers.
                <div className="mx-2 mb-2 h-px bg-border">
                  <span id={headingId} className="sr-only">
                    {heading}
                  </span>
                </div>
              ) : (
                <p
                  id={headingId}
                  className="mb-1 truncate px-4 font-medium text-text-muted text-xs"
                >
                  {heading}
                </p>
              ))}
            <ul
              aria-labelledby={heading ? headingId : undefined}
              className="flex flex-col gap-0.5"
            >
              {group.items.map(renderItem)}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

interface SidebarFooterProps {
  collapsed?: boolean;
  onNavigate?: () => void;
  // Only the desktop sidebar can collapse; the mobile drawer closes.
  showCollapseToggle?: boolean;
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

function SidebarFooter({
  collapsed = false,
  onNavigate,
  showCollapseToggle = false,
}: SidebarFooterProps) {
  const { t } = useTranslation();
  const { config: branding } = useBranding();
  const supportModal = useModalController();

  if (!SUPPORT_LINK && SECONDARY_LINKS.length === 0 && !showCollapseToggle)
    return null;

  // White-label overrides: the operator's own site and support inbox replace the defaults, and
  // the GitHub entry can be hidden. The server sanitizes what it stores, but the URL still only rides
  // into an href after the allowlist check any externally-sourced link gets (defense in depth against
  // a tampered cache or response).
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

  const itemCls =
    "flex items-center gap-3 rounded-md px-4 py-1 text-text-muted text-xs transition-colors hover:bg-bg-tertiary hover:text-text-primary";

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
      <Tooltip
        content={label}
        side="right"
        sideOffset={10}
        disabled={!collapsed}
      >
        <span className="block">{trigger}</span>
      </Tooltip>
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
    const isExternal = isSafeHttpUrl(href);
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
      <div className="flex shrink-0 flex-col gap-1 p-2">
        {(supportItem || secondaryItems.length > 0) && (
          <ul className="flex flex-col">
            {supportItem}
            {secondaryItems}
          </ul>
        )}
        {showCollapseToggle && <SidebarCollapseToggle collapsed={collapsed} />}
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

// App version line, pinned at the very bottom of the sidebar. Independent of the footer
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
    <span className="rounded-sm bg-accent-solid px-1 font-semibold text-[9px] text-accent-foreground uppercase leading-tight tracking-wide">
      {proLabel}
    </span>
  ) : null;

  return (
    <div
      className={cn("shrink-0 pb-2 text-[10px] text-text-muted", {
        "px-2 text-center": collapsed,
        "px-4": !collapsed,
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
                className="absolute top-0 right-0 h-1.5 w-1.5 rounded-full bg-accent-solid"
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
                  className="h-1.5 w-1.5 rounded-full bg-accent-solid"
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

// Shown next to the collapse control so the shortcut useSidebarShortcut already handles is
// discoverable. Read once: the platform does not change.
const COLLAPSE_SHORTCUT =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.userAgent)
    ? "⌘B"
    : "Ctrl+B";

function SidebarCollapseToggle({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const { toggleCollapsed } = useSidebar();
  const label = collapsed
    ? t("nav.expand", "Expand")
    : t("nav.collapse", "Collapse");
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  const button = (
    <button
      type="button"
      onClick={toggleCollapsed}
      aria-pressed={!collapsed}
      aria-controls="app-sidebar"
      aria-keyshortcuts="Meta+B Control+B"
      className="flex w-full items-center gap-3 rounded-md px-4 py-1.5 text-sm text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {collapsed ? (
        <span className="sr-only">{label}</span>
      ) : (
        <>
          <span className="flex-1 truncate text-left">{label}</span>
          {/* Only once the sidebar is wide enough for label and hint side by side; mid-transition
              the hint would otherwise sit on top of the label for a few frames. */}
          <kbd className="@min-[11rem]:inline hidden shrink-0 font-sans text-text-muted text-xs">
            {COLLAPSE_SHORTCUT}
          </kbd>
        </>
      )}
    </button>
  );

  // The same tree in both states: this is the control that flips them, so a conditional wrapper
  // would unmount it under the keyboard focus that just activated it.
  return (
    <Tooltip
      content={`${label} (${COLLAPSE_SHORTCUT})`}
      side="right"
      sideOffset={10}
      disabled={!collapsed}
    >
      {button}
    </Tooltip>
  );
}

function SidebarBrand({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const { logoUrl } = useBranding();
  return (
    // mt-2 + h-12 centers the logo on the panel's top bar, which starts below the panel's own top
    // margin. The symbol has the same size and x in both states, so the swap only adds or removes
    // the name: the mark renders at 5 steps, and the default wordmark is scaled so its own symbol
    // (470px of the asset's 816px height) also lands at 5 steps, with the 5.5-step padding
    // offsetting its transparent left margin. A custom logo has no known geometry, so it is only
    // fitted to the bar.
    <div
      className={cn("mt-2 flex h-12 shrink-0 items-center overflow-hidden", {
        "pl-4": collapsed || !!logoUrl,
        "pl-[calc(var(--spacing)*5.5)]": !collapsed && !logoUrl,
      })}
    >
      <NavLink
        to="/"
        end
        aria-label={t("nav.home", "Home")}
        className="flex shrink-0 items-center rounded-md"
      >
        {/* Switched on the collapsed flag, so the logo always matches the sidebar's state. The
            wordmark keeps its natural width (shrink-0 + max-w-none) and the container clips it,
            so while the rail grows it is revealed, never squeezed. */}
        {collapsed ? (
          <span className="grid size-8 shrink-0 place-items-center">
            <Logo variant="mark" className="size-5 max-w-none" />
          </span>
        ) : (
          <Logo
            className={cn("w-auto max-w-none shrink-0", {
              "h-[calc(var(--spacing)*5*816/470)]": !logoUrl,
              "h-7": !!logoUrl,
            })}
          />
        )}
      </NavLink>
    </div>
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
        <DialogPrimitive.Overlay className="data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-(--z-drawer-overlay) bg-overlay data-[state=closed]:animate-out data-[state=open]:animate-in md:hidden" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left fixed inset-y-0 left-0 z-(--z-drawer) flex w-72 max-w-[85vw] flex-col border-border border-r bg-bg-primary shadow-lg data-[state=closed]:animate-out data-[state=open]:animate-in md:hidden"
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
              className="rounded-md p-1 text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-primary"
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
        className="group/sidebar @container relative hidden shrink-0 flex-col bg-bg-primary transition-[width] duration-200 ease-out md:flex"
      >
        <SidebarBrand collapsed={collapsed} />
        <SidebarNav
          items={items}
          variant="desktop"
          collapsed={collapsed}
          approvalsCount={approvalsCount}
        />
        <SidebarFooter collapsed={collapsed} showCollapseToggle />
        <SidebarVersion collapsed={collapsed} />
        <SidebarResizer />
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
