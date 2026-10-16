import { createHmac, randomUUID } from "node:crypto";
import { jwt } from "@elysiajs/jwt";
import { Elysia } from "elysia";
import type { Prisma, UserRole } from "@/../generated/prisma/client";
import { closeSessionSockets } from "@/api/features/realtime/realtime.service";
import { translate } from "@/api/lib/i18n";
import logger from "@/api/lib/logger";
import mainPrisma from "@/api/lib/prisma";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { WS_CLOSE } from "@/api/lib/realtime";
import config from "@/config";
import { parseDbId } from "@/lib/db-id";
import {
  ServiceUnavailableError,
  TenantSelectorRefusedError,
  UnauthorizedError,
} from "@/lib/errors";
import { isForeignKeyViolation } from "@/lib/pg-error";
import { roleAtLeast, runWithinBudgetOn, type TxBudget } from "@/lib/tenancy";
import { type Membership, resolveMembership } from "@/lib/tenancy/membership";
import {
  metricsBudget,
  metricsDeadline,
  metricsTooSlow,
} from "@/modules/analytics/budget";
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
  // NOTE: `passwordFingerprint` of the hash the session was issued under; absent without a password.
  pwd?: string;
  // NOTE: names the session so a logout can end it (`ended_sessions`); absent on older tokens.
  jti?: string;
  exp?: number;
}

// The ended-session lookup that rides on the session read's user query: one row when this token's
// session logged out. A token without a `jti` names no session and selects nothing.
function endedSessionSelect(payload: JWTPayload) {
  return payload.jti
    ? {
        endedSessions: {
          where: { jti: payload.jti },
          select: { jti: true },
          take: 1,
        },
      }
    : {};
}

function sessionEnded(row: { endedSessions?: { jti: string }[] }): boolean {
  return (row.endedSessions?.length ?? 0) > 0;
}

// Whether a LOGOUT ended this session, as opposed to a re-issued cookie replacing it. Lets a socket
// refused on its re-check sign out (4401) or reconnect under the new cookie (4409).
export async function isSessionLoggedOut(sessionId: string): Promise<boolean> {
  return (
    (await mainPrisma.endedSession.count({
      where: { jti: sessionId, replaced: false },
    })) > 0
  );
}

// A verified token that names its session.
interface NamedSession {
  userId: bigint;
  sessionId: string;
  expiresAt: Date;
}

function namedSession(payload: JWTPayload | false): NamedSession | null {
  if (payload === false) return null;
  if (!payload.jti || typeof payload.exp !== "number") return null;
  const userId =
    typeof payload.userId === "string" ? parseDbId(payload.userId) : null;
  if (userId === null) return null;
  return {
    userId,
    sessionId: payload.jti,
    expiresAt: new Date(payload.exp * 1000),
  };
}

// Records the session as ended until its token expires, dropping the rows past their expiry. True
// when this call inserted the row, false when one was already there. A deleted account (foreign key) has no
// session left to end, and counts as this call ending it. Throws 503 on any other failure.
async function recordEnded(
  session: NamedSession,
  how: { replaced: boolean },
): Promise<boolean> {
  try {
    const [, inserted] = await mainPrisma.$transaction([
      mainPrisma.endedSession.deleteMany({
        where: { expiresAt: { lte: new Date() } },
      }),
      mainPrisma.endedSession.createMany({
        data: [
          {
            jti: session.sessionId,
            userId: session.userId,
            expiresAt: session.expiresAt,
            replaced: how.replaced,
          },
        ],
        skipDuplicates: true,
      }),
      // A logout wins over a replacement recorded first (an invitation re-issue racing it), so the
      // session reads as logged out; a replacement never overwrites a logout.
      ...(how.replaced
        ? []
        : [
            mainPrisma.endedSession.updateMany({
              where: { jti: session.sessionId, replaced: true },
              data: { replaced: false },
            }),
          ]),
    ]);
    return inserted.count > 0;
  } catch (error) {
    if (isForeignKeyViolation(error)) return true;
    logger.warn({ error }, "Ending the session failed; treating as transient");
    throw new ServiceUnavailableError();
  }
}

