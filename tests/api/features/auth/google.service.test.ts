import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import config from "@/config";
import {
  mockCreate,
  mockFindFirst,
  mockFindUnique,
  mockUpdate,
  mockUpdateMany,
  mockUser,
  resetPrismaMocks,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

setupPrismaMock();

// `mock.module` is process-global and PERMANENT: it rewrites the module for every file that runs
// after this one, not just for this file's tests, and nothing in the runner puts it back. So this
// stub answers every JWT verification in the process from here on, including session cookies in
// files this one knows nothing about.
//
// What follows is load-bearing: `jwtVerify` DELEGATES to the real implementation unless a test
// overrides it for its own call, which is why `beforeEach` below clears rather than resets. Only
// the exports NAMED here are replaced — measured, `SignJWT` and the rest survive on their own — so
// delegation is the whole of what keeps the leak harmless. A bare `mockReset()` leaves this
// function returning `undefined`, and
// `undefined` is not a failed verification — it is a TypeError one `.payload` later, which each
// caller's catch reports as an ordinary invalid token. Measured on 2026-08-27 (issue #420): it
// turned every session cookie into a 401 for the files that ran after this one, and the failure
// named the cookie rather than the mock.
// A PLAIN SNAPSHOT, taken before the mock is installed. `await import()` hands back the LIVE
// namespace, which Bun rewrites in place when `mock.module` runs — so a namespace captured here and
// handed back in `afterAll` would re-register the stub rather than undo it, and the spread below
// would copy the stub instead of the real exports.
const realJose = { ...(await import("jose")) };

const mockJwtVerify = mock(
  realJose.jwtVerify as unknown as (...args: unknown[]) => Promise<unknown>,
);

mock.module("jose", () => ({
  createRemoteJWKSet: () => null,
  jwtVerify: mockJwtVerify,
}));

afterAll(() => {
  mock.module("jose", () => realJose);
});

const {
  verifyGoogleIdToken,
  upsertGoogleUser,
  GoogleEmailNotVerifiedError,
  GoogleEmailDomainNotAllowedError,
  GoogleIdMismatchError,
  GoogleAdminLinkBlockedError,
  GoogleRegistrationDisabledError,
} = await import("@/api/features/auth/google.service");

// NOTE: Use the real setup state machine (mock.module is process-global and
// would leak into setup.service.test.ts).
const { completeSetup, initSetupState } = await import(
  "@/api/features/auth/setup.service"
);

const originalSignupEnabled = config.signupEnabled;

// The snapshot is what `afterAll` hands back, so it has to still hold the REAL exports after the
// mock is installed. A live namespace does not: Bun rewrites it in place, and restoring it would
// re-register the stub while reading as a teardown. Asserted rather than commented, because the two
// spellings differ by three characters and behave identically until the day someone imports `jose`
// after this file has run.
describe("the jose snapshot survives its own mock", () => {
  test("the snapshot's jwtVerify is not the stub", () => {
    expect(realJose.jwtVerify).not.toBe(
      mockJwtVerify as unknown as typeof realJose.jwtVerify,
    );
  });

  test("the snapshot still carries the exports the stub does not replace", () => {
    expect(typeof realJose.SignJWT).toBe("function");
  });
});

describe("google.service", () => {
  beforeEach(() => {
    resetPrismaMocks();
    // `mockReset` would strip the delegation above and leave this returning `undefined` for the
    // rest of the process. Clear the call log, keep the real implementation.
    mockJwtVerify.mockClear();
    // NOTE: Default to "setup done, signup open" so the existing creation tests
    // pass the registration gate; specific tests override these.
    completeSetup();
    config.signupEnabled = true;
  });

  // The property the leak violates, asserted from inside this file because that is the only place
  // it can be reached before the damage lands somewhere else. `mock.module` is permanent, so from
  // here on THIS function answers every JWT verification in the process — including session cookies
  // in files that stub nothing. It must therefore still verify a real token after `beforeEach` has
  // run, which is exactly what a `mockReset()` or a non-delegating stub would take away.
  //
  // Without it the failure surfaces hundreds of files later, as a 401 that names the cookie.
  test("a caller that is not this file still gets a working jwtVerify", async () => {
    const { SignJWT, jwtVerify } = await import("jose");
    const key = new TextEncoder().encode("a-throwaway-key-32-chars-long!!!");
    const token = await new SignJWT({ marker: "round-trip" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("5m")
      .sign(key);

    const { payload } = await jwtVerify(token, key);
    expect(payload.marker).toBe("round-trip");
  });

  afterEach(() => {
    config.signupEnabled = originalSignupEnabled;
  });

  describe("verifyGoogleIdToken", () => {
    test("returns normalized profile from valid JWT payload", async () => {
      mockJwtVerify.mockResolvedValueOnce({
        payload: {
          sub: "google-sub-123",
          email: "user@example.com",
          email_verified: true,
          name: "Jane Doe",
        },
      });

      const profile = await verifyGoogleIdToken("header.payload.sig");

      expect(profile).toEqual({
        sub: "google-sub-123",
        email: "user@example.com",
        emailVerified: true,
        name: "Jane Doe",
      });
    });

    test("emailVerified is false when claim is missing", async () => {
      mockJwtVerify.mockResolvedValueOnce({
        payload: {
          sub: "sub",
          email: "user@example.com",
        },
      });

      const profile = await verifyGoogleIdToken("credential");
      expect(profile.emailVerified).toBe(false);
    });

    test("throws when sub is missing", async () => {
      mockJwtVerify.mockResolvedValueOnce({
        payload: { email: "user@example.com", email_verified: true },
      });

      await expect(verifyGoogleIdToken("credential")).rejects.toThrow(
        /missing required claims/,
      );
    });

    test("propagates errors from jwtVerify", async () => {
      mockJwtVerify.mockRejectedValueOnce(new Error("signature failed"));

      await expect(verifyGoogleIdToken("bad")).rejects.toThrow(
        /signature failed/,
      );
    });
  });

  describe("upsertGoogleUser", () => {
    const baseProfile = {
      sub: "google-sub-123",
      email: "user@example.com",
      emailVerified: true,
      name: "Jane Doe",
    };

    test("returns existing user when googleId matches", async () => {
      const existing = { ...mockUser, googleId: "google-sub-123" };
      mockFindUnique.mockResolvedValueOnce(existing);

      const result = await upsertGoogleUser(baseProfile);

      expect(result).toEqual(existing);
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test("links googleId to existing user when email matches and is verified", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce({ ...mockUser });
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockFindUnique.mockResolvedValueOnce({
        ...mockUser,
        googleId: "google-sub-123",
      });

      const result = await upsertGoogleUser(baseProfile);

      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: mockUser.id, googleId: null },
          data: { googleId: "google-sub-123" },
        }),
      );
      expect(result.id).toBe(mockUser.id);
    });

    test("blocks Google linking on a pre-created ADMIN that has never logged in", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce({
        ...mockUser,
        role: "TENANT_ADMIN",
        lastLoginAt: null,
      });

      await expect(upsertGoogleUser(baseProfile)).rejects.toBeInstanceOf(
        GoogleAdminLinkBlockedError,
      );

      expect(mockUpdateMany).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("allows Google linking for ADMIN that has completed at least one login", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce({
        ...mockUser,
        role: "TENANT_ADMIN",
        lastLoginAt: new Date("2026-01-01"),
      });
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });
      mockFindUnique.mockResolvedValueOnce({
        ...mockUser,
        role: "TENANT_ADMIN",
        googleId: "google-sub-123",
      });

      const result = await upsertGoogleUser(baseProfile);

      expect(result.role).toBe("TENANT_ADMIN");
      expect(mockUpdateMany).toHaveBeenCalled();
    });

    test("rejects when linking races and a parallel sign-in already wrote a different googleId", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce({ ...mockUser });
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindUnique.mockResolvedValueOnce({
        ...mockUser,
        googleId: "different-google-sub",
      });

      await expect(upsertGoogleUser(baseProfile)).rejects.toBeInstanceOf(
        GoogleIdMismatchError,
      );
    });

    test("returns the existing user when linking races against an idempotent retry of the same googleId", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce({ ...mockUser });
      mockUpdateMany.mockResolvedValueOnce({ count: 0 });
      mockFindUnique.mockResolvedValueOnce({
        ...mockUser,
        googleId: "google-sub-123",
      });

      const result = await upsertGoogleUser(baseProfile);

      expect(result.id).toBe(mockUser.id);
    });

    test("rejects unverified emails before any link/create branch", async () => {
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(
        upsertGoogleUser({ ...baseProfile, emailVerified: false }),
      ).rejects.toBeInstanceOf(GoogleEmailNotVerifiedError);

      // NOTE: must short-circuit before email lookup, allowlist, or create.
      expect(mockFindFirst).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("rejects linking when existing account has a different googleId", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce({
        ...mockUser,
        googleId: "different-google-sub",
      });

      await expect(upsertGoogleUser(baseProfile)).rejects.toBeInstanceOf(
        GoogleIdMismatchError,
      );

      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("creates new user when no existing account matches", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce({
        ...mockUser,
        email: "user@example.com",
        googleId: "google-sub-123",
        name: "Jane Doe",
      });

      const result = await upsertGoogleUser(baseProfile);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            email: "user@example.com",
            googleId: "google-sub-123",
            name: "Jane Doe",
            tenantId: BigInt(1),
            role: "AGENT",
          },
        }),
      );
      expect(result.email).toBe("user@example.com");
    });

    test("blocks new-account creation when public signup is disabled", async () => {
      config.signupEnabled = false;
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce(null);

      await expect(upsertGoogleUser(baseProfile)).rejects.toBeInstanceOf(
        GoogleRegistrationDisabledError,
      );

      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("blocks new-account creation while first-run setup is pending", async () => {
      await initSetupState(); // no users → setup required
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce(null);

      await expect(upsertGoogleUser(baseProfile)).rejects.toBeInstanceOf(
        GoogleRegistrationDisabledError,
      );

      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("creates new Google user with ADMIN role when domain matches", async () => {
      const config = (await import("@/config")).default;
      const original = config.adminSignupDomains;
      config.adminSignupDomains = ["mycompany.io"];
      try {
        mockFindUnique.mockResolvedValueOnce(null);
        mockFindFirst.mockResolvedValueOnce(null);
        mockCreate.mockResolvedValueOnce(mockUser);

        await upsertGoogleUser({
          sub: "google-sub-456",
          email: "founder@mycompany.io",
          emailVerified: true,
          name: "Founder",
        });

        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ role: "TENANT_ADMIN" }),
          }),
        );
      } finally {
        config.adminSignupDomains = original;
      }
    });

    test("rejects when domain is not in allowedSignupDomains", async () => {
      const config = (await import("@/config")).default;
      const original = [...config.allowedSignupDomains];
      config.allowedSignupDomains = ["allowed.com"];
      try {
        mockFindUnique.mockResolvedValueOnce(null);
        mockFindFirst.mockResolvedValueOnce(null);

        await expect(upsertGoogleUser(baseProfile)).rejects.toBeInstanceOf(
          GoogleEmailDomainNotAllowedError,
        );

        expect(mockCreate).not.toHaveBeenCalled();
      } finally {
        config.allowedSignupDomains = original;
      }
    });

    test("returns existing user when create races and a concurrent insert wins", async () => {
      const created = {
        ...mockUser,
        email: "user@example.com",
        googleId: "google-sub-123",
      };
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockRejectedValueOnce(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
      );
      mockFindUnique.mockResolvedValueOnce(created);

      const result = await upsertGoogleUser(baseProfile);

      expect(result).toEqual(created);
      expect(mockFindUnique).toHaveBeenCalledTimes(2);
    });

    test("rethrows create error when no concurrent row exists", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockRejectedValueOnce(new Error("db down"));
      mockFindUnique.mockResolvedValueOnce(null);

      await expect(upsertGoogleUser(baseProfile)).rejects.toThrow(/db down/);
    });

    test("lowercases email on create", async () => {
      mockFindUnique.mockResolvedValueOnce(null);
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(mockUser);

      await upsertGoogleUser({ ...baseProfile, email: "  USER@Example.COM  " });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: "user@example.com" }),
        }),
      );
    });
  });
});
