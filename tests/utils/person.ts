import type { UserRole } from "@/../generated/prisma/client";

// A user row as the tests describe it, one tenant and one role, turned into what the schema stores
// since issue #756: a PERSON, with the fleet role as `isSuperAdmin` and a tenant role as the person's
// one membership, created in the same statement. Spread the rest of the row through unchanged.
export function personData<
  T extends { tenantId?: bigint | null; role?: UserRole },
>(row: T) {
  const { tenantId, role, ...person } = row;
  const isSuperAdmin = role === "SUPER_ADMIN";
  return {
    ...person,
    isSuperAdmin,
    ...(tenantId != null && !isSuperAdmin
      ? {
          memberships: {
            create: { tenantId, role: role ?? ("AGENT" as UserRole) },
          },
        }
      : {}),
  };
}
