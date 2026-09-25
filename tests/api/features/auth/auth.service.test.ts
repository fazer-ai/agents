import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import config from "@/config";
import {
  asPersonRow,
  mockCount,
  mockCreate,
  mockFindFirst,
  mockFindUnique,
  mockTenantCreate,
  mockUpdate,
  mockUser,
  resetPrismaMocks,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

setupPrismaMock();

const {
  getUserByEmail,
  createUser,
  createInitialAdmin,
  slugifyCompany,
  SetupAlreadyCompleteError,
  hashPassword,
  verifyPassword,
  isEmailDomainAllowed,
  getSignupRoleForEmail,
  getUserHasPassword,
  changeUserPassword,
  NoPasswordSetError,
  IncorrectPasswordError,
} = await import("@/api/features/auth/auth.service");

describe("auth.service", () => {
  beforeEach(() => {
    resetPrismaMocks();
  });

  describe("getUserByEmail", () => {
    test("returns user when found", async () => {
      mockFindFirst.mockResolvedValueOnce(mockUser);

      const result = await getUserByEmail("test@example.com");

      // The person, as the schema stores them since issue #756 (tests/utils/prisma-mock.ts).
      expect(result).toEqual(asPersonRow(mockUser));
      expect(mockFindFirst).toHaveBeenCalledTimes(1);
    });

    test("returns null when user not found", async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const result = await getUserByEmail("nonexistent@example.com");

      expect(result).toBeNull();
    });

    test("trims and searches case-insensitively", async () => {
      mockFindFirst.mockResolvedValueOnce(mockUser);

      await getUserByEmail("  TEST@EXAMPLE.COM  ");

      expect(mockFindFirst).toHaveBeenCalledWith({
        where: { email: { equals: "TEST@EXAMPLE.COM", mode: "insensitive" } },
        // The person and every membership (issue #756).
        select: {
          id: true,
          email: true,
          name: true,
          googleId: true,
          isSuperAdmin: true,
          memberships: {
            select: { tenantId: true, role: true, createdAt: true },
          },
          passwordHash: true,
          lastLoginAt: true,
        },
      });
    });
  });

  describe("createUser", () => {
    test("creates user with trimmed lowercase email and AGENT role by default", async () => {
      const createdUser = { ...mockUser, email: "new@example.com" };
      mockCreate.mockResolvedValueOnce(createdUser);

      const result = await createUser(
        "  NEW@EXAMPLE.COM  ",
        "hashedPassword",
        BigInt(1),
      );

      expect(result).toEqual({
        ...createdUser,
        memberships: asPersonRow(createdUser).memberships,
      });
      // The person and their first membership, in one statement (issue #756).
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            email: "new@example.com",
            passwordHash: "hashedPassword",
            memberships: { create: { tenantId: BigInt(1), role: "AGENT" } },
          },
        }),
      );
    });

    test("never grants an elevated role on password signup even when domain matches", async () => {
      const original = [...config.adminSignupDomains];
      config.adminSignupDomains = ["mycompany.io"];
      try {
        mockCreate.mockResolvedValueOnce(mockUser);
        await createUser("founder@mycompany.io", "hashedPassword", BigInt(1));
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            data: {
              email: "founder@mycompany.io",
              passwordHash: "hashedPassword",
              memberships: { create: { tenantId: BigInt(1), role: "AGENT" } },
            },
          }),
        );
      } finally {
        config.adminSignupDomains = original;
      }
    });

    test("requests sanitized projection without passwordHash", async () => {
      mockCreate.mockResolvedValueOnce(mockUser);
      await createUser("test@example.com", "hashedPassword", BigInt(1));
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          select: {
            id: true,
            email: true,
            name: true,
            googleId: true,
            isSuperAdmin: true,
            memberships: {
              select: { tenantId: true, role: true, createdAt: true },
            },
          },
        }),
      );
    });
  });

  describe("createInitialAdmin", () => {
    test("creates the first account as SUPER_ADMIN (tenant_id NULL) with normalized email", async () => {
      mockCount.mockResolvedValueOnce(0);
      const admin = {
        ...mockUser,
        tenantId: null,
        role: "SUPER_ADMIN" as const,
      };
      mockCreate.mockResolvedValueOnce(admin);

      const result = await createInitialAdmin({
        email: "  Boss@Example.COM  ",
        passwordHash: "hashedPassword",
        name: "Boss",
      });

      expect(result.user.role).toBe("SUPER_ADMIN");
      // NOTE: an initial Tenant is created alongside the fleet admin and its id is returned.
      expect(mockTenantCreate).toHaveBeenCalled();
      expect(result.tenantId).toBe(BigInt(1));
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            email: "boss@example.com",
            passwordHash: "hashedPassword",
            name: "Boss",
            isSuperAdmin: true,
            // NOTE: stamped so the bootstrap admin is not blocked from Google
            // linking (never-logged-in elevated guard in google.service).
            lastLoginAt: expect.any(Date),
          },
        }),
      );
    });

    test("bypasses ALLOWED_SIGNUP_DOMAINS for the bootstrap admin", async () => {
      const original = [...config.allowedSignupDomains];
      config.allowedSignupDomains = ["allowed.com"];
      try {
        mockCount.mockResolvedValueOnce(0);
        mockCreate.mockResolvedValueOnce({
          ...mockUser,
          tenantId: null,
          role: "SUPER_ADMIN",
        });

        const result = await createInitialAdmin({
          email: "founder@other.io",
          passwordHash: "hashedPassword",
          name: null,
        });

        expect(result.user.role).toBe("SUPER_ADMIN");
        expect(mockCreate).toHaveBeenCalled();
      } finally {
        config.allowedSignupDomains = original;
      }
    });

    test("names the initial tenant after the company (slugified), not 'Default'", async () => {
      mockCount.mockResolvedValueOnce(0);
      mockCreate.mockResolvedValueOnce({
        ...mockUser,
        tenantId: null,
        role: "SUPER_ADMIN",
      });

      await createInitialAdmin({
        email: "boss@acme.com",
        passwordHash: "hashedPassword",
        name: "Boss",
        companyName: "  Açaí & Cia  ",
      });

      expect(mockTenantCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { name: "Açaí & Cia", slug: "acai-cia" },
        }),
      );
    });

    test("falls back to the 'Default' tenant when no company name is given", async () => {
      mockCount.mockResolvedValueOnce(0);
      mockCreate.mockResolvedValueOnce({
        ...mockUser,
        tenantId: null,
        role: "SUPER_ADMIN",
      });

      await createInitialAdmin({
        email: "boss@acme.com",
        passwordHash: "hashedPassword",
        name: "Boss",
      });

      expect(mockTenantCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { name: "Default", slug: "default" },
        }),
      );
    });

    test("throws SetupAlreadyCompleteError when a user already exists", async () => {
      mockCount.mockResolvedValueOnce(1);

      await expect(
        createInitialAdmin({
          email: "late@example.com",
          passwordHash: "hashedPassword",
          name: null,
        }),
      ).rejects.toBeInstanceOf(SetupAlreadyCompleteError);

      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("slugifyCompany", () => {
    test("strips diacritics, lowercases, and collapses non-alphanumerics", () => {
      expect(slugifyCompany("Açaí & Cia")).toBe("acai-cia");
      expect(slugifyCompany("Clínica São José")).toBe("clinica-sao-jose");
      expect(slugifyCompany("  Hello   World  ")).toBe("hello-world");
    });

    test("falls back to 'default' for empty/degenerate input", () => {
      expect(slugifyCompany("")).toBe("default");
      expect(slugifyCompany("!!!")).toBe("default");
      expect(slugifyCompany("   ")).toBe("default");
    });
  });

  describe("password change", () => {
    test("getUserHasPassword reflects whether a local password is set", async () => {
      mockFindUnique.mockResolvedValueOnce({ ...mockUser });
      expect(await getUserHasPassword(1n)).toBe(true);
      mockFindUnique.mockResolvedValueOnce({ ...mockUser, passwordHash: null });
      expect(await getUserHasPassword(1n)).toBe(false);
    });

    test("changeUserPassword refuses a Google-only account", async () => {
      mockFindUnique.mockResolvedValueOnce({ ...mockUser, passwordHash: null });
      await expect(
        changeUserPassword(1n, "whatever", "new-password-123"),
      ).rejects.toBeInstanceOf(NoPasswordSetError);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test("changeUserPassword rejects a wrong current password", async () => {
      const hash = await hashPassword("correct-horse");
      mockFindUnique.mockResolvedValueOnce({ ...mockUser, passwordHash: hash });
      await expect(
        changeUserPassword(1n, "wrong-guess", "new-password-123"),
      ).rejects.toBeInstanceOf(IncorrectPasswordError);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    test("changeUserPassword stores a new hash when the current matches", async () => {
      const hash = await hashPassword("correct-horse");
      mockFindUnique.mockResolvedValueOnce({ ...mockUser, passwordHash: hash });
      await changeUserPassword(1n, "correct-horse", "new-password-123");
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe("getSignupRoleForEmail", () => {
    const originalAdmin = [...config.adminSignupDomains];

    beforeEach(() => {
      config.adminSignupDomains = [...originalAdmin];
    });

    afterEach(() => {
      config.adminSignupDomains = [...originalAdmin];
    });

    test("returns AGENT when adminSignupDomains is empty", () => {
      config.adminSignupDomains = [];
      expect(getSignupRoleForEmail("anyone@anywhere.com", true)).toBe("AGENT");
    });

    test("returns TENANT_ADMIN when domain matches and email is verified", () => {
      config.adminSignupDomains = ["mycompany.io"];
      expect(getSignupRoleForEmail("founder@mycompany.io", true)).toBe(
        "TENANT_ADMIN",
      );
    });

    test("never returns an elevated role when email is not verified", () => {
      config.adminSignupDomains = ["mycompany.io"];
      expect(getSignupRoleForEmail("founder@mycompany.io", false)).toBe(
        "AGENT",
      );
    });

    test("returns AGENT when domain does not match", () => {
      config.adminSignupDomains = ["mycompany.io"];
      expect(getSignupRoleForEmail("user@other.com", true)).toBe("AGENT");
    });

    test("matches case-insensitively", () => {
      config.adminSignupDomains = ["mycompany.io"];
      expect(getSignupRoleForEmail("Founder@MyCompany.IO", true)).toBe(
        "TENANT_ADMIN",
      );
    });
  });

  describe("hashPassword", () => {
    test("hashes a password using bcrypt", async () => {
      const password = "securePassword123";
      const hash = await hashPassword(password);

      expect(hash).toBeDefined();
      expect(hash).not.toBe(password);
      expect(hash).toMatch(/^\$2[aby]?\$/);
    });

    test("produces different hashes for the same password (salt)", async () => {
      const password = "securePassword123";
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("isEmailDomainAllowed", () => {
    const originalAllowed = [...config.allowedSignupDomains];

    beforeEach(() => {
      config.allowedSignupDomains = [...originalAllowed];
    });

    afterEach(() => {
      config.allowedSignupDomains = [...originalAllowed];
    });

    test("allows any domain when allowlist is empty", () => {
      config.allowedSignupDomains = [];
      expect(isEmailDomainAllowed("user@anything.com")).toBe(true);
      expect(isEmailDomainAllowed("user@example.io")).toBe(true);
    });

    test("allows only listed domains when allowlist is set", () => {
      config.allowedSignupDomains = ["example.com", "acme.io"];
      expect(isEmailDomainAllowed("user@example.com")).toBe(true);
      expect(isEmailDomainAllowed("user@acme.io")).toBe(true);
      expect(isEmailDomainAllowed("user@other.com")).toBe(false);
    });

    test("matches case-insensitively and trims input", () => {
      config.allowedSignupDomains = ["example.com"];
      expect(isEmailDomainAllowed("  User@EXAMPLE.COM  ")).toBe(true);
    });

    test("rejects malformed emails when allowlist is set", () => {
      config.allowedSignupDomains = ["example.com"];
      expect(isEmailDomainAllowed("not-an-email")).toBe(false);
    });
  });

  describe("verifyPassword", () => {
    test("returns true for matching password and hash", async () => {
      const password = "securePassword123";
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(password, hash);

      expect(isValid).toBe(true);
    });

    test("returns false for non-matching password", async () => {
      const password = "securePassword123";
      const wrongPassword = "wrongPassword456";
      const hash = await hashPassword(password);

      const isValid = await verifyPassword(wrongPassword, hash);

      expect(isValid).toBe(false);
    });

    test("returns false for empty password", async () => {
      const password = "securePassword123";
      const hash = await hashPassword(password);

      const isValid = await verifyPassword("", hash);

      expect(isValid).toBe(false);
    });
  });
});
