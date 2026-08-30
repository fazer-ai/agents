/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

// Comfortably past Popover's CLOSE_DELAY_MS (140), which is the gap the pointer is given to reach
// the box before it goes away.
const CLOSE_WAIT_MS = 400;

// The REAL i18n instance, not the fallback `t` that react-i18next hands out with no provider: that
// one returns the default string untouched, so an assertion about the accessible name would be
// reading "Help about {{subject}}" and calling it a name.
await import("@/client/lib/i18n");
const { FormField } = await import("@/client/components/FormField");
const { Input } = await import("@/client/components/Input");

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
  // Measured, not reasoned, and it is why the label points at the control instead of wrapping it: a
  // <label> forwards a click on any NON-INTERACTIVE descendant to the control it labels, and ARIA
  // makes a `<span role="button">` operable without making it *interactive content* in the HTML
  // sense. With the old wrapping label this click toggled the checkbox, so asking for help mutated
  // the form. A checkbox is the shape that makes it visible; on an input it merely stole focus.
  test("clicking the `?` does not operate the control beside it", () => {
    render(
      <FormField label="Active" help="Why this field exists.">
        <input type="checkbox" />
      </FormField>,
    );
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button"));
    expect(box.checked).toBe(false);
    // and the help did open, so this is not passing because the trigger is inert
    expect(screen.getByText(/why this field exists/i)).toBeTruthy();
  });

  // The other half of the same association: the title still NAMES the control, so a browser focuses
  // it on click. Asserted as the association and not as focus, because happy-dom implements a
  // wrapping label's activation behaviour (which is how the checkbox above is measured) but not
  // `htmlFor`'s: a focus assertion here would be testing the DOM stub, not the component.
  test("the title names the control it sits above", () => {
    render(
      <FormField label="History ceiling" help="Why this field exists.">
        <input />
      </FormField>,
    );
    const input = screen.getByRole("textbox");
    const label = document.querySelector("label") as HTMLLabelElement;
    expect(label.textContent).toBe("History ceiling");
    expect(label.htmlFor).toBe(input.id);
    expect(input.id.length > 0).toBe(true);
  });
  // `group` exists for a field whose children are NOT one focusable control, and there the heading
  // belongs to the WRAPPER. Handing it down as well renamed every child after the group, because
  // `aria-labelledby` beats a control's own `aria-label`: a row of three inputs announced the same
  // words three times, and the one thing that told them apart was gone.
  test("a group's heading does not rename the controls inside it", () => {
    render(
      <FormField label="Reminders" group>
        <div>
          {/* OUR Input, not a bare <input>: the context is what a control reads, and a bare native
              child is reached by `wireNativeControl`, which only walks a direct child. A test built
              on bare inputs inside a wrapper exercises neither path and passes on anything. */}
          <Input aria-label="Reminder 1" value="" onChange={() => {}} />
          <Input aria-label="Reminder 2" value="" onChange={() => {}} />
        </div>
      </FormField>,
    );
    const names = screen
      .getAllByRole("textbox")
      .map(
        (el) =>
          el.getAttribute("aria-labelledby") ?? el.getAttribute("aria-label"),
      );
    expect(names).toEqual(["Reminder 1", "Reminder 2"]);
  });
  // WHAT THIS PROVES AND WHAT IT DOES NOT. It asserts the observable contract: a box that opened
  // because the pointer passed over closes on its own and leaves focus where it was. It does NOT
  // exercise the guard that makes that true in a browser — Radix's non-modal close calls
  // `triggerRef.focus()` unless `onCloseAutoFocus` is defaulted away, and removing that guard here
  // changes nothing, because happy-dom does not run that path. Measured, not assumed: with the
  // guard deleted, focus still stayed on the input.
  //
  // So the guard rests on reading `@radix-ui/react-popover`'s source, and this test rests on the
  // behaviour around it. Kept apart on purpose, because a test that cannot fail for the reason it
  // names is worse than no test: it reads as coverage.
  test("a hover-opened popover closes on its own and leaves focus alone", async () => {
    render(
      <FormField label="History ceiling" help="Why this field exists.">
        <input />
      </FormField>,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    const trigger = screen.getByRole("button");
    input.focus();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    // `act` around a real wait rather than `waitFor`: the close is a setTimeout that ends in a
    // React state update, and waitFor polls outside act, so the update lands after the assertion.
    await act(async () => {
      await new Promise((r) => setTimeout(r, CLOSE_WAIT_MS));
    });
    expect(screen.queryByText(/why this field exists/i)).toBeNull();
    // A BOOLEAN, never the node: a failing expectation holding a happy-dom element serializes a
    // cyclic tree and floods the runner.
    expect(document.activeElement === input).toBe(true);
  });

  // `aria-describedby` takes a LIST, and a control that already describes itself sits inside a
  // field that describes it too. The component computed the merge and then spread the caller's
  // props over it, so declaring a description on the control silently dropped the field's message,
  // which is how a validation message goes unannounced.
  test("a control's own description does not drop the field's", () => {
    render(
      <FormField label="History ceiling" error="Too large.">
        <div>
          <span id="own">extra</span>
          <Input aria-describedby="own" value="" onChange={() => {}} />
        </div>
      </FormField>,
    );
    const ids = (
      screen.getByRole("textbox").getAttribute("aria-describedby") ?? ""
    ).split(" ");
    expect(ids.includes("own")).toBe(true);
    // and the field's own message is still named alongside it
    expect(ids.length > 1).toBe(true);
  });
});
