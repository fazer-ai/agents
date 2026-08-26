import { describe, expect, test } from "bun:test";
import {
  FOLLOW_UP_DEFAULTS,
  FOLLOW_UP_MAX_STEPS,
  isNewFollowUpEpisode,
  readFollowUpConfig,
  stepDelayMinutes,
} from "@/modules/followups/settings";

describe("readFollowUpConfig", () => {
  test("returns defaults (one step) when settings is empty", () => {
    expect(readFollowUpConfig({})).toEqual(FOLLOW_UP_DEFAULTS);
    expect(readFollowUpConfig(null)).toEqual(FOLLOW_UP_DEFAULTS);
    expect(readFollowUpConfig(undefined)).toEqual(FOLLOW_UP_DEFAULTS);
    expect(readFollowUpConfig({ other: 1 })).toEqual(FOLLOW_UP_DEFAULTS);
  });

  test("pauseWhileAppointment defaults to true; only explicit false disables it", () => {
    expect(readFollowUpConfig({}).pauseWhileAppointment).toBe(true);
    expect(
      readFollowUpConfig({ followUp: { enabled: true } }).pauseWhileAppointment,
    ).toBe(true);
    expect(
      readFollowUpConfig({ followUp: { pauseWhileAppointment: false } })
        .pauseWhileAppointment,
    ).toBe(false);
    expect(
      readFollowUpConfig({ followUp: { pauseWhileAppointment: true } })
        .pauseWhileAppointment,
    ).toBe(true);
  });

  test("legacy single-shot flat fields are IGNORED (no back-compat) → one default step", () => {
    const cfg = readFollowUpConfig({
      followUp: {
        enabled: true,
        delayValue: 2,
        delayUnit: "hours",
        instructions: "Be polite.",
      },
    });
    // `enabled` is honored, but the flat delay/instructions are not read; steps falls to the default.
    expect(cfg.enabled).toBe(true);
    expect(cfg.steps).toEqual(FOLLOW_UP_DEFAULTS.steps);
  });

  test("reads an explicit multi-step sequence", () => {
    const cfg = readFollowUpConfig({
      followUp: {
        enabled: true,
        steps: [
          { delayValue: 30, delayUnit: "minutes", instructions: "first" },
          {
            delayValue: 1,
            delayUnit: "days",
            instructions: "last",
            assignLabel: "sem-resposta",
            resolve: true,
          },
        ],
      },
    });
    expect(cfg.steps).toHaveLength(2);
    expect(cfg.steps[0]).toEqual({
      delayValue: 30,
      delayUnit: "minutes",
      instructions: "first",
    });
    expect(cfg.steps[1]).toEqual({
      delayValue: 1,
      delayUnit: "days",
      instructions: "last",
      // legacy single `assignLabel` string is read into the new `assignLabels` array (back-compat)
      assignLabels: ["sem-resposta"],
      resolve: true,
    });
  });

  test("resolve is honored ONLY on the last step (stripped from earlier ones)", () => {
    const cfg = readFollowUpConfig({
      followUp: {
        steps: [
          { delayValue: 1, delayUnit: "hours", resolve: true },
          { delayValue: 2, delayUnit: "hours", resolve: true },
        ],
      },
    });
    expect(cfg.steps[0]?.resolve).toBeUndefined();
    expect(cfg.steps[1]?.resolve).toBe(true);
  });

  // The strip above takes `resolve` OFF a step, and everything else has to survive it. It used to
  // rebuild the step field by field, which meant it listed what to keep — so a step field added
  // later was dropped here, silently, and only in this one case: a mid-sequence step that happens
  // to carry `resolve`. `ignoreAppointmentPause` (#103) is the first field that would have hit it.
  test("stripping resolve keeps every OTHER field of that step", () => {
    const cfg = readFollowUpConfig({
      followUp: {
        steps: [
          {
            delayValue: 1,
            delayUnit: "hours",
            instructions: "pay to keep the slot",
            assignLabels: ["awaiting-payment"],
            resolve: true,
            ignoreAppointmentPause: true,
          },
          { delayValue: 2, delayUnit: "hours" },
        ],
      },
    });
    expect(cfg.steps[0]).toEqual({
      delayValue: 1,
      delayUnit: "hours",
      instructions: "pay to keep the slot",
      assignLabels: ["awaiting-payment"],
      ignoreAppointmentPause: true,
    });
  });

  test("clamps delayValue to minimum 1 and unit falls back", () => {
    const cfg = readFollowUpConfig({
      followUp: { steps: [{ delayValue: 0, delayUnit: "weeks" }] },
    });
    expect(cfg.steps[0]?.delayValue).toBe(1);
    expect(cfg.steps[0]?.delayUnit).toBe("minutes");
  });

  test("instructions trimmed and capped at 2000 chars", () => {
    const cfg = readFollowUpConfig({
      followUp: { steps: [{ instructions: "  hi  " }] },
    });
    expect(cfg.steps[0]?.instructions).toBe("hi");
    const cfg2 = readFollowUpConfig({
      followUp: { steps: [{ instructions: "x".repeat(3000) }] },
    });
    expect(cfg2.steps[0]?.instructions).toHaveLength(2000);
  });

  test("caps the number of steps at FOLLOW_UP_MAX_STEPS", () => {
    const steps = Array.from({ length: FOLLOW_UP_MAX_STEPS + 3 }, () => ({
      delayValue: 1,
      delayUnit: "hours",
    }));
    const cfg = readFollowUpConfig({ followUp: { steps } });
    expect(cfg.steps).toHaveLength(FOLLOW_UP_MAX_STEPS);
  });

  test("an empty/invalid steps array falls back to one default step", () => {
    expect(readFollowUpConfig({ followUp: { steps: [] } }).steps).toEqual(
      FOLLOW_UP_DEFAULTS.steps,
    );
    expect(
      readFollowUpConfig({ followUp: { steps: ["nope", 5] } }).steps,
    ).toEqual(FOLLOW_UP_DEFAULTS.steps);
  });

  test("a blank assignLabel is dropped (not stored as empty string)", () => {
    const cfg = readFollowUpConfig({
      followUp: {
        steps: [{ delayValue: 1, delayUnit: "hours", assignLabel: "   " }],
      },
    });
    expect(cfg.steps[0]?.assignLabels).toBeUndefined();
  });

  test("assignLabels: multiple labels are trimmed, bounded and de-duplicated", () => {
    const cfg = readFollowUpConfig({
      followUp: {
        steps: [
          {
            delayValue: 1,
            delayUnit: "hours",
            assignLabels: ["  vip ", "vip", "urgente", "", 5],
          },
        ],
      },
    });
    expect(cfg.steps[0]?.assignLabels).toEqual(["vip", "urgente"]);
  });
});

