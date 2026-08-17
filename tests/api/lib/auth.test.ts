import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";

import { authPlugin } from "@/api/lib/auth";

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

const mockPrisma = {
  user: {
    findUnique: mock(
      (): Promise<typeof mockUser | null> => Promise.resolve(null),
    ),
  },
};

mock.module("@/api/lib/prisma", () => ({
  default: mockPrisma,
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
          const token = await setAuthCookie(mockUser);
          return { token };
        });

      const response = await app.handle(
        new Request("http://localhost/test-set-cookie", { method: "POST" }),
      );

      expect(response.status).toBe(200);
      // NOTE: happy-dom (registered via tests/setup.ts) strips `Set-Cookie`
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
          const token = await setAuthCookie(mockUser);
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
    test("executes without error", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .post("/test-clear-cookie", ({ clearAuthCookie }) => {
          clearAuthCookie();
          return { success: true };
        });

      const response = await app.handle(
        new Request("http://localhost/test-clear-cookie", {
          method: "POST",
          headers: { Cookie: "auth_token=some_token" },
        }),
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
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

    test("returns null for invalid token", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .get("/test-get-user", async ({ getAuthUser }) => {
          const user = await getAuthUser();
          return { user };
        });

      const response = await app.handle(
        new Request("http://localhost/test-get-user", {
          headers: { Cookie: "auth_token=invalid_token" },
        }),
      );

      const data = await response.json();
      expect(data.user).toBeNull();
    });

    test("returns null for malformed JWT", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .get("/test-get-user", async ({ getAuthUser }) => {
          const user = await getAuthUser();
          return { user };
        });

      const response = await app.handle(
        new Request("http://localhost/test-get-user", {
          headers: { Cookie: "auth_token=not.a.valid.jwt.token" },
        }),
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
            token: await setAuthCookie(mockUser),
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
        mockPrisma.user.findUnique.mockResolvedValueOnce(mockUser);
        const token = await mintToken();
        const res = await readerApp().handle(
          new BunRequest("http://localhost/whoami", {
            headers: { Cookie: `fazerai_auth_token=${token}` },
          }),
        );
        expect((await res.json()).id).toBe(mockUser.id.toString());
      });

      test("resolves a session sent under the pre-rename cookie name", async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce(mockUser);
        const token = await mintToken();
        const res = await readerApp().handle(
          new BunRequest("http://localhost/whoami", {
            headers: { Cookie: `secretaria_v4_auth_token=${token}` },
          }),
        );
        expect((await res.json()).id).toBe(mockUser.id.toString());
      });

      test("prefers the current name when both cookies are present", async () => {
        mockPrisma.user.findUnique.mockResolvedValueOnce(mockUser);
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
        mockPrisma.user.findUnique.mockResolvedValueOnce(mockUser);
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

    test("rejects requests with invalid token with 401", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .get("/protected", () => ({ message: "secret data" }), {
          requireAuth: true,
        });

      const response = await app.handle(
        new Request("http://localhost/protected", {
          headers: { Cookie: "auth_token=invalid" },
        }),
      );

      expect(response.status).toBe(401);
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

    test("rejects requests with invalid token with 401", async () => {
      const app = new Elysia()
        .use(authPlugin)
        .get("/admin", () => ({ message: "admin data" }), {
          requireAdmin: true,
        });

      const response = await app.handle(
        new Request("http://localhost/admin", {
          headers: { Cookie: "auth_token=invalid" },
        }),
      );

      expect(response.status).toBe(401);
    });
  });
});
