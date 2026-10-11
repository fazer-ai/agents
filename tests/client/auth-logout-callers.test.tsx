/// <reference lib="dom" />

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { withI18n } from "../utils/i18n";

// Both logout buttons, rendered: the user menu and the consent page's "use another account". Each
// leaves the page only once the server answered the logout; a failed one stays where it is and says
// so, because `/login` would send a still-signed-in operator straight back.

const { UserMenu } = await import("@/client/components/UserMenu");
const { OAuthConsentPage } = await import("@/client/pages/OAuthConsentPage");
const { ToastProvider } = await import("@/client/components/Toast");
const { AuthProvider } = await import("@/client/contexts/AuthContext");
const { ThemeProvider } = await import("@/client/contexts/ThemeContext");

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const USER = {
  id: "7",
  email: "ana@example.com",
  name: "Ana",
  role: "TENANT_ADMIN",
  tenantId: "1",
  tenantName: "Loja",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function serve(logoutStatus: number): { loggedOut: () => boolean } {
  let out = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://localhost",
    );
    if (url.pathname === "/api/auth/me") {
      return json({ user: out ? null : USER });
    }
    if (url.pathname === "/api/auth/logout") {
      if (logoutStatus === 200) out = true;
      return json(
        logoutStatus === 200 ? { ok: true } : { error: "down" },
        logoutStatus,
      );
    }
    if (url.pathname.startsWith("/api/v1/mcp/oauth/consent")) {
      return json({
        client: { name: "Claude", logoUri: null },
        scopes: ["mcp:read"],
        tenant: { id: "1", name: "Loja" },
        user: { email: USER.email },
      });
    }
    return json({ error: "not stubbed" }, 404);
  }) as unknown as typeof fetch;
  return { loggedOut: () => out };
}

function renderAt(path: string, element: React.ReactNode) {
  render(
    withI18n(
      <ThemeProvider>
        <AuthProvider>
          <ToastProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path={path.split("?")[0]} element={element} />
                <Route path="/login" element={<p>login screen</p>} />
              </Routes>
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </ThemeProvider>,
    ),
  );
}

async function logOutFromTheMenu() {
  renderAt("/agents", <UserMenu />);
  const trigger = await screen.findByRole("button", { name: /Ana/ });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByText("Logout"));
}

async function switchAccountOnConsent() {
  renderAt("/oauth/consent?req=abc", <OAuthConsentPage />);
  fireEvent.click(await screen.findByText(/Not you\? Use another account/));
}

describe("the logout buttons", () => {
  for (const [where, press] of [
    ["the user menu", logOutFromTheMenu],
    ["the consent page", switchAccountOnConsent],
  ] as const) {
    test(`${where} goes to the login screen once the session ended`, async () => {
      const server = serve(200);
      await press();
      await screen.findByText("login screen");
      expect(server.loggedOut()).toBe(true);
    });

    test(`${where} stays and says so when the logout failed`, async () => {
      serve(500);
      // The failed logout is reported on the console by design; kept off the test output.
      const quiet = spyOn(console, "error").mockImplementation(() => {});
      try {
        await press();
        await screen.findByText("Could not sign you out. Please try again.");
        // A navigation renders in a transition, after the toast: flushed before asking for absence.
        await act(async () => {});
        expect(screen.queryAllByText("login screen").length).toBe(0);
      } finally {
        quiet.mockRestore();
      }
    });
  }
});
