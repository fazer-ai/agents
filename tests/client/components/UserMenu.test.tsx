/// <reference lib="dom" />

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { createTestI18n } from "@/tests/utils/i18n";

const mockLogout = mock(async () => {});
const mockSetTheme = mock((_: string) => {});

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { email: "admin@fazer.ai" },
    logout: mockLogout,
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@/client/contexts/ThemeContext", () => ({
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: mockSetTheme,
  }),
  useThemedAsset: (path: string) => ({ src: path }),
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

// A REAL i18next instance, held here so the language radio's effect can be read off it. See
// tests/utils/i18n.tsx: a registry stub of `react-i18next` used to live here, and the `i18n` it
// handed back was a literal `{ language: "en" }` that every file running afterwards imported.
const i18n = createTestI18n();
const changeLanguage = spyOn(i18n, "changeLanguage");

import { I18nextProvider } from "react-i18next";
import { UserMenu } from "@/client/components/UserMenu";

function renderMenu() {
  return render(
    <I18nextProvider i18n={i18n}>
      <TooltipPrimitive.Provider>
        <MemoryRouter initialEntries={["/"]}>
          <Routes>
            <Route path="/" element={<UserMenu />} />
            <Route path="/login" element={<div>LOGIN_PAGE_MARKER</div>} />
            <Route path="/settings" element={<div>SETTINGS_PAGE_MARKER</div>} />
          </Routes>
        </MemoryRouter>
      </TooltipPrimitive.Provider>
    </I18nextProvider>,
  );
}

function openDropdown() {
  const trigger = screen.getByRole("button", { name: /admin@fazer\.ai/i });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  return trigger;
}

describe("UserMenu", () => {
  beforeEach(() => {
    mockLogout.mockClear();
    mockSetTheme.mockClear();
    changeLanguage.mockClear();
  });

  afterEach(() => cleanup());

  test("renders trigger with user email as accessible name", () => {
    renderMenu();
    expect(
      screen.getByRole("button", { name: /admin@fazer\.ai/i }),
    ).toBeInTheDocument();
  });

  test("opens dropdown with theme and language groups", () => {
    renderMenu();
    openDropdown();
    expect(screen.getByText(/^theme$/i)).toBeInTheDocument();
    expect(screen.getByText(/^language$/i)).toBeInTheDocument();
    expect(screen.getAllByRole("menuitemradio").length).toBeGreaterThanOrEqual(
      4,
    );
  });

  test("selecting a theme radio calls setTheme", () => {
    renderMenu();
    openDropdown();
    const lightRadio = screen.getByRole("menuitemradio", { name: /light/i });
    fireEvent.click(lightRadio);
    expect(mockSetTheme).toHaveBeenCalledWith("light");
  });

  test("selecting a language radio calls i18n.changeLanguage", () => {
    renderMenu();
    openDropdown();
    const ptRadio = screen.getByRole("menuitemradio", { name: /português/i });
    fireEvent.click(ptRadio);
    expect(changeLanguage).toHaveBeenCalledWith("pt-BR");
  });

  test("Settings menuitem navigates to /settings", () => {
    renderMenu();
    openDropdown();
    const settingsItem = screen.getByRole("menuitem", { name: /settings/i });
    fireEvent.click(settingsItem);
    expect(screen.getByText("SETTINGS_PAGE_MARKER")).toBeInTheDocument();
  });

  test("logout menuitem calls logout and navigates to /login", async () => {
    renderMenu();
    openDropdown();
    const logoutItem = screen.getByRole("menuitem", { name: /logout/i });
    await act(async () => {
      fireEvent.click(logoutItem);
      await Promise.resolve();
    });
    expect(mockLogout).toHaveBeenCalledTimes(1);
    expect(screen.getByText("LOGIN_PAGE_MARKER")).toBeInTheDocument();
  });

  test("navigates to /login even if logout rejects", async () => {
    mockLogout.mockImplementationOnce(async () => {
      throw new Error("network");
    });
    renderMenu();
    openDropdown();
    const logoutItem = screen.getByRole("menuitem", { name: /logout/i });
    await act(async () => {
      fireEvent.click(logoutItem);
      await Promise.resolve();
    });
    expect(screen.getByText("LOGIN_PAGE_MARKER")).toBeInTheDocument();
  });
});
