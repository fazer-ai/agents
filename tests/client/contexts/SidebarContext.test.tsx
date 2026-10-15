/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarProvider,
  useSidebar,
} from "@/client/contexts/SidebarContext";
import { until } from "@/tests/utils/poll";

let hookValue: ReturnType<typeof useSidebar> | null = null;
let navigateFn: ReturnType<typeof useNavigate> | null = null;

function Consumer() {
  hookValue = useSidebar();
  navigateFn = useNavigate();
  return null;
}

function renderProvider(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <SidebarProvider>
        <Consumer />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

describe("SidebarContext", () => {
  beforeEach(() => {
    localStorage.clear();
    hookValue = null;
  });

  afterEach(() => {
    cleanup();
  });

  test("initializes with defaults when no storage", () => {
    renderProvider();
    expect(hookValue?.collapsed).toBe(false);
    expect(hookValue?.width).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(hookValue?.mobileOpen).toBe(false);
  });

  test("reads collapsed from localStorage", () => {
    localStorage.setItem("@app:sidebar-collapsed", "true");
    renderProvider();
    expect(hookValue?.collapsed).toBe(true);
  });

  test("reads width from localStorage and clamps to range", () => {
    localStorage.setItem("@app:sidebar-width", "999");
    renderProvider();
    expect(hookValue?.width).toBe(SIDEBAR_MAX_WIDTH);

    cleanup();
    localStorage.setItem("@app:sidebar-width", "10");
    renderProvider();
    expect(hookValue?.width).toBe(SIDEBAR_MIN_WIDTH);
  });

  test("toggleCollapsed flips and persists", () => {
    renderProvider();
    act(() => hookValue?.toggleCollapsed());
    expect(hookValue?.collapsed).toBe(true);
    expect(localStorage.getItem("@app:sidebar-collapsed")).toBe("true");

    act(() => hookValue?.toggleCollapsed());
    expect(hookValue?.collapsed).toBe(false);
    expect(localStorage.getItem("@app:sidebar-collapsed")).toBe("false");
  });

  test("setCollapsed sets explicit state and persists", () => {
    renderProvider();
    act(() => hookValue?.setCollapsed(true));
    expect(hookValue?.collapsed).toBe(true);
    expect(localStorage.getItem("@app:sidebar-collapsed")).toBe("true");

    act(() => hookValue?.setCollapsed(false));
    expect(hookValue?.collapsed).toBe(false);
    expect(localStorage.getItem("@app:sidebar-collapsed")).toBe("false");
  });

  test("setWidth clamps immediately and persists after debounce", async () => {
    renderProvider();

    act(() => hookValue?.setWidth(9999));
    expect(hookValue?.width).toBe(SIDEBAR_MAX_WIDTH);

    act(() => hookValue?.setWidth(0));
    expect(hookValue?.width).toBe(SIDEBAR_MIN_WIDTH);

    act(() => hookValue?.setWidth(300));
    expect(hookValue?.width).toBe(300);

    // NOTE: persistence is debounced (~150ms) so only the final value lands
    // in storage; wait for the write itself rather than past a guessed window.
    await until("the width persisted", () =>
      localStorage.getItem("@app:sidebar-width"),
    );
    expect(localStorage.getItem("@app:sidebar-width")).toBe(String(300));
  });

  test("setMobileOpen toggles mobile state", () => {
    renderProvider();
    act(() => hookValue?.setMobileOpen(true));
    expect(hookValue?.mobileOpen).toBe(true);

    act(() => hookValue?.setMobileOpen(false));
    expect(hookValue?.mobileOpen).toBe(false);
  });

  test("falls back to default width when storage value is not a number", () => {
    localStorage.setItem("@app:sidebar-width", "not-a-number");
    renderProvider();
    expect(hookValue?.width).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  test("reads collapsed=false for any non-'true' stored value", () => {
    localStorage.setItem("@app:sidebar-collapsed", "garbage");
    renderProvider();
    expect(hookValue?.collapsed).toBe(false);
  });

  test("keeps state updates even when localStorage.setItem throws", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    try {
      renderProvider();
      act(() => hookValue?.setCollapsed(true));
      expect(hookValue?.collapsed).toBe(true);
      act(() => hookValue?.setWidth(300));
      expect(hookValue?.width).toBe(300);
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  test("route change closes an open mobile drawer", () => {
    renderProvider("/");
    act(() => hookValue?.setMobileOpen(true));
    expect(hookValue?.mobileOpen).toBe(true);
    act(() => {
      navigateFn?.("/settings");
    });
    expect(hookValue?.mobileOpen).toBe(false);
  });

  test("crossing the desktop breakpoint closes an open mobile drawer", () => {
    const listeners: Array<(event: MediaQueryListEvent) => void> = [];
    const mediaQueryList = {
      matches: false,
      media: "(min-width: 768px)",
      onchange: null,
      addEventListener: (
        _type: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        listeners.push(listener);
      },
      removeEventListener: (
        _type: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
      dispatchEvent: () => true,
      addListener: () => {},
      removeListener: () => {},
    } as unknown as MediaQueryList;
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = () => mediaQueryList;

    try {
      renderProvider();
      act(() => hookValue?.setMobileOpen(true));
      expect(hookValue?.mobileOpen).toBe(true);
      act(() => {
        for (const listener of [...listeners]) {
          listener({ matches: true } as MediaQueryListEvent);
        }
      });
      expect(hookValue?.mobileOpen).toBe(false);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});
