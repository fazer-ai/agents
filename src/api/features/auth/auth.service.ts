import type { UserRole } from "@/../generated/prisma/client";
import type { AuthUser } from "@/api/lib/auth";
import prisma from "@/api/lib/prisma";
import config from "@/config";
import { emailEquals } from "@/lib/email-match";
import { asSuperAdmin, runScoped } from "@/lib/tenancy";
import { type Membership, resolveMembership } from "@/lib/tenancy/membership";

function emailDomainMatches(email: string, domains: string[]): boolean {
  if (domains.length === 0) return false;
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return false;
  // Defensive normalization in case the configured list is mutated
  // outside of parseDomainList (e.g. tests).
  const normalized = new Set(
    domains
      .map((d) => d.trim().toLowerCase().replace(/^@+/, ""))
      .filter(Boolean),
  );
  return normalized.has(domain);
}

export function isEmailDomainAllowed(email: string): boolean {
  if (config.allowedSignupDomains.length === 0) return true;
  return emailDomainMatches(email, config.allowedSignupDomains);
}

// `emailVerified` gates elevation: password signups never count as verified, so
// anyone holding an admin-domain address still needs a verified channel (e.g. Google)
// before being elevated to TENANT_ADMIN. SUPER_ADMIN is never granted via signup — only
// through the first-run /setup flow.
export function getSignupRoleForEmail(
  email: string,
  emailVerified: boolean,
): UserRole {
  if (!emailVerified) return "AGENT";
  return emailDomainMatches(email, config.adminSignupDomains)
    ? "TENANT_ADMIN"
    : "AGENT";
}

// A person and the tenants they belong to: one user per email, a membership per tenant.
const AUTH_USER_SELECT = {
  id: true,
  email: true,
  name: true,
  googleId: true,
  isSuperAdmin: true,
  memberships: {
    select: { tenantId: true, role: true, createdAt: true },
  },
} as const;

type PersonRow = {
  id: bigint;
  email: string;
  name: string | null;
  googleId: string | null;
  isSuperAdmin: boolean;
  memberships: Membership[];
};

// The session shape of a person as a login answers it, before the console has chosen a tenant: the
// SUPER_ADMIN is tenant-less, anyone else runs under their default membership (the oldest, per
// src/lib/tenancy/membership.ts). Null for a person with no membership, who has no tenant to enter;
// `getAuthUser` refuses the same person on every request, so a login that let them through would
// only set a cookie that authenticates nothing.
export function sessionUserOf(row: PersonRow): AuthUser | null {
  const { isSuperAdmin, memberships, ...person } = row;
  if (isSuperAdmin) {
    return { ...person, tenantId: null, role: "SUPER_ADMIN", memberships };
  }
  const current = resolveMembership(memberships, undefined);
  if (current === null || "rejected" in current) return null;
  return { ...person, ...current, memberships };
}

// A person who authenticated but belongs to no tenant (and is not a SUPER_ADMIN). The login answers it
// like bad credentials: there is nothing to enter, and a distinct answer would only tell a guesser
// that the password was right.
export class NoMembershipError extends Error {
  constructor() {
    super("The account belongs to no tenant");
    this.name = "NoMembershipError";
  }
}

export function requireSessionUser(row: PersonRow): AuthUser {
  const user = sessionUserOf(row);
  if (!user) throw new NoMembershipError();
  return user;
}

// Whether the person holds an administrative role anywhere: SUPER_ADMIN, or TENANT_ADMIN in at least
// one tenant. Read where an account's power, not one membership's, is what matters (the Google-link
// block in google.service.ts).
export function isAdminAnywhere(row: {
  isSuperAdmin: boolean;
  memberships: readonly { role: UserRole }[];
}): boolean {
  return row.isSuperAdmin || row.memberships.some((m) => m.role !== "AGENT");
}

export async function getUserByEmail(email: string) {
  // NOTE: `findFirst` over a case-insensitive match is still exact: the email is unique across the
  // install, case folded (`users_email_key` on lower(email)), and `emailEquals` keeps `_`/`%` literal.
  return prisma.user.findFirst({
    where: { email: emailEquals(email) },
    select: {
      ...AUTH_USER_SELECT,
      passwordHash: true,
      lastLoginAt: true,
    },
  });
}

// Load a user by id with its password hash, for step-up re-authentication (e.g. confirming a
// destructive action with the current password). Null when the user is gone or has no password set.
export async function getUserById(id: bigint) {
  return prisma.user.findUnique({
    where: { id },
    select: { id: true, passwordHash: true },
  });
}

export async function getUserByGoogleId(googleId: string) {
  return prisma.user.findUnique({
    where: { googleId },
    select: { ...AUTH_USER_SELECT, lastLoginAt: true },
  });
}

