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

// Roles a tenant admin may assign: never SUPER_ADMIN, which only /setup or `bun set-admin` mint.
export type ManageableRole = "AGENT" | "TENANT_ADMIN";

// A person seen through ONE membership. In the fleet view every membership is a row of its own and
// a SUPER_ADMIN is a row with no tenant; `id` is the PERSON, so two rows can share it.
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

// A tenant admin locks the MEMBERSHIP in their own tenant, never the global `users` row, which would
// let them hold another tenant's person (and every write on it) before the scoped read 404s. Only
// the fleet administrator, or a caller whose scoped read already found the person, locks the person.
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

// The invariant, asked by every write that can reduce an administrator count: a scope keeps someone
// who can administer it (a tenant's TENANT_ADMIN memberships, the fleet's SUPER_ADMIN people). The
// count is plain because `lockAdminScopes` serialises it; a lock on the TARGET row would not, since
// two removals of different administrators each count the other as remaining.
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

// One advisory lock per SCOPE (the fleet is `null`), taken before any row by every write that can
// change an administrator count. Not the administrator rows: writers can disagree on the order of a
// set of rows and deadlock. Several scopes are taken in ONE order, fleet first, then tenants
// ascending. `hashtext` can map two scopes to one slot, which only over-serialises.
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

// What the audit trail records of a user. The email is in on purpose: an id no longer identifies a
// deleted person, and every reader of a tenant's trail can already list its users' emails. What
// authenticates (`passwordHash`, `googleId`) and what this family never writes (`lastLoginAt`) stay out.
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
  // NOTE: checked here rather than in the query parser, so a caller without a query string is held
  // to it too; a negative page would reach Prisma as a negative `skip` and answer 500.
  if (!Number.isInteger(page) || page < 1) badQueryParam("page");
  const pageSize = 20;
  const skip = (page - 1) * pageSize;

  // A SQL UNION because the page is cut across memberships and fleet administrators at once.
  // The search is a case-insensitive `contains` on the email, with `%`/`_` escaped.
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

// Every tenant with its member count. Tenants are RLS-protected (asSuperAdmin); memberships are
// global, so a plain groupBy counts them.
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

// The target moved scope between the unlocked peek and the row lock. Never reported: the caller
// retries, and the retry's peek reads the committed state.
class ScopeMovedError extends Error {
  constructor() {
    super("The target moved scope while this write was starting");
    this.name = "ScopeMovedError";
  }
}

// The retries ran out; the operator is told to try again rather than shown a 500.
export class ConcurrentMoveError extends Error {
  constructor() {
    super("This account is being changed by somebody else; try again");
    this.name = "ConcurrentMoveError";
  }
}

const SCOPE_ATTEMPTS = 3;

// Taking the fleet role away must name the tenant the person keeps working in, or they are left with
// nothing to enter. Re-roling a person with several memberships must name one, since the role is
// held per membership.
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

// Retrying replaces a second lock. The scopes are read before the row lock, so a change committed in
// that window leaves the wrong set of scope locks held, and taking more then would break the single
// lock order `lockAdminScopes` keeps. Starting over holds nothing while it waits.
async function withScopeRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ScopeMovedError)) throw error;
      // NOTE: a move is a person acting in a console, so three in a row are shown, not waited out.
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

