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
import { MemoryRouter, Route, Routes } from "react-router";
import { createTestI18n } from "@/tests/utils/i18n";

const mockLogout = mock(async () => true);
const mockSetTheme = mock((_: string) => {});

stubExports(AuthModule, {
  useAuth: () => ({
    user: { email: "admin@fazer.ai" },
    logout: mockLogout,
  }),
});

stubExports(ThemeModule, {
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: mockSetTheme,
  }),
  useThemedAsset: (path: string) => ({ src: path }),
});

// A REAL i18next instance, held here so the language radio's effect can be read off it. Not a
// registry stub of `react-i18next`: that leaks into every file the worker runs afterwards (see
// tests/utils/i18n.tsx).
const i18n = createTestI18n();
const changeLanguage = spyOn(i18n, "changeLanguage");

import { I18nextProvider } from "react-i18next";
import { ToastProvider } from "@/client/components/Toast";
import { UserMenu } from "@/client/components/UserMenu";
import * as AuthModule from "@/client/contexts/AuthContext";
import * as ThemeModule from "@/client/contexts/ThemeContext";
import { stubExports } from "@/tests/utils/module-stub";

function renderMenu() {
  return render(
    <I18nextProvider i18n={i18n}>
      {/* The menu tells the operator when a logout did not end the session, and `useToast` refuses
          to run outside its provider. */}
      <ToastProvider>
        <TooltipPrimitive.Provider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route path="/" element={<UserMenu />} />
              <Route path="/login" element={<div>LOGIN_PAGE_MARKER</div>} />
              <Route
                path="/settings"
                element={<div>SETTINGS_PAGE_MARKER</div>}
              />
            </Routes>
          </MemoryRouter>
        </TooltipPrimitive.Provider>
      </ToastProvider>
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

  test("opens with the signed-in identity, the theme row and the language submenu", () => {
    renderMenu();
    openDropdown();
    expect(screen.getAllByText("admin@fazer.ai").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(3);
    expect(screen.getByRole("menuitem", { name: /language/i })).toHaveAttribute(
      "aria-haspopup",
      "menu",
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
    const languageTrigger = screen.getByRole("menuitem", { name: /language/i });
    fireEvent.keyDown(languageTrigger, { key: "ArrowRight" });
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

  // NOTE: the cookie is HttpOnly, so a logout the server did not answer leaves the operator signed
  // in, and `/login` bounces a signed-in visitor to `redirectTo`: navigating anyway would cost them
  // the route they were on and say nothing about why.
  test("stays put and says so when the session did not end", async () => {
    mockLogout.mockImplementationOnce(async () => false);
    renderMenu();
    openDropdown();
    const logoutItem = screen.getByRole("menuitem", { name: /logout/i });
    await act(async () => {
      fireEvent.click(logoutItem);
      await Promise.resolve();
    });
    expect(screen.queryByText("LOGIN_PAGE_MARKER")).not.toBeInTheDocument();
    expect(screen.getByText(/could not sign you out/i)).toBeInTheDocument();
  });

  describe("language submenu placement", () => {
    const originalMatchMedia = window.matchMedia;

    function setViewport(wide: boolean) {
      window.matchMedia = ((query: string) => ({
        ...originalMatchMedia.call(window, query),
        matches: query === "(min-width: 768px)" ? wide : false,
        addEventListener: () => {},
        removeEventListener: () => {},
      })) as typeof window.matchMedia;
    }

    afterEach(() => {
      window.matchMedia = originalMatchMedia;
    });

    // happy-dom has no layout: every rect is zero, so the popper wrapper's translate is exactly
    // the offset the submenu was given from its trigger. The trigger is given a height, since the
    // narrow submenu drops by it.
    async function openLanguageSubmenu(triggerHeight = 30.6) {
      renderMenu();
      openDropdown();
      const trigger = screen.getByRole("menuitem", { name: /language/i });
      trigger.getBoundingClientRect = () =>
        DOMRect.fromRect({ x: 0, y: 0, width: 0, height: triggerHeight });
      fireEvent.keyDown(trigger, { key: "ArrowRight" });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      const wrapper = screen
        .getByRole("menuitemradio", { name: /português/i })
        .closest("[data-radix-popper-content-wrapper]") as HTMLElement;
      return wrapper.style.transform;
    }

    // NOTE: on a phone the menu spans most of the width, so beside it the submenu opened off
    // screen (left -56px at 393px wide). Below md it opens on top of the menu: 176px wide, its
    // right edge 12px inside the trigger's, and as far down as the trigger is tall, so the
    // "Language" row stays uncovered (30.6px rounds to 31).
    test("opens on top of the menu, under its trigger, on a narrow viewport", async () => {
      setViewport(false);
      expect(await openLanguageSubmenu()).toBe("translate(-188px, 31px)");
      fireEvent.click(
        screen.getByRole("menuitemradio", { name: /português/i }),
      );
      expect(changeLanguage).toHaveBeenCalledWith("pt-BR");
    });

    // NOTE: the horizontal offset is spacing steps, so Comfortable density (0.3rem) and a larger
    // browser font widen it with the `w-44` it wraps: at a 20px root, 47 steps of 6px. The drop
    // follows the trigger, which grows with them.
    test("scales the overlap with the density's spacing step and the root font size", async () => {
      setViewport(false);
      document.documentElement.style.setProperty("--spacing", "0.3rem");
      document.documentElement.style.fontSize = "20px";
      try {
        expect(await openLanguageSubmenu(40)).toBe("translate(-282px, 40px)");
      } finally {
        document.documentElement.style.removeProperty("--spacing");
        document.documentElement.style.fontSize = "";
      }
    });

    // NOTE: the overlapping submenu sits left of where Radix expects a right-side submenu, so a
    // mouse heading down into it leaves the trigger outside the pointer-grace area and Radix
    // focuses the parent menu, which closed the submenu. Focus landing on another item still does.
    test("stays open when focus returns to the parent menu on a narrow viewport", async () => {
      setViewport(false);
      await openLanguageSubmenu();
      const [parentMenu] = screen.getAllByRole("menu");
      // The submenu was opened by keyboard; a pointer move puts Radix back in mouse mode, where
      // focusing the menu container does not jump to its first item.
      fireEvent.pointerMove(document);
      act(() => parentMenu?.focus());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(
        screen.getByRole("menuitemradio", { name: /português/i }),
      ).toBeInTheDocument();
      act(() => screen.getByRole("menuitem", { name: /settings/i }).focus());
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(
        screen.queryByRole("menuitemradio", { name: /português/i }),
      ).not.toBeInTheDocument();
    });

    // NOTE: the -5px align offset reads 0 here because collision shifting pins it to the
    // zero-sized viewport; what matters is the 6px gap to the right of the trigger.
    test("opens beside the menu on a wide viewport", async () => {
      setViewport(true);
      expect(await openLanguageSubmenu()).toBe("translate(6px, 0px)");
    });
  });
});