// Public signup users are always AGENT and must belong to a tenant; the caller
// resolves which tenant (see resolveDefaultTenantId). The person and their membership are created
// together, so a signup never leaves a user with nowhere to enter.
export async function createUser(
  email: string,
  passwordHash: string,
  tenantId: bigint,
): Promise<AuthUser> {
  const row = await prisma.user.create({
    data: {
      email: email.trim().toLowerCase(),
      passwordHash,
      memberships: {
        create: { tenantId, role: getSignupRoleForEmail(email, false) },
      },
    },
    select: AUTH_USER_SELECT,
  });
  return sessionUserOf(row) as AuthUser;
}

export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super("Initial setup has already been completed");
    this.name = "SetupAlreadyCompleteError";
  }
}

// Arbitrary fixed key for the transaction-scoped advisory lock that
// serializes first-run setup. Any concurrent POST /auth/setup waits on the lock,
// then sees a non-empty users table and aborts, so exactly one SUPER_ADMIN is created
// even with the setup token disabled. xact-scoped lock auto-releases on
// commit/rollback, which is safe with the connection pool.
const SETUP_ADVISORY_LOCK_KEY = 727274;

// Company name → a URL-safe slug (diacritics stripped, lowercased, non-alnum → "-"). Empty/degenerate
// input falls back to "default" so the initial tenant always gets a valid, unique-enough slug.
export function slugifyCompany(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return slug || "default";
}

// First-run bootstrap: the SUPER_ADMIN (fleet-level, no membership) and the initial tenant, named
// after the operator's company, in one transaction under asSuperAdmin (the tenant INSERT needs the
// fleet role to pass RLS WITH CHECK). The advisory lock plus count re-check make it idempotent across
// replicas. Returns the user and the new tenant id so the client can auto-select it; throws
// SetupAlreadyCompleteError if a user exists.
export async function createInitialAdmin(params: {
  email: string;
  passwordHash: string;
  name: string | null;
  companyName?: string | null;
}): Promise<{ user: AuthUser; tenantId: bigint }> {
  return asSuperAdmin(async (tx) => {
    // $executeRaw (not $queryRaw): pg_advisory_xact_lock returns void.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SETUP_ADVISORY_LOCK_KEY}::bigint)`;
    if ((await tx.user.count()) > 0) {
      throw new SetupAlreadyCompleteError();
    }

    const company = params.companyName?.trim();
    const tenant = await tx.tenant.create({
      data: {
        name: company || "Default",
        slug: company ? slugifyCompany(company) : "default",
      },
      select: { id: true },
    });

    const row = await tx.user.create({
      data: {
        email: params.email.trim().toLowerCase(),
        passwordHash: params.passwordHash,
        name: params.name,
        isSuperAdmin: true,
        // NOTE: setup auto-logs-in the operator, who already proved control (setup token
        // + just-set password). Stamp lastLoginAt so this account is not caught by the
        // never-logged-in Google-link block in google.service.
        lastLoginAt: new Date(),
      },
      select: AUTH_USER_SELECT,
    });
    return { user: sessionUserOf(row) as AuthUser, tenantId: tenant.id };
  });
}

// Tenant a public/Google self-signup user joins. Single-tenant deployments have
// exactly one; multi-tenant onboarding via tenant-scoped invites is a later phase.
export async function resolveDefaultTenantId(): Promise<bigint | null> {
  return asSuperAdmin(async (tx) => {
    const tenant = await tx.tenant.findFirst({
      orderBy: { id: "asc" },
      select: { id: true },
    });
    return tenant?.id ?? null;
  });
}

export async function createGoogleUser(params: {
  googleId: string;
  email: string;
  name: string | null;
  tenantId: bigint;
}): Promise<AuthUser> {
  const row = await prisma.user.create({
    data: {
      email: params.email.trim().toLowerCase(),
      googleId: params.googleId,
      name: params.name,
      memberships: {
        create: {
          tenantId: params.tenantId,
          role: getSignupRoleForEmail(params.email, true),
        },
      },
    },
    select: AUTH_USER_SELECT,
  });
  return sessionUserOf(row) as AuthUser;
}

// Conditional update on `googleId: null` closes a TOCTOU race where two
// parallel sign-ins for the same email but different Google identities both
// observe googleId as null and the second write would silently overwrite the
// first. The loser refetches and either fast-paths an idempotent retry of the
// same googleId, or surfaces a mismatch.
export async function linkGoogleIdToUser(
  userId: bigint,
  googleId: string,
): Promise<AuthUser | null> {
  const result = await prisma.user.updateMany({
    where: { id: userId, googleId: null },
    data: { googleId },
  });
  if (result.count === 0) {
    const refetched = await prisma.user.findUnique({
      where: { id: userId },
      select: AUTH_USER_SELECT,
    });
    if (refetched?.googleId === googleId) {
      return sessionUserOf(refetched);
    }
    return null;
  }
  const linked = await getUserByGoogleId(googleId);
  return linked ? sessionUserOf(linked) : null;
}

