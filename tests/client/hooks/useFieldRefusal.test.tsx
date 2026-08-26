/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider } from "@/client/components/Toast";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";

// WHAT THE FORM IS DRAWING, WHICH IS NOT WHAT IT CAN SEND.
//
// `placeRefusal` refuses to put a mark where nobody is looking, and the hook answered that with a
// mounted ref, then with a boolean for "the form is on screen". Both were approximations of the
// question the caller can actually answer: is THIS name one the operator can see right now. The
// list is per render, and a form that is not on screen renders nothing.
//
// Answering "put it in your other channel" was only half of it, because for ten of the holders here
// that channel is an error line INSIDE the dialog. So the hook raises the global toast itself once
// nothing is drawn, which is what these tests read: the sentence on screen, not the return.

const FIELDS = ["name"] as const;
const eden = (value: unknown) => ({ value });
const REFUSAL = eden({ error: "name already in use", field: "name" });
const FORM = { name: "Alfa" };

const wrapper = ({ children }: { children: ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);

afterEach(cleanup);

test("a refusal about a drawn input lands on the control", () => {
  const { result } = renderHook(() => useFieldRefusal(FIELDS), { wrapper });
  let toast: string | null = "unset";
  act(() => {
    toast = result.current.capture(REFUSAL, "Could not save.", FORM, FORM);
  });
  expect(toast).toBeNull();
  expect(result.current.at("name", "Alfa")).toBe("name already in use");
  // The other channel stays quiet: exactly one of the two fires.
  expect(screen.queryAllByText("name already in use").length).toBe(0);
});

test("the same refusal is toasted once the form draws nothing", () => {
  const { result } = renderHook(() => useFieldRefusal([]), { wrapper });
  let toast: string | null = "unset";
  act(() => {
    toast = result.current.capture(REFUSAL, "Could not save.", FORM, FORM);
  });
  // Nothing left for the caller to render — its error line is inside the dialog that just closed —
  // and the server's own words on the screen the operator is actually looking at.
  expect(toast).toBeNull();
  expect(result.current.at("name", "Alfa")).toBeNull();
  expect(screen.queryAllByText("name already in use").length).toBe(1);
});

test("a name the form has stopped drawing is toasted, not marked", () => {
  // The half a single on-screen boolean could never answer: the form is right there, and this one
  // control is not. The vault swaps its per-key inputs for a `.env` textarea, the setup screen draws
  // its token box only where enforcement is on, the add-content dialog keeps its text box on one of
  // two tabs. A mark on any of those is written and never rendered.
  const { result } = renderHook(() => useFieldRefusal(["name"]), { wrapper });
  let toast: string | null = "unset";
  act(() => {
    toast = result.current.capture(
      eden({ error: "no surrounding whitespace", field: "public_key" }),
      "Could not save.",
      { public_key: " pk " },
      { public_key: " pk " },
    );
  });
  expect(toast).toBe("no surrounding whitespace");
  expect(screen.queryAllByText("no surrounding whitespace").length).toBe(0);
});

test("the answer follows the render, not the one the request started in", () => {
  // The whole reason it is a ref: the operator dismisses the modal DURING the save, so the list the
  // handler closed over still names every input and the only true answer is the current one.
  const { result, rerender } = renderHook(
    ({ open }: { open: boolean }) => useFieldRefusal(open ? FIELDS : []),
    { initialProps: { open: true }, wrapper },
  );
  const capture = result.current.capture;
  rerender({ open: false });
  act(() => {
    capture(REFUSAL, "Could not save.", FORM, FORM);
  });
  expect(screen.queryAllByText("name already in use").length).toBe(1);
});

test("a caller that words the refusal itself keeps its turn", () => {
  // An empty fallback is how ChannelsPage says it has a better sentence than the server for this
  // one — it names the affordance, disconnect first, which the server cannot know about. The hook
  // has no words of its own here, so raising an empty toast and reporting "told them" would be a
  // new silence in place of the old one.
  const { result } = renderHook(() => useFieldRefusal([]), { wrapper });
  let toast: string | null = "unset";
  act(() => {
    toast = result.current.capture({ value: {} }, "", FORM, FORM);
  });
  expect(toast).toBe("");
  expect(screen.queryAllByRole("status").length).toBe(0);
});
