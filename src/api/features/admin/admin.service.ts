import {
  Prisma,
  type PrismaClient,
  type UserRole,
} from "@/../generated/prisma/client";
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

// A user as the admin panel lists them: a person seen through ONE membership (issue #756). In a
// tenant's view that is the person's membership there; in the fleet view every membership is a row
// of its own, and a SUPER_ADMIN is a row with no tenant. `id` is the PERSON, so two rows of the same
// person carry the same id and differ by `tenantId`.
export interface UserRow {
  id: bigint;
  tenantId: bigint | null;
  email: string;
  name: string | null;
  role: UserRole;
  createdAt: Date;
  lastLoginAt: Date | null;
}

const PERSON_SELECT = {
  id: true,
  email: true,
  name: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

// The person as a member of `tenantId`, or null when they do not belong there.
async function memberRow(
  db: ScopedDb,
  tenantId: bigint,
  userId: bigint,
): Promise<UserRow | null> {
  const m = await db.tenantUser.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { tenantId: true, role: true, user: { select: PERSON_SELECT } },
  });
  return m ? { ...m.user, tenantId: m.tenantId, role: m.role } : null;
}

// The person as a fleet administrator, or null when they are not one.
async function superRow(db: ScopedDb, userId: bigint): Promise<UserRow | null> {
  const u = await db.user.findFirst({
    where: { id: userId, isSuperAdmin: true },
    select: PERSON_SELECT,
  });
  return u ? { ...u, tenantId: null, role: "SUPER_ADMIN" } : null;
}

// The locks, carrying the same fence the read after them carries.
//
// `users` is global, so an unscoped `FOR UPDATE` by id locks a row this caller may have no business
// touching — and it does so BEFORE the scoped read decides it is a 404. A tenant admin could then
// hold a lock on another tenant's user for the length of their transaction, which is contention
// somebody else's role change, deletion or login write waits behind. So a tenant admin locks the
// MEMBERSHIP row in their own tenant, which exists only when the person is theirs to manage, and only
// the fleet administrator, who reaches every person, locks the person.
async function lockMembership(
  db: ScopedDb,
  tenantId: bigint,
  userId: bigint,
): Promise<void> {
  await db.$queryRaw`
    SELECT id FROM tenant_users
     WHERE tenant_id = ${tenantId}::bigint AND user_id = ${userId}
     FOR UPDATE`;
}

async function lockPerson(db: ScopedDb, userId: bigint): Promise<void> {
  await db.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
}

// THE INVARIANT, in one place: a scope keeps somebody who can administer it. Every write that can
// reduce a scope's administrator count asks this, and it is one function because the question is one
// (#496): the delete asked it and the demote did not, so the same tenant could be emptied by the
// cheaper of the two paths.
//
// A tenant's administrators are its TENANT_ADMIN memberships; the fleet's are the SUPER_ADMIN
// people (issue #756). The count is plain because `lockAdminScope` below is what serialises it.
// Counting under a row lock on the TARGET, which is what the delete used to do, is the other half of
// #496: two removals aimed at DIFFERENT administrators lock different rows, so nothing serialises
// them, each counts the other as remaining, and the scope ends with none.
async function assertScopeKeepsAnAdmin(
  db: ScopedDb,
  tenantId: bigint | null,
  leavingUserId: bigint,
): Promise<void> {
  const remaining =
    tenantId === null
      ? await db.user.count({
          where: { isSuperAdmin: true, id: { not: leavingUserId } },
        })
      : await db.tenantUser.count({
          where: {
            tenantId,
            role: "TENANT_ADMIN",
            userId: { not: leavingUserId },
          },
        });
  if (remaining === 0) {
    throw new LastAdminError();
  }
}

