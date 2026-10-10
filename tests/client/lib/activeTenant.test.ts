import { beforeEach, describe, expect, test } from "bun:test";
import {
  dropRejectedSelection,
  getActiveTenantId,
  reconcileActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";

// The stored selection is the one piece of tenant state that lives in the browser, so it outlives
// the tenant it names. The table is over (what is stored, what the fleet list says), and it has two
// answer columns: what survives, and whether a selection was DROPPED. They are not the same column,
// because "nothing selected" is also the ordinary state of an operator who has not picked one yet,
// while a drop is the event that says the pages already on screen were built against a tenant that
// is not there.

describe("reconcileActiveTenantId", () => {
  beforeEach(() => {
    setActiveTenantId(null);
  });

  test("nothing selected stays nothing selected, and nothing was dropped", () => {
    expect(reconcileActiveTenantId(["1", "2"])).toEqual({
      activeId: null,
      cleared: false,
    });
    expect(getActiveTenantId()).toBeNull();
  });

  test("a selection the list has is kept, untouched", () => {
    setActiveTenantId("2");
    expect(reconcileActiveTenantId(["1", "2", "3"])).toEqual({
      activeId: "2",
      cleared: false,
    });
    expect(getActiveTenantId()).toBe("2");
  });

  test("a selection the list does not have is dropped", () => {
    setActiveTenantId("9");
    expect(reconcileActiveTenantId(["1", "2"])).toEqual({
      activeId: null,
      cleared: true,
    });
    expect(getActiveTenantId()).toBeNull();
  });

  test("an empty list is the claim that there are no tenants, so it drops too", () => {
    setActiveTenantId("9");
    expect(reconcileActiveTenantId([])).toEqual({
      activeId: null,
      cleared: true,
    });
    expect(getActiveTenantId()).toBeNull();
  });
});

// The other end of the same question. `reconcileActiveTenantId` asks it at page load, against the
// authoritative list; this one is asked by a single refused REQUEST, mid-session, and is the only
// path that reaches the tenant deleted from another tab, deleted over MCP, or gone because the
// console was pointed at a different database.
describe("dropRejectedSelection", () => {
  beforeEach(() => {
    setActiveTenantId(null);
  });

  test("a refusal naming another id leaves the selection alone", () => {
    // NOTE: the request went out under the old selection and was refused after the operator
    // switched, so the newer choice is not this answer's to discard: the same reason the
    // reconciliation reads storage at call time rather than capturing it when the request left.
    setActiveTenantId("3");
    expect(dropRejectedSelection("9")).toBe(false);
    expect(getActiveTenantId()).toBe("3");
  });

  test("nothing stored is still ours, because localStorage is shared across tabs", () => {
    // NOTE: two tabs open on the same tenant; the first to be refused clears the shared key.
    // Reading null here as "someone else dealt with it" would leave the second tab rendered against
    // a tenant that is gone.
    expect(dropRejectedSelection("9")).toBe(true);
    expect(getActiveTenantId()).toBeNull();
  });
});
