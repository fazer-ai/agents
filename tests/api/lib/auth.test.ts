import {
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { Elysia } from "elysia";

import { authPlugin, authPoolFor } from "@/api/lib/auth";
import { localeMiddleware } from "@/api/middlewares/locale";
import config from "@/config";

// happy-dom's Request drops `Cookie` (a forbidden request header), so a cookie built with the
// global constructor never reaches the route. Bun's native Request is captured in tests/dom-setup.ts
// before registration; use it for anything that has to carry a session cookie.
const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

const mockUser = {
  id: BigInt(1),
  tenantId: BigInt(1) as bigint | null,
  email: "test@example.com",
  name: null as string | null,
  passwordHash: "$2b$10$hashedpassword",
  role: "AGENT" as const,
  googleId: null as string | null,
};

// The row the session lookup reads: the person, with their one membership.
const mockPersonRow = {
  id: mockUser.id,
  email: mockUser.email,
  name: mockUser.name,
  googleId: mockUser.googleId,
  passwordHash: mockUser.passwordHash as string | null,
  isSuperAdmin: false,
  memberships: [
    { tenantId: BigInt(1), role: "AGENT" as const, createdAt: new Date(0) },
  ],
};

const mockPrisma = {
  user: {
    findUnique: mock(
      (): Promise<typeof mockPersonRow | null> => Promise.resolve(null),
    ),
  },
};

mock.module("@/api/lib/prisma", () => ({
  default: mockPrisma,
}));

// The metrics routes authenticate through the metrics pool, so the screen does not need a
// connection of the main one (src/api/lib/prisma-metrics.ts).
const mockMetricsPrisma = {
  user: {
    findUnique: mock(
      (): Promise<typeof mockPersonRow | null> => Promise.resolve(null),
    ),
  },
  // Under the request's deadline the memberships are a read of their own.
  tenantUser: {
    findMany: mock(() => Promise.resolve(mockPersonRow.memberships)),
  },
  endedSession: {
    findMany: mock(() => Promise.resolve([] as { jti: string }[])),
  },
  // The lookup runs in a transaction bounded by the request's budget.
  $executeRaw: mock(() => Promise.resolve(0)),
  $transaction: mock(
    (
      fn: (tx: unknown) => Promise<unknown>,
      _options?: { maxWait: number; timeout: number },
    ) => fn(mockMetricsPrisma),
  ),
};

mock.module("@/api/lib/prisma-metrics", () => ({
  default: mockMetricsPrisma,
}));

function base64urlToBase64(input: string): string {
  const replaced = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (replaced.length % 4)) % 4;
  return replaced + "=".repeat(padLen);
}

