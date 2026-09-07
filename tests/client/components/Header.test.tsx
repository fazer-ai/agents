/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

mock.module("@/client/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { email: "admin@fazer.ai" },
    logout: async () => {},
  }),
  AuthProvider: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@/client/contexts/ThemeContext", () => ({
  useThemedAsset: (path: string) => ({ src: path }),
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
  }),
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));

import { Header } from "@/client/components/Header";
import { ToastProvider } from "@/client/components/Toast";
import { SidebarProvider } from "@/client/contexts/SidebarContext";

function renderHeader(path = "/") {
  return render(
    // The account menu inside tells the operator when a logout did not end the session, and
    // `useToast` refuses to run outside its provider.
    <ToastProvider>
      <TooltipPrimitive.Provider>
        <MemoryRouter initialEntries={[path]}>
          <SidebarProvider>
            <Header />
          </SidebarProvider>
        </MemoryRouter>
      </TooltipPrimitive.Provider>
    </ToastProvider>,
  );
}

describe("Header", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  test("renders logo link", () => {
    renderHeader();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });

  test("marks logo with aria-current=page when on root", () => {
    renderHeader("/");
    expect(screen.getByRole("link")).toHaveAttribute("aria-current", "page");
  });

  test("does not mark logo aria-current when off root", () => {
    renderHeader("/admin");
    expect(screen.getByRole("link")).not.toHaveAttribute("aria-current");
  });

  test("renders account menu trigger with email as accessible name", () => {
    renderHeader();
    expect(
      screen.getByRole("button", { name: /admin@fazer\.ai/i }),
    ).toBeInTheDocument();
  });

  test("renders mobile open-menu button", () => {
    renderHeader();
    expect(
      screen.getByRole("button", { name: /open menu/i }),
    ).toBeInTheDocument();
  });
});
