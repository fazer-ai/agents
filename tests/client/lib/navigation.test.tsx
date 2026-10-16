/// <reference lib="dom" />

import { describe, expect, test } from "bun:test";
import {
  filterNavItems,
  groupNavItems,
  NAV_ITEMS,
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
      "nav.section.integrations",
      "nav.section.monitoring",
      "nav.section.system",
    ]);
    expect(groups.flatMap((g) => g.items)).toEqual(NAV_ITEMS);
    // The day-to-day work opens the list with no heading, the agents and what they use included.
    expect(groups[0]?.items.map((i) => i.to)).toEqual([
      "/",
      "/conversations",
      "/agents",
      "/approvals",
      "/resources",
      "/channels",
    ]);
  });

  test("every role finds the approvals queue, and it carries the badge", () => {
    const approvals = NAV_ITEMS.find((i) => i.to === "/approvals");
    expect(approvals?.badge).toBe("approvals");
    expect(approvals?.requireAdmin).toBeUndefined();
    expect(NAV_ITEMS.filter((i) => i.badge === "approvals")).toHaveLength(1);
  });
});
