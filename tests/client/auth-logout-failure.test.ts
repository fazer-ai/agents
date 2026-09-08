/// <reference lib="dom" />

// A LOGOUT THAT FAILED IS NOT A LOGOUT (#566, round 12 of review).
//
// The session cookie is HttpOnly, so the browser cannot end a session on its own: only the response
// to `POST /auth/logout` carries the `Set-Cookie` that does. A request that did not get one leaves
// the operator signed in on the server, and clearing the console's user anyway shows them the login
// screen while their session is live. On a shared device that is the failure that matters, and a
// reload brings the session back for whoever is sitting there.
//
// The rule is a function rather than a rendered provider for two measured reasons. Another test file
// mocks `@/client/contexts/AuthContext` with `mock.module`, which replaces it for the whole test
// PROCESS, so a test that renders the real `AuthProvider` is handed that stub instead. And mocking
// `@/client/lib/api` the same way to fake the transport took 237 tests in other files down with it,
// for the same reason in the other direction.

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

  // THE COMMON FAILURE, and the one the old shape missed: the treaty reports a transport failure as
  // a VALUE. Measured against it with a fetcher that rejects, it answers `{ data: null, error }`
  // rather than raising, so an `await` followed by a clear, wrapped in a `catch`, cleared anyway.
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

  it("does not let the failure escape to the caller", async () => {
    // The button that calls this has nothing to do with a rejection, and an unhandled one in an
    // onClick is a console error the operator cannot act on. It comes back as an ANSWER instead,
    // which is the half round 15 found missing: both callers navigated to `/login` on any
    // resolution, and `LoginPage` sends a still-signed-in visitor back to `redirectTo` — so a failed
    // logout cost the operator their route, and "Switch account" did nothing, silently.
    expect(
      performLogout(
        async () => {
          throw new Error("boom");
        },
        () => {},
      ),
    ).resolves.toBe(false);
  });
});

// AND WHAT THE TWO BUTTONS DO WITH THAT ANSWER IS ONE DECISION, tested as one. Neither caller can
// be rendered in this suite (the same `mock.module` on `@/client/contexts/AuthContext` that put the
// rule above in a function), and a mutation of an `if` written at each call site survives anything a
// source fence can ask: the battery walked past one reading `if (!ended && false)`.
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

  // And BOTH buttons make it through that decision, which is the half the value cannot answer for:
  // a caller that navigates on its own is the finding coming back at the other site.
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
      // A `finally` is the shape that made the failure invisible: it navigates on every resolution,
      // which is exactly what the answer exists to stop.
      expect(handler).not.toInclude("finally");
    }
  });
});