// Every scope a person's deletion touches: the fleet for a SUPER_ADMIN, and every tenant they belong
// to, administrator or not, since an AGENT membership can be promoted (and the tenant's previous
// admin demoted) before the cascade. Holding those scopes makes such writes wait for the deletion.
async function personScopesOf(
  db: ScopedDb,
  userId: bigint,
): Promise<(bigint | null)[] | null> {
  const person = await db.user.findUnique({
    where: { id: userId },
    select: {
      isSuperAdmin: true,
      memberships: { select: { tenantId: true } },
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
  // Locked before it is read, since the read is the recorded `before`: two concurrent re-roles
  // would otherwise record the same transition twice.
  const before = await memberRow(db, tenantId, userId);
  // NOTE: the scope guard is the READ, so a person outside the tenant is a 404 and never a
  // cross-tenant edit.
  if (!before) {
    throw new UserNotInScopeError();
  }
  // NOTE: on the role the LOCKED read reports.
  if (before.role === "TENANT_ADMIN" && role !== "TENANT_ADMIN") {
    await assertScopeKeepsAnAdmin(db, tenantId, userId);
  }
  await db.tenantUser.update({
    where: { tenantId_userId: { tenantId, userId } },
    data: { role },
  });
  const user = { ...before, role };
  if (before.role !== role) {
    // NOTE: filed under the TARGET's tenant, which for a fleet administrator is not the caller's.
    await auditMutationOn(db, ctx, tenantId, {
      action: "user.role_set",
      target: `user:${userId}`,
      before: userAuditProjection(before),
      after: userAuditProjection(user),
    });
  }
  return user;
}

// `ctx.tenantId` is the tenant the caller administers in this request, null for a SUPER_ADMIN. It
// comes from the session, not the tenancy plugin's selector, which would fence a fleet admin to the
// tab they had open. The fleet re-roles the membership `params.tenantId` names (or the only one);
// `demoteFleet` takes the fleet role away and gives the person that membership.
export async function updateUserRole(
  ctx: TenantContext,
  userId: bigint,
  params: {
    role: ManageableRole;
    tenantId?: bigint | null;
    // Explicit, because a fleet administrator can also hold memberships, and editing one of them must
    // never double as a demotion.
    demoteFleet?: boolean;
  },
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
      // The scope locks come BEFORE the row lock, and which scopes is a question the unlocked
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
      if (!params.demoteFleet) {
        const named =
          params.tenantId ??
          (peek.memberships.length === 1
            ? (peek.memberships[0] as { tenantId: bigint }).tenantId
            : null);
        if (named === null) {
          throw new TenantRequiredError();
        }
        return setMembershipRole(db, ctx, named, userId, role);
      }
      if (!peek.isSuperAdmin) {
        throw new UserNotInScopeError();
      }
      const joining = await tenantToJoin(db, params);
      await lockAdminScopes(db, [null, joining]);
      await lockPerson(db, userId);
      const before = await superRow(db, userId);
      if (!before) throw new ScopeMovedError();
      await assertScopeKeepsAnAdmin(db, null, userId);
      // Replacing an existing TENANT_ADMIN membership in the landing tenant is a demotion
      // there too, so that tenant must keep an administrator. Its scope lock is already held.
      const already = await memberRow(db, joining, userId);
      if (already?.role === "TENANT_ADMIN" && role !== "TENANT_ADMIN") {
        await assertScopeKeepsAnAdmin(db, joining, userId);
      }
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
      // NOTE: filed under the tenant they just joined, since a row under the fleet is one that tenant
      // cannot read (docs/api-and-fleet.md).
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

// A tenant administrator removes the person from THEIR tenant: the membership, and the account only
// when it was the last one, since the rest of the account is not theirs to delete. The fleet deletes
// the account with every membership. Never the acting user, never a scope's last admin. Users have
// no incoming FKs besides their memberships (invitedById/actorId are plain columns), so the row
// deletes cleanly.
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
      // Locked before it is read, so two acts on the same membership do not both audit it.
      const target = await memberRow(db, callerTenantId, userId);
      if (!target) {
        throw new UserNotInScopeError();
      }
      // NOTE: the person too, since two admins removing the last two memberships from different
      // tenants share no other lock and would each leave the account behind. Only after the scoped
      // read found them here, so no tenant admin holds another tenant's person.
      await lockPerson(db, userId);
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
      // NOTE: `audit_logs` has no foreign key to `users`, so this row is where the identity survives.
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
      // Scope locks first, row second (see `lockAdminScopes`).
      const peeked = await personScopesOf(db, userId);
      if (peeked === null) {
        throw new UserNotInScopeError();
      }
      await lockAdminScopes(db, peeked);
      // NOTE: this lock also holds off a new membership, whose insert takes a key-share lock here
      // through the foreign key.
      await lockPerson(db, userId);
      const touched = await personScopesOf(db, userId);
      if (touched === null) {
        throw new UserNotInScopeError();
      }
      assertScopesHeld(peeked, touched);
      for (const scope of (await adminScopesOf(db, userId)) ?? []) {
        await assertScopeKeepsAnAdmin(db, scope, userId);
      }
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
      // NOTE: filed under every tenant (and the fleet) the person was in, since each trail lost them.
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
