import { beforeEach, describe, expect, test } from "bun:test";
import {
  getActiveTenantId,
  reconcileActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";

// The stored selection is the one piece of tenant state that lives in the browser, so it outlives
// the tenant it names. The table is over (what is stored, what the fleet list says), and the column
// that matters is whether the selection survives: everything downstream of it (the header label, the
// X-Tenant-Id every request carries) reads the storage, not this return value. Issue #223.

describe("reconcileActiveTenantId", () => {
  beforeEach(() => {
    setActiveTenantId(null);
  });

  test("nothing selected stays nothing selected", () => {
    expect(reconcileActiveTenantId(["1", "2"])).toBeNull();
    expect(getActiveTenantId()).toBeNull();
  });

  test("a selection the list has is kept, untouched", () => {
    setActiveTenantId("2");
    expect(reconcileActiveTenantId(["1", "2", "3"])).toBe("2");
    expect(getActiveTenantId()).toBe("2");
  });

  test("a selection the list does not have is cleared", () => {
    setActiveTenantId("9");
    expect(reconcileActiveTenantId(["1", "2"])).toBeNull();
    expect(getActiveTenantId()).toBeNull();
  });

  test("an empty list is the claim that there are no tenants, so it clears too", () => {
    setActiveTenantId("9");
    expect(reconcileActiveTenantId([])).toBeNull();
    expect(getActiveTenantId()).toBeNull();
  });

  test("it judges what is stored NOW, not what was stored when the list was asked for", () => {
    // The window this closes: a deep link switches the selection while the list is in flight. The
    // answer coming back describes tenants, not the moment it was requested, so the newer choice is
    // judged on its own merit rather than discarded for having arrived late.
    setActiveTenantId("1");
    setActiveTenantId("3");
    expect(reconcileActiveTenantId(["1", "3"])).toBe("3");
    expect(getActiveTenantId()).toBe("3");
  });
});
