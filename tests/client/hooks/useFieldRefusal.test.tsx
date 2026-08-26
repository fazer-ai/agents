/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { ToastProvider } from "@/client/components/Toast";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";

// WHETHER THE FORM IS ON SCREEN, WHICH IS NOT WHETHER THE COMPONENT IS MOUNTED.
//
// `placeRefusal` refuses to place a mark on a form that is gone, and the hook answered that question
// with a mounted ref. For a page the two are the same. For a modal they are not: `useModalController`
// keeps the wrapper mounted when the dialog closes, so a save still in flight came back to a live
// component and a form nobody could see — the mark was written, `capture` reported "it is on the
// control", and the banner stayed empty. Silence is the one outcome this mechanism must never reach.
//
// And answering "put it in your other channel" was only half a fix, because for ten of the holders
// here that channel is an error line INSIDE the dialog. So the hook raises the global toast itself
// once the form is gone, which is what these tests read: the sentence on screen, not the return.

const FIELDS = ["name"] as const;
const eden = (value: unknown) => ({ value });
const REFUSAL = eden({ error: "name already in use", field: "name" });
const FORM = { name: "Alfa" };

const wrapper = ({ children }: { children: ReactNode }) => (
  <ToastProvider>{children}</ToastProvider>
);

afterEach(cleanup);

test("a refusal about a rendered input lands on the control while the form shows", () => {
  const { result } = renderHook(() => useFieldRefusal(FIELDS, true), {
    wrapper,
  });
  let toast: string | null = "unset";
  act(() => {
    toast = result.current.capture(REFUSAL, "Could not save.", FORM, FORM);
  });
  expect(toast).toBeNull();
  expect(result.current.at("name", "Alfa")).toBe("name already in use");
  // The other channel stays quiet: exactly one of the two fires.
  expect(screen.queryAllByText("name already in use").length).toBe(0);
});

test("the same refusal is toasted once the dialog has closed", () => {
  const { result } = renderHook(() => useFieldRefusal(FIELDS, false), {
    wrapper,
  });
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

test("the answer follows the dialog, not the render the request started in", () => {
  // The whole reason it is a ref: the operator dismisses the modal DURING the save, so the value the
  // handler closed over says "open" and the only true answer is the current one.
  const { result, rerender } = renderHook(
    ({ open }: { open: boolean }) => useFieldRefusal(FIELDS, open),
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
  const { result } = renderHook(() => useFieldRefusal(FIELDS, false), {
    wrapper,
  });
  let toast: string | null = "unset";
  act(() => {
    toast = result.current.capture({ value: {} }, "", FORM, FORM);
  });
  expect(toast).toBe("");
  expect(screen.queryAllByRole("status").length).toBe(0);
});