// One lock per SCOPE, taken before any row, by every write that can change that scope's
// administrator count. An advisory lock rather than the administrator rows themselves, and that is
// the whole design: a set of rows has to be locked in some order, and two writers that disagree
// about the order (a target read as an AGENT while somebody promotes it, a scan that comes back the
// other way round) each end up holding a row the other needs.
//
// The fleet (`tenantId` null) is a scope like any other. A write that touches several scopes (the
// fleet deleting a person who administers two tenants, or demoting a fleet administrator into a
// tenant) takes them in ONE order, fleet first and then tenants ascending, which is what keeps two
// such writers from each holding a scope the other waits for.
//
// `hashtext` maps to int4, so two scopes can share a slot: that over-serialises two tenants' admin
// writes and never lets two holders of the same scope run at once, which is the direction that
// matters (the same trade-off `withEntityLock` documents).
async function lockAdminScopes(
  db: ScopedDb,
  scopes: readonly (bigint | null)[],
): Promise<void> {
  const ordered = [...new Set(scopes)].sort((a, b) =>
    a === null ? -1 : b === null ? 1 : a < b ? -1 : a > b ? 1 : 0,
  );
  for (const tenantId of ordered) {
    const key = `admin-scope:${tenantId === null ? "fleet" : tenantId}`;
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
  }
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

  // One row per membership, plus one per fleet administrator in the fleet view (see `UserRow`). A
  // UNION in SQL because the page has to be cut across both kinds at once. The search keeps the
  // semantics it had: case-insensitive `contains` on the email, `%`/`_` escaped so they mean
  // themselves.
  const pattern = search
    ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    : null;
  const emailFilter = pattern
    ? Prisma.sql`AND u.email ILIKE ${pattern}`
    : Prisma.empty;
  const members = Prisma.sql`
    SELECT u.id, m.tenant_id, u.email, u.name, m.role::text AS role, u.created_at, u.last_login_at
      FROM tenant_users m JOIN users u ON u.id = m.user_id
     WHERE (${tenantId}::bigint IS NULL OR m.tenant_id = ${tenantId}::bigint) ${emailFilter}`;
  const rows = Prisma.sql`
    ${members}
    ${
      tenantId === null
        ? Prisma.sql`UNION ALL
    SELECT u.id, NULL::bigint, u.email, u.name, 'SUPER_ADMIN', u.created_at, u.last_login_at
      FROM users u WHERE u.is_super_admin ${emailFilter}`
        : Prisma.empty
    }`;

  const [page_, counted] = await Promise.all([
    prisma.$queryRaw<
      Array<{
        id: bigint;
        tenant_id: bigint | null;
        email: string;
        name: string | null;
        role: UserRole;
        created_at: Date;
        last_login_at: Date | null;
      }>
    >`SELECT * FROM (${rows}) r
       ORDER BY created_at DESC, id DESC, tenant_id NULLS FIRST
       LIMIT ${pageSize} OFFSET ${skip}`,
    prisma.$queryRaw<
      Array<{ n: bigint }>
    >`SELECT count(*)::bigint AS n FROM (${rows}) r`,
  ]);
  const total = Number(counted[0]?.n ?? 0n);

  return {
    users: page_.map(
      (r): UserRow => ({
        id: r.id,
        tenantId: r.tenant_id,
        email: r.email,
        name: r.name,
        role: r.role,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
      }),
    ),
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
// Tenants are RLS-protected → asSuperAdmin; memberships are global → counted via a plain groupBy
// (a SUPER_ADMIN needs no membership and is not attributed to any tenant).
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
    base.tenantUser.groupBy({ by: ["tenantId"], _count: { _all: true } }),
  ]);
  const countByTenant = new Map(
    counts.map((c) => [c.tenantId.toString(), c._count._all]),
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

// A tenant counts its members and its TENANT_ADMIN members; the fleet counts people, and as admins
// the people who administer anything (the fleet itself, or any tenant).
export async function getAdminStats(tenantId: bigint | null) {
  const [totalUsers, adminCount] =
    tenantId === null
      ? await Promise.all([
          prisma.user.count(),
          prisma.user.count({
            where: {
              OR: [
                { isSuperAdmin: true },
                { memberships: { some: { role: "TENANT_ADMIN" } } },
              ],
            },
          }),
        ])
      : await Promise.all([
          prisma.tenantUser.count({ where: { tenantId } }),
          prisma.tenantUser.count({
            where: { tenantId, role: { not: "AGENT" } },
          }),
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

// The scope this write locked stopped being the scope the write is about, because somebody moved the
// target between the unlocked peek and the row lock. Not reported as itself: the caller retries, and
// the retry's peek reads the committed state, so it converges in one.
class ScopeMovedError extends Error {
  constructor() {
    super("The target moved scope while this write was starting");
    this.name = "ScopeMovedError";
  }
}

// What is left when the retries run out, which needs a name of its own because the operator has to be
// told to try again rather than shown a 500.
export class ConcurrentMoveError extends Error {
  constructor() {
    super("This account is being changed by somebody else; try again");
    this.name = "ConcurrentMoveError";
  }
}

const SCOPE_ATTEMPTS = 3;

// Taking the fleet role away has to say which tenant the person keeps working in: a person with no
// membership has nothing to enter, and a request that does not name a tenant would leave exactly that
// (#534). The fleet also has to name a tenant to re-role somebody who belongs to several, because the
// role is held per membership (issue #756).
export class TenantRequiredError extends Error {
  constructor() {
    super("This role change must name the tenant it applies to");
    this.name = "TenantRequiredError";
  }
}

// A tenant administrator's role change applies to their own tenant, and naming another is refused
// rather than read as "move them there": moving people between tenants is not what this endpoint does.
export class TenantNotChangeableError extends Error {
  constructor() {
    super("A tenant administrator's role change cannot name another tenant");
    this.name = "TenantNotChangeableError";
  }
}

// The named tenant has to exist. It would otherwise reach the operator as a 500 from the foreign key.
export class TenantNotFoundError extends Error {
  constructor() {
    super("Tenant not found");
    this.name = "TenantNotFoundError";
  }
}

// The destination of a fleet administrator's demotion, refused here rather than by the database.
async function tenantToJoin(
  db: ScopedDb,
  params: { tenantId?: bigint | null },
): Promise<bigint> {
  const tenantId = params.tenantId;
  if (tenantId == null) {
    throw new TenantRequiredError();
  }
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });
  if (!tenant) {
    throw new TenantNotFoundError();
  }
  return tenantId;
}

// Retrying is what replaces a second lock. The scope keys are read before the row is locked, so a
// change that commits in that window (the person promoted to the fleet, or given an admin role
// somewhere, by somebody else) leaves this transaction holding the wrong set of scope locks — and
// taking more THEN would mean holding them in an order two callers can disagree about, which is the
// cycle #496 removed. Aborting and starting over holds nothing while it waits, and the new peek reads
// the state the other writer committed.
async function withScopeRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ScopeMovedError)) throw error;
      // A move is a person doing something in a console, so a target that moves three times while one
      // write starts is not contention to wait out: it is something the operator has to see.
      if (attempt >= SCOPE_ATTEMPTS) throw new ConcurrentMoveError();
    }
  }
}

