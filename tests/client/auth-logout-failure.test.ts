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
import { performLogout } from "@/client/contexts/AuthContext";

describe("logging out", () => {
  it("ends the session when the server answered", async () => {
    let ended = false;
    await performLogout(
      async () => ({}),
      () => {
        ended = true;
      },
    );
    expect(ended).toBe(true);
  });

  // THE COMMON FAILURE, and the one the old shape missed: the treaty reports a transport failure as
  // a VALUE. Measured against it with a fetcher that rejects, it answers `{ data: null, error }`
  // rather than raising, so an `await` followed by a clear, wrapped in a `catch`, cleared anyway.
  it("keeps the session when the answer carries an error", async () => {
    let ended = false;
    await performLogout(
      async () => ({ error: new Error("network") }),
      () => {
        ended = true;
      },
    );
    expect(ended).toBe(false);
  });

  it("keeps the session when the call throws outright", async () => {
    let ended = false;
    await performLogout(
      async () => {
        throw new Error("boom");
      },
      () => {
        ended = true;
      },
    );
    expect(ended).toBe(false);
  });

  it("does not let the failure escape to the caller", async () => {
    // The button that calls this has nothing to do with a rejection, and an unhandled one in an
    // onClick is a console error the operator cannot act on.
    expect(
      performLogout(
        async () => {
          throw new Error("boom");
        },
        () => {},
      ),
    ).resolves.toBeUndefined();
  });
});
