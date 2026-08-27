import type { UserRole } from "@/../generated/prisma/client";
import type { AuthUser } from "@/api/lib/auth";
import prisma from "@/api/lib/prisma";
import config from "@/config";
import { asSuperAdmin, runScoped } from "@/lib/tenancy";

function emailDomainMatches(email: string, domains: string[]): boolean {
  if (domains.length === 0) return false;
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return false;
  // NOTE: Defensive normalization in case the configured list is mutated
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

// NOTE: `emailVerified` gates elevation: password signups never count as verified, so
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

const AUTH_USER_SELECT = {
  id: true,
  tenantId: true,
  email: true,
  name: true,
  role: true,
  googleId: true,
} as const;

export async function getUserByEmail(email: string) {
  return prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: {
      ...AUTH_USER_SELECT,
      passwordHash: true,
      googleId: true,
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

export async function getUserByGoogleId(
  googleId: string,
): Promise<AuthUser | null> {
  return prisma.user.findUnique({
    where: { googleId },
    select: AUTH_USER_SELECT,
  });
}

// NOTE: public signup users are always AGENT and must belong to a tenant; the caller
// resolves which tenant (see resolveDefaultTenantId).
export async function createUser(
  email: string,
  passwordHash: string,
  tenantId: bigint,
): Promise<AuthUser> {
  return prisma.user.create({
    data: {
      email: email.trim().toLowerCase(),
      passwordHash,
      tenantId,
      role: getSignupRoleForEmail(email, false),
    },
    select: AUTH_USER_SELECT,
  });
}

export class SetupAlreadyCompleteError extends Error {
  constructor() {
    super("Initial setup has already been completed");
    this.name = "SetupAlreadyCompleteError";
  }
}

// NOTE: Arbitrary fixed key for the transaction-scoped advisory lock that
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

// NOTE: First-run bootstrap. Creates the SUPER_ADMIN (tenant_id NULL — fleet-level) and the initial
// Tenant (named after the operator's company, Chatwoot-style onboarding — no more hardcoded
// "Default"), inside one transaction under asSuperAdmin (the Tenant INSERT needs the fleet role so
// RLS WITH CHECK passes). The advisory lock + count re-check make it idempotent across replicas.
// Returns the SUPER_ADMIN user AND the new tenant id (so the client can auto-select it). Throws
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

    const user = await tx.user.create({
      data: {
        email: params.email.trim().toLowerCase(),
        passwordHash: params.passwordHash,
        name: params.name,
        role: "SUPER_ADMIN",
        tenantId: null,
        // NOTE: setup auto-logs-in the operator, who already proved control (setup token
        // + just-set password). Stamp lastLoginAt so this account is not caught by the
        // never-logged-in Google-link block in google.service.
        lastLoginAt: new Date(),
      },
      select: AUTH_USER_SELECT,
    });
    return { user, tenantId: tenant.id };
  });
}

// NOTE: tenant a public/Google self-signup user joins. Single-tenant deployments have
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
  return prisma.user.create({
    data: {
      email: params.email.trim().toLowerCase(),
      googleId: params.googleId,
      name: params.name,
      tenantId: params.tenantId,
      role: getSignupRoleForEmail(params.email, true),
    },
    select: AUTH_USER_SELECT,
  });
}

// NOTE: Conditional update on `googleId: null` closes a TOCTOU race where two
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
      return refetched;
    }
    return null;
  }
  return getUserByGoogleId(googleId);
}

// NOTE: a password change was attempted on an account that has no local password (e.g. a
// Google-only user). The UI shows a "you sign in with Google" note instead of the form.
export class NoPasswordSetError extends Error {
  constructor() {
    super("This account has no password set");
    this.name = "NoPasswordSetError";
  }
}

// NOTE: the supplied current password did not match. Surfaced as a 400 (not 401) so it does not
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

// Change a user's own password: verify the current one, then store the new hash. Throws
// NoPasswordSetError (Google-only account) or IncorrectPasswordError (wrong current password).
export async function changeUserPassword(
  userId: bigint,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!u?.passwordHash) throw new NoPasswordSetError();
  const ok = await verifyPassword(currentPassword, u.passwordHash);
  if (!ok) throw new IncorrectPasswordError();
  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
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
// called for a non-SUPER_ADMIN (who always has a tenantId); SUPER_ADMIN shows the selected tenant
// instead, resolved client-side from the tenant list.
export async function getTenantName(tenantId: bigint): Promise<string | null> {
  const tenant = await runScoped(
    { tenantId, userId: null, role: "TENANT_ADMIN" },
    (db) =>
      db.tenant.findFirst({ where: { id: tenantId }, select: { name: true } }),
  );
  return tenant?.name ?? null;
}
