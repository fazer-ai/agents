import type { PrismaClient, UserRole } from "@/../generated/prisma/client";

// The role a person holds in one tenant RIGHT NOW (issue #756): SUPER_ADMIN for the fleet operator,
// who holds it everywhere including the fleet scope (`tenantId` null), the membership's role
// otherwise, and null when the person is gone or does not belong there. Read by grants that were
// issued for one tenant and must stop the moment that membership changes (MCP OAuth tokens, the
// Google and MCP connection callbacks).
export async function roleIn(
  base: Pick<PrismaClient, "user">,
  userId: bigint,
  tenantId: bigint | null,
): Promise<UserRole | null> {
  const user = await base.user.findUnique({
    where: { id: userId },
    select: {
      isSuperAdmin: true,
      memberships:
        tenantId === null
          ? false
          : { where: { tenantId }, select: { role: true } },
    },
  });
  if (!user) return null;
  if (user.isSuperAdmin) return "SUPER_ADMIN";
  return user.memberships?.[0]?.role ?? null;
}
