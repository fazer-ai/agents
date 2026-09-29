/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { PathPicker } from "@/client/pages/resources/ToolEditModal";

// The template picker's offer depends on where the caret was when it opened, and the toggle is the
// only thing that re-reads the caret. Inside a block over an empty list the offer is empty, so the
// control has to stay mounted while open, or moving the caret could never bring it back.
//
// Every assertion reduces to a boolean or a string BEFORE expect: a failing expectation that holds a
// DOM node serializes a cyclic happy-dom tree and stalls the runner.

afterEach(cleanup);

const base = {
  leaves: [],
  lists: [],
  open: true,
  onToggle: () => {},
  onPick: () => {},
  openLabel: "Insert a field",
  closeLabel: "Close",
};

describe("PathPicker with nothing to offer", () => {
  test("stays mounted, with the toggle and the reason, when told what to say", () => {
    const { container } = render(
      <PathPicker {...base} emptyLabel="Nothing to pick here" />,
    );
    const buttons = [...container.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual(["Close"]);
    // NOTE: read from the DOCUMENT, not from `container`: the offer renders in a portal (which keeps
    // opening it from pushing the field below it down), so it is not a descendant of the mounted tree.
    expect(document.body.textContent?.includes("Nothing to pick here")).toBe(
      true,
    );
    const reason = [...document.body.querySelectorAll("li")].find((li) =>
      (li.textContent ?? "").includes("Nothing to pick here"),
    );
    expect(Boolean(reason)).toBe(true);
    expect(container.contains(reason ?? null)).toBe(false);
  });

  test("renders nothing when there is nothing to move the caret towards", () => {
    // The appointment pickers, and the template picker with no sample pasted.
    const { container } = render(<PathPicker {...base} />);
    expect(container.innerHTML).toBe("");
  });
});