// Binds a session to the password it was issued under, as Django's session auth hash does: the token
// carries an HMAC of the stored hash, so any write that changes the hash (Settings, `bun set-admin`)
// revokes every session signed before it, with no column to remember to stamp. Keyed with the JWT
// secret because the payload is readable and the raw hash must not leave the server.
export function passwordFingerprint(
  passwordHash: string | null,
): string | undefined {
  if (!passwordHash) return undefined;
  return createHmac("sha256", config.jwtSecret)
    .update(passwordHash)
    .digest("base64url")
    .slice(0, 22);
}

// A token signed under another password is a revoked session: a password is usually changed because
// a session leaked.
function sessionMatchesPassword(
  payload: JWTPayload,
  passwordHash: string | null,
): boolean {
  return payload.pwd === passwordFingerprint(passwordHash);
}

// A session read only as proof of identity: whose it is, and the password hash it was checked
// against, which is the hash a session re-issued from this proof must be signed under.
export interface SessionIdentity {
  userId: bigint;
  passwordHash: string | null;
  // The session's `jti`, for a re-issue that takes this session as its only proof.
  sessionId?: string;
}

export interface AuthUser {
  id: bigint;
  // The tenant THIS request runs under and the role the person holds there: chosen among their
  // memberships by `X-Tenant-Id` (src/lib/tenancy/membership.ts). SUPER_ADMIN: null tenant, and the
  // selector is honored downstream by the tenancy boundary.
  tenantId: bigint | null;
  email: string;
  name: string | null;
  role: UserRole;
  googleId: string | null;
  // Every tenant the person belongs to, for the session payload's selector. Absent on an API key,
  // which is bound to one tenant and has no person behind it.
  memberships?: Membership[];
  // Set when the principal resolved from a Bearer API key (vs the cookie session). Lets the
  // tenancy boundary tag audit rows as actorType "api_key".
  isApiKey?: boolean;
  // For a key: when its minter answered the password step-up, or null for a key that predates the
  // rule. Absent for a session, which answers the step-up per request. Read by `confirmStepUp`.
  stepUpAt?: Date | null;
  // The `jti` of the cookie session, so a logout can close the sockets it opened. Absent on an API
  // key and on a token issued before sessions carried one.
  sessionId?: string;
}

// The session a logout ended: whose it was, and its `jti`.
export interface EndedSessionRef {
  userId: bigint;
  sessionId: string;
}

// Resolves a Bearer API key from the Authorization header to an AuthUser, or null. The synthetic
// identity carries the key's tenant + role (a fleet key: no tenant, SUPER_ADMIN — the same shape a
// SUPER_ADMIN user has, so the tenancy boundary honours X-Tenant-Id for it the same way); `id` is
// the creator's user id (for audit), and isApiKey lets the tenancy boundary tag audit rows
// accordingly. Used only when no session cookie is present (the cookie path is unchanged).
async function apiKeyAuthUser(
  authHeader: string | undefined,
  pool: AuthPool,
): Promise<AuthUser | null> {
  if (typeof authHeader !== "string" || !authHeader.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  let principal: Awaited<ReturnType<typeof verifyApiKey>>;
  try {
    principal = await verifyApiKey(token, pool.db, pool.budget);
  } catch (error) {
    // NOTE: transient, as in the session lookups below: a full pool says nothing about the key.
    logger.warn({ error }, "API key lookup failed; treating as transient");
    throw pool.unavailable();
  }
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
    stepUpAt: principal.stepUpAt,
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

// The pool a request authenticates through, with that pool's transaction budget. The metrics routes
// read through a pool of their own (./prisma-metrics.ts) so the screen still answers while turns hold
// every connection of the main one, and that only holds if the session or key lookup in front of them
// does not need the main pool either; on it, the lookup keeps to the metrics budget.
// The lookup spends the request's one metrics budget, and a lookup that failed once that budget was
// spent (no metrics connection in time) is refused the way the read would have been.
export interface AuthPool {
  db: typeof mainPrisma;
  budget?: TxBudget;
  // Runs a session lookup through this pool, under its budget when it has one.
  lookup: <T>(fn: (db: Prisma.TransactionClient) => Promise<T>) => Promise<T>;
  // The refusal for a lookup that failed: transient, never a signed-out session.
  unavailable: () => Error;
}

// The instance health routes too: an instance alert links to them, and they must answer during the
// saturation the alert is about (docs/logs.md, instance alerts).
const OFF_MAIN_POOL = ["/api/v1/metrics", "/api/v1/instance-health"];

export function authPoolFor(path: string): AuthPool {
  if (!OFF_MAIN_POOL.some((p) => path === p || path.startsWith(`${p}/`))) {
    return {
      db: mainPrisma,
      lookup: (fn) => fn(mainPrisma),
      unavailable: () => new ServiceUnavailableError(),
    };
  }
  const deadline = metricsDeadline();
  const budget = metricsBudget(deadline);
  return {
    db: metricsPrisma,
    budget,
    lookup: (fn) => runWithinBudgetOn(metricsPrisma, budget, fn),
    unavailable: () =>
      Date.now() >= deadline
        ? metricsTooSlow(deadline)
        : new ServiceUnavailableError(),
  };
}

const SESSION_USER = {
  id: true,
  email: true,
  name: true,
  googleId: true,
  isSuperAdmin: true,
  passwordHash: true,
} as const;
const MEMBERSHIP = { tenantId: true, role: true, createdAt: true } as const;

// A nested relation is a SQL statement of its own under one Prisma call, and a deadline is set per
// call (src/lib/tenancy/deadline.ts), so under one each relation of a session read is a call of its
// own, bounded by what is left. Without a deadline the read is one call, as the main pool's always was.
async function endedSessionsOf(
  db: Prisma.TransactionClient,
  userId: bigint,
  payload: JWTPayload,
): Promise<{ endedSessions?: { jti: string }[] }> {
  if (!payload.jti) return {};
  return {
    endedSessions: await db.endedSession.findMany({
      where: { userId, jti: payload.jti },
      select: { jti: true },
      take: 1,
    }),
  };
}

// The password fingerprint and the ended-session mark a session's identity check reads.
export async function findSessionPassword(
  db: Prisma.TransactionClient,
  userId: bigint,
  payload: JWTPayload,
  underDeadline: boolean,
): Promise<{
  passwordHash: string | null;
  endedSessions?: { jti: string }[];
} | null> {
  if (!underDeadline) {
    return db.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, ...endedSessionSelect(payload) },
    });
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!user) return null;
  return { ...user, ...(await endedSessionsOf(db, userId, payload)) };
}

