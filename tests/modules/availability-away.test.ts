import { describe, expect, test } from "bun:test";
import {
  awayMessageDue,
  readAvailabilityConfig,
  renderAwayMessage,
} from "@/modules/availability/away";
import type { Schedule } from "@/modules/business-hours/hours";

// Decision table for the customer-facing out-of-hours copy (#153). Fixed instants, no real clock:
// 2024-01-07 is a Sunday, 2024-01-08 a Monday.
const MON_9_TO_17: Schedule = {
  windows: [{ day: 1, start: "09:00", end: "17:00" }],
  exceptions: [],
  timezone: "UTC",
};
const SUNDAY = new Date("2024-01-07T12:00:00Z");
// Monday 2024-01-08 09:00 UTC, rendered in each placeholder's own language.
const NEXT_PT = "segunda-feira, 08/01, 09:00";
const NEXT_EN = "Monday, 01/08, 09:00";

describe("readAvailabilityConfig", () => {
  test("absent/garbage block → empty copy, i.e. the pre-#153 silence", () => {
    expect(readAvailabilityConfig(undefined).awayMessage).toBe("");
    expect(readAvailabilityConfig({}).awayMessage).toBe("");
    expect(readAvailabilityConfig({ availability: 7 }).awayMessage).toBe("");
    expect(
      readAvailabilityConfig({ availability: { awayMessage: 42 } }).awayMessage,
    ).toBe("");
  });

  test("the switch is off unless it was stored as a real boolean true", () => {
    expect(readAvailabilityConfig(undefined).enabled).toBe(false);
    expect(readAvailabilityConfig({ availability: {} }).enabled).toBe(false);
    expect(
      readAvailabilityConfig({ availability: { enabled: "yes" } }).enabled,
    ).toBe(false);
    expect(
      readAvailabilityConfig({ availability: { enabled: 1 } }).enabled,
    ).toBe(false);
    expect(
      readAvailabilityConfig({ availability: { enabled: true } }).enabled,
    ).toBe(true);
  });

  // The copy SURVIVES the switch being off: that is the whole point of having a switch instead of
  // making an empty textarea mean "off". An operator pausing the message keeps what they wrote.
  test("copy is read whatever the switch says", () => {
    expect(
      readAvailabilityConfig({
        availability: { enabled: false, awayMessage: "Voltamos amanha." },
      }),
    ).toEqual({ enabled: false, awayMessage: "Voltamos amanha." });
  });

  test("copy is trimmed, so whitespace never counts as configured", () => {
    expect(
      readAvailabilityConfig({ availability: { awayMessage: "  oi  " } })
        .awayMessage,
    ).toBe("oi");
    expect(
      readAvailabilityConfig({ availability: { awayMessage: "   " } })
        .awayMessage,
    ).toBe("");
  });
});

