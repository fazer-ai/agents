import { jwt } from "@elysiajs/jwt";
import { Elysia } from "elysia";
import type { UserRole } from "@/../generated/prisma/client";
import { translate } from "@/api/lib/i18n";
import logger from "@/api/lib/logger";
import prisma from "@/api/lib/prisma";
import config from "@/config";
import { ServiceUnavailableError } from "@/lib/errors";
import { roleAtLeast } from "@/lib/tenancy";
import { verifyApiKey } from "@/modules/api-keys/verify";

const COOKIE_NAME = "fazerai_auth_token";
// Compatibility window for the brand rename: sessions minted before it carry the old cookie name.
// We READ it, then rewrite the same JWT under the new name and drop the old one, so an upgrade logs
// nobody out and the legacy cookie is gone after one request. Dropped at 2.0.
const LEGACY_COOKIE_NAME = "secretaria_v4_auth_token";
const TOKEN_EXPIRY = "7d";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days, matching TOKEN_EXPIRY

export interface JWTPayload {
  userId: string;
  email: string;
  role: UserRole;
  // NOTE: string for JWT transport; null only for SUPER_ADMIN.
  tenantId: string | null;
}

export interface AuthUser {
  id: bigint;
  tenantId: bigint | null;
  email: string;
  name: string | null;
  role: UserRole;
  googleId: string | null;
  // Set when the principal resolved from a Bearer API key (vs the cookie session). Lets the
  // tenancy boundary tag audit rows as actorType "api_key".
  isApiKey?: boolean;
}

// Resolves a Bearer API key from the Authorization header to an AuthUser, or null. The synthetic
// identity carries the key's tenant + fixed role; `id` is the creator's user id (for audit), and
// isApiKey lets the tenancy boundary tag audit rows accordingly. Used only when no session cookie is
// present (the cookie path is unchanged).
async function apiKeyAuthUser(
  authHeader: string | undefined,
): Promise<AuthUser | null> {
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  const principal = await verifyApiKey(token);
  if (!principal) return null;
  return {
    id: principal.userId,
    tenantId: principal.tenantId,
    // No human behind a key; label it by id without leaking the secret (never the plaintext).
    email: `apikey:${principal.apiKeyId}`,
    name: null,
    role: principal.role,
    googleId: null,
    isApiKey: true,
  };
}

// Single source for the session cookie attributes, so the login path and the legacy-name rewrite
// below can never drift apart.
function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: config.env === "production",
    sameSite: "lax" as const,
    maxAge: COOKIE_MAX_AGE_S,
    path: "/",
  };
}

