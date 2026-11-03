/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import {
  isInsideRadixPopper,
  Modal,
  ModalCancelButton,
  useModalController,
  useUnsavedChanges,
} from "@/client/components/Modal";

function ControlledModal({
  initial = true,
  closeOnOutsideClick,
}: {
  initial?: boolean;
  closeOnOutsideClick?: boolean;
}) {
  const modal = useModalController();
  // Fire open() exactly once on mount. `modal` identity changes whenever
  // internal state flips, so depending on it would re-open the dialog after
  // Esc closes it and break the test.
  const openedRef = useRef(false);
  useEffect(() => {
    if (!initial || openedRef.current) return;
    openedRef.current = true;
    modal.open();
  }, [initial, modal]);
  return (
    <Modal
      modal={modal}
      title="Confirm"
      footer={<button type="button">Cancel</button>}
      closeOnOutsideClick={closeOnOutsideClick}
    >
      <p>Body content</p>
    </Modal>
  );
}

// Dirty via the `unsavedChanges` prop (state in the wrapper — the common case).
function DirtyModal({ dirty }: { dirty: boolean }) {
  const modal = useModalController();
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    modal.open();
  }, [modal]);
  return (
    <Modal modal={modal} title="Editor" unsavedChanges={dirty}>
      <p>Body content</p>
    </Modal>
  );
}

// Dirty via the descendant hook (state in a body component inside the modal).
function HookBody() {
  useUnsavedChanges(true);
  return <p>Body content</p>;
}
function HookDirtyModal() {
  const modal = useModalController();
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    modal.open();
  }, [modal]);
  return (
    <Modal modal={modal} title="Editor">
      <HookBody />
    </Modal>
  );
}

// A request in flight, dirty or not, with the controls a real form modal has (Cancel in the footer).
function BusyModal({ dirty, busy }: { dirty: boolean; busy: boolean }) {
  const modal = useModalController();
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    modal.open();
  }, [modal]);
  return (
    <Modal
      modal={modal}
      title="Editor"
      unsavedChanges={dirty}
      busy={busy}
      footer={<ModalCancelButton />}
    >
      <p>Body content</p>
    </Modal>
  );
}

// Every user-driven way out: Escape, a press-and-release outside, the X, Cancel, and browser Back.
const DISMISSALS: Array<[string, () => void]> = [
  [
    "Escape",
    () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }),
  ],
  [
    "outside click",
    () => {
      fireEvent.pointerDown(document.body, { clientX: 5000, clientY: 5000 });
      fireEvent.pointerUp(document.body, { clientX: 5000, clientY: 5000 });
    },
  ],
  [
    "the close button",
    () => fireEvent.click(screen.getByRole("button", { name: "Close" })),
  ],
  [
    "Cancel",
    () => fireEvent.click(screen.getByRole("button", { name: "Cancel" })),
  ],
  // Outside `fireEvent`, so the state it sets is flushed by an explicit act.
  ["Back", () => act(() => void window.dispatchEvent(new Event("popstate")))],
];

