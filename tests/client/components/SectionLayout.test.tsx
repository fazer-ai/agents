/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { Building2, Users } from "lucide-react";
import { MemoryRouter } from "react-router";
import { SectionLayout } from "@/client/components/SectionLayout";

afterEach(cleanup);

const TABS = [
  { to: "/admin/users", label: "Users", icon: Users },
  { to: "/admin/tenants", label: "Tenants", icon: Building2 },
];

function renderAt(path: string, tabs: typeof TABS | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SectionLayout title="Admin" navLabel="Admin sections" tabs={tabs}>
        <p>section body</p>
      </SectionLayout>
    </MemoryRouter>,
  );
}

describe("SectionLayout", () => {
  test("lists every section and marks the one open", () => {
    renderAt("/admin/tenants", TABS);
    const nav = screen.getByRole("navigation", { name: "Admin sections" });
    const links = Array.from(nav.querySelectorAll("a")).map((a) => ({
      href: a.getAttribute("href"),
      current: a.getAttribute("aria-current"),
    }));
    expect(links).toEqual([
      { href: "/admin/users", current: null },
      { href: "/admin/tenants", current: "page" },
    ]);
    expect(screen.getByText("section body")).toBeTruthy();
  });

  // A reader who can open one section only (a tenant admin in Admin) gets no links to the others.
  test("no tabs, no section links, and the content still renders", () => {
    renderAt("/admin/users", null);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Admin");
    expect(screen.getByText("section body")).toBeTruthy();
  });
});