export const authPlugin = new Elysia({ name: "auth" })
  .use(
    jwt({
      name: "jwt",
      secret: config.jwtSecret,
      exp: TOKEN_EXPIRY,
    }),
  )
  .derive({ as: "global" }, ({ jwt, cookie, headers }) => ({
    async setAuthCookie(user: AuthUser) {
      const token = await jwt.sign({
        userId: user.id.toString(),
        email: user.email,
        role: user.role,
        tenantId: user.tenantId === null ? null : user.tenantId.toString(),
      });

      cookie[COOKIE_NAME]?.set({ value: token, ...sessionCookieOptions() });
      // A fresh login supersedes any pre-rename cookie; drop it so it can't outlive this session.
      cookie[LEGACY_COOKIE_NAME]?.remove();

      return token;
    },
    clearAuthCookie() {
      cookie[COOKIE_NAME]?.remove();
      cookie[LEGACY_COOKIE_NAME]?.remove();
    },
    async getAuthUser(): Promise<AuthUser | null> {
      let token = cookie[COOKIE_NAME]?.value;
      if (!token || typeof token !== "string") {
        const legacy = cookie[LEGACY_COOKIE_NAME]?.value;
        if (legacy && typeof legacy === "string") {
          // Migrate in place. The token is verified below either way, so copying it under the new
          // name grants a forged legacy cookie nothing it did not already have.
          token = legacy;
          cookie[COOKIE_NAME]?.set({
            value: legacy,
            ...sessionCookieOptions(),
          });
          cookie[LEGACY_COOKIE_NAME]?.remove();
        }
      }
      if (!token || typeof token !== "string") {
        // No session cookie — fall back to a Bearer API key (REST v1 / MCP external clients).
        return apiKeyAuthUser(headers.authorization);
      }

      let payload: JWTPayload | false;
      try {
        payload = (await jwt.verify(token)) as JWTPayload | false;
      } catch (error) {
        // NOTE: A malformed/forged/expired token is a genuine "not
        // authenticated" → null (the caller treats it as logged out). Only
        // token verification belongs in this catch, never the DB lookup below.
        logger.debug({ error }, "Failed to verify auth token");
        return null;
      }
      if (!payload) return null;

      let userId: bigint;
      try {
        userId = BigInt(payload.userId);
      } catch {
        // NOTE: A non-numeric subject is a forged/legacy token shape, not a
        // session.
        return null;
      }

      // NOTE: re-resolve role+tenant from the DB on every request (legacy/stale
      // tokens never grant elevated access; a moved/demoted user loses it at once).
      // A DB failure HERE is a TRANSIENT infrastructure problem (the pool
      // reconnecting during a dev hot-reload, a brief outage), NOT proof the
      // session is invalid. Throw 503 so the request is retryable instead of
      // returning a null user the client can't tell apart from a real logout
      // (which would bounce the operator to /login on every blip, and close any
      // WebSocket with the auth-lost code). The client retries /me at boot.
      let user: AuthUser | null;
      try {
        user = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            tenantId: true,
            email: true,
            name: true,
            role: true,
            googleId: true,
          },
        });
      } catch (error) {
        logger.warn(
          { error },
          "Auth user lookup failed; treating as transient",
        );
        throw new ServiceUnavailableError();
      }

      if (!user) return null;

      // NOTE: fail-closed. A non-SUPER_ADMIN must always carry a tenant; a row that
      // somehow lacks one (or a forged/legacy token shape) is treated as unauthenticated
      // rather than degraded to a tenant-less session.
      if (user.role !== "SUPER_ADMIN" && user.tenantId === null) {
        return null;
      }

      return user;
    },
  }))
  .macro({
    requireAuth(enabled: boolean) {
      if (!enabled) return;

      return {
        async beforeHandle({ getAuthUser, set }) {
          const user = await getAuthUser();
          if (!user) {
            set.status = 401;
            return { error: translate("errors.unauthorized", "Unauthorized") };
          }
        },
      };
    },
    // NOTE: hierarchical gate — SUPER_ADMIN > TENANT_ADMIN > AGENT. `requireRole:
    // "TENANT_ADMIN"` admits TENANT_ADMIN and SUPER_ADMIN.
    requireRole(min: UserRole | undefined) {
      if (!min) return;

      return {
        async beforeHandle({ getAuthUser, set }) {
          const user = await getAuthUser();
          if (!user) {
            set.status = 401;
            return { error: translate("errors.unauthorized", "Unauthorized") };
          }
          if (!roleAtLeast(user.role, min)) {
            set.status = 403;
            return { error: translate("errors.forbidden", "Forbidden") };
          }
        },
      };
    },
    // NOTE: kept for compatibility — "admin" now means TENANT_ADMIN or above.
    requireAdmin(enabled: boolean) {
      if (!enabled) return;

      return {
        async beforeHandle({ getAuthUser, set }) {
          const user = await getAuthUser();
          if (!user) {
            set.status = 401;
            return { error: translate("errors.unauthorized", "Unauthorized") };
          }
          if (!roleAtLeast(user.role, "TENANT_ADMIN")) {
            set.status = 403;
            return { error: translate("errors.forbidden", "Forbidden") };
          }
        },
      };
    },
  });
