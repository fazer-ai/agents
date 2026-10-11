import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import logger from "@/api/lib/logger";
import config from "@/config";
import {
  mockFindFirst,
  mockUser,
  resetPrismaMocks,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

setupPrismaMock();

const {
  initSetupState,
  isSetupRequired,
  isSetupTokenRequired,
  refreshSetupState,
  verifySetupToken,
  completeSetup,
} = await import("@/api/features/auth/setup.service");

const originalSetupTokenRequired = config.setupTokenRequired;

describe("setup.service", () => {
  beforeEach(() => {
    resetPrismaMocks();
    config.setupTokenRequired = originalSetupTokenRequired;
  });

  // NOTE: beforeEach restores between tests, but if the last test in the
  // suite mutates the flag, that change would leak to whichever test file
  // Bun loads next in this process. afterAll guarantees the suite exits
  // with the original value regardless of which case ran last.
  afterAll(() => {
    config.setupTokenRequired = originalSetupTokenRequired;
  });

  test("marks setup complete when a user already exists", async () => {
    mockFindFirst.mockResolvedValueOnce({ ...mockUser });

    await initSetupState();

    expect(isSetupRequired()).toBe(false);
  });

  test("requires setup and rejects bad tokens when no users exist", async () => {
    config.setupTokenRequired = true;
    mockFindFirst.mockResolvedValueOnce(null);

    await initSetupState();

    expect(isSetupRequired()).toBe(true);
    expect(isSetupTokenRequired()).toBe(true);
    expect(verifySetupToken(undefined)).toBe(false);
    expect(verifySetupToken("not-the-token")).toBe(false);
  });

  test("accepts any token when token requirement is disabled", async () => {
    config.setupTokenRequired = false;
    mockFindFirst.mockResolvedValueOnce(null);

    await initSetupState();

    expect(isSetupRequired()).toBe(true);
    expect(isSetupTokenRequired()).toBe(false);
    expect(verifySetupToken(undefined)).toBe(true);
    expect(verifySetupToken("anything")).toBe(true);
  });

  test("completeSetup clears the pending state and invalidates the token", async () => {
    config.setupTokenRequired = true;
    mockFindFirst.mockResolvedValueOnce(null);
    await initSetupState();

    completeSetup();

    expect(isSetupRequired()).toBe(false);
    expect(verifySetupToken("anything")).toBe(false);
  });

  describe("refreshSetupState", () => {
    // Reset the module's in-memory state before each test via the
    // public helpers: initSetupState() with no users + token off seeds
    // (setupComplete=false, setupToken=null); then completeSetup() flips
    // setupComplete=true if a test wants the short-circuit baseline.
    const loggedToken = (info: { mock: { calls: unknown[][] } }) =>
      info.mock.calls
        .map((c) => /[?&]token=([\w-]+)/.exec(String(c[0]))?.[1])
        .find(Boolean);

    async function seedNoUsersNoToken() {
      const previous = config.setupTokenRequired;
      config.setupTokenRequired = false;
      mockFindFirst.mockResolvedValueOnce(null);
      await initSetupState();
      config.setupTokenRequired = previous;
    }

    test("short-circuits when setup is already complete", async () => {
      mockFindFirst.mockResolvedValueOnce({ ...mockUser });
      await initSetupState();
      expect(isSetupRequired()).toBe(false);
      const callsBefore = mockFindFirst.mock.calls.length;

      await refreshSetupState();

      expect(mockFindFirst.mock.calls.length).toBe(callsBefore);
    });

    test("self-heals a stale flag when the DB already has a user", async () => {
      await seedNoUsersNoToken();
      expect(isSetupRequired()).toBe(true);

      mockFindFirst.mockResolvedValueOnce({ ...mockUser });
      await refreshSetupState();

      expect(isSetupRequired()).toBe(false);
    });

    test("regenerates the setup token after a boot-time DB recovery (token required)", async () => {
      // NOTE: Models initSetupState() bailing on a transient DB outage:
      // setupComplete stays false and setupToken stays null. Without the
      // refresh-time regeneration, verifySetupToken would refuse every
      // token forever and the operator would be locked out until restart.
      await seedNoUsersNoToken();
      config.setupTokenRequired = true;
      mockFindFirst.mockResolvedValueOnce(null);

      const info = spyOn(logger, "info").mockImplementation(() => logger);
      try {
        await refreshSetupState();
        const token = loggedToken(info);
        expect(isSetupRequired()).toBe(true);
        expect(token).toBeString();
        // NOTE: the token the operator reads in the log is the one the gate accepts.
        expect(verifySetupToken(token)).toBe(true);
        expect(verifySetupToken("not-the-token")).toBe(false);
      } finally {
        info.mockRestore();
      }
    });

    test("does not generate a token when the token is not required", async () => {
      await seedNoUsersNoToken();
      config.setupTokenRequired = false;
      mockFindFirst.mockResolvedValueOnce(null);

      const info = spyOn(logger, "info").mockImplementation(() => logger);
      try {
        await refreshSetupState();
        expect(isSetupRequired()).toBe(true);
        expect(loggedToken(info)).toBeUndefined();
      } finally {
        info.mockRestore();
      }
    });
  });
});
