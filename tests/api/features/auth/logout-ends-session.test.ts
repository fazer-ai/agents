import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Elysia } from "elysia";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";

// Logging out ends the session on the server: a copy of the cookie taken before the logout is
// refused after it, and only that session ends. Against real rows, through the app's own routes.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

const suUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let appDb: PrismaClient | undefined;
if (suUrl && appUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    appDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await appDb.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

// The app's own client against the test database, so the session lookup reads real rows. Restored as
// a fresh literal, the way biome-plugins/no-module-mock-live-namespace.grit requires.
const originalPrisma = (await import("@/api/lib/prisma")).default;
// Runs once right after the next session-identity read (the user lookup that selects only the
// password hash), to land a logout between a request's proof and its re-issue.
let afterSessionRead: (() => Promise<void>) | null = null;
type Delegate = Record<string | symbol, unknown>;
const db =
  appDb &&
  new Proxy(appDb, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key !== "user") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return new Proxy(value as Delegate, {
        get(users, method) {
          const fn = Reflect.get(users, method);
          if (typeof fn !== "function") return fn;
          if (method !== "findUnique") return fn.bind(users);
          return async (args: { select?: Record<string, unknown> }) => {
            const row = await fn.call(users, args);
            if (
              afterSessionRead &&
              args?.select?.passwordHash &&
              !args.select.memberships
            ) {
              const run = afterSessionRead;
              afterSessionRead = null;
              await run();
            }
            return row;
          };
        },
      });
    },
  });
mock.module("@/api/lib/prisma", () => ({ default: db }));
afterAll(() => {
  mock.module("@/api/lib/prisma", () => ({ default: originalPrisma }));
});

const server = (await import("@/app")).default;
const { authPlugin, isSessionLoggedOut, passwordFingerprint } = await import(
  "@/api/lib/auth"
);
const { trackSocket, untrackSocket } = await import(
  "@/api/features/realtime/realtime.service"
);
const { WS_CLOSE } = await import("@/api/lib/realtime");

const tag = `lo1275-${process.pid}`;
let tenantId = 0n;
let otherTenant = 0n;
let userId = 0n;
let passwordHash = "";

const minter = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => {
    const user = {
      id: userId,
      email: `${tag}@x.test`,
      name: null,
      googleId: null,
      role: "AGENT" as const,
      tenantId,
    };
    return { token: await setAuthCookie(user, passwordHash) };
  })
  .post("/mint-proved", async ({ setAuthCookie, headers, set }) => {
    const user = {
      id: userId,
      email: `${tag}@x.test`,
      name: null,
      googleId: null,
      role: "AGENT" as const,
      tenantId,
    };
    try {
      return {
        token: await setAuthCookie(user, passwordHash, {
          proofSessionId: headers["x-proof"],
        }),
      };
    } catch (error) {
      // NOTE: the app's error handler answers an AppError with its own status (src/app.ts).
      set.status = (error as { statusCode?: number }).statusCode ?? 500;
      return { error: String(error) };
    }
  });

// A session as the login issues it; `over` is a cookie the browser already holds.
async function signIn(over?: string): Promise<string> {
  const res = await minter.handle(
    new BunRequest("http://localhost/mint", {
      method: "POST",
      headers: over ? { cookie: over } : {},
    }),
  );
  return ((await res.json()) as { token: string }).token;
}

function req(path: string, cookie?: string, method = "GET"): Request {
  return new BunRequest(`http://localhost/api${path}`, {
    method,
    headers: cookie ? { cookie } : {},
  });
}

// `GET /auth/me` answers 200 with or without a session; whose session it is sits in the body.
const signedIn = async (cookie: string): Promise<boolean> => {
  const res = await server.handle(req("/auth/me", cookie));
  return ((await res.json()) as { user: unknown }).user != null;
};
const logout = (cookie?: string) =>
  server.handle(req("/auth/logout", cookie, "POST"));
const session = (token: string) => `fazerai_auth_token=${token}`;
const jtiOf = (token: string): string | undefined =>
  JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  ).jti;