// The person behind a session, with their memberships and the ended-session mark.
export async function findSessionUser(
  db: Prisma.TransactionClient,
  userId: bigint,
  payload: JWTPayload,
  underDeadline: boolean,
): Promise<{
  id: bigint;
  email: string;
  name: string | null;
  googleId: string | null;
  isSuperAdmin: boolean;
  passwordHash: string | null;
  memberships: Membership[];
  endedSessions?: { jti: string }[];
} | null> {
  if (!underDeadline) {
    return db.user.findUnique({
      where: { id: userId },
      select: {
        ...SESSION_USER,
        memberships: { select: MEMBERSHIP },
        ...endedSessionSelect(payload),
      },
    });
  }
  const user = await db.user.findUnique({
    where: { id: userId },
    select: SESSION_USER,
  });
  if (!user) return null;
  const memberships = await db.tenantUser.findMany({
    where: { userId },
    select: MEMBERSHIP,
  });
  return {
    ...user,
    memberships,
    ...(await endedSessionsOf(db, userId, payload)),
  };
}

// The requests that reached a session gate, marked before their query and body are validated.
// Elysia validates them before `beforeHandle`, where the gates answer, so a malformed input with no
// session would be refused as a schema error and tell the caller what the route accepts before
// telling them to sign in. The app's error handler reads this to answer that request as the gate
// would (`src/app.ts`). Keyed by the request, so it lives exactly as long as the request does.
const gatedSessions = new WeakMap<Request, () => Promise<AuthUser | null>>();

const sessionReads = new WeakMap<Request, Promise<AuthUser | null>>();

function markSessionGated({
  request,
  requestAuthUser,
}: {
  request: Request;
  requestAuthUser: () => Promise<AuthUser | null>;
}): void {
  gatedSessions.set(request, requestAuthUser);
}

// Whether this request reached a session gate without a session. False for a route with no gate.
export async function refusedForSession(request: Request): Promise<boolean> {
  const readSession = gatedSessions.get(request);
  if (!readSession) return false;
  try {
    return (await readSession()) === null;
  } catch {
    return false;
  }
}

