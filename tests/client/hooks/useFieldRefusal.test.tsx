/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useFieldRefusal } from "@/client/hooks/useFieldRefusal";

// WHETHER THE FORM IS ON SCREEN, WHICH IS NOT WHETHER THE COMPONENT IS MOUNTED.
//
// `placeRefusal` refuses to place a mark on a form that is gone, and the hook answered that question
// with a mounted ref. For a page the two are the same. For a modal they are not: `useModalController`
// keeps the wrapper mounted when the dialog closes, so a save still in flight came back to a live
// component and a form nobody could see — the mark was written, `capture` reported "it is on the
// control", and the banner stayed empty. Silence is the one outcome this mechanism must never reach.

const FIELDS = ["name"] as const;
const eden = (value: unknown) => ({ value });
const REFUSAL = eden({ error: "name already in use", field: "name" });
const FORM = { name: "Alfa" };

afterEach(cleanup);

test("a refusal about a rendered input lands on the control while the form shows", () => {
  const { result } = renderHook(() => useFieldRefusal(FIELDS, true));
  let toast: string | null = "unset";
  act(() => {
    toast = result.current.capture(REFUSAL, "Could not save.", FORM, FORM);
  });
  expect(toast).toBeNull();
  expect(result.current.at("name", "Alfa")).toBe("name already in use");
});

test("the same refusal goes to the toast once the dialog has closed", () => {
  const { result } = renderHook(() => useFieldRefusal(FIELDS, false));
  let toast: string | null = "unset";
  act(() => {
    toast = result.current.capture(REFUSAL, "Could not save.", FORM, FORM);
  });
  // The server's own words, in the channel that is still on screen.
  expect(toast).toBe("name already in use");
  expect(result.current.at("name", "Alfa")).toBeNull();
});

test("the answer follows the dialog, not the render the request started in", () => {
  // The whole reason it is a ref: the operator dismisses the modal DURING the save, so the value the
  // handler closed over says "open" and the only true answer is the current one.
  const { result, rerender } = renderHook(
    ({ open }: { open: boolean }) => useFieldRefusal(FIELDS, open),
    { initialProps: { open: true } },
  );
  const capture = result.current.capture;
  rerender({ open: false });
  let toast: string | null = "unset";
  act(() => {
    toast = capture(REFUSAL, "Could not save.", FORM, FORM);
  });
  expect(toast).toBe("name already in use");
});
