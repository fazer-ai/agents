import { describe, expect, test } from "bun:test";
import {
  type Membership,
  resolveMembership,
  roleInTenant,
} from "@/lib/tenancy/membership";

// Issue #756: a person is ONE user with a membership per tenant, and each request runs under the one
// its `X-Tenant-Id` names. The defect the issue opened on was a login that landed in one of a
// person's tenants with nothing deciding which; these pin the rule that replaced it.

const at = (iso: string) => new Date(iso);
const TWO: Membership[] = [
  { tenantId: 20n, role: "AGENT", createdAt: at("2026-05-01T00:00:00Z") },
  {
    tenantId: 10n,
    role: "TENANT_ADMIN",
    createdAt: at("2026-03-01T00:00:00Z"),
  },
];

describe("which membership a request runs under", () => {
  test("a selector naming a membership runs under it, with the role held there", () => {
    expect(resolveMembership(TWO, "20")).toEqual({
      tenantId: 20n,
      role: "AGENT",
    });
    expect(resolveMembership(TWO, "10")).toEqual({
      tenantId: 10n,
      role: "TENANT_ADMIN",
    });
  });

  test("a selector outside the memberships is refused, never swapped for another", () => {
    expect(resolveMembership(TWO, "30")).toEqual({ rejected: "30" });
  });

  test("a malformed selector is refused with what it said", () => {
    expect(resolveMembership(TWO, "0x14")).toEqual({ rejected: "0x14" });
    expect(resolveMembership(TWO, " 20")).toEqual({ rejected: " 20" });
  });

  test("no selector runs under the OLDEST membership, whatever order they come in", () => {
    expect(resolveMembership(TWO, undefined)).toEqual({
      tenantId: 10n,
      role: "TENANT_ADMIN",
    });
    expect(resolveMembership([...TWO].reverse(), "")).toEqual({
      tenantId: 10n,
      role: "TENANT_ADMIN",
    });
  });

  test("two memberships created in the same instant tie-break on the tenant id", () => {
    const same = at("2026-01-01T00:00:00Z");
    expect(
      resolveMembership(
        [
          { tenantId: 9n, role: "AGENT", createdAt: same },
          { tenantId: 4n, role: "AGENT", createdAt: same },
        ],
        undefined,
      ),
    ).toEqual({ tenantId: 4n, role: "AGENT" });
  });

  test("no membership is no tenant", () => {
    expect(resolveMembership([], undefined)).toBeNull();
    expect(resolveMembership([], "10")).toBeNull();
  });
});

describe("the role a principal holds in a named tenant", () => {
  test("a person holds the role of that membership, and none outside them", () => {
    const person = {
      role: "AGENT" as const,
      tenantId: 20n,
      memberships: TWO,
    };
    expect(roleInTenant(person, 10n)).toBe("TENANT_ADMIN");
    expect(roleInTenant(person, 20n)).toBe("AGENT");
    expect(roleInTenant(person, 30n)).toBeNull();
  });

  test("the fleet administrator holds it everywhere", () => {
    expect(
      roleInTenant(
        { role: "SUPER_ADMIN", tenantId: null, memberships: [] },
        7n,
      ),
    ).toBe("SUPER_ADMIN");
  });

  test("a principal bound to one tenant (an API key) holds its role there only", () => {
    const key = { role: "TENANT_ADMIN" as const, tenantId: 5n };
    expect(roleInTenant(key, 5n)).toBe("TENANT_ADMIN");
    expect(roleInTenant(key, 6n)).toBeNull();
  });
});
