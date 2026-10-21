/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import {
  NavGuardProvider,
  useConfirmLeave,
  useNavGuard,
} from "@/client/contexts/NavGuardContext";

// The discard confirm asks because the page is dirty when the operator tries to leave. A save still
// on the wire makes that true for a moment: once it lands the page is clean, so there is nothing
// left to discard and the leave the operator asked for goes ahead. A save that fails leaves the page
// dirty, and the confirm stays.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

const setUrl = () =>
  (globalThis as { happyDOM?: { setURL(u: string): void } }).happyDOM?.setURL(
    "http://localhost/agents/7",
  );
setUrl();

// A browser's history.back() always ends in a popstate; landing it at once keeps the trap's cleanup
// of one test from swallowing the next test's Back.
let back: ReturnType<typeof spyOn>;
beforeEach(() => {
  setUrl();
  back = spyOn(window.history, "back").mockImplementation(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
});
afterEach(() => {
  cleanup();
  back.mockRestore();
});

let setDirty: (dirty: boolean) => void = () => {};
let setOtherDirty: (dirty: boolean) => void = () => {};
let ran = 0;

// A second form on the same page, with its own registration.
function OtherForm() {
  const [dirty, set] = useState(false);
  setOtherDirty = set;
  useNavGuard(dirty);
  return null;
}

function Page() {
  const [dirty, set] = useState(true);
  setDirty = set;
  useNavGuard(dirty);
  const confirmLeave = useConfirmLeave();
  return (
    <>
      <p>editor</p>
      <OtherForm />
      <a href="/agents">Back to agents</a>
      <button
        type="button"
        onClick={() =>
          confirmLeave(() => {
            ran += 1;
          })
        }
      >
        Switch
      </button>
    </>
  );
}

function mount() {
  ran = 0;
  return render(
    <MemoryRouter initialEntries={["/agents/7"]}>
      <NavGuardProvider>
        <Routes>
          <Route path="/agents/7" element={<Page />} />
          <Route path="/agents" element={<p>agent list</p>} />
        </Routes>
      </NavGuardProvider>
    </MemoryRouter>,
  );
}

const asking = () =>
  document.body.textContent?.toLowerCase().includes("discard") === true;
const onList = () => document.body.textContent?.includes("agent list") === true;

describe("a leave asked while the page is dirty", () => {
  test("goes ahead once the page turns clean, and the confirm closes", () => {
    mount();
    fireEvent.click(screen.getByText("Back to agents"));
    expect(asking()).toBe(true);
    act(() => setDirty(false));
    expect(asking()).toBe(false);
    expect(onList()).toBe(true);
  });

  test("stays asked while the page is still dirty", () => {
    mount();
    fireEvent.click(screen.getByText("Back to agents"));
    act(() => setDirty(true));
    expect(asking()).toBe(true);
    expect(onList()).toBe(false);
  });

  test("stays asked while another form on the page is still dirty", () => {
    mount();
    act(() => setOtherDirty(true));
    fireEvent.click(screen.getByText("Back to agents"));
    act(() => setDirty(false));
    expect(asking()).toBe(true);
    expect(onList()).toBe(false);
  });

  test("an action held by the confirm runs once the page turns clean", () => {
    mount();
    fireEvent.click(screen.getByText("Switch"));
    expect(asking()).toBe(true);
    expect(ran).toBe(0);
    act(() => setDirty(false));
    expect(ran).toBe(1);
    expect(asking()).toBe(false);
  });

  // Back pops the guard's sentinel and the trap pushes it again, so the page entry sits one below.
  // Leaving goes past both in ONE traversal: the guard letting go must not traverse as well, or the
  // two would land one entry too far.
  test("a Back held by the confirm leaves the page in one traversal", () => {
    mount();
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(asking()).toBe(true);
    const go = spyOn(window.history, "go").mockImplementation(() => {});
    const backs = back.mock.calls.length;
    try {
      act(() => setDirty(false));
      expect(go.mock.calls.map((c) => String(c[0]))).toEqual(["-2"]);
      expect(back.mock.calls.length).toBe(backs);
      expect(asking()).toBe(false);
    } finally {
      go.mockRestore();
    }
  });
});
