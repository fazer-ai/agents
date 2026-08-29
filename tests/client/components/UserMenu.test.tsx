/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const mockLogout = mock(async () => {});
const mockSetTheme = mock((_: string) => {});
const mockChangeLanguage = mock(async (_: string) => {});

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

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) => {
      const text = typeof fallback === "string" ? fallback : key;
      if (!vars) return text;
      return text.replace(/\{\{(\w+)\}\}/g, (m, name) =>
        name in vars ? String(vars[name]) : m,
      );
    },
    i18n: {
      language: "en",
      changeLanguage: mockChangeLanguage,
    },
  }),
}));

import { UserMenu } from "@/client/components/UserMenu";

function renderMenu() {
  return render(
    <TooltipPrimitive.Provider>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/" element={<UserMenu />} />
          <Route path="/login" element={<div>LOGIN_PAGE_MARKER</div>} />
          <Route path="/settings" element={<div>SETTINGS_PAGE_MARKER</div>} />
        </Routes>
      </MemoryRouter>
    </TooltipPrimitive.Provider>,
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
    mockChangeLanguage.mockClear();
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
    expect(mockChangeLanguage).toHaveBeenCalledWith("pt-BR");
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
