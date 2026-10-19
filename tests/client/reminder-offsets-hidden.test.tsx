/// <reference lib="dom" />

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NumberInput, RangeHolds } from "@/client/components";
import {
  CalendarSubTabPanels,
  ReminderConfigEditor,
} from "@/client/pages/resources/IntegrationEditModal";
import { intRange } from "@/lib/number-range";

afterEach(cleanup);

// With reminders off the offset rows are not drawn, so an out-of-range draft cannot hold Save: it goes
// back as loaded, or the server refuses the whole integration over a field nobody can see.
test("an out-of-range offset typed, then reminders off, saves the offsets as loaded", () => {
  const loaded = {
    appointmentReminders: { enabled: true, offsetsHours: [24] },
  };
  const sent: Record<string, unknown>[] = [];
  render(
    <ReminderConfigEditor
      cfg={loaded}
      loadedCfg={loaded}
      setCfg={(patch) => sent.push(patch)}
    />,
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "Amount" }), {
    target: { value: "9000" },
  });
  fireEvent.click(
    screen.getByRole("switch", {
      name: "Send reminders before booked appointments",
    }),
  );
  const last = sent.at(-1)?.appointmentReminders as Record<string, unknown>;
  expect(last.enabled).toBe(false);
  expect(last.offsetsHours).toEqual([24]);
});

// The editor unmounts with its sub-tab. Coming back mounts it over the draft, which must not become
// "as loaded": the hidden 9000 would then be sent, and refused, with reminders off.
test("an out-of-range draft survives a sub-tab remount without becoming the loaded offsets", () => {
  const loaded = {
    appointmentReminders: { enabled: true, offsetsHours: [24] },
  };
  const sent: Record<string, unknown>[] = [];
  const first = render(
    <ReminderConfigEditor
      cfg={loaded}
      loadedCfg={loaded}
      setCfg={(patch) => sent.push(patch)}
    />,
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "Amount" }), {
    target: { value: "9000" },
  });
  const draft = sent.at(-1) as Record<string, unknown>;
  first.unmount();
  render(
    <ReminderConfigEditor
      cfg={draft}
      loadedCfg={loaded}
      setCfg={(patch) => sent.push(patch)}
    />,
  );
  fireEvent.click(
    screen.getByRole("switch", {
      name: "Send reminders before booked appointments",
    }),
  );
  const last = sent.at(-1)?.appointmentReminders as Record<string, unknown>;
  expect(last.enabled).toBe(false);
  expect(last.offsetsHours).toEqual([24]);
});

// A field holds the modal's Save only while mounted. Switching sub-tab away from an offset out of
// range must keep holding it, or the save goes through to the server's refusal.
test("an out-of-range field on the other Calendar sub-tab still holds the save", () => {
  const held: boolean[] = [];
  const panels = (tab: "calendars" | "reminders") => (
    <RangeHolds onHeldChange={(h) => held.push(h)}>
      <CalendarSubTabPanels
        tab={tab}
        calendars={<p>calendars</p>}
        reminders={
          <NumberInput
            aria-label="offset"
            range={intRange(1, 720)}
            value="9000"
            onChange={() => {}}
          />
        }
      />
    </RangeHolds>
  );
  const { rerender } = render(panels("reminders"));
  expect(held.at(-1)).toBe(true);
  rerender(panels("calendars"));
  expect(held.at(-1)).toBe(true);
  expect(screen.getByText("calendars").parentElement?.hidden).toBe(false);
});
