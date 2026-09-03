import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient, UserRole } from "@/../generated/prisma/client";
import type { ManageableRole } from "@/api/features/admin/admin.service";
import { hashPassword } from "@/api/features/auth/auth.service";
import type { AuthUser } from "@/api/lib/auth";
import basePrisma from "@/api/lib/prisma";
import { asPrincipalOn, type TenantContext } from "@/lib/tenancy";
import { auditMutationOn } from "@/modules/audit/service";

// User-invitation flow (adapted from the sibling app's single-tenant invite system to our
// multi-tenant model). Security invariants:
//   - the token is HASHED at rest (sha256); the plaintext is returned ONCE (the inviter pastes a
//     copyable link — there is no mailer). A DB dump never yields a usable token.
//   - the `invitations` table is GLOBAL (no RLS): every read/write here MUST carry an explicit
//     tenant scope (tenantScope), exactly like admin.service does for `users`. A forgotten filter
//     leaks/edits cross-tenant invites with no DB backstop.
//   - role is bound to the invite ROW; SUPER_ADMIN is never invitable (ManageableRole + a DB CHECK).
//   - acceptInvite binds tenantId + role from the persisted invite, NEVER from the request, and is
//     single-use via a compare-and-set consume.
// `base` is injectable so integration tests pass their own (real) client instead of the singleton.

const INVITE_TTL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

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

async function emailExistsInTenant(
  base: Pick<PrismaClient, "user">,
  email: string,
  tenantId: bigint,
): Promise<boolean> {
  const existing = await base.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" }, tenantId },
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

// What an invitation's row carries. The EMAIL is the subject here and there is nothing else it could
// be: an invitation names a person who has no account yet, so an id would name nothing. The
// `tokenHash` never appears — it is the verifier for a live credential that grants membership of the
// tenant, and a trail its own admins read is the last place it belongs.
function inviteAuditProjection(row: {
  id: bigint;
  tenantId: bigint;
  email: string;
  role: string;
  expiresAt: Date;
}) {
  return {
    invitationId: row.id.toString(),
    tenantId: row.tenantId.toString(),
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
// plaintext token ONCE.
//
// `invitedById` comes off the CONTEXT and is no longer an argument, for the same reason the audit
// row's actor does: it is the one field saying who granted this membership, and a caller that could
// pass its own would attribute an invitation to somebody who never issued it.
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
    // Moved INSIDE the transaction: it is a read that decides whether the write happens, and outside
    // it decided against a snapshot the upsert could no longer be held to.
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

export interface InviteListItem {
  id: string;
  email: string;
  role: UserRole;
  tenantId: string;
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
    tenantId: r.tenantId.toString(),
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
  return { email: row.email, role: row.role };
}

export interface AcceptInviteParams {
  token: string;
  password: string;
  name?: string | null;
}

const AUTH_USER_SELECT = {
  id: true,
  tenantId: true,
  email: true,
  name: true,
  role: true,
  googleId: true,
} as const;

// Consumes an invite and creates the user. tenantId + role come from the ROW (never the request).
// Single-use via CAS consume in the same transaction as the user insert; the (tenant, lower(email))
// unique index is the DB backstop against a duplicate account.
export async function acceptInvite(
  params: AcceptInviteParams,
  base: PrismaClient = basePrisma,
): Promise<AuthUser> {
  const tokenHash = hashToken(params.token);
  const invite = await base.invitation.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      tenantId: true,
      email: true,
      role: true,
      consumedAt: true,
      expiresAt: true,
    },
  });
  if (!invite || inviteStatus(invite) !== "pending") {
    throw new InviteInvalidError();
  }
  if (await emailExistsInTenant(base, invite.email, invite.tenantId)) {
    throw new InviteEmailInUseError();
  }
  const passwordHash = await hashPassword(params.password);

  return base.$transaction(async (tx) => {
    // CAS consume: a concurrent/replayed accept sees count 0 and is rejected (single-use).
    const consumed = await tx.invitation.updateMany({
      where: { id: invite.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) throw new InviteInvalidError();
    return tx.user.create({
      data: {
        email: invite.email,
        passwordHash,
        name: params.name?.trim() || null,
        tenantId: invite.tenantId,
        role: invite.role,
        // Accept auto-logs-in; stamp lastLoginAt so the Google-link block doesn't trip later.
        lastLoginAt: new Date(),
      },
      select: AUTH_USER_SELECT,
    });
  });
}