describe("renderAwayMessage", () => {
  test("no copy → nothing is sent (the feature is off by default)", () => {
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "",
        schedule: MON_9_TO_17,
        now: SUNDAY,
      }),
    ).toEqual({ send: false, reason: "not_configured" });
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "   ",
        schedule: MON_9_TO_17,
        now: SUNDAY,
      }),
    ).toEqual({ send: false, reason: "not_configured" });
  });

  // The switch is checked FIRST: a paused message is paused even when the copy is perfect and the
  // schedule has a next opening to promise. Nothing downstream of it runs.
  test("the switch off sends nothing, and says so", () => {
    expect(
      renderAwayMessage({
        enabled: false,
        copy: "Voltamos {proximo_atendimento}.",
        schedule: MON_9_TO_17,
        now: SUNDAY,
      }),
    ).toEqual({ send: false, reason: "disabled" });
  });

  test("the switch on with no copy is still nothing to send", () => {
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "   ",
        schedule: MON_9_TO_17,
        now: SUNDAY,
      }),
    ).toEqual({ send: false, reason: "not_configured" });
  });

  test("copy with no placeholder goes out exactly as written", () => {
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "Estamos fechados agora.",
        schedule: MON_9_TO_17,
        now: SUNDAY,
      }),
    ).toEqual({ send: true, text: "Estamos fechados agora." });
  });

  test("each placeholder renders the next opening in its own language", () => {
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "Voltamos {proximo_atendimento}.",
        schedule: MON_9_TO_17,
        now: SUNDAY,
      }),
    ).toEqual({ send: true, text: `Voltamos ${NEXT_PT}.` });
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "We are back {next_open}.",
        schedule: MON_9_TO_17,
        now: SUNDAY,
      }),
    ).toEqual({ send: true, text: `We are back ${NEXT_EN}.` });
  });

  test("every occurrence is replaced, and mixed copy stays in its own languages", () => {
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "{proximo_atendimento} / {next_open} / {proximo_atendimento}",
        schedule: MON_9_TO_17,
        now: SUNDAY,
      }),
    ).toEqual({
      send: true,
      text: `${NEXT_PT} / ${NEXT_EN} / ${NEXT_PT}`,
    });
  });

  // The value comes from nextOpenAt, so it is exception-aware: with Monday taken by a holiday the
  // copy must promise Tuesday, not the weekly grid's Monday.
  test("the promised time skips a date exception", () => {
    const withHoliday: Schedule = {
      windows: [
        { day: 1, start: "09:00", end: "17:00" },
        { day: 2, start: "09:00", end: "17:00" },
      ],
      exceptions: [{ date: "2024-01-08", label: "Feriado", ranges: [] }],
      timezone: "UTC",
    };
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "Voltamos {proximo_atendimento}.",
        schedule: withHoliday,
        now: SUNDAY,
      }),
    ).toEqual({ send: true, text: "Voltamos terça-feira, 09/01, 09:00." });
  });

  // The horizon is a full year, so the promised date can land in the NEXT one and read as this
  // week's. The year shows up exactly there, and nowhere else (every case above renders without it).
  test("a reopening in another year is dated with the year", () => {
    const wednesdays: Schedule = {
      windows: [{ day: 3, start: "09:00", end: "17:00" }],
      exceptions: [],
      timezone: "UTC",
    };
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "Voltamos {proximo_atendimento}. / {next_open}",
        schedule: wednesdays,
        now: new Date("2024-12-30T12:00:00Z"), // Monday, two days before the turn of the year
      }),
    ).toEqual({
      send: true,
      text: "Voltamos quarta-feira, 01/01/2025, 09:00. / Wednesday, 01/01/2025, 09:00",
    });
  });

  // Copy that promises a return time cannot be sent when there is no return time to promise: a
  // mutilated sentence and an invented one are both worse than the note the operator already gets.
  test("a schedule that never opens suppresses copy that promises a time", () => {
    const neverOpens: Schedule = {
      windows: [{ day: 1, start: "09:00", end: "17:00" }],
      exceptions: [
        {
          date: "2024-01-01",
          dateEnd: "2024-12-31",
          recurring: true,
          label: "Fechado indefinidamente",
          ranges: [],
        },
      ],
      timezone: "UTC",
    };
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "Voltamos {proximo_atendimento}.",
        schedule: neverOpens,
        now: SUNDAY,
      }),
    ).toEqual({ send: false, reason: "no_next_open" });
  });

  test("copy that promises nothing still goes out on a schedule that never opens", () => {
    const neverOpens: Schedule = {
      windows: [{ day: 1, start: "09:00", end: "17:00" }],
      exceptions: [
        {
          date: "2024-01-01",
          dateEnd: "2024-12-31",
          recurring: true,
          ranges: [],
        },
      ],
      timezone: "UTC",
    };
    expect(
      renderAwayMessage({
        enabled: true,
        copy: "Estamos fechados.",
        schedule: neverOpens,
        now: SUNDAY,
      }),
    ).toEqual({ send: true, text: "Estamos fechados." });
  });
});

// The cadence is the away message's own, on its own watermark: the operator note answers a question
// that does not change, this one answers a question the customer asks again every day.
describe("awayMessageDue", () => {
  const SP: Schedule = {
    windows: [{ day: 1, start: "09:00", end: "17:00" }],
    exceptions: [],
    timezone: "America/Sao_Paulo",
  };

  test("never sent → due", () => {
    expect(awayMessageDue(MON_9_TO_17, SUNDAY, null)).toBe(true);
  });

  test("already sent the same local day → not due", () => {
    expect(
      awayMessageDue(MON_9_TO_17, SUNDAY, new Date("2024-01-07T08:00:00Z")),
    ).toBe(false);
  });

  test("sent on an earlier local day → due again", () => {
    expect(
      awayMessageDue(MON_9_TO_17, SUNDAY, new Date("2024-01-06T20:00:00Z")),
    ).toBe(true);
  });

  // The day boundary is the SCHEDULE's, not UTC's: 12:00 local is Jan 7 in UTC and 21:30 local is
  // already Jan 8 there, so a UTC comparison would hand the customer a second message before their
  // day ended.
  test("the local day boundary is the schedule timezone's, not UTC's", () => {
    const sentAt = new Date("2024-01-07T15:00:00Z"); // Sun 12:00 local, Jan 7 UTC
    const now = new Date("2024-01-08T00:30:00Z"); // Sun 21:30 local, Jan 8 UTC
    expect(awayMessageDue(SP, now, sentAt)).toBe(false);
  });
});
