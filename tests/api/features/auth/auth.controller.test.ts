import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { treaty } from "@elysiajs/eden";
import { Elysia } from "elysia";
import config from "@/config";
import {
  mockCount,
  mockCreate,
  mockFindFirst,
  mockUser,
  resetPrismaMocks,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

setupPrismaMock();

// NOTE: Drive the real setup state machine via its exported helpers instead of
// mocking it: Bun's mock.module is process-global, so a partial mock here would
// leak into setup.service.test.ts (which needs the real module).
const { authController } = await import("@/api/features/auth/auth.controller");
const { completeSetup, initSetupState } = await import(
  "@/api/features/auth/setup.service"
);

const createTestClient = () => {
  const app = new Elysia().use(authController);
  return treaty(app);
};

describe("authController", () => {
  // NOTE: `config` is a process-global singleton imported across test files in
  // a single Bun process, so any mutation that escapes this file would leak to
  // others (order-dependent contamination). Snapshot once and restore on exit.
  const originalSignupEnabled = config.signupEnabled;
  const originalSetupTokenRequired = config.setupTokenRequired;

  beforeAll(() => {
    config.signupEnabled = true;
    config.setupTokenRequired = false;
  });

  afterAll(() => {
    config.signupEnabled = originalSignupEnabled;
    config.setupTokenRequired = originalSetupTokenRequired;
  });

  beforeEach(() => {
    resetPrismaMocks();
    // NOTE: Default to "setup done, signup open, no token needed" so the
    // existing happy-path tests pass the gates; tests override as needed.
    config.signupEnabled = true;
    config.setupTokenRequired = false;
    completeSetup();
  });

  describe("POST /auth/setup", () => {
    test("creates the initial admin and completes setup", async () => {
      await initSetupState(); // no users → setup required
      mockCount.mockResolvedValueOnce(0);
      mockCreate.mockResolvedValueOnce({
        ...mockUser,
        tenantId: null,
        role: "SUPER_ADMIN",
      });

      const api = createTestClient();
      const response = await api.auth.setup.post({
        email: "admin@example.com",
        password: "password123",
      });

      expect(response.status).toBe(200);
      expect(response.data?.user?.role).toBe("SUPER_ADMIN");
    });

    test("returns 409 when setup is already complete", async () => {
      // beforeEach already marked setup complete.
      const api = createTestClient();
      const response = await api.auth.setup.post({
        email: "admin@example.com",
        password: "password123",
      });

      expect(response.status).toBe(409);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("returns 401 for an invalid or missing setup token", async () => {
      config.setupTokenRequired = true;
      await initSetupState(); // generates a token we do not pass

      const api = createTestClient();
      const response = await api.auth.setup.post({
        email: "admin@example.com",
        password: "password123",
        token: "wrong-token",
      });

      expect(response.status).toBe(401);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("returns 409 when a concurrent request already created the admin", async () => {
      await initSetupState();
      // NOTE: createInitialAdmin sees a non-empty table under the advisory lock
      // and throws SetupAlreadyCompleteError.
      mockCount.mockResolvedValueOnce(1);

      const api = createTestClient();
      const response = await api.auth.setup.post({
        email: "admin@example.com",
        password: "password123",
      });

      expect(response.status).toBe(409);
    });

    test("validates password minimum length (returns 422)", async () => {
      await initSetupState();

      const api = createTestClient();
      const response = await api.auth.setup.post({
        email: "admin@example.com",
        password: "short",
      });

      expect(response.status).toBe(422);
    });
  });

  describe("POST /auth/signup", () => {
    test("creates a new user successfully", async () => {
      mockFindFirst.mockResolvedValueOnce(null);
      mockCreate.mockResolvedValueOnce(mockUser);

      const api = createTestClient();
      const response = await api.auth.signup.post({
        email: "newuser@example.com",
        password: "password123",
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty("user");
      expect(response.data?.user).toMatchObject({
        id: mockUser.id.toString(),
        email: mockUser.email,
        role: mockUser.role,
      });
    });

    test("returns 400 for duplicate email", async () => {
      mockFindFirst.mockResolvedValueOnce(mockUser);

      const api = createTestClient();
      const response = await api.auth.signup.post({
        email: "existing@example.com",
        password: "password123",
      });

      expect(response.status).toBe(400);
      expect(response.error?.value).toHaveProperty(
        "error",
        "Email already in use",
      );
      // And the input it is about. The signup form has two boxes and only one of them can be fixed,
      // so a sentence with no name sends the operator to guess (#320). Built by hand in the
      // controller rather than raised as an AppError, which is why `refusalBody` never sees it.
      expect(response.error?.value).toHaveProperty("field", "email");
    });

    test("validates email format (returns 422)", async () => {
      const api = createTestClient();
      const response = await api.auth.signup.post({
        email: "invalid-email",
        password: "password123",
      });

      expect(response.status).toBe(422);
    });

    test("validates password minimum length (returns 422)", async () => {
      const api = createTestClient();
      const response = await api.auth.signup.post({
        email: "test@example.com",
        password: "short",
      });

      expect(response.status).toBe(422);
    });

    test("returns 403 when public signup is disabled", async () => {
      config.signupEnabled = false;

      const api = createTestClient();
      const response = await api.auth.signup.post({
        email: "user@example.com",
        password: "password123",
      });

      expect(response.status).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    test("returns 403 while first-run setup is still pending", async () => {
      await initSetupState();

      const api = createTestClient();
      const response = await api.auth.signup.post({
        email: "user@example.com",
        password: "password123",
      });

      expect(response.status).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  describe("POST /auth/login", () => {
    test("logs in with valid credentials", async () => {
      const hashedPassword = await Bun.password.hash("password123", {
        algorithm: "bcrypt",
        cost: 4,
      });
      const userWithHash = { ...mockUser, passwordHash: hashedPassword };

      mockFindFirst.mockResolvedValueOnce(userWithHash);

      const api = createTestClient();
      const response = await api.auth.login.post({
        email: "test@example.com",
        password: "password123",
      });

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty("user");
      expect(response.data?.user?.email).toBe(mockUser.email);
    });

    test("returns 401 for non-existent user", async () => {
      mockFindFirst.mockResolvedValueOnce(null);

      const api = createTestClient();
      const response = await api.auth.login.post({
        email: "nonexistent@example.com",
        password: "password123",
      });

      expect(response.status).toBe(401);
      expect(response.error?.value).toHaveProperty(
        "error",
        "Invalid email or password",
      );
    });

    test("returns 401 for wrong password", async () => {
      const hashedPassword = await Bun.password.hash("correctpassword", {
        algorithm: "bcrypt",
        cost: 4,
      });
      const userWithHash = { ...mockUser, passwordHash: hashedPassword };

      mockFindFirst.mockResolvedValueOnce(userWithHash);

      const api = createTestClient();
      const response = await api.auth.login.post({
        email: "test@example.com",
        password: "wrongpassword",
      });

      expect(response.status).toBe(401);
      expect(response.error?.value).toHaveProperty(
        "error",
        "Invalid email or password",
      );
    });
  });

  describe("GET /auth/me", () => {
    test("returns null user and providers when not authenticated", async () => {
      const api = createTestClient();
      const response = await api.auth.me.get();

      expect(response.status).toBe(200);
      expect(response.data?.user).toBeNull();
      expect(response.data).toHaveProperty("providers");
    });

    test("exposes setup and signup flags", async () => {
      config.setupTokenRequired = true;
      config.signupEnabled = false;
      await initSetupState();

      const api = createTestClient();
      const response = await api.auth.me.get();

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        setupRequired: true,
        setupTokenRequired: true,
        signupEnabled: false,
      });
    });

    test("returns default flag values when setup is complete and signup is open", async () => {
      // NOTE: beforeEach already left us in this state (signupEnabled=true,
      // setupTokenRequired=false, completeSetup()); the assertion guards
      // against a future regression that ties the flags to the request user
      // or otherwise breaks the boot-state plumbing.
      const api = createTestClient();
      const response = await api.auth.me.get();

      expect(response.status).toBe(200);
      expect(response.data).toMatchObject({
        setupRequired: false,
        setupTokenRequired: false,
        signupEnabled: true,
      });
    });
  });

  describe("POST /auth/login with OAuth-only user", () => {
    test("returns 401 without leaking account type", async () => {
      const oauthOnlyUser = { ...mockUser, passwordHash: null };
      mockFindFirst.mockResolvedValueOnce(oauthOnlyUser);

      const api = createTestClient();
      const response = await api.auth.login.post({
        email: "test@example.com",
        password: "anypassword",
      });

      expect(response.status).toBe(401);
      expect(response.error?.value).toHaveProperty(
        "error",
        "Invalid email or password",
      );
    });
  });

  describe("POST /auth/logout", () => {
    test("logs out successfully", async () => {
      const api = createTestClient();
      const response = await api.auth.logout.post();

      expect(response.status).toBe(200);
      expect(response.data).toHaveProperty("success", true);
    });
  });
});
