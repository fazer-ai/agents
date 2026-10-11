import { beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "@/lib/errors";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// Step-up is a property of the SESSION, and a Bearer API key has none: a key minted under a step-up
// (`stepUpAt`) answers it by itself, rather than with its creator's password, which would tie the
// automation to a person. A key with no step-up on record answers with its creator's password. The
// rule is in docs/api-and-fleet.md, "Step-up is a property of the session".

setupPrismaMock();
const { confirmStepUp, requireSession } = await import("@/api/lib/step-up");

const HASH = await Bun.password.hash("s3cret");
const session = (
  overrides: Partial<Parameters<typeof confirmStepUp>[0]> = {},
) => ({ userId: 1n, actorType: "user" as const, ...overrides });

describe("confirmStepUp", () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({ ...mockUser, passwordHash: HASH }),
    );
  });

  test("a session with the right password passes", async () => {
    await expect(confirmStepUp(session(), "s3cret")).resolves.toBeUndefined();
    expect(mockFindUnique).toHaveBeenCalledTimes(1);
  });

  test("a session with the wrong password is refused as incorrect (403)", async () => {
    const err = await confirmStepUp(session(), "nope").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(403);
    expect((err as AppError).translationKey).toBe("errors.invalidPassword");
  });

  // Missing is not incorrect: the field is optional on the wire, so a session that omits it gets a
  // sentence naming what is missing rather than a schema 422.
  test("a session without a password is refused as required (400), before any lookup", async () => {
    for (const absent of [undefined, ""]) {
      const err = await confirmStepUp(session(), absent).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(400);
      expect((err as AppError).translationKey).toBe("errors.passwordRequired");
    }
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  test("a session whose account has no password (Google-only) cannot step up", async () => {
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({ ...mockUser, passwordHash: null }),
    );
    const err = await confirmStepUp(session(), "s3cret").catch((e) => e);
    expect((err as AppError).translationKey).toBe("errors.invalidPassword");
  });

  test("a session with no user behind it cannot step up", async () => {
    const err = await confirmStepUp(session({ userId: null }), "s3cret").catch(
      (e) => e,
    );
    expect((err as AppError).statusCode).toBe(403);
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  test("a key minted under step-up passes with no password and no lookup; a password it sends is not read", async () => {
    const key = session({ actorType: "api_key", stepUpAt: new Date() });
    await expect(confirmStepUp(key, undefined)).resolves.toBeUndefined();
    // The creator's password is NOT what such a key proves: even a wrong one changes nothing.
    await expect(confirmStepUp(key, "wrong")).resolves.toBeUndefined();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  // A key with no step-up on record answers with its creator's password (`userId` names the creator
  // for a key), so nothing it could do is refused and nothing it could not do is allowed. Absent is
  // the same as null.
  test("a key minted before the rule (no step-up on record) still answers with its creator's password", async () => {
    for (const legacy of [
      session({ actorType: "api_key", stepUpAt: null }),
      session({ actorType: "api_key" }),
    ]) {
      const missing = await confirmStepUp(legacy, undefined).catch((e) => e);
      expect((missing as AppError).statusCode).toBe(400);
      expect((missing as AppError).translationKey).toBe(
        "errors.passwordRequired",
      );
      const wrong = await confirmStepUp(legacy, "nope").catch((e) => e);
      expect((wrong as AppError).statusCode).toBe(403);
      expect((wrong as AppError).translationKey).toBe("errors.invalidPassword");
      await expect(confirmStepUp(legacy, "s3cret")).resolves.toBeUndefined();
    }
  });
});

// A key never mints a credential that outlives it: the routes that mint one refuse
// a key outright, in either spelling the two boundaries use for "this is a key".
describe("requireSession", () => {
  test("a session passes, in both shapes", () => {
    expect(() => requireSession({})).not.toThrow();
    expect(() => requireSession({ actorType: "user" })).not.toThrow();
    expect(() => requireSession({ isApiKey: false })).not.toThrow();
    expect(() => requireSession({ actorType: "mcp" })).not.toThrow();
  });

  test("a key is refused, in both shapes, with the sentence the console can show", () => {
    for (const key of [{ actorType: "api_key" as const }, { isApiKey: true }]) {
      const err = (() => {
        try {
          requireSession(key);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(403);
      expect((err as AppError).translationKey).toBe(
        "errors.apiKeyRequiresSession",
      );
    }
  });
});