export const authPlugin = new Elysia({ name: "auth" })
  .use(
    jwt({
      name: "jwt",
      secret: config.jwtSecret,
      exp: TOKEN_EXPIRY,
    }),
  )
  .derive({ as: "global" }, ({ jwt, cookie, headers, path }) => {
    // The token the browser presents, under the current name or else the pre-rename one, picked the
    // way `getAuthUser` picks it: an empty current cookie falls through to the legacy one.
    function presentedToken(): string | null {
      const current = cookie[COOKIE_NAME]?.value;
      if (current && typeof current === "string") return current;
      const legacy = cookie[LEGACY_COOKIE_NAME]?.value;
      return legacy && typeof legacy === "string" ? legacy : null;
    }

    // The session the browser's cookie names, verified, or null.
    async function currentSession(): Promise<NamedSession | null> {
      const token = presentedToken();
      if (!token) return null;
      try {
        return namedSession((await jwt.verify(token)) as JWTPayload | false);
      } catch {
        return null;
      }
    }

    return {
      // NOTE: `passwordHash` is the hash the caller authenticated against, not what the row holds by
      // the time the cookie is signed: a login that verified the OLD password while a change landed
      // must come out already revoked, not valid under the new one. Required so no call site omits it.
      // NOTE: a re-issued cookie is a NEW session (a new `jti`), and the one it replaces in this
      // browser ends, its sockets closed with 4409 so they reconnect under the new cookie: one logout
      // then ends everything the browser holds. With `proofSessionId` the replaced session was the
      // request's only proof of identity, so a logout that ended it first refuses the re-issue (401)
      // instead of minting a session nothing proved.
      async setAuthCookie(
        user: AuthUser,
        passwordHash: string | null,
        options: { proofSessionId?: string } = {},
      ) {
        const replaced = await currentSession();
        if (options.proofSessionId !== undefined) {
          if (replaced?.sessionId !== options.proofSessionId) {
            throw new UnauthorizedError();
          }
          // Refused only when a logout DID end it. A failure to record is not a refusal: the
          // caller (accepting an invitation) has already committed, and a 503 would leave a used
          // invitation and no session; the replaced token then lives until it expires.
          const ended = await recordEnded(replaced, { replaced: true }).catch(
            () => true,
          );
          // A row already there may be another re-issue of this same cookie (two invitations
          // accepted at once), which is no reason to refuse; only a logout's row is.
          const loggedOut =
            !ended &&
            (await isSessionLoggedOut(replaced.sessionId).catch(() => false));
          if (loggedOut) throw new UnauthorizedError();
        } else if (replaced) {
          // NOTE: best effort: failing to end the replaced session never refuses a sign-in that
          // proved itself; that token keeps working until it expires, as before sessions had ids.
          await recordEnded(replaced, { replaced: true }).catch(() => false);
        }
        if (replaced) {
          closeSessionSockets(
            replaced.userId,
            replaced.sessionId,
            WS_CLOSE.CREDENTIALS_CHANGED,
          );
        }
        const pwd = passwordFingerprint(passwordHash);
        const token = await jwt.sign({
          userId: user.id.toString(),
          email: user.email,
          role: user.role,
          tenantId: user.tenantId === null ? null : user.tenantId.toString(),
          ...(pwd ? { pwd } : {}),
          jti: randomUUID(),
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
      // NOTE: ends the session the cookie names, so a copy of it is refused from here on. A cookie that
      // does not verify, or a token with no `jti`, ends nothing. Expired rows are dropped on the way:
      // past its expiry the token is refused by its signature alone.
      async endSession(): Promise<EndedSessionRef | null> {
        const session = await currentSession();
        if (!session) return null;
        await recordEnded(session, { replaced: false });
        return { userId: session.userId, sessionId: session.sessionId };
      },
      // NOTE: WHICH PERSON the session cookie names, and the password hash it was verified against,
      // and nothing else: no tenant selector, no membership, no API key. For the one operation where
      // the session is only proof of identity (accepting an invitation into the account it names), a
      // stale selector must not turn that proof into "signed out".
      async getSessionIdentity(): Promise<SessionIdentity | null> {
        const token = presentedToken();
        if (!token) return null;
        let payload: JWTPayload | false;
        try {
          payload = (await jwt.verify(token)) as JWTPayload | false;
        } catch {
          return null;
        }
        if (!payload || typeof payload.userId !== "string") return null;
        const userId = parseDbId(payload.userId);
        if (userId === null) return null;
        // A revoked session proves nothing, so the password fingerprint is checked here too. A DB
        // failure is transient, as in getAuthUser below, and never reads as signed out.
        let row: {
          passwordHash: string | null;
          endedSessions?: { jti: string }[];
        } | null;
        const pool = authPoolFor(path);
        try {
          row = await pool.lookup((db) =>
            findSessionPassword(
              db,
              userId,
              payload,
              pool.budget?.deadline !== undefined,
            ),
          );
        } catch (error) {
          logger.warn(
            { error },
            "Session user lookup failed; treating as transient",
          );
          throw pool.unavailable();
        }
        if (
          !row ||
          !sessionMatchesPassword(payload, row.passwordHash) ||
          sessionEnded(row)
        ) {
          return null;
        }
        return {
          userId,
          passwordHash: row.passwordHash,
          ...(payload.jti ? { sessionId: payload.jti } : {}),
        };
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
          return apiKeyAuthUser(headers.authorization, authPoolFor(path));
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
          // biome-ignore lint/plugin/no-bigint-cast: the subject of a JWT this server signed; a token that fails to convert is answered as no session at all.
          userId = BigInt(payload.userId);
        } catch {
          // NOTE: A non-numeric subject is a forged/legacy token shape, not a
          // session.
          return null;
        }

        // Re-resolve role+tenant from the DB on every request (stale tokens never grant elevated
        // access; a moved/demoted user loses it at once). A DB failure HERE is TRANSIENT (pool
        // reconnecting, a brief outage), NOT proof the session is invalid: throw 503 so the request is
        // retryable, never a null user the client reads as a logout (bouncing the operator to /login on
        // every blip and closing any WebSocket with the auth-lost code). The client retries /me at boot.
        let row: {
          id: bigint;
          email: string;
          name: string | null;
          googleId: string | null;
          isSuperAdmin: boolean;
          passwordHash: string | null;
          memberships: Membership[];
          endedSessions?: { jti: string }[];
        } | null;
        const pool = authPoolFor(path);
        try {
          row = await pool.lookup((db) =>
            findSessionUser(
              db,
              userId,
              payload,
              pool.budget?.deadline !== undefined,
            ),
          );
        } catch (error) {
          logger.warn(
            { error },
            "Auth user lookup failed; treating as transient",
          );
          throw pool.unavailable();
        }

        if (!row) return null;
        const {
          isSuperAdmin,
          memberships,
          passwordHash,
          endedSessions,
          ...person
        } = row;
        if (!sessionMatchesPassword(payload, passwordHash)) return null;
        if (sessionEnded({ endedSessions })) return null;

        if (isSuperAdmin) {
          return {
            ...person,
            tenantId: null,
            role: "SUPER_ADMIN",
            memberships,
            ...(payload.jti ? { sessionId: payload.jti } : {}),
          };
        }

        // Fail-closed. A person with no membership has no tenant to run under, and is treated as
        // unauthenticated rather than degraded to a tenant-less session. A selector outside their
        // memberships is refused with the id it named, so the console drops it.
        const current = resolveMembership(memberships, headers["x-tenant-id"]);
        if (current === null) return null;
        if ("rejected" in current) {
          throw new TenantSelectorRefusedError(current.rejected);
        }
        return {
          ...person,
          ...current,
          memberships,
          ...(payload.jti ? { sessionId: payload.jti } : {}),
        };
      },
    };
  })
  .derive({ as: "global" }, ({ request, getAuthUser }) => ({
    // The session as this request read it, shared by the tenancy boundary, the gates and the
    // refusal of a request without one. `getAuthUser` stays a fresh read on every call, since a
    // socket re-checks its session through it long after the upgrade request was answered.
    requestAuthUser(): Promise<AuthUser | null> {
      let read = sessionReads.get(request);
      if (!read) {
        read = getAuthUser();
        sessionReads.set(request, read);
      }
      return read;
    },
  }))
  .macro({
    requireAuth(enabled: boolean) {
      if (!enabled) return;

      return {
        transform: markSessionGated,
        async beforeHandle({ requestAuthUser, set }) {
          const user = await requestAuthUser();
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
        transform: markSessionGated,
        async beforeHandle({ requestAuthUser, set }) {
          const user = await requestAuthUser();
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
    // Compatibility alias: "admin" means TENANT_ADMIN or above.
    requireAdmin(enabled: boolean) {
      if (!enabled) return;

      return {
        transform: markSessionGated,
        async beforeHandle({ requestAuthUser, set }) {
          const user = await requestAuthUser();
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
