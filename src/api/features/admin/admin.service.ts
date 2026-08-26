import type { PrismaClient } from "@/../generated/prisma/client";
import prisma from "@/api/lib/prisma";
import { badQueryParam } from "@/lib/query-param";
import { asSuperAdminOn } from "@/lib/tenancy";

// NOTE: roles a tenant admin may assign (never SUPER_ADMIN, which is fleet-level and
// only minted via /setup or `bun set-admin`).
export type ManageableRole = "AGENT" | "TENANT_ADMIN";

const USER_SELECT = {
  id: true,
  tenantId: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

// NOTE: the users table is GLOBAL (no RLS), so these functions scope by tenant
// explicitly. tenantId === null means a SUPER_ADMIN caller (fleet-wide visibility).
function tenantScope(tenantId: bigint | null) {
  return tenantId === null ? {} : { tenantId };
}

export async function getUsers(
  tenantId: bigint | null,
  page = 1,
  search?: string,
) {
  // The RANGE lives here, not in the query parser, so a caller that never sends a query string is
  // held to it too. Without this a negative page reaches Prisma as a negative `skip` and answers
  // 500 (measured on `?page=-5`), and a fractional one is echoed back to the client as `page`.
  if (!Number.isInteger(page) || page < 1) badQueryParam("page");
  const pageSize = 20;
  const skip = (page - 1) * pageSize;

  const where = {
    ...tenantScope(tenantId),
    ...(search
      ? { email: { contains: search, mode: "insensitive" as const } }
      : {}),
  };

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: { createdAt: "desc" },
      skip,
      take: pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users,
    total,
    page,
    totalPages: Math.ceil(total / pageSize),
  };
}

export interface TenantWithUserCount {
  id: string;
  name: string;
  slug: string;
  demoMode: boolean;
  createdAt: Date;
  userCount: number;
}

// Full tenant list for the SUPER_ADMIN admin panel (Tenants tab), each with its user count.
// Tenants are RLS-protected → asSuperAdmin; users are global → counted via a plain groupBy
// (SUPER_ADMIN rows have a null tenantId and are not attributed to any tenant).
export async function listTenantsWithUserCounts(
  base: PrismaClient = prisma,
): Promise<TenantWithUserCount[]> {
  const [tenants, counts] = await Promise.all([
    asSuperAdminOn(base, (db) =>
      db.tenant.findMany({
        select: {
          id: true,
          name: true,
          slug: true,
          demoMode: true,
          createdAt: true,
        },
        orderBy: { id: "asc" },
      }),
    ),
    base.user.groupBy({ by: ["tenantId"], _count: { _all: true } }),
  ]);
  const countByTenant = new Map(
    counts.map((c) => [c.tenantId?.toString() ?? "", c._count._all]),
  );
  return tenants.map((tn) => ({
    id: tn.id.toString(),
    name: tn.name,
    slug: tn.slug,
    demoMode: tn.demoMode,
    createdAt: tn.createdAt,
    userCount: countByTenant.get(tn.id.toString()) ?? 0,
  }));
}

export async function getAdminStats(tenantId: bigint | null) {
  const scope = tenantScope(tenantId);
  const [totalUsers, adminCount] = await Promise.all([
    prisma.user.count({ where: scope }),
    prisma.user.count({ where: { ...scope, role: { not: "AGENT" } } }),
  ]);

  return { totalUsers, adminCount };
}

export class UserNotInScopeError extends Error {
  constructor() {
    super("User not found in scope");
    this.name = "UserNotInScopeError";
  }
}

// Deleting yourself would orphan the session; refuse.
export class CannotDeleteSelfError extends Error {
  constructor() {
    super("Cannot delete yourself");
    this.name = "CannotDeleteSelfError";
  }
}

// Deleting the last admin of a scope (the last TENANT_ADMIN of a tenant, or the last SUPER_ADMIN of
// the fleet) would lock everyone out of administration; refuse.
export class LastAdminError extends Error {
  constructor() {
    super("Cannot delete the last admin");
    this.name = "LastAdminError";
  }
}

export async function updateUserRole(
  tenantId: bigint | null,
  userId: bigint,
  role: ManageableRole,
) {
  // NOTE: updateMany with the tenant guard so a tenant admin can only re-role users in
  // their own tenant; count 0 means out-of-scope/non-existent (404, not a cross-tenant edit).
  const result = await prisma.user.updateMany({
    where: { id: userId, ...tenantScope(tenantId) },
    data: { role },
  });
  if (result.count === 0) {
    throw new UserNotInScopeError();
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  });
  if (!user) {
    throw new UserNotInScopeError();
  }
  return user;
}

// Delete a user. Scoped exactly like updateUserRole (a TENANT_ADMIN is fenced to its own tenant; a
// SUPER_ADMIN, tenantId null, is fleet-wide). Two guards: never delete the acting user, and never
// delete the last admin of a scope (tenant TENANT_ADMIN, or fleet SUPER_ADMIN). Users have no
// incoming FKs (invitedById/actorId are plain columns), so the row deletes cleanly.
export async function deleteUser(
  callerTenantId: bigint | null,
  userId: bigint,
  actingUserId: bigint,
  base: PrismaClient = prisma,
) {
  if (userId === actingUserId) {
    throw new CannotDeleteSelfError();
  }
  const target = await base.user.findFirst({
    where: { id: userId, ...tenantScope(callerTenantId) },
    select: { id: true, role: true, tenantId: true },
  });
  if (!target) {
    throw new UserNotInScopeError();
  }
  if (target.role === "TENANT_ADMIN" || target.role === "SUPER_ADMIN") {
    // For a tenant admin, "the scope" is the tenant; for a super-admin (tenantId null), the fleet.
    const remaining = await base.user.count({
      where: {
        role: target.role,
        id: { not: userId },
        tenantId: target.tenantId === null ? null : target.tenantId,
      },
    });
    if (remaining === 0) {
      throw new LastAdminError();
    }
  }
  await base.user.deleteMany({
    where: { id: userId, ...tenantScope(callerTenantId) },
  });
}
