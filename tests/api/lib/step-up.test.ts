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
//
// "Minted under a step-up" is what the key carries (`stepUpAt`), not what its kind implies: a key
// that predates the rule was minted with no password anywhere, and it keeps answering the way every
// key did before, with its creator's password (review round 3).

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

  test("a key minted under step-up passes with no password and no lookup; a password it sends is not read", async () => {
    const key = session({ actorType: "api_key", stepUpAt: new Date() });
    await expect(confirmStepUp(key, undefined)).resolves.toBeUndefined();
    // The creator's password is NOT what such a key proves: even a wrong one changes nothing.
    await expect(confirmStepUp(key, "wrong")).resolves.toBeUndefined();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  // Review round 3 on #308: a key that predates the rule has no step-up to carry, so it answers
  // the way every key did before this change, with its creator's password (`userId` names the
  // creator for a key). Nothing it could do yesterday is refused, nothing it could not do is
  // allowed. Absent is the same as null: no step-up on record is no step-up.
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

  // The cookie session's `actorType` is absent (the tenancy boundary only stamps "api_key"); absent
  // is a session, never a key.
  test("an absent actorType is a session", async () => {
    const err = await confirmStepUp({ userId: 1n }, undefined).catch((e) => e);
    expect((err as AppError).translationKey).toBe("errors.passwordRequired");
  });
});

// A key never mints a credential that outlives it (review round 2): the routes that mint one refuse
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

  // The principal the helper reads is the one the boundary stamped (`stepUpAt` included). A route
  // that builds `{ userId, actorType }` by hand has dropped the step-up on record, and every key
  // reaching it, legacy or not, is asked the creator's password — or, with a different hand-built
  // shape, none is. One spelling at the AuthUser seam (`stepUpPrincipalOf`), the context elsewhere.
  test("every call site hands the helper the boundary's principal, never a hand-built one", async () => {
    const calls = await countInSrc(/\bconfirmStepUp\(/g);
    const whole = await countInSrc(
      /\bconfirmStepUp\(\s*(?:ctx\b|stepUpPrincipalOf\()/g,
    );
    const sites = Object.entries(calls).filter(
      ([file]) => file !== "src/api/lib/step-up.ts",
    );
    expect(sites.length).toBeGreaterThan(1);
    for (const [file, n] of sites) {
      expect([file, whole[file] ?? 0]).toEqual([file, n]);
    }
  });
});