// A password change was attempted on an account that has no local password (e.g. a
// Google-only user). The UI shows a "you sign in with Google" note instead of the form.
export class NoPasswordSetError extends Error {
  constructor() {
    super("This account has no password set");
    this.name = "NoPasswordSetError";
  }
}

// The supplied current password did not match. Surfaced as a 400 (not 401) so it does not
// trip the client's unauthorized-session handling — the session is valid, only the field is wrong.
export class IncorrectPasswordError extends Error {
  constructor() {
    super("Current password is incorrect");
    this.name = "IncorrectPasswordError";
  }
}

// Whether the user can change their password (i.e. has a local password at all). Google-only
// accounts return false so the settings page shows a note instead of an unusable form.
export async function getUserHasPassword(userId: bigint): Promise<boolean> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  return Boolean(u?.passwordHash);
}

// The account facts the Settings pages show: when it was created and which sign-in methods it has.
export async function getAccountDetails(userId: bigint) {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { createdAt: true, passwordHash: true, googleId: true },
  });
  if (!row) return null;
  return {
    createdAt: row.createdAt,
    hasPassword: Boolean(row.passwordHash),
    googleLinked: row.googleId !== null,
  };
}

// The display name is the one profile field a person edits about themselves; null clears it, and
// the UI shows the email instead. The role is not on the person row (it lives in the memberships),
// so the caller answers with the one it already resolved.
export async function updateUserName(userId: bigint, name: string | null) {
  return prisma.user.update({
    where: { id: userId },
    data: { name },
    select: { id: true, email: true, name: true },
  });
}

// Another write changed the password between the verification and the update, so this change did not
// land and must not be reported as done.
export class PasswordChangedConcurrentlyError extends Error {
  constructor() {
    super("The password was changed by another request");
    this.name = "PasswordChangedConcurrentlyError";
  }
}

// Change a user's own password: verify the current one, then store the new hash, and return it so the
// caller can re-sign its own session. The new hash revokes every session signed under the old one
// (`passwordFingerprint` in lib/auth). Throws NoPasswordSetError (Google-only account),
// IncorrectPasswordError (wrong current password) or PasswordChangedConcurrentlyError.
export async function changeUserPassword(
  userId: bigint,
  currentPassword: string,
  newPassword: string,
): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!u?.passwordHash) throw new NoPasswordSetError();
  const ok = await verifyPassword(currentPassword, u.passwordHash);
  if (!ok) throw new IncorrectPasswordError();
  const passwordHash = await hashPassword(newPassword);
  // Compare-and-swap on the verified hash, so two changes racing on the same current password cannot
  // both succeed.
  const { count } = await prisma.user.updateMany({
    where: { id: userId, passwordHash: u.passwordHash },
    data: { passwordHash },
  });
  if (count !== 1) throw new PasswordChangedConcurrentlyError();
  return passwordHash;
}

// The hash a session is signed under when its proof was not a password (Google), read from the row.
export async function getPasswordHash(userId: bigint): Promise<string | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  return row?.passwordHash ?? null;
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "bcrypt", cost: 10 });
}

export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

export async function updateLastLogin(userId: bigint) {
  return prisma.user.update({
    where: { id: userId },
    data: { lastLoginAt: new Date() },
  });
}

// The tenant's display name for the authenticated user (header chip / context). Scoped read:
// `tenants` is under RLS, so the GUC must be set (runScoped) — a bare read returns no row. Only
// called for a non-SUPER_ADMIN (whose session always runs under a membership); SUPER_ADMIN shows the
// selected tenant instead, resolved client-side from the tenant list.
export async function getTenantName(tenantId: bigint): Promise<string | null> {
  const tenant = await runScoped(
    { tenantId, userId: null, role: "TENANT_ADMIN" },
    (db) =>
      db.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
  );
  return tenant?.name ?? null;
}

// The tenants behind a person's memberships, named, oldest first (the order `resolveMembership`
// defaults by), for the console's selector. One scoped read per membership: `tenants` is under RLS
// and a person belongs to a handful at most. A membership whose tenant cannot be read is left out
// rather than shown nameless.
export async function listMembershipTenants(
  memberships: readonly Membership[],
): Promise<{ tenantId: bigint; name: string; role: UserRole }[]> {
  const ordered = [...memberships].sort(
    (a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime() ||
      (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0),
  );
  const out: { tenantId: bigint; name: string; role: UserRole }[] = [];
  for (const m of ordered) {
    const name = await getTenantName(m.tenantId);
    if (name !== null) out.push({ tenantId: m.tenantId, name, role: m.role });
  }
  return out;
}
