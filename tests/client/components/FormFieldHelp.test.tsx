/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The REAL i18n instance, not the fallback `t` that react-i18next hands out with no provider: that
// one returns the default string untouched, so an assertion about the accessible name would be
// reading "Help about {{subject}}" and calling it a name.
await import("@/client/lib/i18n");
const { FormField } = await import("@/client/components/FormField");

// The `?` that opens a field's long-form help (issue #411).
//
// It is asserted through a CLICK reaching rendered text, and not by looking for the button or for a
// prop, because the two ways this affordance dies are both invisible to a shallower check.
//
// The first is measured, not imagined: the trigger shipped with an `onClick` that called
// `preventDefault` — added to stop the wrapping <label> from forwarding the click to the control —
// and Radix composes the trigger's handler with `checkForDefaultPrevented`, so cancelling the event
// cancelled its own `onOpenToggle`. The button rendered, the aria wiring was right, and nothing
// opened. (The guard was also unnecessary: a label's activation behaviour does nothing for an event
// targeted at an interactive descendant, and a <button> is one.)
//
// The second is the reason this is a Popover and not a Tooltip at all: a Radix tooltip cannot be
// opened by touch — three handlers close every route in, measured in the note on Popover.tsx — and
// the console has a mobile drawer. A test that only hovered would pass on a component no phone can
// open.

describe("FormField help", () => {
  afterEach(() => cleanup());

  test("no `?` when the field declares no help", () => {
    render(
      <FormField label="History ceiling" description="Empty means no ceiling.">
        <input />
      </FormField>,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("a click on the `?` reveals the help", () => {
    render(
      <FormField
        label="History ceiling"
        description="Empty means no ceiling."
        help="The agent sends the whole history on every turn."
      >
        <input />
      </FormField>,
    );
    // Before the click the help is nowhere in the document — not merely hidden, since a popover
    // renders into a portal only once open.
    expect(screen.queryByText(/sends the whole history/i)).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/sends the whole history/i)).toBeTruthy();
  });

  // The name has to NAME THE FIELD, not merely exist. A page of twelve fields renders twelve of
  // these, and a generic name on all of them is a tab order of twelve identical buttons: the
  // trigger is reachable, and useless, which is the failure a "has an aria-label" check passes.
  test("the trigger is named after the field it explains", () => {
    render(
      <FormField label="History ceiling" help="Why this field exists.">
        <input />
      </FormField>,
    );
    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-label")).toContain("History ceiling");
  });

  test("the trigger announces its state", () => {
    render(
      <FormField label="History ceiling" help="Why this field exists.">
        <input />
      </FormField>,
    );
    const trigger = screen.getByRole("button");
    // The glyph is decorative, so without a name the button is announced as "?", or as nothing.
    expect(trigger.getAttribute("aria-label")).toBeTruthy();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  // The inline text and the help are different jobs, so declaring one must not silence the other:
  // what the operator needs to fill the field correctly stays on screen either way.
  test("help does not replace the inline description", () => {
    render(
      <FormField
        label="History ceiling"
        description="Empty means no ceiling."
        help="Why this field exists."
      >
        <input />
      </FormField>,
    );
    expect(screen.getByText(/empty means no ceiling/i)).toBeTruthy();
  });
  // Escape means dismiss, and it used to mean the opposite here. Radix reports the trigger's own
  // click, Escape and an outside click through one `onOpenChange(false)`, and the branch that
  // exists so a click can PIN a hover-opened box was taking all three: Escape on a box the pointer
  // had merely hovered open pinned it and left it on screen.
  test("Escape dismisses a popover that hover opened", () => {
    render(
      <FormField label="History ceiling" help="Why this field exists.">
        <input />
      </FormField>,
    );
    const trigger = screen.getByRole("button");
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    expect(screen.getByText(/why this field exists/i)).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByText(/why this field exists/i)).toBeNull();
  });

  // The `?` sits inside the <label>, and an accessible name is computed from the label's whole
  // subtree: the trigger carries its own aria-label, so without an explicit `aria-labelledby` the
  // input is announced as "History ceiling Show help: History ceiling". The control is pointed at
  // the TITLE alone, which wins over the native label.
  test("the field's name is the title, not the title plus the help trigger", () => {
    render(
      <FormField label="History ceiling" help="Why this field exists.">
        <input />
      </FormField>,
    );
    const input = screen.getByRole("textbox");
    const named = document.getElementById(
      input.getAttribute("aria-labelledby") ?? "",
    );
    expect(named?.textContent).toBe("History ceiling");
    expect(named?.querySelector("[role='button']")).toBeNull();
  });

  // The context carried `required` and `invalid` from the first version and nothing read them, so
  // a field declared required was not announced as required and a field-level refusal did not mark
  // the box it was about. A bare native child is wired the same way through `wireNativeControl`.
  test("required and invalid reach the control the field wraps", () => {
    render(
      <FormField label="History ceiling" required error="Too large.">
        <input />
      </FormField>,
    );
    const input = screen.getByRole("textbox");
    expect(input.hasAttribute("required")).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBeTruthy();
  });
});
