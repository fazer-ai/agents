/// <reference lib="dom" />

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import {
  isInsideRadixPopper,
  Modal,
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

  test("closes when Esc is pressed", () => {
    render(<ControlledModal />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
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