// The scopes a write locked have to be the scopes its guards count. Asked AFTER the row lock, where
// the answer is finally stable.
function assertScopesHeld(
  locked: readonly (bigint | null)[],
  now: readonly (bigint | null)[],
): void {
  const held = new Set(locked);
  if (now.some((s) => !held.has(s))) throw new ScopeMovedError();
}

// The administrative scopes a person holds: the fleet when they are a SUPER_ADMIN, and every tenant
// they administer. These are the scopes deleting the person would reduce.
async function adminScopesOf(
  db: ScopedDb,
  userId: bigint,
): Promise<(bigint | null)[] | null> {
  const person = await db.user.findUnique({
    where: { id: userId },
    select: {
      isSuperAdmin: true,
      memberships: {
        where: { role: "TENANT_ADMIN" },
        select: { tenantId: true },
      },
    },
  });
  if (!person) return null;
  return [
    ...(person.isSuperAdmin ? [null] : []),
    ...person.memberships.map((m) => m.tenantId),
  ];
}

// Re-role one membership. Shared by the tenant administrator (their own tenant) and the fleet
// (whichever membership it names), under the tenant's scope lock and the membership's row lock.
async function setMembershipRole(
  db: ScopedDb,
  ctx: TenantContext,
  tenantId: bigint,
  userId: bigint,
  role: ManageableRole,
): Promise<UserRow> {
  await lockAdminScopes(db, [tenantId]);
  await lockMembership(db, tenantId, userId);
  // The row is locked before it is read, and the read is what the recorded `before` comes from.
  // Two admins re-roling the same person otherwise both read the same value and both record the
  // same transition, so the trail shows one of the two changes twice and the other not at all.
  const before = await memberRow(db, tenantId, userId);
  // NOTE: the scope guard is the READ, so a person outside the tenant is a 404 and never a
  // cross-tenant edit.
  if (!before) {
    throw new UserNotInScopeError();
  }
  // The guard, on the role the LOCKED read reports: a demote only threatens the invariant when it
  // takes an administrator role away.
  if (before.role === "TENANT_ADMIN" && role !== "TENANT_ADMIN") {
    await assertScopeKeepsAnAdmin(db, tenantId, userId);
  }
  await db.tenantUser.update({
    where: { tenantId_userId: { tenantId, userId } },
    data: { role },
  });
  const user = { ...before, role };
  if (before.role !== role) {
    // Filed under the TARGET's tenant, which is not the caller's for a fleet administrator: a
    // SUPER_ADMIN re-roling somebody in tenant 7 is that tenant's business.
    await auditMutationOn(db, ctx, tenantId, {
      action: "user.role_set",
      target: `user:${userId}`,
      before: userAuditProjection(before),
      after: userAuditProjection(user),
    });
  }
  return user;
}

