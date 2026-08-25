import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  authorize,
  isAdminRole,
  resolveRequestTenantContext,
  roleAtLeast,
} from "@/lib/tenancy";
import { expectWaiverLedger } from "@/tests/utils/ledger";

const superAdmin = { id: 1n, tenantId: null, role: "SUPER_ADMIN" as const };
const tenantAdmin = { id: 2n, tenantId: 3n, role: "TENANT_ADMIN" as const };
const agent = { id: 4n, tenantId: 3n, role: "AGENT" as const };

describe("role hierarchy", () => {
  test("roleAtLeast respects SUPER_ADMIN > TENANT_ADMIN > AGENT", () => {
    expect(roleAtLeast("SUPER_ADMIN", "TENANT_ADMIN")).toBe(true);
    expect(roleAtLeast("TENANT_ADMIN", "TENANT_ADMIN")).toBe(true);
    expect(roleAtLeast("AGENT", "TENANT_ADMIN")).toBe(false);
    expect(roleAtLeast(undefined, "AGENT")).toBe(false);
  });

  test("isAdminRole is true only for elevated roles", () => {
    expect(isAdminRole("SUPER_ADMIN")).toBe(true);
    expect(isAdminRole("TENANT_ADMIN")).toBe(true);
    expect(isAdminRole("AGENT")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
  });
});

describe("authorize", () => {
  test("super admin may target any tenant", () => {
    expect(() =>
      authorize({ tenantId: null, userId: 1n, role: "SUPER_ADMIN" }, 99n),
    ).not.toThrow();
  });

  test("tenant user may only touch its own tenant", () => {
    expect(() =>
      authorize({ tenantId: 3n, userId: 2n, role: "TENANT_ADMIN" }, 3n),
    ).not.toThrow();
    expect(() =>
      authorize({ tenantId: 3n, userId: 2n, role: "TENANT_ADMIN" }, 9n),
    ).toThrow();
    expect(() =>
      authorize({ tenantId: 3n, userId: 2n, role: "AGENT" }, null),
    ).toThrow();
  });
});

describe("resolveRequestTenantContext", () => {
  test("null user yields null context", () => {
    expect(resolveRequestTenantContext(null, "5")).toEqual({
      context: null,
      anomaly: false,
    });
  });

  test("super admin without header has a null target", () => {
    const { context } = resolveRequestTenantContext(superAdmin, undefined);
    expect(context?.tenantId).toBeNull();
    expect(context?.role).toBe("SUPER_ADMIN");
  });

  test("super admin selects the target tenant via X-Tenant-Id", () => {
    const { context } = resolveRequestTenantContext(superAdmin, "5");
    expect(context?.tenantId).toBe(5n);
  });

  test("malformed selector for super admin yields a null target", () => {
    const { context } = resolveRequestTenantContext(superAdmin, "not-a-number");
    expect(context?.tenantId).toBeNull();
  });

  test("tenant admin keeps own tenant and flags a forged header as anomaly", () => {
    const ok = resolveRequestTenantContext(tenantAdmin, "3");
    expect(ok.context?.tenantId).toBe(3n);
    expect(ok.anomaly).toBe(false);

    const forged = resolveRequestTenantContext(tenantAdmin, "9");
    expect(forged.context?.tenantId).toBe(3n);
    expect(forged.anomaly).toBe(true);
  });

  test("agent ignores X-Tenant-Id entirely", () => {
    const { context, anomaly } = resolveRequestTenantContext(agent, "9");
    expect(context?.tenantId).toBe(3n);
    expect(anomaly).toBe(true);
  });
});

// The registry of tenant-scoped models is a hand-kept list in `multi-tenant.ts`, and nothing
// checked it against the schema — so a new table with a `tenant_id` joined it only if whoever
// added the table remembered. `PlaygroundTurnNote` did not (issue #136, review round 9), and it is
// not the first. This reads both sides and forces the next one to be a DECISION: register it, or
// name it below with a reason.
//
// The list is not an approval of what is on it. Everything except the documented global/identity
// tables predates this guard and has never been audited; the point is that the set cannot grow
// silently any more.
describe("every model with a tenant_id is accounted for", () => {
  const KNOWN_UNREGISTERED: Record<string, string> = {
    // Documented exclusions (see the comment above TENANT_SCOPED_MODELS): global/identity tables.
    User: "identity, not tenant data",
    AuditLog: "written for global actions too",
    McpOAuthAccessToken: "OAuth identity table",
    McpOAuthRefreshToken: "OAuth identity table",
    McpOAuthAuthorizationCode: "OAuth identity table",
    McpOAuthPendingAuthorization: "OAuth identity table",
    // Undocumented, and older than this guard. Every write to these passes tenantId explicitly, so
    // nothing is broken today; what they lack is the anti-spoof override. Not touched here: this
    // PR's scope is the playground, and changing seven write paths on the strength of a sweep is
    // how a fix becomes an incident.
    AgentThread: "pre-existing gap, not audited",
    ChatwootAgentBot: "pre-existing gap, not audited",
    ChatwootDeployment: "pre-existing gap, not audited",
    Invitation: "pre-existing gap, not audited",
    KnowledgeDocument: "pre-existing gap, not audited",
    PlaygroundMedia: "pre-existing gap, not audited",
    PlaygroundSession: "pre-existing gap, not audited",
  };

  test("it is registered, or named here with a reason", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const withTenantId = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter(([, , body]) => /^\s*tenantId\s+BigInt/m.test(body ?? ""))
      .map(([, name]) => name as string);
    // A sweep that finds nothing is a broken sweep, not a clean repo.
    expect(withTenantId.length).toBeGreaterThan(20);

    const src = readFileSync("src/lib/tenancy/multi-tenant.ts", "utf8");
    const registered = new Set(
      [
        ...(src
          .match(
            /TENANT_SCOPED_MODELS = new Set<string>\(\[([\s\S]*?)\]\)/,
          )?.[1]
          ?.matchAll(/"(\w+)"/g) ?? []),
      ].map(([, m]) => m as string),
    );
    expect(registered.has("PlaygroundTurnNote")).toBe(true);

    const unaccounted = withTenantId.filter(
      (m) => !registered.has(m) && !(m in KNOWN_UNREGISTERED),
    );
    expect(unaccounted).toEqual([]);
    // ...and the ledger cannot outlive what it excuses: a name here that IS registered, or that no
    // longer exists, is a line nobody removed.
    expect(
      Object.keys(KNOWN_UNREGISTERED).filter(
        (m) => registered.has(m) || !withTenantId.includes(m),
      ),
    ).toEqual([]);
  });

  // Both assertions above read `registered` out of the tree, so the ledger is the one input neither
  // of them can contradict: a model added to it is excused AND is not stale. Pinned at the thirteen
  // it was argued into. Seven of those are recorded as "pre-existing gap, not audited", which is
  // exactly why this list must not be where the eighth goes. tests/utils/ledger.ts, issue #293.
  test("the unregistered-model ledger may only shrink", () => {
    expectWaiverLedger("KNOWN_UNREGISTERED", KNOWN_UNREGISTERED, 13);
  });
});