describe("Modal while a request is in flight (busy)", () => {
  afterEach(() => cleanup());

  test.each(DISMISSALS)(
    "a dirty modal stays open on %s and never offers to discard",
    (_, dismiss) => {
      render(<BusyModal dirty busy />);
      dismiss();
      expect(screen.getByText("Editor")).toBeInTheDocument();
      expect(screen.queryByText("Discard changes?")).toBeNull();
    },
  );

  test.each(DISMISSALS)("a clean modal stays open on %s", (_, dismiss) => {
    render(<BusyModal dirty={false} busy />);
    dismiss();
    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.queryByText("Discard changes?")).toBeNull();
  });

  test.each(DISMISSALS)(
    "once the request settles, %s on a dirty modal offers to discard again",
    (_, dismiss) => {
      const view = render(<BusyModal dirty busy />);
      view.rerender(<BusyModal dirty busy={false} />);
      dismiss();
      expect(screen.getByText("Discard changes?")).toBeInTheDocument();
    },
  );

  test("the unload prompt stays armed for a dirty form while the request is out", () => {
    render(<BusyModal dirty busy />);
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  test("Back is trapped while busy even on a clean form, and released when the request settles", () => {
    const push = spyOn(window.history, "pushState");
    const view = render(<BusyModal dirty={false} busy={false} />);
    const before = push.mock.calls.length;
    view.rerender(<BusyModal dirty={false} busy />);
    expect(push.mock.calls.length).toBe(before + 1);
    view.rerender(<BusyModal dirty={false} busy={false} />);
    window.dispatchEvent(new Event("popstate"));
    expect(push.mock.calls.length).toBe(before + 1);
    push.mockRestore();
  });
});

describe("Modal", () => {
  afterEach(() => cleanup());

  test("renders title and body when open", () => {
    render(<ControlledModal />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Confirm")).toBeInTheDocument();
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });

  test("does not render when closed", () => {
    render(<ControlledModal initial={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("exposes close button with aria-label", () => {
    render(<ControlledModal />);
    expect(
      screen.getByRole("button", { name: /^close$/i }),
    ).toBeInTheDocument();
  });

  test("Esc still closes when closeOnOutsideClick is false", () => {
    render(<ControlledModal closeOnOutsideClick={false} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("pointerup without prior outside pointerdown does not close", () => {
    render(<ControlledModal />);
    fireEvent.pointerUp(document.body);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("clean modal closes immediately on Esc (no discard confirm)", () => {
    render(<DirtyModal dirty={false} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByText("Editor")).toBeNull();
    expect(screen.queryByText("Discard changes?")).toBeNull();
  });

  test("dirty modal shows the discard confirm on Esc instead of closing", () => {
    render(<DirtyModal dirty />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    // The modal stays open and the confirm appears over it.
    expect(screen.getByText("Editor")).toBeInTheDocument();
    expect(screen.getByText("Discard changes?")).toBeInTheDocument();
  });

  test("Keep editing dismisses the confirm and keeps the modal open", () => {
    render(<DirtyModal dirty />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByText("Discard changes?")).toBeNull();
    expect(screen.getByText("Editor")).toBeInTheDocument();
  });

  test("Discard abandons the changes and closes the modal", () => {
    render(<DirtyModal dirty />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Editor")).toBeNull();
  });

  test("useUnsavedChanges from a body component also guards close", async () => {
    render(<HookDirtyModal />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(await screen.findByText("Discard changes?")).toBeInTheDocument();
  });

  test("nested Modal stacks above its parent via depth-based z-index", () => {
    function Nested() {
      const parent = useModalController();
      const child = useModalController();
      const openedRef = useRef(false);
      useEffect(() => {
        if (openedRef.current) return;
        openedRef.current = true;
        parent.open();
        child.open();
      }, [parent, child]);
      return (
        <Modal modal={parent} title="Parent">
          <Modal modal={child} title="Child">
            <p>Child body</p>
          </Modal>
        </Modal>
      );
    }
    const { baseElement } = render(<Nested />);
    const dialogs = Array.from(
      baseElement.querySelectorAll<HTMLElement>('[role="dialog"]'),
    );
    expect(dialogs.length).toBe(2);
    const [parent, child] = dialogs as [HTMLElement, HTMLElement];
    // Parent: no inline z-index, inherits Tailwind z-(--z-modal) token.
    expect(parent.style.zIndex).toBe("");
    // Child: inline calc() referencing the same CSS token, one step above.
    expect(child.style.zIndex).toContain("var(--z-modal)");
    expect(child.style.zIndex).toContain("+ 2");
  });

  test("isInsideRadixPopper: true for targets inside a portaled popper, false otherwise", () => {
    // A Radix dropdown/select portals its content into a popper wrapper outside the modal DOM.
    // A press on that content must NOT read as an outside-modal click (item 31: the Vault type
    // picker was closing/discarding the modal). Everything else stays outside.
    const wrapper = document.createElement("div");
    wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    const item = document.createElement("button");
    wrapper.appendChild(item);
    document.body.appendChild(wrapper);

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    const menuItem = document.createElement("div");
    menu.appendChild(menuItem);
    document.body.appendChild(menu);

    const plain = document.createElement("div");
    document.body.appendChild(plain);

    try {
      expect(isInsideRadixPopper(item)).toBe(true);
      expect(isInsideRadixPopper(wrapper)).toBe(true);
      expect(isInsideRadixPopper(menuItem)).toBe(true);
      expect(isInsideRadixPopper(plain)).toBe(false);
      expect(isInsideRadixPopper(document.body)).toBe(false);
      expect(isInsideRadixPopper(null)).toBe(false);
    } finally {
      wrapper.remove();
      menu.remove();
      plain.remove();
    }
  });

  test("warns once nesting reaches the --z-toast layer", () => {
    function Deep() {
      const m0 = useModalController();
      const m1 = useModalController();
      const m2 = useModalController();
      const m3 = useModalController();
      const m4 = useModalController();
      const m5 = useModalController();
      const openedRef = useRef(false);
      useEffect(() => {
        if (openedRef.current) return;
        openedRef.current = true;
        m0.open();
        m1.open();
        m2.open();
        m3.open();
        m4.open();
        m5.open();
      }, [m0, m1, m2, m3, m4, m5]);
      return (
        <Modal modal={m0} title="d0">
          <Modal modal={m1} title="d1">
            <Modal modal={m2} title="d2">
              <Modal modal={m3} title="d3">
                <Modal modal={m4} title="d4">
                  <Modal modal={m5} title="d5">
                    <p>too deep</p>
                  </Modal>
                </Modal>
              </Modal>
            </Modal>
          </Modal>
        </Modal>
      );
    }
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(<Deep />);
      const deepWarns = warn.mock.calls.filter((call) =>
        String(call[0]).includes("--z-toast"),
      );
      expect(deepWarns.length).toBeGreaterThan(0);
    } finally {
      warn.mockRestore();
    }
  });
});

// NOTE: The pointerup-outside close behavior (only close when both mousedown
// AND mouseup land outside the dialog) is not unit-tested: Radix's
// onPointerDownOutside detection relies on layered document listeners that
// happy-dom does not reliably trigger via fireEvent. Verify manually in a
// browser, or cover via e2e (Playwright) if the behavior is critical.

describe("Modal slides to the center of a new height until it is touched", () => {
  // happy-dom has no layout, so the heights, the top and the observer are stand-ins, and it drops an
  // inline `top` written as `max()` over `dvh`, so the inline top of a slide is not read here. What
  // a real browser paints, frame by frame, is in docs/modals.md.
  let height = 0;
  // null is "where the pin puts it": the top `--modal-top` resolves to, as a browser would lay it
  // out; a number stands for a top layout put somewhere else.
  let pinnedTop: number | null = null;
  let reduced = false;
  let observers: FakeObserver[] = [];
  const calls: string[] = [];
  class FakeObserver {
    targets = new Set<Element>();
    constructor(private cb: ResizeObserverCallback) {
      observers.push(this);
    }
    observe(target: Element) {
      calls.push("observe");
      this.targets.add(target);
    }
    unobserve(target: Element) {
      calls.push("unobserve");
      this.targets.delete(target);
    }
    disconnect() {
      this.targets.clear();
    }
    fire() {
      if (this.targets.size === 0) return;
      this.cb([], this as unknown as ResizeObserver);
    }
  }
  const fire = () =>
    act(() => {
      for (const observer of observers) observer.fire();
    });
  const originals = {
    offsetHeight: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    ),
    offsetTop: Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetTop",
    ),
    observer: globalThis.ResizeObserver,
    matchMedia: window.matchMedia,
  };
  beforeEach(() => {
    height = 0;
    pinnedTop = null;
    reduced = false;
    observers = [];
    calls.length = 0;
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => height,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        if (pinnedTop !== null) return pinnedTop;
        const pin = /calc\(50dvh - ([\d.]+)px\)/.exec(
          this.style.getPropertyValue("--modal-top"),
        );
        const half = pin ? Number(pin[1]) : height / 2;
        return Math.max(16, window.innerHeight / 2 - half);
      },
    });
    globalThis.ResizeObserver =
      FakeObserver as unknown as typeof ResizeObserver;
    window.matchMedia = ((query: string) => ({
      matches: reduced && query.includes("reduce"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    cleanup();
    for (const key of ["offsetHeight", "offsetTop"] as const) {
      const original = originals[key];
      if (original) Object.defineProperty(HTMLElement.prototype, key, original);
    }
    globalThis.ResizeObserver = originals.observer;
    window.matchMedia = originals.matchMedia;
  });

  let api: { open: () => void; close: () => void; rows: (n: number) => void };
  function Loading() {
    const modal = useModalController();
    const [rows, setRows] = useState(1);
    api = { open: modal.open, close: modal.close, rows: setRows };
    return (
      <Modal modal={modal} title="Loading">
        {Array.from({ length: rows }, (_, i) => (
          <p key={String(i)}>row</p>
        ))}
        <input aria-label="field" />
      </Modal>
    );
  }
  // The box inside the full-viewport Content, the node the slide moves.
  const dialog = () =>
    screen.getByRole("dialog").firstElementChild as HTMLElement;
  const top = () => dialog().style.getPropertyValue("--modal-top");
  const center = (h: number) => `max(1rem, calc(50dvh - ${h / 2}px))`;
  // Opens at `h`, and lets the observer take its first report, the height of the first frame.
  const openAt = (h: number) => {
    render(<Loading />);
    height = h;
    act(() => api.open());
    fire();
  };
  const transitionEnd = (propertyName: string) => {
    const event = new Event("transitionend");
    Object.defineProperty(event, "propertyName", { value: propertyName });
    act(() => {
      dialog().dispatchEvent(event);
    });
  };

  test("opens centered on its first frame's height, with the entry zoom anchored at the top", () => {
    openAt(286);
    const classes = dialog().className.split(/\s+/);
    expect(classes).toContain("top-(--modal-top)");
    expect(classes).toContain("origin-top");
    expect(classes).not.toContain("-translate-y-1/2");
    expect(top()).toBe(center(286));
    expect(dialog().style.height).toBe("");
  });

  test("before it is touched, a change of height slides from the painted height to the new center", () => {
    openAt(200);
    pinnedTop = 300;
    calls.length = 0;
    height = 500;
    act(() => api.rows(9));
    fire();
    const style = dialog().style;
    expect(calls).toEqual(["unobserve"]);
    expect(style.height).toBe("500px");
    expect(style.overflow).toBe("hidden");
    expect(style.maxHeight).toBe("none");
    expect(style.transition).toContain("260ms");
    expect(style.transition).toContain("cubic-bezier(0.2, 0, 0, 1)");
    // NOTE: the pin is still the old height until the slide ends.
    expect(top()).toBe(center(200));
    transitionEnd("top");
    expect(top()).toBe(center(200));
    transitionEnd("height");
    expect(top()).toBe(center(500));
    expect(style.height).toBe("");
    expect(style.top).toBe("");
    expect(style.transition).toBe("");
    expect(style.maxHeight).toBe("");
    expect(style.overflow).toBe("");
    expect(calls).toEqual(["unobserve", "observe"]);
  });

  test("a slide is capped at the viewport less its margins", () => {
    openAt(200);
    height = window.innerHeight + 400;
    act(() => api.rows(30));
    fire();
    expect(dialog().style.height).toBe(`${window.innerHeight - 32}px`);
    transitionEnd("height");
    expect(top()).toBe(center(window.innerHeight - 32));
  });

  test("a change of height while it slides is picked up when it is observed again", () => {
    openAt(200);
    height = 500;
    act(() => api.rows(9));
    fire();
    // NOTE: unobserved while sliding, so this report never reaches the callback.
    height = 300;
    fire();
    expect(dialog().style.height).toBe("500px");
    transitionEnd("height");
    expect(top()).toBe(center(500));
    fire();
    expect(dialog().style.height).toBe("300px");
  });

  test("a slide whose transition never ends still settles", async () => {
    openAt(200);
    height = 400;
    act(() => api.rows(9));
    fire();
    await waitFor(() => expect(top()).toBe(center(400)), { timeout: 2000 });
    expect(dialog().style.height).toBe("");
  });

  for (const [gesture, act_] of [
    ["a pointerdown", (target: Element) => fireEvent.pointerDown(target)],
    ["a keydown", (target: Element) => fireEvent.keyDown(target, { key: "a" })],
  ] as const) {
    test(`after ${gesture} inside it, the top stays and the height changes at the bottom edge`, () => {
      openAt(200);
      act_(screen.getByLabelText("field"));
      pinnedTop = 300;
      height = 400;
      act(() => api.rows(9));
      fire();
      expect(dialog().style.height).toBe("");
      expect(top()).toBe(center(200));
      height = 120;
      act(() => api.rows(1));
      fire();
      expect(dialog().style.height).toBe("");
      expect(top()).toBe(center(200));
    });
  }

  test("a pointerdown or keydown outside it does not count as touching it", () => {
    openAt(200);
    fireEvent.pointerDown(document.body);
    fireEvent.keyDown(document.body, { key: "a" });
    height = 400;
    act(() => api.rows(9));
    fire();
    expect(dialog().style.height).toBe("400px");
  });

  test("after it was touched, reaching the bottom edge with room above slides it to the center", () => {
    openAt(200);
    fireEvent.pointerDown(screen.getByLabelText("field"));
    fireEvent.pointerUp(document.body);
    pinnedTop = window.innerHeight / 2 - 100;
    // NOTE: what layout gives a pinned dialog cut by its max-height at the bottom margin.
    height = window.innerHeight - 16 - pinnedTop;
    act(() => api.rows(20));
    fire();
    expect(dialog().style.height).toBe(`${height}px`);
    transitionEnd("height");
    expect(top()).toBe(center(height));
  });

  test("with reduced motion it moves straight to the new center and is observed again a frame later", async () => {
    reduced = true;
    openAt(200);
    calls.length = 0;
    height = 500;
    act(() => api.rows(9));
    fire();
    expect(top()).toBe(center(500));
    expect(dialog().style.height).toBe("");
    expect(dialog().style.transition).toBe("");
    expect(calls).toEqual(["unobserve"]);
    await waitFor(() => expect(calls).toEqual(["unobserve", "observe"]));
  });

  test("a change of viewport size centers it at once on the height it has now", () => {
    openAt(200);
    fireEvent.pointerDown(screen.getByLabelText("field"));
    height = 600;
    act(() => api.rows(9));
    fire();
    expect(top()).toBe(center(200));
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(top()).toBe(center(600));
    expect(dialog().style.height).toBe("");
  });

  test("a change of viewport size in the middle of a slide drops it and centers at once", () => {
    openAt(200);
    height = 500;
    act(() => api.rows(9));
    fire();
    expect(dialog().style.height).toBe("500px");
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(top()).toBe(center(500));
    expect(dialog().style.height).toBe("");
    expect(dialog().style.transition).toBe("");
    transitionEnd("height");
    expect(top()).toBe(center(500));
  });

  test("a press inside it in the middle of a slide freezes the box where it is, until the frame after the pointer is up", async () => {
    openAt(200);
    pinnedTop = 250;
    height = 500;
    act(() => api.rows(9));
    fire();
    expect(dialog().style.transition).toContain("260ms");
    calls.length = 0;
    fireEvent.pointerDown(screen.getByLabelText("field"));
    const style = dialog().style;
    expect(style.transition).toBe("none");
    expect(style.height).not.toBe("");
    expect(top()).toBe(center(window.innerHeight - 2 * pinnedTop));
    // NOTE: the slide is over; its transitionend does not move the box to the center it was going to.
    transitionEnd("height");
    expect(top()).toBe(center(window.innerHeight - 2 * pinnedTop));
    expect(style.height).not.toBe("");
    fireEvent.pointerUp(document.body);
    // NOTE: still held through the click that follows the pointerup.
    expect(style.height).not.toBe("");
    await waitFor(() => expect(style.height).toBe(""));
    expect(style.transition).toBe("");
    expect(calls).toEqual(["observe"]);
  });

  test("a click on the X in the middle of a slide closes it with the box where it is painted", () => {
    openAt(200);
    pinnedTop = 250;
    height = 500;
    act(() => api.rows(9));
    fire();
    const node = dialog();
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.pointerDown(close);
    fireEvent.pointerUp(close);
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(node.style.height).not.toBe("");
    expect(node.style.top).toBe(`${pinnedTop}px`);
    expect(node.style.transition).toBe("none");
  });

  test("a new press before the frame after a pointerup keeps the box held", async () => {
    openAt(200);
    pinnedTop = 250;
    height = 500;
    act(() => api.rows(9));
    fire();
    const field = screen.getByLabelText("field");
    fireEvent.pointerDown(field);
    fireEvent.pointerUp(field);
    fireEvent.pointerDown(field);
    // NOTE: two frames, so the one the pointerup scheduled has run.
    for (const _ of [1, 2]) {
      await new Promise((resolve) =>
        requestAnimationFrame(() => resolve(null)),
      );
    }
    expect(dialog().style.height).not.toBe("");
    fireEvent.pointerUp(field);
    await waitFor(() => expect(dialog().style.height).toBe(""));
  });

  test("typing in it in the middle of a slide stops the box where it is, and lets the height go a frame later", async () => {
    openAt(200);
    pinnedTop = 250;
    height = 500;
    act(() => api.rows(9));
    fire();
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "a" });
    expect(dialog().style.transition).toBe("none");
    expect(top()).toBe(center(window.innerHeight - 2 * pinnedTop));
    await waitFor(() => expect(dialog().style.height).toBe(""));
    expect(dialog().style.transition).toBe("");
  });

  // NOTE: happy-dom plays no exit animation, so the panel is gone right after the close; what is
  // read is the style the node was left with, which is what a browser paints while it fades out.
  test("a close in the middle of a slide leaves the box where it is painted", () => {
    openAt(200);
    pinnedTop = 250;
    height = 500;
    act(() => api.rows(9));
    fire();
    const node = dialog();
    act(() => api.close());
    expect(node.style.height).not.toBe("");
    expect(node.style.top).toBe(`${pinnedTop}px`);
    expect(node.style.transition).toBe("none");
  });

  test("an Esc in the middle of a slide closes it with the box where it is painted", () => {
    openAt(200);
    pinnedTop = 250;
    height = 500;
    act(() => api.rows(9));
    fire();
    const node = dialog();
    fireEvent.keyDown(screen.getByLabelText("field"), { key: "Escape" });
    expect(node.style.height).not.toBe("");
    expect(node.style.top).toBe(`${pinnedTop}px`);
    expect(node.style.transition).toBe("none");
  });

  test("a close with no slide running leaves nothing inline", () => {
    openAt(200);
    const node = dialog();
    act(() => api.close());
    expect(node.style.height).toBe("");
    expect(node.style.top).toBe("");
  });

  test("after it was touched, the slide from the bottom edge waits for the frame after the pointer is up", async () => {
    openAt(200);
    fireEvent.pointerDown(screen.getByLabelText("field"));
    pinnedTop = window.innerHeight / 2 - 100;
    height = window.innerHeight - 16 - pinnedTop;
    act(() => api.rows(20));
    fire();
    expect(dialog().style.height).toBe("");
    expect(top()).toBe(center(200));
    fireEvent.pointerUp(document.body);
    expect(dialog().style.height).toBe("");
    // NOTE: painted cut at that height while the pointer was down, so only the top moves now.
    await waitFor(() => expect(dialog().style.height).toBe(`${height}px`));
    expect(dialog().style.transition).toContain("260ms");
    transitionEnd("top");
    expect(top()).toBe(center(height));
  });

  // The natural height is read through getComputedStyle with max-height lifted; that read is the
  // forced layout in which a browser grows the scroll area and clamps its scrollTop.
  const onLiftedRead = (fn: () => void) => {
    const original = window.getComputedStyle;
    const node = dialog();
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      if (element === node && node.style.maxHeight === "none") fn();
      return original.call(window, element, pseudo);
    }) as typeof window.getComputedStyle;
    return () => {
      window.getComputedStyle = original;
    };
  };

  test("a report with the same height, a change of width only, measures nothing", () => {
    openAt(200);
    let lifted = 0;
    const restore = onLiftedRead(() => {
      lifted += 1;
    });
    try {
      fire();
      fire();
    } finally {
      restore();
    }
    expect(lifted).toBe(0);
    expect(dialog().style.height).toBe("");
  });

  test("measuring the natural height keeps where a scrolled body is", () => {
    openAt(200);
    fireEvent.pointerDown(screen.getByLabelText("field"));
    fireEvent.pointerUp(document.body);
    const scroller = screen.getByLabelText("field")
      .parentElement as HTMLElement;
    scroller.scrollTop = 120;
    expect(scroller.scrollTop).toBe(120);
    // NOTE: cut at the bottom edge, so the natural height is measured.
    pinnedTop = window.innerHeight / 2 - 100;
    height = window.innerHeight - 16 - pinnedTop;
    const restore = onLiftedRead(() => {
      scroller.scrollTop = 0;
    });
    try {
      act(() => api.rows(20));
      fire();
    } finally {
      restore();
    }
    expect(dialog().style.height).toBe(`${height}px`);
    expect(scroller.scrollTop).toBe(120);
  });

  test("a dialog that grew before the observer's first report is checked on that report", () => {
    render(<Loading />);
    height = 200;
    act(() => api.open());
    // NOTE: grown and cut at the bottom edge before the first report arrives.
    pinnedTop = window.innerHeight / 2 - 100;
    height = window.innerHeight - 16 - pinnedTop;
    act(() => api.rows(20));
    fire();
    expect(dialog().style.height).toBe(`${height}px`);
    transitionEnd("height");
    expect(top()).toBe(center(height));
  });

  // A 900px viewport and an unchanged 865px box centered at 17.5px: the computed values are
  // fractional, and offsetTop rounds to 18, so `18 + 865` reads as cut at the bottom edge.
  const atHalfPixel = (reducedMotionOn: boolean) => {
    reduced = reducedMotionOn;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 900,
    });
    const original = window.getComputedStyle;
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const style = original.call(window, element, pseudo);
      if (element.parentElement?.getAttribute("role") !== "dialog")
        return style;
      return new Proxy(style, {
        get: (target, key) =>
          key === "top"
            ? "17.5px"
            : key === "height"
              ? "865px"
              : Reflect.get(target, key),
      });
    }) as typeof window.getComputedStyle;
    pinnedTop = 18;
    render(<Loading />);
    height = 865;
    act(() => api.open());
    return () => {
      window.getComputedStyle = original;
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalInnerHeight,
      });
    };
  };

  for (const reducedMotionOn of [false, true]) {
    test(`an unchanged box centered on a half pixel starts no slide${reducedMotionOn ? ", with reduced motion" : ""}`, () => {
      const restore = atHalfPixel(reducedMotionOn);
      try {
        const pin = top();
        calls.length = 0;
        fire();
        fire();
        expect(calls).toEqual([]);
        expect(dialog().style.height).toBe("");
        expect(dialog().style.transition).toBe("");
        expect(top()).toBe(pin);
      } finally {
        restore();
      }
    });
  }

  // Radix keeps the Content mounted through its exit animation, and a reopen in that window gets
  // the same box back. happy-dom runs no CSS, so the exit animation is stubbed: Radix reads the
  // computed animation name of the Content, and when it changes on close it waits for an
  // animationend that never comes.
  const withExitAnimation = () => {
    const original = window.getComputedStyle;
    window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
      const style = original.call(window, element, pseudo);
      if (element.getAttribute("role") !== "dialog") return style;
      return new Proxy(style, {
        get: (target, key) =>
          key === "animationName"
            ? element.getAttribute("data-state") === "closed"
              ? "exit"
              : "enter"
            : Reflect.get(target, key),
      });
    }) as typeof window.getComputedStyle;
    return () => {
      window.getComputedStyle = original;
    };
  };

  test("a reopen that gets back a box closed while idle is centered on the height it has now", () => {
    const restore = withExitAnimation();
    try {
      openAt(200);
      fireEvent.pointerDown(screen.getByLabelText("field"));
      fireEvent.pointerUp(document.body);
      // NOTE: touched, so a change of height keeps the top and grows at the bottom edge.
      height = 500;
      act(() => api.rows(9));
      fire();
      expect(top()).toBe(center(200));
      const node = dialog();
      act(() => api.close());
      expect(node.isConnected).toBe(true);
      expect(node.parentElement?.dataset.state).toBe("closed");
      act(() => api.open());
      expect(dialog()).toBe(node);
      expect(top()).toBe(center(500));
    } finally {
      restore();
    }
  });

  test("a reopened box starts untouched: a change of height slides it to the center again", () => {
    const restore = withExitAnimation();
    try {
      openAt(200);
      fireEvent.pointerDown(screen.getByLabelText("field"));
      fireEvent.pointerUp(document.body);
      const node = dialog();
      act(() => api.close());
      act(() => api.open());
      expect(dialog()).toBe(node);
      fire();
      height = 400;
      act(() => api.rows(9));
      fire();
      expect(dialog().style.height).toBe("400px");
    } finally {
      restore();
    }
  });

  // A body that changes height in its own mount effect (a list whose data is already cached, any
  // setState on mount) commits after the pin was measured and before the baseline is read: the
  // baseline then matches the new height, the first report sees no change, and the untouched box
  // stays centered on the height it had for one render.
  function ChangesOnMount({ to }: { to: number }) {
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
      height = to;
      setLoaded(true);
    }, [to]);
    return <p>{loaded ? "loaded" : "loading"}</p>;
  }
  function MountModal({ to }: { to: number }) {
    const modal = useModalController();
    api = { open: modal.open, close: modal.close, rows: () => {} };
    return (
      <Modal modal={modal} title="Mount">
        <ChangesOnMount to={to} />
      </Modal>
    );
  }

  for (const [label, to] of [
    ["grows", 300],
    ["shrinks", 120],
  ] as const) {
    test(`an untouched box whose body ${label} in a mount effect ends centered on its height`, () => {
      render(<MountModal to={to} />);
      height = 200;
      act(() => api.open());
      expect(screen.getByText("loaded")).toBeTruthy();
      fire();
      // NOTE: painted at its new height already, so only the top moves; the slide ends on `top`.
      expect(dialog().style.transition).toContain("260ms");
      expect(dialog().style.height).toBe(`${to}px`);
      transitionEnd("top");
      expect(top()).toBe(center(to));
      expect(dialog().style.height).toBe("");
    });
  }

  test("an untouched box whose body changes height in a mount effect moves straight to its center with reduced motion", () => {
    reduced = true;
    render(<MountModal to={300} />);
    height = 200;
    act(() => api.open());
    fire();
    expect(top()).toBe(center(300));
  });

  test("a new opening is centered on its own first frame", async () => {
    openAt(200);
    expect(top()).toBe(center(200));
    act(() => api.close());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    height = 300;
    act(() => api.open());
    expect(top()).toBe(center(300));
  });
});
