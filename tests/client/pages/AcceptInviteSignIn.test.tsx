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
    signedInAs = null;
    logoutAnswer = true;
    logouts = 0;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
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

  test("back on the page, the parked invitation is read once and cleared", async () => {
    sessionStorage.setItem(PARKED, "tok-756");
    renderAt("/accept-invite");
    await waitFor(() => {
      expect(inviteQueries.join(",")).toBe("tok-756");
    });
    expect(sessionStorage.getItem(PARKED)).toBeNull();
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
