import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, UserRole } from "@/../generated/prisma/client";
import type { ManageableRole } from "@/api/features/admin/admin.service";
import {
  hashPassword,
  sessionUserOf,
  verifyPassword,
} from "@/api/features/auth/auth.service";
import type { AuthUser, SessionIdentity } from "@/api/lib/auth";
import basePrisma from "@/api/lib/prisma";
import { emailEquals } from "@/lib/email-match";
import {
  asPrincipalOn,
  asSuperAdminOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { auditMutationOn } from "@/modules/audit/service";

// User-invitation flow. Security invariants:
//   - the token is HASHED at rest (sha256); the plaintext is returned ONCE (no mailer: the inviter
//     pastes the link), so a DB dump never yields a usable token.
//   - `invitations` is GLOBAL (no RLS): every read/write MUST carry tenantScope, like admin.service
//     does for `users`. A forgotten filter leaks cross-tenant invites with no DB backstop.
//   - role is bound to the invite ROW; a DB CHECK ties SUPER_ADMIN to a FLEET invite (no tenant).
//   - acceptInvite binds tenantId + role from the persisted invite, NEVER the request; single-use (CAS).
// `base` is injectable so integration tests pass their own (real) client instead of the singleton.

const INVITE_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// A fleet invitation hands over the whole installation, so its link lives a day instead of a week.
const FLEET_INVITE_TTL_MS = DAY_MS;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Same tenant-scoping convention as admin.service: null tenantId = SUPER_ADMIN (fleet-wide).
function tenantScope(tenantId: bigint | null) {
  return tenantId === null ? {} : { tenantId };
}

export type InviteStatus = "pending" | "consumed" | "expired";

function inviteStatus(row: {
  consumedAt: Date | null;
  expiresAt: Date;
}): InviteStatus {
  if (row.consumedAt) return "consumed";
  if (row.expiresAt.getTime() <= Date.now()) return "expired";
  return "pending";
}

export class InviteEmailInUseError extends Error {
  constructor() {
    super("A user with this email already exists in this tenant");
    this.name = "InviteEmailInUseError";
  }
}

export class InviteInvalidError extends Error {
  constructor() {
    super("Invitation is invalid, expired, or already used");
    this.name = "InviteInvalidError";
  }
}

export class InviteNotFoundError extends Error {
  constructor() {
    super("Invitation not found");
    this.name = "InviteNotFoundError";
  }
}

// The invitee ALREADY has an account and did not prove it is theirs: neither signed in as that person
// nor the account's current password. An invitation joins an existing account to the tenant, and
// whoever holds the link must not be able to take that account over with it.
export class InviteAccountProofError extends Error {
  constructor() {
    super("Sign in to the invited account, or give its current password");
    this.name = "InviteAccountProofError";
  }
}

// A NEW account needs a password (the existing-account path proves itself another way, so the field
// is optional on the wire).
export class InvitePasswordRequiredError extends Error {
  constructor() {
    super("A password is required to create the account");
    this.name = "InvitePasswordRequiredError";
  }
}

// Whether the person behind `email` already belongs to `tenantId`. The email is unique across the
// install, so this is one person and the question is their membership.
async function emailExistsInTenant(
  base: Pick<PrismaClient, "tenantUser">,
  email: string,
  tenantId: bigint,
): Promise<boolean> {
  const existing = await base.tenantUser.findFirst({
    where: {
      tenantId,
      user: { email: emailEquals(email) },
    },
    select: { id: true },
  });
  return existing !== null;
}

export interface CreateInviteParams {
  tenantId: bigint;
  email: string;
  role: ManageableRole;
  ttlDays?: number;
}

// What an invitation's row carries. The EMAIL is the subject: the invitee may have no account yet,
// so an id could name nothing. The `tokenHash` never appears: it verifies a live credential that
// grants membership of the tenant, and a trail its own admins read is the last place it belongs.
function inviteAuditProjection(row: {
  id: bigint;
  tenantId: bigint | null;
  email: string;
  role: string;
  expiresAt: Date;
}) {
  return {
    invitationId: row.id.toString(),
    tenantId: row.tenantId === null ? null : row.tenantId.toString(),
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export interface CreatedInvite {
  id: bigint;
  email: string;
  role: UserRole;
  token: string;
  expiresAt: Date;
}

// Mints (or rotates) an invite for (tenantId, email). The caller resolves tenantId + role per the
// principal (a TENANT_ADMIN is forced to its own tenant; a SUPER_ADMIN targets any). Returns the
// plaintext token ONCE. `invitedById` comes off the CONTEXT, never an argument: it says who granted
// this membership, and a caller that could pass its own would attribute an invitation to somebody
// who never issued it.
export async function createInvite(
  ctx: TenantContext,
  params: CreateInviteParams,
  base: PrismaClient = basePrisma,
): Promise<CreatedInvite> {
  // Defense-in-depth (ManageableRole already excludes it; the DB CHECK is the last line).
  if ((params.role as UserRole) === "SUPER_ADMIN") {
    throw new InviteInvalidError();
  }
  const email = params.email.trim().toLowerCase();
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(
    Date.now() + (params.ttlDays ?? INVITE_TTL_DAYS) * DAY_MS,
  );
  const row = await asPrincipalOn(base, ctx, async (db) => {
    // NOTE: inside the transaction because this read decides whether the write happens; outside it,
    // it would decide against a snapshot the upsert is not held to.
    if (await emailExistsInTenant(db, email, params.tenantId)) {
      throw new InviteEmailInUseError();
    }
    const created = await db.invitation.upsert({
      where: { tenantId_email: { tenantId: params.tenantId, email } },
      create: {
        tenantId: params.tenantId,
        email,
        role: params.role,
        tokenHash,
        invitedById: ctx.userId,
        expiresAt,
      },
      // Re-invite rotates the token/role/expiry and clears any prior consumption.
      update: {
        role: params.role,
        tokenHash,
        invitedById: ctx.userId,
        expiresAt,
        consumedAt: null,
      },
      select: {
        id: true,
        tenantId: true,
        email: true,
        role: true,
        expiresAt: true,
      },
    });
    // Filed under the INVITED tenant and not the caller's: a SUPER_ADMIN issuing the first
    // TENANT_ADMIN invite of a brand-new tenant (`POST /v1/tenants` with `adminEmail`) has no tenant
    // of their own, and that invitation is the new tenant's business. Unconditional, because every
    // apply here mints a token: a re-invite ROTATES the previous one, so the act that looks like a
    // no-op is the one that revoked a live credential.
    await auditMutationOn(db, ctx, created.tenantId, {
      action: "invitation.create",
      target: `invitation:${created.id}`,
      after: inviteAuditProjection(created),
    });
    return created;
  });
  return { id: row.id, email: row.email, role: row.role, token, expiresAt };
}

// Only a SUPER_ADMIN mints a fleet invitation, since it makes the invitee one.
export class FleetInviteForbiddenError extends Error {
  constructor() {
    super("Only a super admin can invite a super admin");
    this.name = "FleetInviteForbiddenError";
  }
}

// Mints (or rotates) the FLEET invitation for `email`: accepting it makes the invitee a SUPER_ADMIN.
// It names no tenant, lives a day, and is single-use like any other. Rotation replaces the row, so
// the previous link stops working the moment a new one exists.
export async function createFleetInvite(
  ctx: TenantContext,
  rawEmail: string,
  base: PrismaClient = basePrisma,
): Promise<CreatedInvite> {
  if (ctx.role !== "SUPER_ADMIN") throw new FleetInviteForbiddenError();
  const email = rawEmail.trim().toLowerCase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + FLEET_INVITE_TTL_MS);
  const row = await asPrincipalOn(base, ctx, async (db) => {
    // NOTE: per-email lock, since two rotations would otherwise both delete before either inserts,
    // and the second insert would hit `invitations_fleet_email_key`.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`fleet-invite:${email}`})::bigint)`;
    await db.invitation.deleteMany({ where: { tenantId: null, email } });
    const created = await db.invitation.create({
      data: {
        tenantId: null,
        email,
        role: "SUPER_ADMIN",
        tokenHash: hashToken(token),
        invitedById: ctx.userId,
        expiresAt,
      },
      select: {
        id: true,
        tenantId: true,
        email: true,
        role: true,
        expiresAt: true,
      },
    });
    await auditMutationOn(db, ctx, null, {
      action: "invitation.create",
      target: `invitation:${created.id}`,
      after: inviteAuditProjection(created),
    });
    return created;
  });
  return { id: row.id, email: row.email, role: row.role, token, expiresAt };
}

// A fleet invitation must not outlive the person reaching or leaving the fleet by another route: one
// left pending would let them take the fleet role back with their own credentials after a demotion.
// Called inside the write that changes `is_super_admin`.
export async function dropFleetInvites(
  db: Pick<ScopedDb, "invitation">,
  email: string,
): Promise<void> {
  await db.invitation.deleteMany({
    where: { tenantId: null, email: email.trim().toLowerCase() },
  });
}

export interface InviteListItem {
  id: string;
  email: string;
  role: UserRole;
  // Null for a fleet invitation.
  tenantId: string | null;
  status: InviteStatus;
  expiresAt: Date;
  createdAt: Date;
}

export async function listInvites(
  tenantId: bigint | null,
  base: PrismaClient = basePrisma,
): Promise<InviteListItem[]> {
  const rows = await base.invitation.findMany({
    where: tenantScope(tenantId),
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      tenantId: true,
      consumedAt: true,
      expiresAt: true,
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id.toString(),
    email: r.email,
    role: r.role,
    tenantId: r.tenantId === null ? null : r.tenantId.toString(),
    status: inviteStatus(r),
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }));
}

// Hard-delete, tenant-scoped (count 0 → out-of-scope/non-existent → NotFound, never cross-tenant).
// The scope is the caller's HOME tenant off the context, null for a SUPER_ADMIN (fleet-wide).
export async function revokeInvite(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await asPrincipalOn(base, ctx, async (db) => {
    // Scoped like the read below it, and for the same reason `admin.service.ts` scopes its own:
    // `invitations` is global, so an unscoped lock by id would let a tenant admin hold another
    // tenant's invitation row for the length of a request that is about to 404.
    await db.$queryRaw`
      SELECT id FROM invitations
       WHERE id = ${id}
         AND (${ctx.tenantId}::bigint IS NULL OR tenant_id = ${ctx.tenantId}::bigint)
       FOR UPDATE`;
    const before = await db.invitation.findFirst({
      where: { id, ...tenantScope(ctx.tenantId) },
      select: {
        id: true,
        tenantId: true,
        email: true,
        role: true,
        expiresAt: true,
      },
    });
    if (!before) throw new InviteNotFoundError();
    const res = await db.invitation.deleteMany({
      where: { id, ...tenantScope(ctx.tenantId) },
    });
    if (res.count === 0) throw new InviteNotFoundError();
    await auditMutationOn(db, ctx, before.tenantId, {
      action: "invitation.revoke",
      target: `invitation:${id}`,
      before: inviteAuditProjection(before),
    });
  });
}

export interface ValidatedInvite {
  email: string;
  role: UserRole;
  // Whether the invited email already has an account, so the accept page asks for that account's
  // password instead of a new one. Only the holder of the (secret) link learns it.
  existingAccount: boolean;
}

// Pre-fill lookup for the accept page. Returns null (generic) for missing/consumed/expired so the
// endpoint cannot distinguish live from dead tokens.
export async function findValidInviteByToken(
  token: string,
  base: PrismaClient = basePrisma,
): Promise<ValidatedInvite | null> {
  const row = await base.invitation.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { email: true, role: true, consumedAt: true, expiresAt: true },
  });
  if (!row || inviteStatus(row) !== "pending") return null;
  const account = await base.user.findFirst({
    where: { email: emailEquals(row.email) },
    select: { id: true },
  });
  return {
    email: row.email,
    role: row.role,
    existingAccount: account !== null,
  };
}

