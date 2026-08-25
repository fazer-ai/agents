import { beforeEach, describe, expect, test } from "bun:test";
import {
  dropSelectionIfRejected,
  getActiveTenantId,
  reconcileActiveTenantId,
  setActiveTenantId,
} from "@/client/lib/activeTenant";

// The stored selection is the one piece of tenant state that lives in the browser, so it outlives
// the tenant it names. The table is over (what is stored, what the fleet list says), and it has two
// answer columns: what survives, and whether a selection was DROPPED. They are not the same column,
// because "nothing selected" is also the ordinary state of an operator who has not picked one yet,
// while a drop is the event that says the pages already on screen were built against a tenant that
// is not there. Issue #223.

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

  test("it judges what is stored NOW, not what was stored when the list was asked for", () => {
    // The window this closes: a deep link switches the selection while the list is in flight. The
    // answer coming back describes tenants, not the moment it was requested, so the newer choice is
    // judged on its own merit rather than discarded for having arrived late.
    setActiveTenantId("1");
    setActiveTenantId("3");
    expect(reconcileActiveTenantId(["1", "3"])).toEqual({
      activeId: "3",
      cleared: false,
    });
    expect(getActiveTenantId()).toBe("3");
  });
});

// The other end of the same question. `reconcileActiveTenantId` asks it at page load, against the
// authoritative list; this one is asked by a single refused REQUEST, mid-session, and is the only
// path that reaches the tenant deleted from another tab, deleted over MCP, or gone because the
// console was pointed at a different database. Issue #252.
//
// It compares the id rather than trusting the refusal, for the same reason the reconciliation reads
// storage at call time: a request that went out under the old selection can be refused AFTER the
// operator has switched to a live tenant, and that newer choice is not this answer's to discard.
describe("dropSelectionIfRejected", () => {
  beforeEach(() => {
    setActiveTenantId(null);
  });

  test("the selection the server refused is the selection it drops", () => {
    setActiveTenantId("9");
    expect(dropSelectionIfRejected("9")).toBe(true);
    expect(getActiveTenantId()).toBeNull();
  });

  test("a refusal naming another id leaves the selection alone", () => {
    setActiveTenantId("3");
    expect(dropSelectionIfRejected("9")).toBe(false);
    expect(getActiveTenantId()).toBe("3");
  });

  test("with nothing selected there is nothing to drop", () => {
    // This is also the once-flag. A page has several requests in flight and each one answers 404;
    // the first clears storage synchronously, so every later answer in the burst lands here and
    // reports false, and the caller reloads once rather than once per request.
    expect(dropSelectionIfRejected("9")).toBe(false);
    expect(getActiveTenantId()).toBeNull();
  });
});
