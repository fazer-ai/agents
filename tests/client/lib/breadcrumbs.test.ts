import { describe, expect, test } from "bun:test";
import { buildBreadcrumbs } from "@/client/lib/breadcrumbs";

describe("breadcrumbs", () => {
  test("returns empty array on root", () => {
    expect(buildBreadcrumbs("/")).toEqual([]);
  });

  test("returns single crumb for top-level page", () => {
    const crumbs = buildBreadcrumbs("/admin");
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({
      labelKey: "nav.admin",
      to: undefined,
    });
  });

  test("builds nested trail with links except the last", () => {
    const crumbs = buildBreadcrumbs("/settings/profile");
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]).toMatchObject({
      labelKey: "settings.title",
      to: "/settings",
    });
    expect(crumbs[1]).toMatchObject({
      labelKey: "settings.profile",
      to: undefined,
    });
  });

  test("ignores unknown segments silently", () => {
    const crumbs = buildBreadcrumbs("/settings/unknown");
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0]).toMatchObject({
      labelKey: "settings.title",
      to: undefined,
    });
  });

  test("builds the agent editor trail with the tab label", () => {
    const crumbs = buildBreadcrumbs("/agents/abc123/behavior");
    expect(crumbs).toHaveLength(3);
    expect(crumbs[0]).toMatchObject({ labelKey: "nav.agents", to: "/agents" });
    expect(crumbs[1]).toMatchObject({
      labelKey: "breadcrumbs.agent",
      to: "/agents/abc123",
    });
    expect(crumbs[2]).toMatchObject({
      labelKey: "editor.tab.behavior",
      to: undefined,
    });
  });

  test("applies a label override to the matching path", () => {
    const crumbs = buildBreadcrumbs("/agents/abc123/model", {
      "/agents/abc123": "Concierge",
    });
    expect(crumbs[1]).toMatchObject({
      to: "/agents/abc123",
      override: "Concierge",
    });
    // Unrelated crumbs carry no override.
    expect(crumbs[2]?.override).toBeUndefined();
  });

  test("builds a dashboard's trail, named by the dashboard once it loads", () => {
    const crumbs = buildBreadcrumbs("/dashboards/sac", {
      "/dashboards/sac": "Agora no SAC",
    });
    expect(crumbs).toHaveLength(2);
    expect(crumbs[0]).toMatchObject({
      labelKey: "nav.dashboards",
      to: "/dashboards",
    });
    expect(crumbs[1]).toMatchObject({
      labelKey: "breadcrumbs.dashboard",
      to: undefined,
      override: "Agora no SAC",
    });
    expect(buildBreadcrumbs("/dashboards")).toEqual([
      {
        labelKey: "nav.dashboards",
        defaultLabel: "Dashboards",
        to: undefined,
        override: undefined,
      },
    ]);
  });
});
