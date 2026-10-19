/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/client/components/Button";
import { Modal, useModalController } from "@/client/components/Modal";
import {
  NumberInput,
  RangeHolds,
  RangeHoldsSuspended,
} from "@/client/components/NumberInput";
import { intRange, numberRange } from "@/lib/number-range";

// The real instance, so the message is interpolated as the console shows it.
await import("@/client/lib/i18n");

// The field draws the range the server refuses outside of and holds the nearest Save while its value
// is out of it, so a typed -10 never reaches the server.

const WINDOW = intRange(3, 120);

function Form({
  initial,
  optional = false,
  disabled = false,
  range = WINDOW,
}: {
  initial: string;
  optional?: boolean;
  disabled?: boolean;
  range?: ReturnType<typeof intRange>;
}) {
  const [value, setValue] = useState(initial);
  const [shown, setShown] = useState(true);
  return (
    <RangeHolds>
      {shown && (
        <NumberInput
          aria-label="window"
          range={range}
          value={value}
          optional={optional}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
      <Button onClick={() => setShown(false)}>hide</Button>
      <Button holdOnRange>Save</Button>
      <Button>Other</Button>
    </RangeHolds>
  );
}

const save = () => screen.getByRole("button", { name: "Save" });
const type = (v: string) =>
  fireEvent.change(screen.getByLabelText("window"), { target: { value: v } });

describe("NumberInput", () => {
  afterEach(() => cleanup());

  test("a value below the range holds Save and says the range; fixing it releases Save", () => {
    render(<Form initial="10" />);
    expect(save()).not.toBeDisabled();
    type("-10");
    expect(save()).toBeDisabled();
    expect(screen.getByText("Between 3 and 120.")).toBeInTheDocument();
    type("3");
    expect(save()).not.toBeDisabled();
  });

  test("a value above the range holds Save", () => {
    render(<Form initial="10" />);
    type("121");
    expect(save()).toBeDisabled();
  });

  test("a fraction where the range counts whole units holds Save and says so", () => {
    render(<Form initial="10" />);
    type("2.5e1");
    expect(save()).not.toBeDisabled();
    type("10.5");
    expect(save()).toBeDisabled();
    expect(screen.getByText("Use a whole number.")).toBeInTheDocument();
  });

  test("a fraction inside a decimal range passes", () => {
    render(<Form initial="0.5" range={numberRange(0, 1)} />);
    type("0.75");
    expect(save()).not.toBeDisabled();
  });

  test("empty holds a required field and passes an optional one", () => {
    render(<Form initial="10" />);
    type("");
    expect(save()).toBeDisabled();
    cleanup();
    render(<Form initial="10" optional />);
    type("");
    expect(save()).not.toBeDisabled();
  });

  test("a disabled field holds nothing, since the operator cannot change it", () => {
    render(<Form initial="-10" disabled />);
    expect(save()).not.toBeDisabled();
  });

  test("a field taken off screen releases its hold", () => {
    render(<Form initial="-10" />);
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "hide" }));
    expect(save()).not.toBeDisabled();
  });

  // A Behavior section hidden by the agent's mode is drawn but not shown, so its fields stay mounted.
  test("a field in a suspended part of the form holds nothing until it is shown again", () => {
    function Hidden() {
      const [suspended, setSuspended] = useState(true);
      return (
        <RangeHolds>
          <RangeHoldsSuspended suspended={suspended}>
            <NumberInput aria-label="window" range={WINDOW} value="-10" />
          </RangeHoldsSuspended>
          <Button onClick={() => setSuspended(!suspended)}>toggle</Button>
          <Button holdOnRange>Save</Button>
        </RangeHolds>
      );
    }
    render(<Hidden />);
    expect(save()).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(save()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "toggle" }));
    expect(save()).not.toBeDisabled();
  });

  test("only a holdOnRange button is held", () => {
    render(<Form initial="-10" />);
    expect(screen.getByRole("button", { name: "Other" })).not.toBeDisabled();
  });
});

function NumberModal() {
  const modal = useModalController();
  const opened = useRef(false);
  const [value, setValue] = useState("10");
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    modal.open();
  }, [modal]);
  return (
    <Modal
      modal={modal}
      title="Edit"
      footer={<Button holdOnRange>Save</Button>}
    >
      <NumberInput
        aria-label="window"
        range={WINDOW}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </Modal>
  );
}

// Every modal is a <RangeHolds>, and the footer sits inside it, so a resource modal's Save holds
// without wiring of its own.
test("a number out of range in a modal's body holds the footer's Save", () => {
  render(<NumberModal />);
  expect(save()).not.toBeDisabled();
  type("-509");
  expect(save()).toBeDisabled();
  cleanup();
});
