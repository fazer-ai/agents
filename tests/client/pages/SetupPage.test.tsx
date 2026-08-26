/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

const mockLogin = mock((_: unknown) => {});
const mockRefresh = mock(async () => {});

let authState: {
  user: { email: string } | null;
  setupTokenRequired: boolean;
  login: typeof mockLogin;
  refresh: typeof mockRefresh;
};

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@/client/contexts/ThemeContext", () => ({
  useThemedAsset: (path: string) => ({ src: path }),
  // NOTE: `useTheme` is consumed transitively by the components barrel
  // (`@/client/components`) that SetupPage imports from, so the mock must
  // surface it even if SetupPage itself never reads the hook.
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
  }),
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
    i18n: { language: "en" },
  }),
  // NOTE: `SetupPage` imports from the `@/client/components` barrel, which
  // transitively pulls `@/client/lib/i18n.ts` and its top-level
  // `i18n.use(initReactI18next).init(...)`. Without this stub the file fails
  // to load on CI (different module-eval ordering than the dev box) with
  // `SyntaxError: Export named 'initReactI18next' not found`. Shape matches
  // the real export: `{ type: "3rdParty", init }`.
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const { SetupPage } = await import("@/client/pages/SetupPage");
const { ToastProvider } = await import("@/client/components/Toast");

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

// The provider is not decoration here: `useFieldRefusal` reaches for the global toast when the form
// it is holding for has left the screen, so a holder outside a ToastProvider is one that cannot keep
// its promise that exactly one channel fires. The app mounts every route inside one.
function renderAt(path: string) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/setup"
            element={
              <>
                <SetupPage />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe("SetupPage", () => {
  beforeEach(() => {
    authState = {
      user: null,
      setupTokenRequired: true,
      login: mockLogin,
      refresh: mockRefresh,
    };
    mockLogin.mockClear();
    mockRefresh.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("renders the token field when setupTokenRequired is true", () => {
    renderAt("/setup");
    expect(screen.getByLabelText("Setup token")).toBeDefined();
  });

  test("hides the token field when setupTokenRequired is false", () => {
    authState.setupTokenRequired = false;
    renderAt("/setup");
    expect(screen.queryByLabelText("Setup token")).toBeNull();
  });

  test("captures the ?token= query param and strips it from the URL", async () => {
    renderAt("/setup?token=abc123");

    // NOTE: The token is held in component state and shown in the field, but
    // the URL is cleaned on mount so it does not linger in history or in
    // Referer headers.
    const tokenInput = screen.getByLabelText("Setup token") as HTMLInputElement;
    expect(tokenInput.value).toBe("abc123");

    await waitFor(() => {
      expect(screen.getByTestId("location-search").textContent).toBe("");
    });
  });
});

test("a refusal about the hidden setup token is read out, not swallowed", async () => {
  // The token box is drawn only where enforcement is on, but a token captured from `?token=` is SENT
  // either way, and the route caps it at 256 characters. Declaring `token` unconditionally put the
  // server's sentence on a control this screen is not rendering, and `capture` — believing it had
  // placed it — kept the toast quiet. The button just stopped doing anything.
  authState.setupTokenRequired = false;
  const realFetch = globalThis.fetch;
  const reason = "The value sent in token is not valid.";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      (init?.method ?? "GET").toUpperCase() === "POST" &&
      url.includes("/setup")
    ) {
      return new Response(JSON.stringify({ error: reason, field: "token" }), {
        status: 422,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    renderAt("/setup?token=abc123");
    for (const [label, value] of [
      ["Company name", "ACME"],
      ["Name", "Ana"],
      ["Email", "ana@acme.co"],
      ["Password", "hunter2hunter2"],
      ["Confirm Password", "hunter2hunter2"],
    ] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Create admin account" }),
    );

    await waitFor(() => {
      expect(screen.queryAllByText(reason).length).toBeGreaterThan(0);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
