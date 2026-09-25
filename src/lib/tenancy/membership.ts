import type { UserRole } from "@/../generated/prisma/client";
import { parseDbId } from "@/lib/db-id";

// Which of a person's memberships a request runs under (issue #756). Pure, so the rule is tested
// without Elysia or a database.
//
// A person is one user with a membership per tenant, the way Chatwoot has `account_users`, and the
// console picks one per request with `X-Tenant-Id`, the same header a SUPER_ADMIN already sends.
//
//   - a selector naming one of the person's memberships runs under it, with the role held THERE;
//   - a selector naming anything else is REFUSED (`rejected`), never exchanged for another
//     membership. Landing in a tenant the person did not choose, with nothing on screen saying so, is
//     the defect #756 was opened on;
//   - no selector runs under the OLDEST membership. A person with one membership never needs to
//     choose, and for one with several it is the stable default until the console sends a choice;
//   - no membership at all is no tenant, and the session is refused upstream (fail-closed).
export interface Membership {
  tenantId: bigint;
  role: UserRole;
  createdAt: Date;
}

export type MembershipResolution =
  | { tenantId: bigint; role: UserRole }
  | { rejected: string }
  | null;

export function resolveMembership(
  memberships: readonly Membership[],
  headerTenantId: string | undefined,
): MembershipResolution {
  if (memberships.length === 0) return null;
  // Truthiness, as for the SUPER_ADMIN selector (src/lib/tenancy/index.ts): the console omits the
  // header when nothing is selected, and an empty value is the one spelling of "no selector".
  if (headerTenantId) {
    const target = parseDbId(headerTenantId);
    const hit =
      target === null
        ? undefined
        : memberships.find((m) => m.tenantId === target);
    return hit
      ? { tenantId: hit.tenantId, role: hit.role }
      : { rejected: headerTenantId };
  }
  const oldest = [...memberships].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0),
  )[0] as Membership;
  return { tenantId: oldest.tenantId, role: oldest.role };
}

// The role a signed-in principal holds in one tenant, from what the session already loaded: every
// tenant for the SUPER_ADMIN, the membership's role for a person, and null outside their memberships.
// For the flows that name their tenant themselves instead of taking the request's selector (an OAuth
// callback carries it in its signed state, a WebSocket in its query), where the request's own tenant
// is only the person's default and says nothing about the one being acted on.
export function roleInTenant(
  user: {
    role: UserRole;
    tenantId: bigint | null;
    memberships?: readonly { tenantId: bigint; role: UserRole }[];
  },
  tenantId: bigint,
): UserRole | null {
  if (user.role === "SUPER_ADMIN") return "SUPER_ADMIN";
  if (user.memberships) {
    return user.memberships.find((m) => m.tenantId === tenantId)?.role ?? null;
  }
  // A principal bound to one tenant (an API key) holds its role there and nowhere else.
  return user.tenantId === tenantId ? user.role : null;
}
