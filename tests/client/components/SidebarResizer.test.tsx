/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { SidebarResizer } from "@/client/components/SidebarResizer";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SidebarProvider,
  useSidebar,
} from "@/client/contexts/SidebarContext";

let hook: ReturnType<typeof useSidebar> | null = null;
function Probe() {
  hook = useSidebar();
  return null;
}

function renderResizer() {
  return render(
    <MemoryRouter>
      <SidebarProvider>
        <Probe />
        <SidebarResizer />
      </SidebarProvider>
    </MemoryRouter>,
  );
}

// Pointermove is coalesced into a requestAnimationFrame, so the width
// only changes after the next frame.
function nextFrame() {
  return act(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

function getSeparator() {
  return screen.getByRole("separator");
}

describe("SidebarResizer", () => {
  beforeEach(() => {
    localStorage.clear();
    hook = null;
  });

  afterEach(() => {
    cleanup();
    delete document.body.dataset.resizingSidebar;
    delete document.body.dataset.sidebarSnapping;
  });

  test("exposes WAI-ARIA window splitter attributes", () => {
    renderResizer();
    const sep = getSeparator();
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("aria-valuemin", String(SIDEBAR_MIN_WIDTH));
    expect(sep).toHaveAttribute("aria-valuemax", String(SIDEBAR_MAX_WIDTH));
    expect(sep).toHaveAttribute("aria-valuenow", String(SIDEBAR_DEFAULT_WIDTH));
    expect(sep).toHaveAttribute("tabIndex", "0");
  });

  test("ArrowRight increases width by keyboard step", () => {
    renderResizer();
    const sep = getSeparator();
    act(() => {
      fireEvent.keyDown(sep, { key: "ArrowRight" });
    });
    expect(hook?.width).toBe(SIDEBAR_DEFAULT_WIDTH + 16);
  });

  test("ArrowLeft decreases width; below MIN_WIDTH collapses", () => {
    renderResizer();
    act(() => {
      hook?.setWidth(SIDEBAR_MIN_WIDTH);
    });
    const sep = getSeparator();
    act(() => {
      fireEvent.keyDown(sep, { key: "ArrowLeft" });
    });
    expect(hook?.collapsed).toBe(true);
  });

  test("Home sets width to MIN and End to MAX", () => {
    renderResizer();
    const sep = getSeparator();
    act(() => {
      fireEvent.keyDown(sep, { key: "End" });
    });
    expect(hook?.width).toBe(SIDEBAR_MAX_WIDTH);
    act(() => {
      fireEvent.keyDown(sep, { key: "Home" });
    });
    expect(hook?.width).toBe(SIDEBAR_MIN_WIDTH);
  });

  test("Enter toggles collapse", () => {
    renderResizer();
    const sep = getSeparator();
    act(() => {
      fireEvent.keyDown(sep, { key: "Enter" });
    });
    expect(hook?.collapsed).toBe(true);
    act(() => {
      fireEvent.keyDown(sep, { key: "Enter" });
    });
    expect(hook?.collapsed).toBe(false);
  });

  test("Space also toggles collapse", () => {
    renderResizer();
    const sep = getSeparator();
    act(() => {
      fireEvent.keyDown(sep, { key: " " });
    });
    expect(hook?.collapsed).toBe(true);
  });

  test("reports aria-valuetext when collapsed", () => {
    renderResizer();
    act(() => {
      hook?.setCollapsed(true);
    });
    const sep = getSeparator();
    expect(sep.getAttribute("aria-valuetext")).toBeTruthy();
  });

  test("event.repeat on ArrowRight is ignored", () => {
    renderResizer();
    const sep = getSeparator();
    const before = hook?.width;
    act(() => {
      fireEvent.keyDown(sep, { key: "ArrowRight", repeat: true });
    });
    expect(hook?.width).toBe(before as number);
  });

  test("ArrowRight expands from collapsed back to MIN_WIDTH", () => {
    renderResizer();
    act(() => {
      hook?.setCollapsed(true);
    });
    const sep = getSeparator();
    act(() => {
      fireEvent.keyDown(sep, { key: "ArrowRight" });
    });
    expect(hook?.collapsed).toBe(false);
    expect(hook?.width).toBe(SIDEBAR_MIN_WIDTH);
  });

  test("pointer drag updates width and cleans body dataset on release", () => {
    renderResizer();
    const sep = getSeparator();
    act(() => {
      fireEvent.pointerDown(sep, {
        pointerId: 1,
        button: 0,
        clientX: SIDEBAR_MIN_WIDTH,
      });
    });
    expect(document.body.dataset.resizingSidebar).toBe("true");
    act(() => {
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 300 });
    });
    act(() => {
      fireEvent.pointerUp(sep, { pointerId: 1, clientX: 300 });
    });
    expect(document.body.dataset.resizingSidebar).toBeUndefined();
    expect(hook?.collapsed).toBe(false);
    expect(hook?.width).toBe(300);
  });

  test("pointer drag below collapse snap collapses the sidebar", () => {
    renderResizer();
    const sep = getSeparator();
    act(() => {
      fireEvent.pointerDown(sep, {
        pointerId: 1,
        button: 0,
        clientX: SIDEBAR_MIN_WIDTH,
      });
    });
    act(() => {
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 50 });
    });
    act(() => {
      fireEvent.pointerUp(sep, { pointerId: 1, clientX: 50 });
    });
    expect(hook?.collapsed).toBe(true);
    expect(document.body.dataset.resizingSidebar).toBeUndefined();
  });

  test("crossing the collapse snap mid-drag re-enables the width transition", async () => {
    renderResizer();
    const sep = getSeparator();
    act(() => {
      fireEvent.pointerDown(sep, {
        pointerId: 1,
        button: 0,
        clientX: SIDEBAR_MIN_WIDTH,
      });
    });
    act(() => {
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 300 });
    });
    await nextFrame();
    expect(document.body.dataset.sidebarSnapping).toBeUndefined();

    act(() => {
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 50 });
    });
    await nextFrame();
    expect(hook?.collapsed).toBe(true);
    expect(document.body.dataset.sidebarSnapping).toBe("true");
  });

  test("the snapping flag clears once the transition has had time to run", async () => {
    renderResizer();
    const sep = getSeparator();
    act(() => {
      fireEvent.pointerDown(sep, {
        pointerId: 1,
        button: 0,
        clientX: SIDEBAR_MIN_WIDTH,
      });
    });
    act(() => {
      fireEvent.pointerMove(sep, { pointerId: 1, clientX: 50 });
    });
    await nextFrame();
    expect(document.body.dataset.sidebarSnapping).toBe("true");

    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(document.body.dataset.sidebarSnapping).toBeUndefined();
  });
});
