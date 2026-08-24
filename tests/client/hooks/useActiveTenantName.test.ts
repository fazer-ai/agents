import { describe, expect, test } from "bun:test";
import {
  isFleetSession,
  resolveActiveTenantName,
} from "@/client/hooks/useActiveTenantName";

// Two sessions read this name from two different places, and the split is the whole decision: a
// tenant-scoped user carries their tenant on the session, while a SUPER_ADMIN has no home tenant and
// has to be told which one is selected. Pure, so the table can state it without a DOM and without
// standing on AuthContext, which other test files replace process-wide.

const superAdmin = { role: "SUPER_ADMIN", tenantId: null };
const tenantAdmin = { role: "TENANT_ADMIN", tenantId: "7", tenantName: "Beta" };
// Two entries, and the selection is never the first: a list of one cannot tell "the name of the
// SELECTED tenant" apart from "the name of the first tenant there is".
const FLEET = [
  { id: "3", name: "Outra" },
  { id: "7", name: "Acme" },
];

describe("isFleetSession", () => {
  test("only a SUPER_ADMIN with no home tenant reads the fleet list", () => {
    expect(isFleetSession(superAdmin)).toBe(true);
    expect(isFleetSession(tenantAdmin)).toBe(false);
    expect(isFleetSession(null)).toBe(false);
    expect(isFleetSession(undefined)).toBe(false);
    // A SUPER_ADMIN row that somehow carries a tenant is not a fleet session: it already has its
    // answer, and asking for the list would be a request that should never leave the browser.
    expect(isFleetSession({ role: "SUPER_ADMIN", tenantId: "7" })).toBe(false);
  });
});

describe("resolveActiveTenantName", () => {
  test("a tenant-scoped user gets the name the session already carries", () => {
    expect(resolveActiveTenantName(tenantAdmin, [], null)).toBe("Beta");
    // The list is irrelevant to this session, selection included.
    expect(resolveActiveTenantName(tenantAdmin, FLEET, "3")).toBe("Beta");
  });

  test("a session with no name at all resolves to nothing", () => {
    expect(
      resolveActiveTenantName({ role: "AGENT", tenantId: "7" }, FLEET, "7"),
    ).toBeNull();
    expect(resolveActiveTenantName(null, FLEET, "7")).toBeNull();
  });

  test("a fleet session resolves the SELECTED tenant, not the first one", () => {
    expect(resolveActiveTenantName(superAdmin, FLEET, "7")).toBe("Acme");
    expect(resolveActiveTenantName(superAdmin, FLEET, "3")).toBe("Outra");
  });

  test("nothing selected, and a selection the list does not have, both resolve to nothing", () => {
    expect(resolveActiveTenantName(superAdmin, FLEET, null)).toBeNull();
    // The window before the reconciliation lands: the id is still stored and already means nothing.
    expect(resolveActiveTenantName(superAdmin, FLEET, "999")).toBeNull();
    // Still loading.
    expect(resolveActiveTenantName(superAdmin, [], "7")).toBeNull();
  });
});
