import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  createGoogleUser,
  getUserByEmail,
  getUserByGoogleId,
  isAdminAnywhere,
  isEmailDomainAllowed,
  linkGoogleIdToUser,
  requireSessionUser,
  resolveDefaultTenantId,
} from "@/api/features/auth/auth.service";
import { isSetupRequired } from "@/api/features/auth/setup.service";
import type { AuthUser } from "@/api/lib/auth";
import config from "@/config";

const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
);

const GOOGLE_ISSUERS = [
  "accounts.google.com",
  "https://accounts.google.com",
] as const;

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

export class GoogleEmailNotVerifiedError extends Error {
  constructor() {
    super("Google account email is not verified");
    this.name = "GoogleEmailNotVerifiedError";
  }
}

export class GoogleEmailDomainNotAllowedError extends Error {
  constructor() {
    super("Google account email domain is not allowed to register");
    this.name = "GoogleEmailDomainNotAllowedError";
  }
}

export class GoogleIdMismatchError extends Error {
  constructor() {
    super("Email is already linked to a different Google account");
    this.name = "GoogleIdMismatchError";
  }
}

export class GoogleAdminLinkBlockedError extends Error {
  constructor() {
    super("ADMIN account must complete a password login before Google linking");
    this.name = "GoogleAdminLinkBlockedError";
  }
}

export class GoogleRegistrationDisabledError extends Error {
  constructor() {
    super("New account registration is disabled");
    this.name = "GoogleRegistrationDisabledError";
  }
}

export async function verifyGoogleIdToken(
  credential: string,
): Promise<GoogleProfile> {
  // NOTE: Defense-in-depth. The /google route is conditionally registered when
  // googleOAuthEnabled is true, but this guard removes any ambiguity if the
  // function is reached via tests, refactors, or mutated config.
  if (!config.googleClientId) {
    throw new Error("Google OAuth is not configured");
  }
  const { payload } = await jwtVerify(credential, JWKS, {
    issuer: [...GOOGLE_ISSUERS],
    audience: config.googleClientId,
  });

  const sub = payload.sub;
  const email = payload.email;
  if (typeof sub !== "string" || typeof email !== "string") {
    throw new Error("Google ID token missing required claims");
  }

  return {
    sub,
    email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" ? payload.name : null,
  };
}

export async function upsertGoogleUser(
  profile: GoogleProfile,
): Promise<AuthUser> {
  const byGoogleId = await getUserByGoogleId(profile.sub);
  if (byGoogleId) {
    return requireSessionUser(byGoogleId);
  }

  // NOTE: Reject unverified Google emails before any account creation or
  // linking path so an unverified address cannot inherit ADMIN_SIGNUP_DOMAINS
  // promotion or pass the allowlist check.
  if (!profile.emailVerified) {
    throw new GoogleEmailNotVerifiedError();
  }

  const byEmail = await getUserByEmail(profile.email);
  if (byEmail) {
    // NOTE: If the existing account is already linked to a *different* Google
    // identity, refuse to relink. Otherwise a recycled workspace address (or a
    // second Google identity sharing the same email) could take over the
    // account silently.
    if (byEmail.googleId && byEmail.googleId !== profile.sub) {
      throw new GoogleIdMismatchError();
    }
    // NOTE: An elevated row (TENANT_ADMIN/SUPER_ADMIN) that has never logged in is
    // almost always one an operator pre-created via `bun set-admin <email>`. Allowing
    // first-time Google linking on such a row would let anyone holding
    // email_verified=true for that address (e.g. a Workspace admin or insider) take over
    // the account. Require at least one password login to prove inbox control before
    // Google linking becomes available for elevated accounts.
    // An account is elevated if it is SUPER_ADMIN or administers ANY tenant (issue #756): the block
    // protects the account, and one account now carries every membership.
    if (isAdminAnywhere(byEmail) && byEmail.lastLoginAt === null) {
      throw new GoogleAdminLinkBlockedError();
    }
    const linked = await linkGoogleIdToUser(byEmail.id, profile.sub);
    if (!linked) {
      throw new GoogleIdMismatchError();
    }
    return linked;
  }

  // NOTE: This is the new-account path (no row by googleId or email). Closing
  // registration must block it too, otherwise disabling signup would leak a
  // Google-only registration channel. While setup is still pending the first
  // account must come through /setup so it is guaranteed ADMIN, so block here as
  // well. Login and account-linking for existing users above are unaffected.
  if (isSetupRequired() || !config.signupEnabled) {
    throw new GoogleRegistrationDisabledError();
  }

  if (!isEmailDomainAllowed(profile.email)) {
    throw new GoogleEmailDomainNotAllowedError();
  }

  // NOTE: a self-signup user must join a tenant; with none provisioned there is nothing
  // to join, so treat it like closed registration rather than create a tenant-less row.
  const tenantId = await resolveDefaultTenantId();
  if (tenantId === null) {
    throw new GoogleRegistrationDisabledError();
  }

  // NOTE: Two parallel first-time sign-ins for the same Google account can
  // both pass the read checks above and race on insert. Catch the unique
  // constraint conflict and re-resolve via googleId so the loser succeeds.
  try {
    return await createGoogleUser({
      googleId: profile.sub,
      email: profile.email,
      name: profile.name,
      tenantId,
    });
  } catch (error) {
    const existing = await getUserByGoogleId(profile.sub);
    if (existing) return requireSessionUser(existing);
    throw error;
  }
}