// `ctx.tenantId` is the tenant the caller administers in THIS request (their selected membership,
// src/api/lib/auth.ts) and null for a SUPER_ADMIN, who reaches every person. The controller builds
// it from the session on purpose — handing this the tenancy plugin's selector would silently fence a
// fleet admin to whatever tab they had open.
//
// A tenant administrator re-roles the person's membership in their own tenant. The fleet re-roles
// the membership `params.tenantId` names (or the only one the person has), and demoting a fleet
// administrator takes the fleet role away and gives them that membership (issue #756).
export async function updateUserRole(
  ctx: TenantContext,
  userId: bigint,
  params: { role: ManageableRole; tenantId?: bigint | null },
  base: PrismaClient = prisma,
): Promise<UserRow> {
  const { role } = params;
  if (ctx.tenantId !== null) {
    if (params.tenantId != null && params.tenantId !== ctx.tenantId) {
      throw new TenantNotChangeableError();
    }
    const tenantId = ctx.tenantId;
    return asPrincipalOn(base, ctx, (db) =>
      setMembershipRole(db, ctx, tenantId, userId, role),
    );
  }
  return withScopeRetry(() =>
    asPrincipalOn(base, ctx, async (db) => {
      // NOTE: the scope locks come BEFORE the row lock, and which scopes is a question the unlocked
      // peek answers; the locked read below confirms it or starts over (`withScopeRetry`).
      const peek = await db.user.findUnique({
        where: { id: userId },
        select: {
          isSuperAdmin: true,
          memberships: { select: { tenantId: true } },
        },
      });
      if (!peek) {
        throw new UserNotInScopeError();
      }
      if (!peek.isSuperAdmin) {
        const named =
          params.tenantId ??
          (peek.memberships.length === 1
            ? (peek.memberships[0] as { tenantId: bigint }).tenantId
            : null);
        if (named === null) {
          throw new TenantRequiredError();
        }
        const user = await setMembershipRole(db, ctx, named, userId, role);
        // Promoted to the fleet while this ran: the membership's role changed under a role the
        // person no longer answers to as such, so the write starts over and takes the right path.
        if (await superRow(db, userId)) throw new ScopeMovedError();
        return user;
      }
      const joining = await tenantToJoin(db, params);
      await lockAdminScopes(db, [null, joining]);
      await lockPerson(db, userId);
      const before = await superRow(db, userId);
      if (!before) throw new ScopeMovedError();
      await assertScopeKeepsAnAdmin(db, null, userId);
      await db.user.update({
        where: { id: userId },
        data: { isSuperAdmin: false },
      });
      await db.tenantUser.upsert({
        where: { tenantId_userId: { tenantId: joining, userId } },
        create: { tenantId: joining, userId, role },
        update: { role },
      });
      const user: UserRow = { ...before, tenantId: joining, role };
      // Filed under the tenant the person is IN once the write lands, the one they just joined.
      // `docs/api-and-fleet.md`: a row about a person joins the trail of the person, and a row filed
      // under the fleet is one the tenant that gained them cannot read.
      await auditMutationOn(db, ctx, joining, {
        action: "user.role_set",
        target: `user:${userId}`,
        before: userAuditProjection(before),
        after: userAuditProjection(user),
      });
      return user;
    }),
  );
}

