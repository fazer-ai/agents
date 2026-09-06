import type { PrismaClient } from "@/../generated/prisma/client";
import prisma from "@/api/lib/prisma";
import { badQueryParam } from "@/lib/query-param";
import {
  asPrincipalOn,
  asSuperAdminOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { auditMutationOn } from "@/modules/audit/service";

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

// The lock, carrying the same fence the read after it carries.
//
// `users` is global, so an unscoped `FOR UPDATE` by id locks a row this caller may have no business
// touching — and it does so BEFORE the scoped read decides it is a 404. A tenant admin could then
// hold a lock on another tenant's user for the length of their transaction, which is contention
// somebody else's role change, deletion or login write waits behind. The scope has to be part of
// the lock, not of the check after it.
//
// `IS NULL OR` rather than two queries: a SUPER_ADMIN has no home tenant and reaches every row, and
// keeping one statement is what keeps the lock and the read (`tenantScope`) provably the same fence.
async function lockUserInScope(
  db: ScopedDb,
  tenantId: bigint | null,
  userId: bigint,
): Promise<void> {
  await db.$queryRaw`
    SELECT id FROM users
     WHERE id = ${userId}
       AND (${tenantId}::bigint IS NULL OR tenant_id = ${tenantId}::bigint)
     FOR UPDATE`;
}

// THE INVARIANT, in one place: a scope keeps somebody who can administer it. Every write that can
// reduce a scope's administrator count asks this, and it is one function because the question is one
// (#496): the delete asked it and the demote did not, so the same tenant could be emptied by the
// cheaper of the two paths.
//
// The count is plain because `lockAdminScope` below is what serialises it. Counting under a row lock
// on the TARGET, which is what the delete used to do, is the other half of that issue: two removals
// aimed at DIFFERENT administrators lock different rows, so nothing serialises them, each counts the
// other as remaining, and the scope ends with none.
async function assertScopeKeepsAnAdmin(
  db: ScopedDb,
  role: "TENANT_ADMIN" | "SUPER_ADMIN",
  tenantId: bigint | null,
  leavingUserId: bigint,
): Promise<void> {
  const remaining = await db.user.count({
    where: { role, tenantId, id: { not: leavingUserId } },
  });
  if (remaining === 0) {
    throw new LastAdminError();
  }
}

// One lock per SCOPE, taken before any row, by every write that can change that scope's
// administrator count. An advisory lock rather than the administrator rows themselves, and that is
// the whole design: a set of rows has to be locked in some order, and two writers that disagree
// about the order (a target read as an AGENT while somebody promotes it, a scan that comes back the
// other way round) each end up holding a row the other needs. A single lock taken FIRST cannot be
// held by anyone who is waiting for another, so this family has no lock cycle to reason about.
//
// The scope is the target's tenant, and the fleet (`tenantId` null) is a scope like any other. A
// user never changes tenant — nothing in the tree writes `users.tenant_id` after creation, and only
// `updateUserRole` writes `users.role` — so the tenant read to build this key cannot be stale in the
// way the role can, which is what lets the key be chosen before the row is locked.
//
// `hashtext` maps to int4, so two scopes can share a slot: that over-serialises two tenants' admin
// writes and never lets two holders of the same scope run at once, which is the direction that
// matters (the same trade-off `withEntityLock` documents).
async function lockAdminScope(
  db: ScopedDb,
  tenantId: bigint | null,
): Promise<void> {
  const key = `admin-scope:${tenantId === null ? "fleet" : tenantId}`;
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
}

// The scope this write belongs to, read with the caller's own fence so naming an id from another
// tenant cannot make the lock above serialise that tenant. Null when the target is not visible here
// at all: the read under the lock is what answers 404, and this one only picks the key.
async function scopeOfTarget(
  db: ScopedDb,
  callerTenantId: bigint | null,
  userId: bigint,
): Promise<{ tenantId: bigint | null } | null> {
  return db.user.findFirst({
    where: { id: userId, ...tenantScope(callerTenantId) },
    select: { tenantId: true },
  });
}

// What a user's row carries when their membership changes.
//
// The email is IN it, and that is a decision rather than an oversight. The trail exists to answer
// "who became an admin" and "whose account was deleted", and an id answers neither once the row it
// pointed at is gone — which for a delete is the whole point. It is also not a disclosure: every
// reader of a tenant's trail can already list that tenant's users with their emails. What stays out
// is what authenticates rather than identifies (`passwordHash`, `googleId`) and what this family
// never writes (`lastLoginAt`, stamped by the login path, which #400 leaves to the auth question it
// belongs to).
function userAuditProjection(row: {
  id: bigint;
  tenantId: bigint | null;
  email: string;
  name: string | null;
  role: string;
}) {
  return {
    userId: row.id.toString(),
    tenantId: row.tenantId === null ? null : row.tenantId.toString(),
    email: row.email,
    name: row.name,
    role: row.role,
  };
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

// `ctx.tenantId` is the caller's HOME tenant and never a console selection: a SUPER_ADMIN has none
// (null → unscoped, so they re-role across tenants), and everyone else is fenced to their own. The
// controller builds it that way on purpose — handing this the tenancy plugin's selector would
// silently fence a fleet admin to whatever tab they had open.
export async function updateUserRole(
  ctx: TenantContext,
  userId: bigint,
  role: ManageableRole,
  base: PrismaClient = prisma,
) {
  return asPrincipalOn(base, ctx, async (db) => {
    // The row is locked before it is read, and the read is what the recorded `before` comes from.
    // Two admins re-roling the same person otherwise both read the same value and both record the
    // same transition, so the trail shows one of the two changes twice and the other not at all —
    // on the family where the recorded transition is the entire point.
    // NOTE: the scope lock comes BEFORE the row lock, and nothing here takes a second one. Which
    // scope is a question the unlocked read below can answer, because a user never changes tenant;
    // which ROLE they hold is not, which is why the guard is evaluated on the locked read further
    // down rather than on this one.
    const scope = await scopeOfTarget(db, ctx.tenantId, userId);
    if (scope !== null) {
      await lockAdminScope(db, scope.tenantId);
    }
    await lockUserInScope(db, ctx.tenantId, userId);
    const before = await db.user.findFirst({
      where: { id: userId, ...tenantScope(ctx.tenantId) },
      select: USER_SELECT,
    });
    // NOTE: the scope guard is the READ, so an out-of-scope target is a 404 and never a cross-tenant
    // edit — the same fence the `updateMany` this replaced carried in its `where`.
    if (!before) {
      throw new UserNotInScopeError();
    }
    // The guard, on the role the LOCKED read reports and not on any earlier one: a demote only
    // threatens the invariant when it takes an administrator role away.
    if (
      (before.role === "TENANT_ADMIN" || before.role === "SUPER_ADMIN") &&
      before.role !== role
    ) {
      await assertScopeKeepsAnAdmin(db, before.role, before.tenantId, userId);
    }
    const user = await db.user.update({
      where: { id: userId },
      data: { role },
      select: USER_SELECT,
    });
    if (before.role !== user.role) {
      // Filed under the TARGET's tenant, which is not the caller's: a SUPER_ADMIN re-roling somebody
      // in tenant 7 is that tenant's business, and keyed on the actor the row would join a trail
      // (or the fleet's) where the tenant it happened to can never read it. A SUPER_ADMIN target
      // belongs to no tenant, and their row is fleet-level for the same reason.
      await auditMutationOn(db, ctx, before.tenantId, {
        action: "user.role_set",
        target: `user:${userId}`,
        before: userAuditProjection(before),
        after: userAuditProjection(user),
      });
    }
    return user;
  });
}

// Delete a user. Scoped exactly like updateUserRole (a TENANT_ADMIN is fenced to its own tenant; a
// SUPER_ADMIN, tenantId null, is fleet-wide). Two guards: never delete the acting user, and never
// delete the last admin of a scope (tenant TENANT_ADMIN, or fleet SUPER_ADMIN). Users have no
// incoming FKs (invitedById/actorId are plain columns), so the row deletes cleanly.
export async function deleteUser(
  ctx: TenantContext,
  userId: bigint,
  base: PrismaClient = prisma,
) {
  if (userId === ctx.userId) {
    throw new CannotDeleteSelfError();
  }
  const callerTenantId = ctx.tenantId;
  await asPrincipalOn(base, ctx, async (db) => {
    // Locked before it is read, which serialises two acts on the SAME user: without it both read the
    // row, both record a `before` naming a live account, and the trail carries the deletion twice.
    //
    // NOTE: the scope lock first and the row second, for the reason `updateUserRole` gives at the
    // same call. Taking it here rather than counting under the target's own row lock is what stops
    // two deletes aimed at different administrators from each reading the other as remaining.
    const scope = await scopeOfTarget(db, callerTenantId, userId);
    if (scope !== null) {
      await lockAdminScope(db, scope.tenantId);
    }
    await lockUserInScope(db, callerTenantId, userId);
    const target = await db.user.findFirst({
      where: { id: userId, ...tenantScope(callerTenantId) },
      select: USER_SELECT,
    });
    if (!target) {
      throw new UserNotInScopeError();
    }
    // For a tenant admin "the scope" is the tenant; for a super-admin (tenantId null), the fleet.
    if (target.role === "TENANT_ADMIN" || target.role === "SUPER_ADMIN") {
      await assertScopeKeepsAnAdmin(db, target.role, target.tenantId, userId);
    }
    const removed = await db.user.deleteMany({
      where: { id: userId, ...tenantScope(callerTenantId) },
    });
    if (removed.count === 0) return;
    // The row OUTLIVES the account, which is the only reason it can answer for it: `audit_logs` has
    // no foreign key to `users` (the delete's own comment says why), so this is where a deleted
    // person's identity survives. Filed under the tenant they belonged to, fleet-level for a
    // SUPER_ADMIN, who belonged to none.
    await auditMutationOn(db, ctx, target.tenantId, {
      action: "user.delete",
      target: `user:${userId}`,
      before: userAuditProjection(target),
    });
  });
}
