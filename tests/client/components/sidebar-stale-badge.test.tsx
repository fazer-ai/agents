/// <reference lib="dom" />

import {
  afterAll,
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
import { MemoryRouter } from "react-router";
import * as AuthModule from "@/client/contexts/AuthContext";
import * as ThemeModule from "@/client/contexts/ThemeContext";
import * as UpdatesModule from "@/client/contexts/UpdatesContext";
import { stubExports } from "@/tests/utils/module-stub";

// The version line at the foot of the sidebar shows the build this tab runs. After a deploy the
// release check goes quiet (the server is now the newest release), so the line itself says the
// console was updated and offers the reload, instead of looking current.
//
// NOTE: assertions reduce to a boolean or a string BEFORE expect; a failing expectation holding a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

const ENV_DEFAULTS = {
  IS_FREE: false,
  EDITION: "full",
  CDN_URL: "",
  APP_VERSION: "",
  APP_BUILD_ID: "",
};
mock.module("@/client/lib/env", () => ({
  ...ENV_DEFAULTS,
  APP_VERSION: "9.9.1",
  APP_BUILD_ID: "9.9.1+a",
}));
afterAll(() => {
  mock.module("@/client/lib/env", () => ENV_DEFAULTS);
});

let update = {
  available: false,
  currentVersion: "9.9.1",
  latestVersion: null as string | null,
  releaseUrl: null as string | null,
};
stubExports(UpdatesModule, {
  useUpdates: () => ({ announcements: [], update, refresh: () => {} }),
});

stubExports(AuthModule, {
  useAuth: () => ({ user: { role: "AGENT" } }),
});
stubExports(ThemeModule, {
  useThemedAsset: (path: string) => ({ src: path }),
  useTheme: () => ({
    theme: "dark",
    resolvedTheme: "dark",
    setTheme: () => {},
  }),
});

const { Sidebar } = await import("@/client/components/Sidebar");
const { SidebarProvider } = await import("@/client/contexts/SidebarContext");
const { NavGuardProvider } = await import("@/client/contexts/NavGuardContext");
const { onApiResponse } = await import("@/client/lib/api");
const { resetBuildWatch } = await import("@/client/lib/staleBuild");

let reloads = 0;
const reloadSpy = spyOn(window.location, "reload").mockImplementation(() => {
  reloads++;
});
afterAll(() => {
  reloadSpy.mockRestore();
  resetBuildWatch();
});

const serverAnswers = (build: string) =>
  onApiResponse(
    new Response(null, {
      headers: {
        "x-app-build": build,
        "x-app-version": build.split("+")[0] ?? "",
      },
    }),
  );

function renderSidebar() {
  return render(
    <TooltipPrimitive.Provider>
      <MemoryRouter initialEntries={["/"]}>
        <NavGuardProvider>
          <SidebarProvider>
            <Sidebar />
          </SidebarProvider>
        </NavGuardProvider>
      </MemoryRouter>
    </TooltipPrimitive.Provider>,
  );
}

const reloadControl = () =>
  screen.queryByRole("button", { name: /console updated/i });

// The release indicator's own mark: the accent dot next to "update".
const releaseDots = () =>
  document.querySelectorAll("#app-sidebar .bg-accent-solid.rounded-full")
    .length;

beforeEach(() => {
  update = {
    available: false,
    currentVersion: "9.9.1",
    latestVersion: null,
    releaseUrl: null,
  };
  localStorage.clear();
  resetBuildWatch("9.9.1+a");
  reloads = 0;
});
afterEach(() => cleanup());

describe("the sidebar version line", () => {
  test("shows the tab's own version and no reload while current", () => {
    renderSidebar();
    act(() => serverAnswers("9.9.1+a"));
    const line = document.getElementById("app-sidebar")?.textContent ?? "";
    expect([line.includes("v9.9.1"), reloadControl() === null]).toEqual([
      true,
      true,
    ]);
  });

  test("keeps the tab's own version after a deploy and offers the reload", () => {
    renderSidebar();
    act(() => serverAnswers("9.9.2+b"));
    const control = reloadControl();
    expect([
      control?.textContent?.includes("v9.9.1") ?? false,
      control?.getAttribute("aria-label") ?? "",
    ]).toEqual([true, "Console updated to v9.9.2. Reload"]);
  });

  test("a newer release alone shows its dot and its link", () => {
    update = { ...update, available: true, latestVersion: "9.9.3" };
    renderSidebar();
    act(() => serverAnswers("9.9.1+a"));
    const line = document.getElementById("app-sidebar")?.textContent ?? "";
    expect([releaseDots(), line.includes("update")]).toEqual([1, true]);
  });

  test("a stale tab never borrows the release dot, even with a newer release out", () => {
    update = { ...update, available: true, latestVersion: "9.9.3" };
    renderSidebar();
    act(() => serverAnswers("9.9.2+b"));
    const control = reloadControl();
    const line = document.getElementById("app-sidebar")?.textContent ?? "";
    expect([
      releaseDots(),
      control?.querySelector("svg") !== null && control !== null,
      line.includes("update"),
    ]).toEqual([0, true, false]);
  });

  test("the collapsed stale line has no release dot either", () => {
    update = { ...update, available: true, latestVersion: "9.9.3" };
    renderSidebar();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    });
    act(() => serverAnswers("9.9.2+b"));
    const control = reloadControl();
    expect([
      releaseDots(),
      control !== null && control.querySelector("svg") !== null,
      control?.querySelector(".rounded-full") != null,
    ]).toEqual([0, true, false]);
  });

  test("the collapsed line offers the same reload", () => {
    renderSidebar();
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    });
    act(() => serverAnswers("9.9.2+b"));
    const control = reloadControl();
    if (control) fireEvent.click(control);
    expect([control?.textContent ?? "", reloads]).toEqual(["9.9.1", 1]);
  });

  test("the reload control reloads the page", () => {
    renderSidebar();
    act(() => serverAnswers("9.9.2+b"));
    const control = reloadControl();
    if (control) fireEvent.click(control);
    expect(reloads).toBe(1);
  });
});
