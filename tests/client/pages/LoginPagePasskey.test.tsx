/// <reference lib="dom" />

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import * as AuthModule from "@/client/contexts/AuthContext";
import * as ThemeModule from "@/client/contexts/ThemeContext";
import * as PasskeyModule from "@/client/lib/passkey";
import { withI18n } from "@/tests/utils/i18n";
import { stubExports } from "@/tests/utils/module-stub";

// The passkey ways into /login follow PASSKEYS_ENABLED as /auth/me reports it: off, the page shows no
// passkey button and does not ask the browser for passkey suggestions; on, both are there, and a
// password attempt stops the background request and starts it again when it fails.
//
// Assertions reduce to strings/booleans before expect; a DOM node in a failing expectation
// serializes a cyclic happy-dom tree and stalls the runner.

let passkeysEnabled = false;
let signupEnabled = false;
const loggedIn: string[] = [];
stubExports(AuthModule, {
  useAuth: () => ({
    user: null,
    login: (u: { email: string }) => loggedIn.push(u.email),
    providers: {},
    signupEnabled,
    passkeysEnabled,
  }),
});

stubExports(ThemeModule, {
  useThemedAsset: (path: string) => ({ src: path }),
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
  }),
});

let autofillStarts = 0;
let autofillStops = 0;
let buttonSignIns = 0;
let buttonSignal: AbortSignal | undefined;
let buttonResult: Promise<unknown> | null = null;
stubExports(PasskeyModule, {
  passkeysSupported: () => true,
  passkeyAutofillSupported: async () => true,
  passkeyAutofill: () => {
    autofillStarts += 1;
    return {
      run: () => new Promise<never>(() => {}),
      stop: () => {
        autofillStops += 1;
      },
    };
  },
  signInWithPasskey: async (signal?: AbortSignal) => {
    buttonSignIns += 1;
    buttonSignal = signal;
    if (buttonResult) return buttonResult;
    return {
      id: "1",
      email: "p@x.test",
      name: null,
      role: "AGENT",
      tenantId: "1",
    };
  },
});

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/api/auth/login")) {
    return new Response(
      JSON.stringify({ error: "Invalid email or password" }),
      {
        status: 401,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return realFetch(input as RequestInfo | URL, init);
}) as typeof fetch;

const { ToastProvider } = await import("@/client/components");
const { LoginPage } = await import("@/client/pages/LoginPage");

function renderLogin() {
  return render(
    withI18n(
      <ToastProvider>
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<p>home</p>} />
            <Route path="/signup" element={<p>signup</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    ),
  );
}

const passkeyButton = () =>
  screen.queryByRole("button", { name: "Sign in with a passkey" }) !== null;
const emailAutocomplete = () =>
  (document.getElementById("email") as HTMLInputElement | null)?.getAttribute(
    "autocomplete",
  ) ?? null;

beforeEach(() => {
  loggedIn.length = 0;
  autofillStarts = 0;
  autofillStops = 0;
  buttonSignIns = 0;
  buttonSignal = undefined;
  buttonResult = null;
  signupEnabled = false;
});
afterEach(() => cleanup());
afterAll(() => {
  globalThis.fetch = realFetch;
});

test("with passkeys off, /login has no passkey button and asks for no suggestions", async () => {
  passkeysEnabled = false;
  renderLogin();
  await new Promise((r) => setTimeout(r, 20));
  expect(passkeyButton()).toBe(false);
  expect(emailAutocomplete()).toBe(null);
  expect(autofillStarts).toBe(0);
});

test("with passkeys on, the button and the email field's suggestions are there", async () => {
  passkeysEnabled = true;
  renderLogin();
  expect(passkeyButton()).toBe(true);
  expect(emailAutocomplete()).toBe("username webauthn");
  await waitFor(() => expect(autofillStarts).toBe(1));
});

test("the button signs in and leaves /login", async () => {
  passkeysEnabled = true;
  renderLogin();
  await waitFor(() => expect(autofillStarts).toBe(1));
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in with a passkey" }),
  );
  await waitFor(() => expect(loggedIn.join()).toBe("p@x.test"));
  expect(buttonSignIns).toBe(1);
  expect(autofillStops).toBe(1);
  expect(screen.queryByText("home") !== null).toBe(true);
});

test("a password attempt stops the background request and starts it again when it fails", async () => {
  passkeysEnabled = true;
  renderLogin();
  await waitFor(() => expect(autofillStarts).toBe(1));
  fireEvent.change(document.getElementById("email") as HTMLInputElement, {
    target: { value: "a@x.test" },
  });
  fireEvent.change(document.getElementById("password") as HTMLInputElement, {
    target: { value: "wrong-password" },
  });
  fireEvent.submit(
    (document.getElementById("email") as HTMLInputElement)
      .form as HTMLFormElement,
  );
  await waitFor(() => expect(autofillStarts).toBe(2));
  expect(autofillStops).toBe(1);
  expect(loggedIn.length).toBe(0);
});

test("leaving /login closes a pending passkey sign-in, and a late session does not navigate", async () => {
  passkeysEnabled = true;
  signupEnabled = true;
  let settle: (u: unknown) => void = () => {};
  buttonResult = new Promise((r) => {
    settle = r;
  });
  renderLogin();
  await waitFor(() => expect(autofillStarts).toBe(1));
  fireEvent.click(
    screen.getByRole("button", { name: "Sign in with a passkey" }),
  );
  await waitFor(() => expect(buttonSignIns).toBe(1));
  expect(buttonSignal?.aborted).toBe(false);
  fireEvent.click(screen.getByRole("link", { name: /sign up/i }));
  await waitFor(() => expect(screen.queryByText("signup") !== null).toBe(true));
  expect(buttonSignal?.aborted).toBe(true);
  settle({
    id: "1",
    email: "p@x.test",
    name: null,
    role: "AGENT",
    tenantId: "1",
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(loggedIn.join()).toBe("p@x.test");
  expect(screen.queryByText("signup") !== null).toBe(true);
  expect(screen.queryByText("home") !== null).toBe(false);
});
