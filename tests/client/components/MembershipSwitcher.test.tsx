/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { MembershipSwitcher } from "@/client/components/TenantSwitcher";

// Issue #756: a person who belongs to several tenants gets the header switcher over their OWN
// memberships (from the session), showing the tenant the session runs under. It is the SUPER_ADMIN's
// picker without the fleet list and without "create tenant", which is not a member's to do.
//
// NOTE: assertions reduce to strings/booleans before expect; a DOM node in a failing expectation
// serializes a cyclic happy-dom tree and stalls the runner.

afterEach(() => {
  cleanup();
});

const TENANTS = [
  { id: "10", name: "Clínica Norte" },
  { id: "20", name: "Clínica Sul" },
];

describe("the membership switcher", () => {
  test("names the tenant the session runs under", () => {
    const view = render(
      <MemoryRouter>
        <MembershipSwitcher tenants={TENANTS} activeId="20" />
      </MemoryRouter>,
    );
    const trigger = view.getByRole("button", { name: "Switch tenant" });
    expect(trigger.textContent ?? "").toContain("Clínica Sul");
    expect(trigger.textContent ?? "").not.toContain("Clínica Norte");
  });

  test("lists the person's tenants, and offers nothing to create", async () => {
    const view = render(
      <MemoryRouter>
        <MembershipSwitcher tenants={TENANTS} activeId="10" />
      </MemoryRouter>,
    );
    const trigger = view.getByRole("button", { name: "Switch tenant" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);
    // Opened: both memberships are offered...
    expect((await view.findAllByRole("menuitemradio")).length).toBe(2);
    // ...and creating a tenant is not a member's to do.
    expect(view.queryByText("Create tenant") === null).toBe(true);
  });
});
