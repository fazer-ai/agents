/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { PathPicker } from "@/client/pages/resources/ToolEditModal";

// Round 3 of review on #459. The template picker's offer depends on where the caret was when it
// opened, and the toggle is the only thing that re-reads the caret. Inside a block over an empty
// list the offer is empty, and the first draft unmounted the whole control while it was open, so
// moving the caret could never bring it back.
//
// NOTE: every assertion reduces to a boolean or a string BEFORE expect — a failing expectation that
// holds a DOM node serializes a cyclic happy-dom tree and stalls the runner.

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
    // Read from the DOCUMENT, not from `container`: since #462 the offer renders in a portal, so it
    // is not a descendant of the mounted tree. The claim is unchanged — the control stays mounted
    // and says why it is empty — and the portal is what keeps opening it from pushing the field
    // below it down, so it is asserted here rather than merely accommodated.
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
    // The appointment pickers, and the template picker with no sample pasted: as before.
    const { container } = render(<PathPicker {...base} />);
    expect(container.innerHTML).toBe("");
  });
});