describe("isNewFollowUpEpisode", () => {
  const t0 = new Date("2026-06-18T23:06:59Z");
  const later = new Date("2026-06-18T23:18:25Z");
  const earlier = new Date("2026-06-18T22:00:00Z");

  test("a genuine customer inbound with no follow-up yet → fresh episode", () => {
    expect(isNewFollowUpEpisode(null, later)).toBe(true);
  });

  test("no genuine customer inbound → NOT an episode (nothing to follow up on)", () => {
    // A control command (/teste, /reset) never advances lastInboundAt, so a conversation whose only
    // "messages" are commands has lastInboundAt null and must not arm a follow-up.
    expect(isNewFollowUpEpisode(null, null)).toBe(false);
    expect(isNewFollowUpEpisode(t0, null)).toBe(false);
  });

  test("customer replied AFTER the last follow-up → fresh episode (sequence restarts)", () => {
    expect(isNewFollowUpEpisode(t0, later)).toBe(true);
  });

  test("last inbound is before/at the last follow-up → still the same episode", () => {
    expect(isNewFollowUpEpisode(t0, earlier)).toBe(false);
    expect(isNewFollowUpEpisode(t0, t0)).toBe(false);
  });
});

describe("stepDelayMinutes", () => {
  test("minutes passthrough", () => {
    expect(
      stepDelayMinutes({
        delayValue: 90,
        delayUnit: "minutes",
        instructions: "",
      }),
    ).toBe(90);
  });

  test("hours conversion", () => {
    expect(
      stepDelayMinutes({ delayValue: 2, delayUnit: "hours", instructions: "" }),
    ).toBe(120);
  });

  test("days conversion", () => {
    expect(
      stepDelayMinutes({ delayValue: 1, delayUnit: "days", instructions: "" }),
    ).toBe(1440);
  });

  test("clamps to minimum 1 minute", () => {
    expect(
      stepDelayMinutes({
        delayValue: 0,
        delayUnit: "minutes",
        instructions: "",
      }),
    ).toBe(1);
  });

  test("clamps to maximum 43200 minutes (30 days)", () => {
    expect(
      stepDelayMinutes({
        delayValue: 100,
        delayUnit: "days",
        instructions: "",
      }),
    ).toBe(43200);
  });
});