export interface AcceptInviteParams {
  token: string;
  password?: string;
  name?: string | null;
  // The person signed in on this browser, when there is one. An existing account accepts by being
  // signed in as itself under its current password, or by that password.
  session?: SessionIdentity | null;
}

const AUTH_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  googleId: true,
  isSuperAdmin: true,
  memberships: { select: { tenantId: true, role: true, createdAt: true } },
} as const;

// Consumes an invite and makes the invitee a member. tenantId + role come from the ROW (never the
// request). Single-use via CAS consume in the same transaction as the write. One person per email:
// when the email already has an account, the invitation adds a MEMBERSHIP to it and changes nothing
// else about the account (not its password, not its name). Otherwise it creates the account with its
// first membership. The (tenant, user) unique index is the DB backstop against joining twice. The
// session it answers runs under the invited tenant.
export async function acceptInvite(
  params: AcceptInviteParams,
  base: PrismaClient = basePrisma,
): Promise<
  AuthUser & {
    joinedTenantId: bigint | null;
    sessionPasswordHash: string | null;
  }
> {
  const tokenHash = hashToken(params.token);
  const invite = await base.invitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tenantId: true,
      email: true,
      role: true,
      invitedById: true,
      consumedAt: true,
      expiresAt: true,
    },
  });
  if (!invite || inviteStatus(invite) !== "pending") {
    throw new InviteInvalidError();
  }
  const fleetTenantId = invite.tenantId;
  if (
    fleetTenantId !== null &&
    (await emailExistsInTenant(base, invite.email, fleetTenantId))
  ) {
    throw new InviteEmailInUseError();
  }
  const account = await base.user.findFirst({
    where: { email: emailEquals(invite.email) },
    select: { id: true, passwordHash: true, isSuperAdmin: true },
  });
  if (fleetTenantId === null && account?.isSuperAdmin) {
    throw new InviteEmailInUseError();
  }
  if (account) {
    // A session verified under a password the account no longer holds is no proof: a change
    // landing between that check and this read would otherwise sign a revoked session back in.
    const signedInAsIt =
      params.session?.userId === account.id &&
      params.session.passwordHash === account.passwordHash;
    const knowsPassword =
      !signedInAsIt &&
      account.passwordHash !== null &&
      typeof params.password === "string" &&
      (await verifyPassword(params.password, account.passwordHash));
    if (!signedInAsIt && !knowsPassword) {
      throw new InviteAccountProofError();
    }
  } else if (!params.password || params.password.length < 8) {
    throw new InvitePasswordRequiredError();
  }
  const passwordHash =
    account || !params.password ? null : await hashPassword(params.password);
  // The hash the new session is signed under: the one this request proved or created.
  const sessionPasswordHash = account ? account.passwordHash : passwordHash;

  if (invite.tenantId === null) {
    const row = await acceptFleetInvite(base, invite, account, {
      email: invite.email,
      passwordHash,
      name: params.name?.trim() || null,
    });
    const session = sessionUserOf(row);
    if (!session) throw new InviteInvalidError();
    return { ...session, joinedTenantId: null, sessionPasswordHash };
  }
  const tenantId = invite.tenantId;

  const row = await base.$transaction(async (tx) => {
    // CAS consume: a concurrent/replayed accept sees count 0 and is rejected (single-use).
    const consumed = await tx.invitation.updateMany({
      where: { id: invite.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) throw new InviteInvalidError();
    const membership = {
      tenantId,
      role: invite.role,
      invitedById: invite.invitedById,
    };
    if (account) {
      await tx.tenantUser.create({
        data: { ...membership, userId: account.id },
      });
      return tx.user.update({
        where: { id: account.id },
        // Accept signs the person in; stamp lastLoginAt as a login would.
        data: { lastLoginAt: new Date() },
        select: AUTH_USER_SELECT,
      });
    }
    return tx.user.create({
      data: {
        email: invite.email,
        passwordHash,
        name: params.name?.trim() || null,
        memberships: { create: membership },
        // Accept auto-logs-in; stamp lastLoginAt so the Google-link block doesn't trip later.
        lastLoginAt: new Date(),
      },
      select: AUTH_USER_SELECT,
    });
  });
  const session = sessionUserOf(row);
  if (!session) throw new InviteInvalidError();
  // NOTE: `joinedTenantId` is where the invitation LEADS, apart from the session's own scope: a fleet
  // administrator's session has no tenant (null), and the console still has to open on the one they
  // just joined.
  if (session.role === "SUPER_ADMIN") {
    return { ...session, joinedTenantId: tenantId, sessionPasswordHash };
  }
  return {
    ...session,
    tenantId,
    role: invite.role,
    joinedTenantId: tenantId,
    sessionPasswordHash,
  };
}

// The fleet half of `acceptInvite`, already proven: consume the invitation and make the person a
// SUPER_ADMIN, the existing account (its memberships kept) or a new one with none. Under the fleet
// role, because the grant is recorded on the fleet's trail, which only that role writes.
async function acceptFleetInvite(
  base: PrismaClient,
  invite: { id: bigint; email: string },
  account: { id: bigint } | null,
  fresh: { email: string; passwordHash: string | null; name: string | null },
) {
  return asSuperAdminOn(base, async (db) => {
    // NOTE: the person before the invitation, the order every fleet-role write takes (`addSuperAdmin`
    // and the demotions lock the person, then drop this email's fleet invitations).
    if (account) {
      await db.$queryRaw`SELECT id FROM users WHERE id = ${account.id} FOR UPDATE`;
    }
    const consumed = await db.invitation.updateMany({
      where: { id: invite.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) throw new InviteInvalidError();
    const row = account
      ? await db.user.update({
          where: { id: account.id },
          data: { isSuperAdmin: true, lastLoginAt: new Date() },
          select: AUTH_USER_SELECT,
        })
      : await db.user.create({
          data: { ...fresh, isSuperAdmin: true, lastLoginAt: new Date() },
          select: AUTH_USER_SELECT,
        });
    const actor: TenantContext = {
      tenantId: null,
      userId: row.id,
      role: "SUPER_ADMIN",
      actorType: "user",
    };
    await auditMutationOn(db, actor, null, {
      action: "user.role_set",
      target: `user:${row.id}`,
      after: {
        userId: row.id.toString(),
        tenantId: null,
        email: row.email,
        name: row.name,
        role: "SUPER_ADMIN",
        invitationId: invite.id.toString(),
      },
    });
    return row;
  });
}
