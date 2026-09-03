import { beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "@/lib/errors";
import {
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";
import { countInSrc } from "@/tests/utils/source-text";

// Step-up is a property of the SESSION, and a Bearer API key has none (issue #308).
//
// Six routes re-ask the acting user's password before an irreversible act (minting a key is one of
// them, since the key answers every later step-up by itself). Each read that password
// against the row `ctx.userId` names, which for an API-key principal is the key's CREATOR: a machine
// holding the key could only pass by also holding a person's password, and that is the coupling the
// issue reports as "fragile by nature" (the password rotates, the person leaves, the automation
// breaks). The key is presented on every request and was itself minted under a step-up; there is
// nothing left for a password to prove, so the helper answers for the principal kind, once, and the
// routes stop spelling the check themselves.

setupPrismaMock();
const { confirmStepUp } = await import("@/api/lib/step-up");

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

  // Missing is not incorrect. Before the field became optional on the wire the schema answered 422
  // with no name for what was missing; a session that omits it now gets the sentence the console can
  // show.
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

  test("an API-key principal passes with no password and no lookup; a password it sends is not read", async () => {
    await expect(
      confirmStepUp(session({ actorType: "api_key" }), undefined),
    ).resolves.toBeUndefined();
    // The creator's password is NOT what a key proves: even a wrong one changes nothing.
    await expect(
      confirmStepUp(session({ actorType: "api_key" }), "wrong"),
    ).resolves.toBeUndefined();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  // The cookie session's `actorType` is absent (the tenancy boundary only stamps "api_key"); absent
  // is a session, never a key.
  test("an absent actorType is a session", async () => {
    const err = await confirmStepUp({ userId: 1n }, undefined).catch((e) => e);
    expect((err as AppError).translationKey).toBe("errors.passwordRequired");
  });
});

// The rule has one implementation. A route that spells `verifyPassword(` itself has decided, on
// its own, whether a key may pass — and it decided the old way, against the creator's row. The two
// legitimate callers are the definition and the login route, where a password IS the credential.
describe("every step-up goes through confirmStepUp", () => {
  test("verifyPassword( is called from the login route and the helper only", async () => {
    const found = await countInSrc(/\bverifyPassword\(/g);
    const allowed = new Set([
      "src/api/features/auth/auth.service.ts",
      "src/api/features/auth/auth.controller.ts",
      "src/api/lib/step-up.ts",
    ]);
    const strays = Object.keys(found).filter((f) => !allowed.has(f));
    expect(strays).toEqual([]);
    // Control: the sweep can see a call at all, or an empty stray list proves nothing.
    expect(found["src/api/lib/step-up.ts"]).toBe(1);
  });
});
