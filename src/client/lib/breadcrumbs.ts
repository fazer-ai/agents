export interface Breadcrumb {
  labelKey: string;
  defaultLabel: string;
  to?: string;
  // Pre-resolved literal label that wins over i18n (data-derived, e.g. an
  // agent's name registered via BreadcrumbContext). See useBreadcrumbLabel.
  override?: string;
}

interface StaticRoute {
  path: string;
  labelKey: string;
  defaultLabel: string;
}

interface DynamicRoute {
  pattern: RegExp;
  resolve: (match: RegExpMatchArray) => {
    labelKey: string;
    defaultLabel: string;
  };
}

// Static routes are matched by exact prefix during the walk, so adding a
// new page here makes it appear automatically in the trail.
// t('nav.agents', 'Agents')
// t('editor.tab.general', 'General')
// t('editor.tab.model', 'Model')
// t('editor.tab.tools', 'Tools')
// t('editor.tab.knowledge', 'Knowledge')
// t('editor.tab.behavior', 'Behavior')
// t('editor.tab.experiments', 'A/B')
// t('editor.tab.playground', 'Playground')
// t('nav.resources', 'Components')
// t('resources.tabs.tools', 'Tools')
// t('resources.tabs.mcp', 'MCP servers')
// t('resources.tabs.knowledge', 'Knowledge')
// t('resources.tabs.hours', 'Hours')
// t('resources.tabs.followups', 'Follow-ups')
// t('resources.tabs.integrations', 'Integrations')
// t('resources.tabs.vault', 'Vault')
// t('resources.tabs.advanced', 'Advanced')
// t('nav.admin', 'Admin')
// t('admin.users', 'Users')
// t('admin.tenants', 'Tenants')
// t('admin.tabBranding', 'Branding')
// t('settings.title', 'Settings')
// t('settings.profile', 'Profile')
// t('settings.appearance', 'Appearance')
const STATIC_ROUTES: StaticRoute[] = [
  { path: "/agents", labelKey: "nav.agents", defaultLabel: "Agents" },
  { path: "/resources", labelKey: "nav.resources", defaultLabel: "Components" },
  {
    path: "/resources/tools",
    labelKey: "resources.tabs.tools",
    defaultLabel: "Tools",
  },
  {
    path: "/resources/mcp",
    labelKey: "resources.tabs.mcp",
    defaultLabel: "MCP servers",
  },
  {
    path: "/resources/knowledge",
    labelKey: "resources.tabs.knowledge",
    defaultLabel: "Knowledge",
  },
  {
    path: "/resources/hours",
    labelKey: "resources.tabs.hours",
    defaultLabel: "Hours",
  },
  {
    path: "/resources/followups",
    labelKey: "resources.tabs.followups",
    defaultLabel: "Follow-ups",
  },
  {
    path: "/resources/integrations",
    labelKey: "resources.tabs.integrations",
    defaultLabel: "Integrations",
  },
  {
    path: "/resources/vault",
    labelKey: "resources.tabs.vault",
    defaultLabel: "Vault",
  },
  {
    path: "/resources/advanced",
    labelKey: "resources.tabs.advanced",
    defaultLabel: "Advanced",
  },
  { path: "/admin", labelKey: "nav.admin", defaultLabel: "Admin" },
  { path: "/admin/users", labelKey: "admin.users", defaultLabel: "Users" },
  {
    path: "/admin/tenants",
    labelKey: "admin.tenants",
    defaultLabel: "Tenants",
  },
  {
    path: "/admin/branding",
    labelKey: "admin.tabBranding",
    defaultLabel: "Branding",
  },
  { path: "/mcp", labelKey: "nav.mcp", defaultLabel: "MCP" },
  { path: "/settings", labelKey: "settings.title", defaultLabel: "Settings" },
  {
    path: "/settings/profile",
    labelKey: "settings.profile",
    defaultLabel: "Profile",
  },
  {
    path: "/settings/appearance",
    labelKey: "settings.appearance",
    defaultLabel: "Appearance",
  },
];

// Dynamic routes are matched when a prefix has no static entry. The
// resolver receives the RegExp match so it can surface the captured segment
// (e.g. a user email) as the default label.
// Tab segment → its editor label (defaults mirror editor.tab.* in the locales).
const AGENT_TAB_LABELS: Record<string, string> = {
  general: "General",
  model: "Model",
  tools: "Tools",
  knowledge: "Knowledge",
  behavior: "Behavior",
  experiments: "A/B",
  playground: "Playground",
};

const DYNAMIC_ROUTES: DynamicRoute[] = [
  {
    pattern: /^\/admin\/users\/([^/]+)$/,
    resolve: (match) => ({
      labelKey: "admin.user",
      defaultLabel: decodeURIComponent(match[1] ?? ""),
    }),
  },
  // Agent editor: the id is opaque, so the real name arrives via a label
  // override (BreadcrumbContext); "Agent" is just the loading placeholder.
  {
    pattern: /^\/agents\/([^/]+)$/,
    resolve: () => ({ labelKey: "breadcrumbs.agent", defaultLabel: "Agent" }),
  },
  {
    pattern: /^\/agents\/[^/]+\/([^/]+)$/,
    resolve: (match) => {
      const tab = match[1] ?? "";
      return {
        labelKey: `editor.tab.${tab}`,
        defaultLabel: AGENT_TAB_LABELS[tab] ?? tab,
      };
    },
  },
];

function resolvePath(
  path: string,
): { labelKey: string; defaultLabel: string } | null {
  const staticMatch = STATIC_ROUTES.find((r) => r.path === path);
  if (staticMatch) {
    return {
      labelKey: staticMatch.labelKey,
      defaultLabel: staticMatch.defaultLabel,
    };
  }
  for (const route of DYNAMIC_ROUTES) {
    const match = path.match(route.pattern);
    if (match) return route.resolve(match);
  }
  return null;
}

export function buildBreadcrumbs(
  pathname: string,
  overrides: Record<string, string> = {},
): Breadcrumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return [];

  const crumbs: Breadcrumb[] = [];
  for (let i = 0; i < segments.length; i++) {
    const path = `/${segments.slice(0, i + 1).join("/")}`;
    const label = resolvePath(path);
    if (!label) continue;
    const isLast = i === segments.length - 1;
    crumbs.push({
      labelKey: label.labelKey,
      defaultLabel: label.defaultLabel,
      to: isLast ? undefined : path,
      override: overrides[path],
    });
  }

  // The isLast flag above is based on the raw segment index, so a path
  // like `/settings/unknown` still marks the `settings` crumb as non-last and
  // keeps it clickable. Override the final *matched* crumb to always be
  // non-navigable — the user is already there as far as breadcrumbs care.
  const last = crumbs[crumbs.length - 1];
  if (last) last.to = undefined;

  return crumbs;
}
