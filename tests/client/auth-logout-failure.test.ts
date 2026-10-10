/// <reference lib="dom" />

// A logout that failed is not a logout. The session cookie is HttpOnly, so only the response to
// `POST /auth/logout` can end it; clearing the console's user without that response shows the login
// screen while the session is live, and on a shared device a reload brings it back.
// The rule is a function, not a rendered provider: `mock.module` replaces a module for the whole
// test PROCESS, so another file's stub of `@/client/contexts/AuthContext` would answer here, and
// stubbing `@/client/lib/api` would break other files the same way.

import { describe, expect, it } from "bun:test";
import { afterLogout, performLogout } from "@/client/lib/logout";
import { codeOnly } from "@/tests/utils/source-text";

describe("logging out", () => {
  it("ends the session when the server answered", async () => {
    let ended = false;
    const ok = await performLogout(
      async () => ({}),
      () => {
        ended = true;
      },
    );
    expect(ended).toBe(true);
    expect(ok).toBe(true);
  });

  // NOTE: the common failure: the treaty reports a transport failure as a VALUE (`{ data: null,
  // error }`) rather than raising, so an `await` followed by a clear inside a `catch` clears anyway.
  it("keeps the session when the answer carries an error", async () => {
    let ended = false;
    const ok = await performLogout(
      async () => ({ error: new Error("network") }),
      () => {
        ended = true;
      },
    );
    expect(ended).toBe(false);
    expect(ok).toBe(false);
  });

  it("keeps the session when the call throws outright", async () => {
    let ended = false;
    const ok = await performLogout(
      async () => {
        throw new Error("boom");
      },
      () => {
        ended = true;
      },
    );
    expect(ended).toBe(false);
    expect(ok).toBe(false);
  });
});

// And what the two buttons do with that answer is one decision, tested as one. Neither caller can
// be rendered in this suite (the same `mock.module` problem), and an `if` written at each call site
// survives any source fence, e.g. `if (!ended && false)`.
describe("what the callers do with the answer", () => {
  it("goes where it was going once the session ended", () => {
    const done: string[] = [];
    afterLogout(
      true,
      () => done.push("go"),
      () => done.push("warn"),
    );
    expect(done).toEqual(["go"]);
  });

  it("says so instead of going anywhere when it did not", () => {
    const done: string[] = [];
    afterLogout(
      false,
      () => done.push("go"),
      () => done.push("warn"),
    );
    expect(done).toEqual(["warn"]);
  });

  // NOTE: BOTH buttons go through that decision, which the value alone cannot answer for: a caller
  // that navigates on its own would reopen the bug at that site.
  it("is the decision both buttons make", async () => {
    for (const f of [
      "src/client/components/UserMenu.tsx",
      "src/client/pages/OAuthConsentPage.tsx",
    ]) {
      const src = codeOnly(await Bun.file(f).text());
      const from = src.indexOf("logout()");
      expect(from).toBeGreaterThan(-1);
      // Both ways from the call, because the menu passes the answer straight in
      // (`afterLogout(await logout(), …)`) while the consent page waits on the promise first.
      const handler = src.slice(Math.max(0, from - 400), from + 700);
      expect(handler).toInclude("afterLogout(");
      // NOTE: a `finally` would navigate on every resolution, which is what the answer exists to
      // stop.
      expect(handler).not.toInclude("finally");
    }
  });
});