// Remove a user. A tenant administrator removes the person FROM THEIR TENANT: the membership goes,
// and the account with it only when it was the person's last one (an account with nowhere to enter
// is nothing to keep). The account itself — name, email, password, the other tenants — is not a
// tenant administrator's to delete (issue #756). The fleet deletes the account, every membership
// with it. Two guards: never delete the acting user, and never remove the last admin of a scope.
// Users have no incoming FKs besides their memberships (invitedById/actorId are plain columns), so
// the row deletes cleanly.
export async function deleteUser(
  ctx: TenantContext,
  userId: bigint,
  base: PrismaClient = prisma,
) {
  if (userId === ctx.userId) {
    throw new CannotDeleteSelfError();
  }
  const callerTenantId = ctx.tenantId;
  if (callerTenantId !== null) {
    await asPrincipalOn(base, ctx, async (db) => {
      await lockAdminScopes(db, [callerTenantId]);
      await lockMembership(db, callerTenantId, userId);
      // Locked before it is read, which serialises two acts on the SAME membership: without it both
      // read the row, both record a `before` naming a live member, and the trail carries it twice.
      const target = await memberRow(db, callerTenantId, userId);
      if (!target) {
        throw new UserNotInScopeError();
      }
      if (target.role === "TENANT_ADMIN") {
        await assertScopeKeepsAnAdmin(db, callerTenantId, userId);
      }
      const removed = await db.tenantUser.deleteMany({
        where: { tenantId: callerTenantId, userId },
      });
      if (removed.count === 0) return;
      await db.user.deleteMany({
        where: { id: userId, isSuperAdmin: false, memberships: { none: {} } },
      });
      // The row OUTLIVES the membership, which is the only reason it can answer for it: `audit_logs`
      // has no foreign key to `users`, so this is where a removed person's identity survives.
      await auditMutationOn(db, ctx, callerTenantId, {
        action: "user.delete",
        target: `user:${userId}`,
        before: userAuditProjection(target),
      });
    });
    return;
  }
  await withScopeRetry(() =>
    asPrincipalOn(base, ctx, async (db) => {
      // NOTE: the scope locks first and the row second, for the reason `lockAdminScopes` gives.
      // Taking them rather than counting under the target's own row lock is what stops two deletes
      // aimed at different administrators from each reading the other as remaining.
      const peeked = await adminScopesOf(db, userId);
      if (peeked === null) {
        throw new UserNotInScopeError();
      }
      await lockAdminScopes(db, peeked);
      await lockPerson(db, userId);
      const scopes = await adminScopesOf(db, userId);
      if (scopes === null) {
        throw new UserNotInScopeError();
      }
      assertScopesHeld(peeked, scopes);
      for (const scope of scopes) {
        await assertScopeKeepsAnAdmin(db, scope, userId);
      }
      // What the person was, read under the lock: one row per membership, and the fleet row.
      const memberships = await db.tenantUser.findMany({
        where: { userId },
        select: { tenantId: true },
        orderBy: { tenantId: "asc" },
      });
      const views: UserRow[] = [];
      const asSuper = await superRow(db, userId);
      if (asSuper) views.push(asSuper);
      for (const m of memberships) {
        const row = await memberRow(db, m.tenantId, userId);
        if (row) views.push(row);
      }
      const removed = await db.user.deleteMany({ where: { id: userId } });
      if (removed.count === 0) return;
      // Filed under every tenant the person belonged to, and the fleet for a SUPER_ADMIN: each of
      // those trails lost somebody, and a row filed under only one is one the others cannot read.
      for (const view of views) {
        await auditMutationOn(db, ctx, view.tenantId, {
          action: "user.delete",
          target: `user:${userId}`,
          before: userAuditProjection(view),
        });
      }
    }),
  );
}
