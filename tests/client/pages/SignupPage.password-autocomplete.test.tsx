/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import * as AuthModule from "@/client/contexts/AuthContext";
import * as ThemeModule from "@/client/contexts/ThemeContext";
import { withI18n } from "@/tests/utils/i18n";
import { stubExports } from "@/tests/utils/module-stub";

stubExports(AuthModule, {
  useAuth: () => ({
    user: null,
    login: () => {},
    providers: {},
    signupEnabled: true,
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

const { SignupPage } = await import("@/client/pages/SignupPage");
const { ToastProvider } = await import("@/client/components/Toast");

afterEach(() => cleanup());

test("signing up asks the password manager for a new password in both boxes", () => {
  render(
    withI18n(
      <ToastProvider>
        <MemoryRouter initialEntries={["/signup"]}>
          <Routes>
            <Route path="/signup" element={<SignupPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    ),
  );
  const boxes = [...document.querySelectorAll("input[type=password]")].map(
    (el) => `${el.id}:${el.getAttribute("autocomplete")}`,
  );
  expect(boxes).toEqual([
    "password:new-password",
    "confirmPassword:new-password",
  ]);
});
