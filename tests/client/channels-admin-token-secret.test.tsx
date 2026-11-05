/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { ToastProvider } from "@/client/components";
import { AuthProvider } from "@/client/contexts/AuthContext";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import { ChannelsPage } from "@/client/pages/ChannelsPage";
import { withI18n } from "@/tests/utils/i18n";

// The Chatwoot admin token is masked, but it is not the operator's sign-in password: a password
// manager that treats it as one offers to fill it with the console password and to save the token
// as that password.

const realFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
});

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });

function serve(connected: boolean) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/auth/me")
      return json({
        user: { id: "u1", email: "a@b.c", role: "SUPER_ADMIN", tenantId: null },
      });
    if (path === "/api/v1/chatwoot/deployment")
      return json(
        connected
          ? {
              deployment: { baseUrl: "https://chat.example.com" },
              accounts: [],
            }
          : { deployment: null, accounts: [] },
      );
    if (path === "/api/v1/chatwoot/inboxes") return json({ inboxes: [] });
    if (path === "/api/v1/chatwoot/inboxes/bot-status")
      return json({ statuses: {}, observerStatuses: {} });
    if (path === "/api/v1/agents") return json({ agents: [], total: 0 });
    return json({});
  }) as unknown as typeof fetch;
}

function renderPage() {
  render(
    withI18n(
      <MemoryRouter>
        <ThemeProvider>
          <AuthProvider>
            <ToastProvider>
              <TooltipPrimitive.Provider>
                <ChannelsPage />
              </TooltipPrimitive.Provider>
            </ToastProvider>
          </AuthProvider>
        </ThemeProvider>
      </MemoryRouter>,
    ),
  );
}

const optsOut = (el: HTMLElement) => ({
  type: el.getAttribute("type"),
  autocomplete: el.getAttribute("autocomplete"),
  onePassword: el.getAttribute("data-1p-ignore"),
  lastPass: el.getAttribute("data-lpignore"),
  bitwarden: el.getAttribute("data-bwignore"),
  formType: el.getAttribute("data-form-type"),
});

const EXPECTED = {
  type: "password",
  autocomplete: "off",
  onePassword: "",
  lastPass: "true",
  bitwarden: "",
  formType: "other",
};

describe("the Chatwoot admin token box is not a password field for password managers", () => {
  test("in the connect dialog", async () => {
    serve(false);
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect instance" }),
    );
    const box = await screen.findByLabelText(/Admin access token/);
    expect(optsOut(box)).toEqual(EXPECTED);
  });

  test("in the edit-connection dialog", async () => {
    serve(true);
    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit connection" }),
    );
    const box = await screen.findByLabelText(/Admin access token/);
    expect(optsOut(box)).toEqual(EXPECTED);
  });
});
