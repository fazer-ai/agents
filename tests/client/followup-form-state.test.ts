import { describe, expect, test } from "bun:test";
import {
  followUpToForm,
  followUpToStored,
} from "@/client/pages/agents/followUpFormState";
import { readFollowUpConfig } from "@/modules/followups/settings";
import { followUpStepFields } from "../utils/followup-step-fields";

// The Behavior save REPLACES the whole `followUp` block with what the form holds, and each step is
// rebuilt field by field. So a field the form does not carry is not merely un-editable: it is
// DELETED on the next save by an operator who never opened that switch. That already happened to
// `tts.baseURL`, which REST and MCP accept and the form did not. A step is the worst shape for it —
// a bag of optional fields, three of them today — so the guard here is not a hand-written list: it
// is the field list of `FollowUpStep` itself, read off the source the runtime consumes.

// Every interface field, each set to something a default read would NOT produce, so a field the
// form drops comes back different rather than coincidentally equal.
const FULL_STEP = {
  delayValue: 3,
  delayUnit: "days",
  instructions: "ask about the pending payment",
  assignLabels: ["awaiting-payment"],
  resolve: true,
  ignoreAppointmentPause: true,
};

describe("agent editor follow-up round-trip", () => {
  // The helper throws on an empty parse, so this is the assertion that the list is the RIGHT one:
  // it names the field this issue adds, which is what every check below iterates over.
  test("the field list is read off the interface, and it names the new field", () => {
    expect(followUpStepFields()).toContain("ignoreAppointmentPause");
  });

  // The guard that catches the NEXT field: `FollowUpStep` growing a key the form does not carry
  // fails here, at the moment it is added.
  test("the form carries every field the step interface declares", () => {
    expect(Object.keys(FULL_STEP).sort()).toEqual(followUpStepFields());
    const round = followUpToStored(
      followUpToForm({ followUp: { enabled: true, steps: [FULL_STEP] } }),
    );
    expect(Object.keys(round.steps[0] ?? {}).sort()).toEqual(
      followUpStepFields(),
    );
    expect(round.steps[0]).toEqual(FULL_STEP);
  });

  // #103: the switch is HIDDEN while the agent-wide pause is off, because there it decides nothing.
  // Hidden is not off — an operator who turns the pause off, saves, and turns it back on would
  // otherwise find every step's exemption silently cleared.
  test("an exemption survives a save made while the agent-wide pause is off", () => {
    const stored = {
      followUp: {
        enabled: true,
        pauseWhileAppointment: false,
        steps: [
          { delayValue: 1, delayUnit: "hours", instructions: "" },
          FULL_STEP,
        ],
      },
    };
    const round = followUpToStored(followUpToForm(stored));
    expect(round.pauseWhileAppointment).toBe(false);
    expect(round.steps[1]?.ignoreAppointmentPause).toBe(true);
  });

  // A step that did not opt out writes no key at all, so an agent saved through this form stays
  // byte-comparable with one that was never opened.
  test("a step without the exemption writes no key for it", () => {
    const round = followUpToStored(followUpToForm({}));
    expect(round.steps[0]).toEqual({
      delayValue: 30,
      delayUnit: "minutes",
      instructions: "",
    });
  });

  // And what the form writes is what the runtime reads back: the pair is only worth anything if
  // the reader agrees, since the reader is what the sweep and the handler consult.
  test("what the form stores is what the runtime reader sees", () => {
    const stored = followUpToStored(
      followUpToForm({ followUp: { enabled: true, steps: [FULL_STEP] } }),
    );
    const cfg = readFollowUpConfig({ followUp: stored });
    expect(cfg.steps[0]?.ignoreAppointmentPause).toBe(true);
    expect(cfg.steps[0]?.delayValue).toBe(3);
    expect(cfg.pauseWhileAppointment).toBe(true);
  });
});
