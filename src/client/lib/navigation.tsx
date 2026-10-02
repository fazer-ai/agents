import {
  BarChart3,
  Bot,
  ClipboardList,
  Gauge,
  Globe,
  KeyRound,
  LibraryBig,
  LifeBuoy,
  ListChecks,
  Megaphone,
  MessagesSquare,
  Package,
  Radar,
  RadioTower,
  ScrollText,
  Settings,
  Shield,
  ShoppingBag,
  Sprout,
  Target,
  Webhook,
} from "lucide-react";
import type { ElementType, SVGProps } from "react";
import { GithubIcon } from "@/client/components/icons/GithubIcon";
import { isAdminRole } from "@/client/lib/roles";

// ElementType (not ComponentType) so it fits lucide's ForwardRefExotic
// components, inline React icons, and `<img>`-based brand marks without
// per-item casts.
export type NavItemIcon = ElementType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export interface NavItem {
  to: string;
  labelKey: string;
  defaultLabel: string;
  icon: NavItemIcon;
  // NOTE: bump to requiredRole if more roles are added
  requireAdmin?: boolean;
  // Optional count badge driven by a named source. "approvals" => pending KB suggestions
  // (usePendingApprovals). The sidebar renders a numeric pill (expanded) or a dot (collapsed).
  badge?: "approvals";
  // Optional heading the sidebar groups this item under. Consecutive items with the same
  // `labelKey` form one group; a run without a section renders with no heading. Add the key's magic
  // comment next to the item like the labels above.
  section?: { labelKey: string; defaultLabel: string };
}

export interface NavGroup {
  section: NavItem["section"] | null;
  items: NavItem[];
}

export function groupNavItems(items: NavItem[]): NavGroup[] {
  const groups: NavGroup[] = [];
  for (const item of items) {
    const key = item.section?.labelKey ?? null;
    const last = groups.at(-1);
    if (last && (last.section?.labelKey ?? null) === key) {
      last.items.push(item);
    } else {
      groups.push({ section: item.section ?? null, items: [item] });
    }
  }
  return groups;
}

// t('nav.section.integrations', 'Integrations')
// t('nav.section.merchant', 'Merchant')
// t('nav.section.monitoring', 'Monitoring')
// t('nav.section.system', 'System')
const MERCHANT = { labelKey: "nav.section.merchant", defaultLabel: "Merchant" };
const INTEGRATIONS = {
  labelKey: "nav.section.integrations",
  defaultLabel: "Integrations",
};
const MONITORING = {
  labelKey: "nav.section.monitoring",
  defaultLabel: "Monitoring",
};
const SYSTEM = { labelKey: "nav.section.system", defaultLabel: "System" };