describe("authPlugin", () => {
  beforeEach(() => {
    // NOTE: mockClear preserves the default Promise.resolve(null) stub; using
    // mockReset here would strip it and later tests would receive `undefined`
    // from findUnique() instead of a Prisma-shaped async result.
    mockPrisma.user.findUnique.mockClear();
  });

  describe("setAuthCookie", () => {
    test("returns valid JWT token with correct structure", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .post("/test-set-cookie", async ({ setAuthCookie }) => {
          const token = await setAuthCookie(mockUser, mockUser.passwordHash);
          return { token };
        });

      const response = await app.handle(
        new Request("http://localhost/test-set-cookie", { method: "POST" }),
      );

      expect(response.status).toBe(200);
      // Happy-dom (registered via tests/setup.ts) strips `Set-Cookie`
      // from Response headers as a forbidden response header. The cookie
      // side effect is therefore only observable indirectly through the
      // JWT returned by `setAuthCookie`, which we assert below.
      const data = await response.json();
      expect(data.token).toBeDefined();
      expect(typeof data.token).toBe("string");

      const parts = data.token.split(".");
      expect(parts).toHaveLength(3);

      const payload = JSON.parse(atob(base64urlToBase64(parts[1])));
      expect(payload.userId).toBe(mockUser.id.toString());
      expect(payload.email).toBe(mockUser.email);
      expect(payload.role).toBe(mockUser.role);
    });

    test("includes expiration in JWT token", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .post("/test-set-cookie", async ({ setAuthCookie }) => {
          const token = await setAuthCookie(mockUser, mockUser.passwordHash);
          return { token };
        });

      const response = await app.handle(
        new Request("http://localhost/test-set-cookie", { method: "POST" }),
      );

      const data = await response.json();
      const parts = data.token.split(".");
      const payload = JSON.parse(atob(base64urlToBase64(parts[1])));

      expect(payload.exp).toBeDefined();
      expect(payload.iat).toBeDefined();
      expect(payload.exp).toBeGreaterThan(payload.iat);
    });
  });

  describe("clearAuthCookie", () => {
    test("expires both session cookies the request carried", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .post("/test-clear-cookie", ({ clearAuthCookie, set }) => {
          clearAuthCookie();
          return structuredClone(set.cookie);
        });
      const response = await app.handle(
        new BunRequest("http://localhost/test-clear-cookie", {
          method: "POST",
          headers: {
            cookie: "fazerai_auth_token=a; secretaria_v4_auth_token=b",
          },
        }),
      );

      const jar = await response.json();
      const expired = { value: "", maxAge: 0 };
      expect(jar.fazerai_auth_token).toMatchObject(expired);
      expect(jar.secretaria_v4_auth_token).toMatchObject(expired);
    });
  });

  describe("getAuthUser", () => {
    test("returns null when no cookie present", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .get("/test-get-user", async ({ getAuthUser }) => {
          const user = await getAuthUser();
          return { user };
        });

      const response = await app.handle(
        new Request("http://localhost/test-get-user"),
      );

      const data = await response.json();
      expect(data.user).toBeNull();
    });

    // Brand rename compatibility window. Sessions minted by the previous image carry
    // `secretaria_v4_auth_token`; the current one issues and reads `fazerai_auth_token`. Reading
    // both is what keeps an upgrade from logging every operator out. Dropped at 2.0.
    describe("session cookie name", () => {
      // Mints a real session JWT through setAuthCookie, then replays it as a raw Cookie header
      // under whichever name the caller wants to exercise.
      async function mintToken(): Promise<string> {
        const app = new Elysia()
          .use(authPlugin)
          .post("/mint", async ({ setAuthCookie }) => ({
            token: await setAuthCookie(mockUser, mockUser.passwordHash),
          }));
        const res = await app.handle(
          new Request("http://localhost/mint", { method: "POST" }),
        );
        return (await res.json()).token;
      }

      function readerApp() {
        return new Elysia()
          .use(authPlugin)
          .get("/whoami", async ({ getAuthUser }) => {
            const user = await getAuthUser();
            return { id: user ? user.id.toString() : null };
          });
      }

      test("resolves a session sent under the current cookie name", async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce(mockPersonRow);
        const token = await mintToken();
        const res = await readerApp().handle(
          new BunRequest("http://localhost/whoami", {
            headers: { Cookie: `fazerai_auth_token=${token}` },
          }),
        );
        expect((await res.json()).id).toBe(mockUser.id.toString());
      });

      test("resolves a session sent under the pre-rename cookie name", async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce(mockPersonRow);
        const token = await mintToken();
        const res = await readerApp().handle(
          new BunRequest("http://localhost/whoami", {
            headers: { Cookie: `secretaria_v4_auth_token=${token}` },
          }),
        );
        expect((await res.json()).id).toBe(mockUser.id.toString());
      });

      test("a metrics route reads the session through the metrics pool, any other route through the main one", async () => {
        const token = await mintToken();
        const app = new Elysia().group("/api", (api) =>
          api
            .use(authPlugin)
            .get("/v1/metrics/costs", async ({ getAuthUser }) => ({
              id: (await getAuthUser())?.id.toString() ?? null,
            }))
            .get("/v1/agents", async ({ getAuthUser }) => ({
              id: (await getAuthUser())?.id.toString() ?? null,
            })),
        );
        const ask = (path: string) =>
          app.handle(
            new BunRequest(`http://localhost${path}`, {
              headers: { Cookie: `fazerai_auth_token=${token}` },
            }),
          );
        mockMetricsPrisma.user.findUnique.mockResolvedValueOnce(mockPersonRow);
        mockMetricsPrisma.$transaction.mockClear();
        mockMetricsPrisma.tenantUser.findMany.mockClear();
        expect((await (await ask("/api/v1/metrics/costs")).json()).id).toBe(
          mockUser.id.toString(),
        );
        // Inside a transaction whose wait and run are what is left of the request's metrics budget.
        const options = mockMetricsPrisma.$transaction.mock.calls[0]?.[1];
        expect(options?.maxWait).toBeLessThanOrEqual(config.metrics.timeoutMs);
        expect(options?.timeout).toBeLessThanOrEqual(config.metrics.timeoutMs);
        // The memberships are a read of their own, so the deadline is set before each one.
        expect(mockMetricsPrisma.tenantUser.findMany).toHaveBeenCalledTimes(1);
        mockMetricsPrisma.user.findUnique.mockResolvedValueOnce(mockPersonRow);
        expect((await (await ask("/api/v1/agents")).json()).id).toBeNull();
      });

      test("a metrics route's key lookup keeps to what is left of the request's metrics budget, any other to the main one", () => {
        const metrics = authPoolFor("/api/v1/metrics/costs").budget;
        expect(metrics?.timeout).toBeLessThanOrEqual(config.metrics.timeoutMs);
        expect(metrics?.timeout).toBeGreaterThan(0);
        expect(metrics?.deadline).toBeDefined();
        expect(authPoolFor("/api/v1/metrics").budget?.maxWait).toBeDefined();
        expect(authPoolFor("/api/v1/metricsx").budget).toBeUndefined();
        expect(authPoolFor("/api/v1/agents").budget).toBeUndefined();
      });

      test("a metrics route whose session lookup fails after the request's budget is spent answers the metrics refusal", async () => {
        const token = await mintToken();
        const app = new Elysia().use(localeMiddleware).group("/api", (api) =>
          api
            .use(authPlugin)
            .get("/v1/metrics/costs", async ({ getAuthUser }) =>
              getAuthUser().then(
                () => ({ status: 200 }),
                (e: { statusCode?: number; field?: string }) => ({
                  status: e.statusCode ?? 500,
                  field: e.field ?? null,
                }),
              ),
            ),
        );
        const ask = () =>
          app.handle(
            new BunRequest("http://localhost/api/v1/metrics/costs", {
              headers: { Cookie: `fazerai_auth_token=${token}` },
            }),
          );
        const metrics = config.metrics;
        const saved = metrics.timeoutMs;
        metrics.timeoutMs = 50;
        // NOTE: drops a value an earlier test queued and never consumed.
        mockMetricsPrisma.user.findUnique.mockReset();
        try {
          // The pool gave no connection until the budget was gone.
          mockMetricsPrisma.user.findUnique.mockImplementationOnce(() => {
            setSystemTime(new Date(Date.now() + 100));
            return Promise.reject(
              new Error("timeout exceeded when trying to connect"),
            );
          });
          expect(await (await ask()).json()).toEqual({
            status: 503,
            field: "since",
          });
          // A lookup that fails inside the budget is the plain transient 503.
          mockMetricsPrisma.user.findUnique.mockImplementationOnce(() =>
            Promise.reject(new Error("connection reset")),
          );
          metrics.timeoutMs = 10_000;
          expect(await (await ask()).json()).toEqual({
            status: 503,
            field: null,
          });
        } finally {
          metrics.timeoutMs = saved;
          setSystemTime();
          mockMetricsPrisma.user.findUnique.mockImplementation(() =>
            Promise.resolve(null),
          );
        }
      });

      test("an API key whose lookup fails is a transient 503, not a 500", async () => {
        const app = new Elysia()
          .use(authPlugin)
          .get("/who", async ({ getAuthUser }) =>
            getAuthUser().then(
              () => ({ status: 200 }),
              (e: { statusCode?: number }) => ({ status: e.statusCode ?? 500 }),
            ),
          );
        // The mock client has no `$transaction`, so the key's lookup throws as a full pool would.
        const res = await app.handle(
          new BunRequest("http://localhost/who", {
            headers: { Authorization: "Bearer fazerai_abc" },
          }),
        );
        expect((await res.json()).status).toBe(503);
      });

      test("refuses a session signed under another password", async () => {
        const token = await mintToken();
        mockPrisma.user.findUnique.mockResolvedValueOnce({
          ...mockPersonRow,
          passwordHash: "$2b$10$anotherhash",
        });
        const res = await readerApp().handle(
          new BunRequest("http://localhost/whoami", {
            headers: { Cookie: `fazerai_auth_token=${token}` },
          }),
        );
        expect((await res.json()).id).toBeNull();
      });

      test("refuses a session that carries no password fingerprint for an account that has one", async () => {
        const app = new Elysia()
          .use(authPlugin)
          .post("/mint", async ({ setAuthCookie }) => ({
            token: await setAuthCookie(mockUser, null),
          }));
        const { token } = (await (
          await app.handle(
            new Request("http://localhost/mint", { method: "POST" }),
          )
        ).json()) as { token: string };
        mockPrisma.user.findUnique.mockResolvedValueOnce(mockPersonRow);
        const res = await readerApp().handle(
          new BunRequest("http://localhost/whoami", {
            headers: { Cookie: `fazerai_auth_token=${token}` },
          }),
        );
        expect((await res.json()).id).toBeNull();
      });

      test("the proof of identity refuses a revoked session too", async () => {
        const token = await mintToken();
        mockPrisma.user.findUnique.mockResolvedValueOnce({
          ...mockPersonRow,
          passwordHash: "$2b$10$anotherhash",
        });
        const app = new Elysia()
          .use(authPlugin)
          .get("/who", async ({ getSessionIdentity }) => ({
            id: (await getSessionIdentity())?.userId.toString() ?? null,
          }));
        const res = await app.handle(
          new BunRequest("http://localhost/who", {
            headers: { Cookie: `fazerai_auth_token=${token}` },
          }),
        );
        expect((await res.json()).id).toBeNull();
      });

      test("prefers the current name when both cookies are present", async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce(mockPersonRow);
        const token = await mintToken();
        const res = await readerApp().handle(
          new BunRequest("http://localhost/whoami", {
            headers: {
              Cookie: `fazerai_auth_token=${token}; secretaria_v4_auth_token=not.a.valid.jwt`,
            },
          }),
        );
        // A garbage legacy cookie must not shadow a good current one.
        expect((await res.json()).id).toBe(mockUser.id.toString());
      });

      test("migrates a legacy cookie in place: rewrites it, clears the old name", async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce(mockPersonRow);
        const token = await mintToken();
        // happy-dom strips `Set-Cookie` off the Response, so assert on Elysia's cookie jar —
        // the exact state it serializes into the header.
        const app = new Elysia()
          .use(authPlugin)
          .get("/whoami", async ({ getAuthUser, cookie }) => {
            await getAuthUser();
            return {
              current: cookie.fazerai_auth_token?.value ?? null,
              legacyValue: cookie.secretaria_v4_auth_token?.value ?? null,
              legacyMaxAge: cookie.secretaria_v4_auth_token?.maxAge ?? null,
            };
          });
        const res = await app.handle(
          new BunRequest("http://localhost/whoami", {
            headers: { Cookie: `secretaria_v4_auth_token=${token}` },
          }),
        );
        const jar = await res.json();
        expect(jar.current).toBe(token);
        // remove() → empty value + Max-Age 0, i.e. an expiry instruction for the browser.
        expect(jar.legacyValue).toBe("");
        expect(jar.legacyMaxAge).toBe(0);
      });

      test("a legacy cookie carrying garbage is still rejected", async () => {
        const res = await readerApp().handle(
          new BunRequest("http://localhost/whoami", {
            headers: { Cookie: "secretaria_v4_auth_token=not.a.valid.jwt" },
          }),
        );
        expect((await res.json()).id).toBeNull();
      });
    });
  });

  describe("requireAuth macro", () => {
    test("rejects unauthenticated requests with 401", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .get("/protected", () => ({ message: "secret data" }), {
          requireAuth: true,
        });

      const response = await app.handle(
        new Request("http://localhost/protected"),
      );

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Unauthorized");
    });
  });

  describe("requireAdmin macro", () => {
    test("rejects unauthenticated users with 401", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .get("/admin", () => ({ message: "admin data" }), {
          requireAdmin: true,
        });

      const response = await app.handle(new Request("http://localhost/admin"));

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe("Unauthorized");
    });
  });
});
