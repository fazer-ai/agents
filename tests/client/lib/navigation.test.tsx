/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import {
  filterNavItems,
  groupNavItems,
  NAV_ITEMS,
  type NavItem,
} from "@/client/lib/navigation";

describe("navigation", () => {
  test("includes base routes", () => {
    const paths = NAV_ITEMS.map((item) => item.to);
    expect(paths).toContain("/");
    expect(paths).toContain("/admin");
  });

  test("filterNavItems hides admin routes for non-admin roles", () => {
    const items = filterNavItems(NAV_ITEMS, "AGENT");
    expect(items.every((item) => !item.requireAdmin)).toBe(true);
    expect(items.map((i) => i.to)).not.toContain("/admin");
  });

  test("filterNavItems hides admin routes when role is undefined", () => {
    const items = filterNavItems(NAV_ITEMS, undefined);
    expect(items.every((item) => !item.requireAdmin)).toBe(true);
  });

  test("filterNavItems includes admin routes for elevated roles", () => {
    expect(
      filterNavItems(NAV_ITEMS, "TENANT_ADMIN").find((i) => i.to === "/admin"),
    ).toBeDefined();
    expect(
      filterNavItems(NAV_ITEMS, "SUPER_ADMIN").find((i) => i.to === "/admin"),
    ).toBeDefined();
  });

  test("the sidebar groups every item into consecutive sections", () => {
    const groups = groupNavItems(NAV_ITEMS);
    expect(groups.map((g) => g.section?.labelKey ?? null)).toEqual([
      null,
      "nav.section.build",
      "nav.section.integrations",
      "nav.section.monitoring",
      "nav.section.system",
    ]);
    expect(groups.flatMap((g) => g.items)).toEqual(NAV_ITEMS);
  });

  test("groupNavItems splits consecutive items by section", () => {
    const icon = () => null;
    const admin = { labelKey: "nav.sectionAdmin", defaultLabel: "Admin" };
    const items: NavItem[] = [
      { to: "/", labelKey: "a", defaultLabel: "A", icon },
      { to: "/b", labelKey: "b", defaultLabel: "B", icon, section: admin },
      { to: "/c", labelKey: "c", defaultLabel: "C", icon, section: admin },
    ];
    const groups = groupNavItems(items);
    expect(groups.map((g) => g.section?.labelKey ?? null)).toEqual([
      null,
      "nav.sectionAdmin",
    ]);
    expect(groups[1]?.items.map((i) => i.to)).toEqual(["/b", "/c"]);
  });
});