const endedRows = async () =>
  Number(
    (
      await suDb.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*)::bigint AS n FROM ended_sessions WHERE user_id = ${userId}`
    )[0]?.n ?? 0,
  );

describe.skipIf(!dbUp)("logging out", () => {
  beforeAll(async () => {
    passwordHash = await Bun.password.hash("the-password-1275", {
      algorithm: "bcrypt",
      cost: 4,
    });
    tenantId = (
      await suDb.tenant.create({
        data: { name: "T1275", slug: tag },
        select: { id: true },
      })
    ).id;
    userId = (
      await suDb.user.create({
        data: { email: `${tag}@x.test`, passwordHash },
        select: { id: true },
      })
    ).id;
    await suDb.tenantUser.create({
      data: { tenantId, userId, role: "AGENT" },
    });
    otherTenant = (
      await suDb.tenant.create({
        data: { name: "T1275 other", slug: `${tag}-other` },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (userId) {
      await suDb.$executeRawUnsafe(`DELETE FROM users WHERE id = ${userId}`);
    }
    for (const t of [tenantId, otherTenant].filter((t) => t !== 0n)) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${t}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM invitations WHERE tenant_id = ${t}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${t}`);
    }
    await suDb.$disconnect();
    await appDb?.$disconnect();
  });

  test("refuses a copy of the cookie taken before it, and only that session ends", async () => {
    const laptop = await signIn();
    const phone = await signIn();
    expect(jtiOf(laptop)).toBeString();
    expect(jtiOf(laptop)).not.toBe(jtiOf(phone));
    expect(await signedIn(session(laptop))).toBe(true);

    expect((await logout(session(laptop))).status).toBe(200);

    expect(await signedIn(session(laptop))).toBe(false);
    expect(await signedIn(session(phone))).toBe(true);
  });

  test("ends a session presented under the legacy name behind an empty current cookie", async () => {
    const token = await signIn();
    const res = await logout(
      `fazerai_auth_token=; secretaria_v4_auth_token=${token}`,
    );
    expect(res.status).toBe(200);
    expect(await signedIn(session(token))).toBe(false);
  });

  test("refuses the copy under the legacy cookie name too", async () => {
    const token = await signIn();
    await logout(session(token));
    expect(await signedIn(`secretaria_v4_auth_token=${token}`)).toBe(false);
  });

  test("twice with the same copy records it once, and with no session records nothing", async () => {
    const token = await signIn();
    const before = await endedRows();
    expect((await logout(session(token))).status).toBe(200);
    expect((await logout(session(token))).status).toBe(200);
    expect(await endedRows()).toBe(before + 1);

    expect((await logout()).status).toBe(200);
    expect((await logout("fazerai_auth_token=not-a-token")).status).toBe(200);
    const forged = await new SignJWT({
      userId: userId.toString(),
      jti: "forged",
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("another-secret-entirely-0123456789"));
    expect((await logout(session(forged))).status).toBe(200);
    expect(await endedRows()).toBe(before + 1);
  });

  test("keeps an ended session until its token expires, and drops the expired ones on the next write", async () => {
    const token = await signIn();
    await logout(session(token));
    const row = await suDb.$queryRaw<{ expires_at: Date }[]>`
      SELECT expires_at FROM ended_sessions WHERE jti = ${jtiOf(token)}`;
    const exp = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    ).exp as number;
    expect(row[0]?.expires_at.getTime()).toBe(exp * 1000);

    await suDb.$executeRaw`
      INSERT INTO ended_sessions (jti, user_id, expires_at)
      VALUES (${`${tag}-stale`}, ${userId}, now() - interval '1 minute')`;
    await logout(session(await signIn()));
    const stale = await suDb.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM ended_sessions WHERE jti = ${`${tag}-stale`}`;
    expect(Number(stale[0]?.n)).toBe(0);
  });

  test("closes the sockets that session opened, and only those", async () => {
    const laptop = await signIn();
    const phone = await signIn();
    const closes: Record<string, number[]> = { laptop: [], phone: [] };
    trackSocket(
      userId,
      `${tag}-laptop`,
      { close: (c) => closes.laptop?.push(c ?? 0) },
      jtiOf(laptop),
    );
    trackSocket(
      userId,
      `${tag}-phone`,
      { close: (c) => closes.phone?.push(c ?? 0) },
      jtiOf(phone),
    );
    try {
      await logout(session(laptop));
      expect(closes).toEqual({ laptop: [WS_CLOSE.UNAUTHORIZED], phone: [] });
    } finally {
      untrackSocket(userId, `${tag}-laptop`);
      untrackSocket(userId, `${tag}-phone`);
    }
  });

  // An account deleted while one of its cookies is still out: that session can no longer sign in,
  // so its logout is already done rather than a failure to retry forever.
  test("of an account that was deleted, succeeds", async () => {
    const goneId = (
      await suDb.user.create({
        data: { email: `${tag}-gone@x.test`, passwordHash },
        select: { id: true },
      })
    ).id;
    const gone = new Elysia()
      .use(authPlugin)
      .post("/mint", async ({ setAuthCookie }) => ({
        token: await setAuthCookie(
          {
            id: goneId,
            email: `${tag}-gone@x.test`,
            name: null,
            googleId: null,
            role: "AGENT",
            tenantId,
          },
          passwordHash,
        ),
      }));
    const { token } = (await (
      await gone.handle(
        new Request("http://localhost/mint", { method: "POST" }),
      )
    ).json()) as { token: string };
    await suDb.$executeRawUnsafe(`DELETE FROM users WHERE id = ${goneId}`);
    expect((await logout(session(token))).status).toBe(200);
  });

  // A cookie re-issued over a live session (accepting an invitation, a password change, signing in
  // again) is a new session, and the one it replaces ends: the browser holds one session, and its
  // sockets reconnect under the new cookie.
  test("a cookie re-issued over a live session replaces it, and the old one ends", async () => {
    const first = await signIn();
    const closes: number[] = [];
    trackSocket(
      userId,
      `${tag}-first`,
      { close: (c) => closes.push(c ?? 0) },
      jtiOf(first),
    );
    try {
      const renewed = await signIn(session(first));
      expect(jtiOf(renewed)).not.toBe(jtiOf(first));
      expect(await signedIn(session(first))).toBe(false);
      expect(await signedIn(session(renewed))).toBe(true);
      expect(closes).toEqual([WS_CLOSE.CREDENTIALS_CHANGED]);
      // Replaced, not logged out: a socket refused on its re-check reconnects instead of signing out.
      expect(await isSessionLoggedOut(jtiOf(first) ?? "")).toBe(false);
      await logout(session(renewed));
      expect(await isSessionLoggedOut(jtiOf(renewed) ?? "")).toBe(true);
    } finally {
      untrackSocket(userId, `${tag}-first`);
    }
  });

  // A re-issue whose only proof was the session (accepting an invitation signed in) is refused when a
  // logout ended that session between the proof and the re-issue.
  test("a re-issue proved by a session that a logout just ended is refused", async () => {
    const proof = await signIn();
    await logout(session(proof));
    const res = await minter.handle(
      new BunRequest("http://localhost/mint-proved", {
        method: "POST",
        headers: { cookie: session(proof), "x-proof": jtiOf(proof) ?? "" },
      }),
    );
    expect(res.status).toBe(401);
  });

  test("a different person signing in over the cookie starts their own session", async () => {
    const otherId = (
      await suDb.user.create({
        data: { email: `${tag}-other@x.test`, passwordHash },
        select: { id: true },
      })
    ).id;
    try {
      const other = new Elysia()
        .use(authPlugin)
        .post("/mint", async ({ setAuthCookie }) => ({
          token: await setAuthCookie(
            {
              id: otherId,
              email: `${tag}-other@x.test`,
              name: null,
              googleId: null,
              role: "AGENT",
              tenantId,
            },
            passwordHash,
          ),
        }));
      const mine = await signIn();
      const theirs = (
        (await (
          await other.handle(
            new BunRequest("http://localhost/mint", {
              method: "POST",
              headers: { cookie: session(mine) },
            }),
          )
        ).json()) as { token: string }
      ).token;
      expect(jtiOf(theirs)).not.toBe(jtiOf(mine));
      expect(await signedIn(session(mine))).toBe(false);
    } finally {
      await suDb.$executeRawUnsafe(`DELETE FROM users WHERE id = ${otherId}`);
    }
  });

  // Accepting an invitation takes a signed-in session as proof of the account; an ended one is not.
  test("an ended session is no proof of the account when accepting an invitation", async () => {
    const { createInvite } = await import(
      "@/api/features/invitations/invitation.service"
    );
    const accept = async (cookie: string) => {
      const { token } = await createInvite(
        { tenantId: null, userId, role: "SUPER_ADMIN" },
        { tenantId: otherTenant, email: `${tag}@x.test`, role: "AGENT" },
        suDb,
      );
      return server.handle(
        new BunRequest("http://localhost/api/auth/accept-invite", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ token }),
        }),
      );
    };
    const joined = () =>
      suDb.tenantUser.count({ where: { userId, tenantId: otherTenant } });

    const ended = await signIn();
    await logout(session(ended));
    expect((await accept(session(ended))).status).toBe(401);
    expect(await joined()).toBe(0);

    expect((await accept(session(await signIn()))).status).toBe(200);
    expect(await joined()).toBe(1);
  });

  // Two invitations accepted at once on one cookie: the second re-issue finds the session already
  // replaced by the first, not logged out, and is not refused.
  test("a second re-issue proved by a session another re-issue just replaced is not refused", async () => {
    const proof = await signIn();
    await signIn(session(proof));
    const res = await minter.handle(
      new BunRequest("http://localhost/mint-proved", {
        method: "POST",
        headers: { cookie: session(proof), "x-proof": jtiOf(proof) ?? "" },
      }),
    );
    expect(res.status).toBe(200);
  });

  test("a logout after the session was replaced still reads as a logout", async () => {
    const a = await signIn();
    await signIn(session(a));
    expect(await isSessionLoggedOut(jtiOf(a) ?? "")).toBe(false);
    await logout(session(a));
    expect(await isSessionLoggedOut(jtiOf(a) ?? "")).toBe(true);
    const res = await minter.handle(
      new BunRequest("http://localhost/mint-proved", {
        method: "POST",
        headers: { cookie: session(a), "x-proof": jtiOf(a) ?? "" },
      }),
    );
    expect(res.status).toBe(401);
  });

  // Signed in, the session is the invitation's only proof: a logout landing after that proof was read
  // and before the cookie is re-issued refuses the re-issue instead of minting a session.
  test("an invitation accepted on a session that logs out meanwhile issues no session", async () => {
    const { createInvite } = await import(
      "@/api/features/invitations/invitation.service"
    );
    const third = (
      await suDb.tenant.create({
        data: { name: "T1275 third", slug: `${tag}-third` },
        select: { id: true },
      })
    ).id;
    try {
      const { token } = await createInvite(
        { tenantId: null, userId, role: "SUPER_ADMIN" },
        { tenantId: third, email: `${tag}@x.test`, role: "AGENT" },
        suDb,
      );
      const proof = await signIn();
      afterSessionRead = async () => {
        await logout(session(proof));
      };
      const res = await server.handle(
        new BunRequest("http://localhost/api/auth/accept-invite", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: session(proof),
          },
          body: JSON.stringify({ token }),
        }),
      );
      expect(afterSessionRead).toBeNull();
      expect(res.status).toBe(401);
    } finally {
      afterSessionRead = null;
      await suDb.$executeRawUnsafe(
        `DELETE FROM invitations WHERE tenant_id = ${third}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenant_users WHERE tenant_id = ${third}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${third}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${third}`);
    }
  });

  // A token signed before sessions carried an id cannot be named, so it keeps working until it
  // expires, as every session did.
  test("cannot end a session issued without an id", async () => {
    const legacy = await new SignJWT({
      userId: userId.toString(),
      email: `${tag}@x.test`,
      role: "AGENT",
      tenantId: tenantId.toString(),
      pwd: passwordFingerprint(passwordHash),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret));
    const before = await endedRows();
    expect((await logout(session(legacy))).status).toBe(200);
    expect(await endedRows()).toBe(before);
    expect(await signedIn(session(legacy))).toBe(true);
  });
});
