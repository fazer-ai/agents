import { describe, expect, test } from "bun:test";
import { appointmentPauseApplies } from "@/modules/followups/appointment-pause";
import {
  type FollowUpConfig,
  type FollowUpStep,
  readFollowUpConfig,
} from "@/modules/followups/settings";

// The decision table for the pair that decides whether a live appointment holds a follow-up back:
// the agent-wide flag and the step about to fire (issue #103). Three sites consult this — the
// sweep's enqueue decision, the handler's gate, and the console's indicator — and they reach it by
// completely different routes, so what makes them agree is that there is one function rather than
// three conditions. A table here is what makes the function's answer reviewable without a database.

function cfg(pause: boolean, steps: FollowUpStep[] = []): FollowUpConfig {
  return {
    enabled: true,
    pauseWhileAppointment: pause,
    steps:
      steps.length > 0
        ? steps
        : [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
  };
}

const step = (over: Partial<FollowUpStep> = {}): FollowUpStep => ({
  delayValue: 1,
  delayUnit: "minutes",
  instructions: "",
  ...over,
});

describe("appointmentPauseApplies", () => {
  const CASES: Array<[string, boolean, FollowUpStep | undefined, boolean]> = [
    ["pause on, ordinary step", true, step(), true],
    [
      "pause on, step opted out",
      true,
      step({ ignoreAppointmentPause: true }),
      false,
    ],
    ["pause OFF, ordinary step", false, step(), false],
    // The agent-wide off wins on its own: an opt-out on a step is not a second switch that could
    // somehow turn the pause back ON.
    [
      "pause OFF, step opted out",
      false,
      step({ ignoreAppointmentPause: true }),
      false,
    ],
    // A caller that cannot name a step has not shown an exemption, so the pause stands. This is the
    // console's state between sequences and the sweep's state for a config with no readable step.
    ["pause on, no step at all", true, undefined, true],
    ["pause OFF, no step at all", false, undefined, false],
  ];

  for (const [name, pause, s, expected] of CASES) {
    test(`${name} → pause ${expected ? "applies" : "does not apply"}`, () => {
      expect(appointmentPauseApplies(cfg(pause), s)).toBe(expected);
    });
  }

  // `false` is the ONLY value that turns the agent-wide pause off, and it has to be the boolean.
  // A stored string "false" reads as ON, because the reader's test is `!== false`. Pinned here
  // because the sweep used to ask this in SQL, where `->>` renders the string and the boolean
  // identically and the fence lifted itself on a spelling.
  test.each([
    [undefined, true],
    [true, true],
    [false, false],
    [null, true],
    ["false", true],
    ["true", true],
    [0, true],
  ] as Array<[unknown, boolean]>)(
    "pauseWhileAppointment stored as %p → pause applies: %p",
    (stored, applies) => {
      const bag: Record<string, unknown> = {
        enabled: true,
        steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
      };
      if (stored !== undefined) bag.pauseWhileAppointment = stored;
      const read = readFollowUpConfig({ followUp: bag });
      expect(appointmentPauseApplies(read, read.steps[0])).toBe(applies);
    },
  );

  // And the mirror on the step's side: only the boolean `true` exempts a step, so a truthy string
  // does not silently disable the fence for that step.
  test.each([
    [undefined, true],
    [true, false],
    [false, true],
    ["true", true],
    [1, true],
  ] as Array<[unknown, boolean]>)(
    "ignoreAppointmentPause stored as %p → pause applies: %p",
    (stored, applies) => {
      const bag: Record<string, unknown> = {
        delayValue: 1,
        delayUnit: "minutes",
        instructions: "",
      };
      if (stored !== undefined) bag.ignoreAppointmentPause = stored;
      const read = readFollowUpConfig({
        followUp: { enabled: true, steps: [bag] },
      });
      expect(appointmentPauseApplies(read, read.steps[0])).toBe(applies);
    },
  );
});
