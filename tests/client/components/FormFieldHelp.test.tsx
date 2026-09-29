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

// NO real i18n instance here: `HelpPopover` COMPOSES the accessible name, so the fallback `t`
// react-i18next hands out with no provider returns the default string these assertions want. And
// `bun test` shares one worker across files, so initialising i18n here would slow every file that
// runs afterwards past its per-test budget: a top-level import is a global side effect.
const { FormField } = await import("@/client/components/FormField");
const { Input } = await import("@/client/components/Input");
const { Select } = await import("@/client/components/Select");

// The `?` that opens a field's long-form help, asserted through a CLICK reaching rendered text
// rather than by finding the button or a prop. Radix composes the trigger's handler with
// `checkForDefaultPrevented`, so a trigger `onClick` that calls `preventDefault` renders fine and
// never opens. And it is a Popover, not a Tooltip, because a Radix tooltip cannot be opened by
// touch (docs/ui.md, Where help goes): a test that only hovered would pass on what no phone can
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
    // Before the click the help is nowhere in the document, not merely hidden, since a popover
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
  // NOTE: Radix reports the trigger's own click, Escape and an outside click through one
  // `onOpenChange(false)`, so the branch that lets a click PIN a hover-opened box must not take
  // Escape too: Escape on a hover-opened box dismisses it.
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

  // NOTE: the field's `required` and `invalid` must reach the control, or a required field is not
  // announced as required and a field-level refusal does not mark its box. A bare native child is
  // wired the same way through `wireNativeControl`.
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
  // NOTE: why the label points at the control instead of wrapping it: a <label> forwards a click on
  // any NON-INTERACTIVE descendant to its control, and a `<span role="button">` is not interactive
  // content in the HTML sense, so a wrapping label would let this click toggle the checkbox.
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

  // NOTE: the title still NAMES the control, so a browser focuses it on click. Asserted as the
  // association and not as focus, because happy-dom implements a wrapping label's activation (which
  // the checkbox above relies on) but not `htmlFor`'s: a focus assertion would test the DOM stub.
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
  // NOTE: under `group` the heading belongs to the WRAPPER. Handing it down would rename every
  // child after the group, because `aria-labelledby` beats a control's own `aria-label`.
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
  // NOTE: this asserts the observable contract only. It does NOT exercise the guard that makes it
  // true in a browser (Radix's non-modal close calls `triggerRef.focus()` unless `onCloseAutoFocus`
  // is defaulted away): happy-dom never runs that path, so deleting the guard leaves this test
  // green.
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

  // NOTE: `aria-describedby` takes a LIST, and a control that describes itself sits inside a field
  // that describes it too. Spreading the caller's props over the merge would drop the field's
  // message, which is how a validation message goes unannounced.
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
  // NOTE: a caller that already knows its control is invalid (BusinessHoursForm marks an
  // overlapping window) must keep saying so: with `{...props}` spread first, the computed
  // `aria-invalid` has to read the caller's own value or it wins over it.
  test("a control keeps the invalid state its caller declared", () => {
    render(
      <FormField label="Opens at">
        <Input aria-invalid value="" onChange={() => {}} />
      </FormField>,
    );
    expect(
      screen.getByRole("textbox").getAttribute("aria-invalid"),
    ).toBeTruthy();
  });

  // NOTE: the announcement and the drawing have to agree: a `FormField error=` around a <Select>
  // (ToolEditModal's method and transport) must paint the select's border too, not only set its
  // `aria-invalid`.
  test("a field-level refusal marks the select it is about, not just announces it", () => {
    render(
      <FormField label="Method" error="Not allowed for this transport.">
        <Select value="GET" onChange={() => {}}>
          <option value="GET">GET</option>
        </Select>
      </FormField>,
    );
    const select = screen.getByRole("combobox");
    expect(select.getAttribute("aria-invalid")).toBeTruthy();
    expect(select.className).toContain("border-error");
  });

  // NOTE: a group's error is a statement about the COMPOSITE. Propagating it would paint every
  // control inside red over one refusal (ToolEditModal's AI fields), while a bare <input> in the
  // same group stays normal because nothing wires it.
  test("a group's error marks the group, not every control inside it", () => {
    render(
      <FormField label="AI fields" group error="Two fields share a name.">
        <div>
          <Input value="" onChange={() => {}} />
          <Input value="" onChange={() => {}} />
        </div>
      </FormField>,
    );
    expect(screen.getByRole("group").getAttribute("aria-invalid")).toBeTruthy();
    for (const box of screen.getAllByRole("textbox")) {
      expect(box.getAttribute("aria-invalid")).toBeNull();
      expect(box.className).not.toContain("border-error");
    }
  });

  // `required` on a composite is not decoration: handed down, it makes every part of the composite
  // individually mandatory to submit, which is a different form than the one the caller declared.
  test("a group's required does not make each part mandatory", () => {
    render(
      <FormField label="URL template" group required>
        <div>
          <Input value="" onChange={() => {}} />
          <Input value="" onChange={() => {}} />
        </div>
      </FormField>,
    );
    for (const box of screen.getAllByRole("textbox")) {
      expect((box as HTMLInputElement).required).toBe(false);
    }
  });

  // A child that brought its own id keeps it, so the label has to point at THAT one. Pointing at
  // the generated id would name nothing: clicking the title would focus nothing and the control
  // would have no name at all.
  test("the label follows an id the child brought itself", () => {
    render(
      <FormField label="Email">
        <input id="email-field" />
      </FormField>,
    );
    const label = document.querySelector("label") as HTMLLabelElement;
    expect(label.htmlFor).toBe("email-field");
    expect(screen.getByRole("textbox").id).toBe("email-field");
  });

  // NOTE: Radix arms `FocusScope`'s Tab handler with a hard-coded `loop: true` even when non-modal,
  // and our help is prose, so a focused box would cancel every Tab and Shift+Tab until Escape. The
  // trigger keeps focus instead, so Tab carries on through the form.
  test("opening the help with the keyboard leaves focus on the trigger", () => {
    render(
      <FormField label="History ceiling" help="Why this field exists.">
        <input />
      </FormField>,
    );
    const trigger = screen.getByRole("button");
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement === trigger).toBe(true);
  });

  // NOTE: the BOX is a `role="dialog"` Radix names nothing, so without this every help on a page is
  // the same anonymous dialog. Naming the trigger does not fix it: `aria-controls` points at the
  // box, it does not name it.
  test("the open help box is named after the field", () => {
    render(
      <FormField label="History ceiling" help="Why this field exists.">
        <input />
      </FormField>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(
      screen.getByRole("dialog", { name: /History ceiling/ }),
    ).toBeTruthy();
  });

  // NOTE: pinning must DISARM the close a preceding `pointerleave` scheduled (hover the `?`, move
  // off, press Enter within 140ms). Otherwise the pinned box vanishes, and `pinned` stays true on a
  // closed box so the next hover opens one that `closeOnLeave` refuses to close.
  test("pinning a hover-opened popover survives the close it interrupted", async () => {
    render(
      <FormField label="History ceiling" help="Why this field exists.">
        <input />
      </FormField>,
    );
    const trigger = screen.getByRole("button");
    trigger.focus();
    fireEvent.pointerEnter(trigger, { pointerType: "mouse" });
    fireEvent.pointerLeave(trigger, { pointerType: "mouse" });
    // The pin arrives while the close is still pending, which is the whole point: firing it after
    // the timer had already run would test nothing.
    fireEvent.click(trigger);
    await act(async () => {
      await new Promise((r) => setTimeout(r, CLOSE_WAIT_MS));
    });
    expect(screen.queryByText(/why this field exists/i)).toBeTruthy();
  });
});
