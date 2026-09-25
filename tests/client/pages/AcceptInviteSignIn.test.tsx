/// <reference lib="dom" />

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { withI18n } from "@/tests/utils/i18n";

// Review round 4 on #756: an invitation to an account that signs in with Google has no password to
// enter on the accept page. It offers signing in instead, and the invitation waits in the tab (never
// back on a URL) until the invitee returns to the page signed in.
//
// NOTE: assertions reduce to strings/booleans before expect; a DOM node in a failing expectation
// serializes a cyclic happy-dom tree and stalls the runner.

const PARKED = "@app:parked-invite";
const realFetch = globalThis.fetch;
const inviteQueries: string[] = [];
const accepted: string[] = [];

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/auth/invite")) {
    inviteQueries.push(
      new URL(url, "http://localhost").searchParams.get("token") ?? "",
    );
    return new Response(
      JSON.stringify({
        invite: { email: "g@x.test", role: "AGENT", existingAccount: true },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (url.includes("/auth/accept-invite")) {
    accepted.push(JSON.parse(String(init?.body ?? "{}")).token ?? "");
    return new Response(
      JSON.stringify({
        user: {
          id: "9",
          email: "g@x.test",
          role: "SUPER_ADMIN",
          tenantId: null,
        },
        joinedTenantId: "20",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return realFetch(input as RequestInfo | URL, init);
}) as typeof fetch;

let signedInAs: { email: string } | null = null;
let logoutAnswer = true;
let logouts = 0;
mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: signedInAs,
    login: () => {},
    logout: async () => {
      logouts += 1;
      if (logoutAnswer) signedInAs = null;
      return logoutAnswer;
    },
  }),
}));

const { AcceptInvitePage } = await import("@/client/pages/AcceptInvitePage");
// Accepting from a running session reloads onto the joined tenant; the test only needs it not to.
const realLocation = window.location;
Object.defineProperty(window, "location", {
  configurable: true,
  value: { ...window.location, assign: () => {} },
});
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");

let seenPath = "";
function PathProbe() {
  const l = useLocation();
  seenPath = l.pathname + l.search;
  return null;
}

function renderAt(entry: string) {
  return render(
    withI18n(
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <PathProbe />
          <Routes>
            <Route path="/accept-invite" element={<AcceptInvitePage />} />
            <Route path="/login" element={<div>login page</div>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>,
    ),
  );
}

describe("accepting an invitation by signing in", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.removeItem(PARKED);
    inviteQueries.length = 0;
    accepted.length = 0;
    signedInAs = null;
    logoutAnswer = true;
    logouts = 0;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: realLocation,
    });
  });

  test("parks the invitation in the tab and goes to sign in, with no token on the URL", async () => {
    renderAt("/accept-invite?token=tok-756");
    const button = await screen.findByText(
      "Sign in to this account instead (Google included)",
    );
    fireEvent.click(button);
    await waitFor(() => {
      expect(seenPath).toBe(
        `/login?redirect=${encodeURIComponent("/accept-invite")}`,
      );
    });
    expect(sessionStorage.getItem(PARKED)).toBe("tok-756");
  });

  // Review round 7: it stays parked through whatever reloads the sign-in takes, and goes only once the
  // invitation is accepted.
  test("back on the page, the parked invitation is read and kept until it is accepted", async () => {
    sessionStorage.setItem(PARKED, "tok-756");
    signedInAs = { email: "g@x.test" };
    renderAt("/accept-invite");
    await waitFor(() => {
      expect(inviteQueries.join(",")).toBe("tok-756");
    });
    expect(sessionStorage.getItem(PARKED)).toBe("tok-756");
    fireEvent.click(await screen.findByText("Join"));
    await waitFor(() => {
      expect(accepted.join(",")).toBe("tok-756");
    });
    await waitFor(() => {
      expect(sessionStorage.getItem(PARKED)).toBeNull();
    });
    // A fleet administrator's session names no tenant; the console opens on the one just joined.
    expect(sessionStorage.getItem("@app:active-tenant")).toBe("20");
    sessionStorage.removeItem("@app:active-tenant");
    localStorage.removeItem("@app:active-tenant");
  });

  // Signed in as somebody else, the login page would bounce straight back: that session ends first,
  // and a logout the server did not confirm goes nowhere.
  test("signed in as somebody else, signs that session out before going to sign in", async () => {
    signedInAs = { email: "other@x.test" };
    renderAt("/accept-invite?token=tok-756");
    fireEvent.click(
      await screen.findByText(
        "Sign out and sign in to this account (Google included)",
      ),
    );
    await waitFor(() => {
      expect(seenPath.startsWith("/login")).toBe(true);
    });
    expect(logouts).toBe(1);
    expect(sessionStorage.getItem(PARKED)).toBe("tok-756");
  });

  test("a sign-out that failed stays on the invitation", async () => {
    signedInAs = { email: "other@x.test" };
    logoutAnswer = false;
    renderAt("/accept-invite?token=tok-756");
    fireEvent.click(
      await screen.findByText(
        "Sign out and sign in to this account (Google included)",
      ),
    );
    await waitFor(() => {
      expect(logouts).toBe(1);
    });
    expect(seenPath.startsWith("/accept-invite")).toBe(true);
  });
});