// t('nav.dashboard', 'Dashboard')
// t('nav.conversations', 'Conversations')
// t('nav.agents', 'Agents')
// t('nav.resources', 'Components')
// t('nav.channels', 'Channels')
// t('nav.webhooks', 'Webhooks')
// t('nav.apiKeys', 'API keys')
// t('nav.logs', 'Logs')
// t('nav.audit', 'Audit')
// t('nav.admin', 'Admin')
// t('nav.settings', 'Settings')
// t('nav.leads', 'Leads')
// t('nav.sources', 'Sources')
// t('nav.catalog', 'Catalog')
// t('nav.orders', 'Orders')
// t('nav.nurture', 'Nurture')
// t('nav.analytics', 'Analytics')
// t('nav.onboarding', 'Getting started')
// t('nav.broadcasts', 'Broadcasts')
export const NAV_ITEMS: NavItem[] = [
  {
    to: "/",
    labelKey: "nav.dashboard",
    defaultLabel: "Dashboard",
    icon: Gauge,
    requireAdmin: true,
  },
  {
    to: "/conversations",
    labelKey: "nav.conversations",
    defaultLabel: "Conversations",
    icon: MessagesSquare,
  },
  {
    // vinvin merchant extension: leads -> catalog -> orders read off the same
    // /api/v1/merchant services.
    to: "/leads",
    labelKey: "nav.leads",
    defaultLabel: "Leads",
    icon: Target,
    requireAdmin: true,
    section: MERCHANT,
  },
  {
    to: "/sources",
    labelKey: "nav.sources",
    defaultLabel: "Sources",
    icon: Radar,
    requireAdmin: true,
    section: MERCHANT,
  },
  {
    to: "/catalog",
    labelKey: "nav.catalog",
    defaultLabel: "Catalog",
    icon: Package,
    requireAdmin: true,
    section: MERCHANT,
  },
  {
    to: "/orders",
    labelKey: "nav.orders",
    defaultLabel: "Orders",
    icon: ShoppingBag,
    requireAdmin: true,
    section: MERCHANT,
  },
  {
    to: "/nurture",
    labelKey: "nav.nurture",
    defaultLabel: "Nurture",
    icon: Sprout,
    requireAdmin: true,
    section: MERCHANT,
  },
  {
    to: "/analytics",
    labelKey: "nav.analytics",
    defaultLabel: "Analytics",
    icon: BarChart3,
    requireAdmin: true,
    section: MERCHANT,
  },
  {
    to: "/onboarding",
    labelKey: "nav.onboarding",
    defaultLabel: "Getting started",
    icon: ListChecks,
    requireAdmin: true,
    section: MERCHANT,
  },
  {
    to: "/broadcasts",
    labelKey: "nav.broadcasts",
    defaultLabel: "Broadcasts",
    icon: Megaphone,
    requireAdmin: true,
    section: MERCHANT,
  },
  {
    to: "/agents",
    labelKey: "nav.agents",
    defaultLabel: "Agents",
    icon: Bot,
    requireAdmin: true,
  },
  {
    to: "/resources",
    labelKey: "nav.resources",
    defaultLabel: "Components",
    icon: LibraryBig,
    requireAdmin: true,
    badge: "approvals",
  },
  {
    to: "/channels",
    labelKey: "nav.channels",
    defaultLabel: "Channels",
    icon: RadioTower,
    requireAdmin: true,
  },
  {
    to: "/webhooks",
    labelKey: "nav.webhooks",
    defaultLabel: "Webhooks",
    icon: Webhook,
    requireAdmin: true,
    section: INTEGRATIONS,
  },
  {
    to: "/api-keys",
    labelKey: "nav.apiKeys",
    defaultLabel: "API keys",
    icon: KeyRound,
    requireAdmin: true,
    section: INTEGRATIONS,
  },
  {
    to: "/logs",
    labelKey: "nav.logs",
    defaultLabel: "Logs",
    icon: ScrollText,
    requireAdmin: true,
    section: MONITORING,
  },
  {
    to: "/audit",
    labelKey: "nav.audit",
    defaultLabel: "Audit",
    icon: ClipboardList,
    requireAdmin: true,
    section: MONITORING,
  },
  {
    to: "/admin",
    labelKey: "nav.admin",
    defaultLabel: "Admin",
    icon: Shield,
    requireAdmin: true,
    section: SYSTEM,
  },
  {
    to: "/settings",
    labelKey: "nav.settings",
    defaultLabel: "Settings",
    icon: Settings,
    section: SYSTEM,
  },
];

export function filterNavItems(
  items: NavItem[],
  role: string | undefined,
): NavItem[] {
  return items.filter((item) => !item.requireAdmin || isAdminRole(role));
}

export interface FooterLink {
  // Stable identity so the sidebar can white-label per entry (swap the website
  // href/label from the branding config; hide the GitHub entry).
  id: "website" | "github";
  href: string;
  labelKey: string;
  defaultLabel: string;
  icon: ElementType<SVGProps<SVGSVGElement>>;
}

export interface SupportContact {
  emailKey: string;
  defaultEmail: string;
  labelKey: string;
  defaultLabel: string;
  icon: ElementType<SVGProps<SVGSVGElement>>;
}

// SUPPORT_LINK renders above SECONDARY_LINKS with a "Need help?" label
// and opens a modal with the email + copy-to-clipboard action (instead of
// a raw mailto: link, which is unreliable when the user has no mail client).
// The email itself is i18n-driven so projects can route support to a
// locale-specific inbox. Set to null to hide the support block entirely.
// t('nav.support', 'Support')
// t('support.email', 'support@fazer.ai')
export const SUPPORT_LINK: SupportContact | null = {
  emailKey: "support.email",
  defaultEmail: "support@fazer.ai",
  labelKey: "nav.support",
  defaultLabel: "Support",
  icon: LifeBuoy,
};

// t('nav.website', 'fazer.ai')
// t('nav.github', 'GitHub')
// Always the public open-source repo — even in Pro/Full (whose own repo is private): the user can
// only open the public one. Used for the footer GitHub link AND the "new version" upgrade link, so
// both point at fazer-ai/agents regardless of edition (never the hub).
export const AGENTS_REPO_URL = "https://github.com/fazer-ai/agents";

export const SECONDARY_LINKS: FooterLink[] = [
  {
    id: "website",
    href: "https://fazer.ai",
    labelKey: "nav.website",
    defaultLabel: "fazer.ai",
    icon: Globe,
  },
  {
    id: "github",
    href: AGENTS_REPO_URL,
    labelKey: "nav.github",
    defaultLabel: "GitHub",
    icon: GithubIcon,
  },
];

// Upgrade destination for Pro-gated features (the hub's agents page). Centralized here, alongside
// the other external links, so every <ProGate> CTA and any future upsell point at one URL.
export const UPGRADE_URL = "https://app.fazer.ai/#/agents";
