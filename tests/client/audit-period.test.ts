import { describe, expect, test } from "bun:test";
import {
  AUDIT_PERIOD_PRESETS,
  auditPresetOf,
  auditPresetRange,
  isCommittableRange,
  isUsableRange,
  mondayOf,
  msUntilNextLocalMidnight,
  selectedPreset,
  shiftDays,
} from "@/client/lib/auditPeriod";

// The audit page's period presets. Every case below is a DAY chosen to sit on a boundary the naive
// arithmetic gets wrong — month ends, a leap day, a Sunday, a year end — because on an ordinary
// Wednesday in the middle of a 31-day month almost any implementation agrees with this one.

describe("shiftDays crosses the boundaries the calendar has", () => {
  const CASES: [string, string, number, string][] = [
    ["month end", "2026-01-31", 1, "2026-02-01"],
    ["month start backwards", "2026-03-01", -1, "2026-02-28"],
    ["leap day forwards", "2024-02-28", 1, "2024-02-29"],
    ["leap day backwards", "2024-03-01", -1, "2024-02-29"],
    ["year end", "2026-12-31", 1, "2027-01-01"],
    ["year start backwards", "2026-01-01", -1, "2025-12-31"],
    // A DST boundary in São Paulo's old calendar: local `Date` arithmetic lands on the 15th here,
    // which is the failure the UTC arithmetic exists to avoid.
    ["a DST Sunday", "2018-11-04", -1, "2018-11-03"],
  ];
  for (const [name, from, days, want] of CASES) {
    test(name, () => {
      expect(shiftDays(from, days)).toBe(want);
    });
  }
});

describe("mondayOf answers the working week", () => {
  // 2026-09-03 is a Thursday; its Monday is the 31st of August, in the previous month.
  test("a Thursday looks back into the previous month", () => {
    expect(mondayOf("2026-09-03")).toBe("2026-08-31");
  });
  test("a Monday is its own Monday", () => {
    expect(mondayOf("2026-08-31")).toBe("2026-08-31");
  });
  // THE CASE THE OTHER CONVENTION GETS WRONG. A Sunday belongs to the week that opened six days
  // earlier, not to the one starting tomorrow: an incident on Sunday evening is "this week" to
  // nobody on Monday morning if the week opens on Sunday.
  test("a Sunday closes the week that opened on Monday", () => {
    expect(mondayOf("2026-09-06")).toBe("2026-08-31");
  });
});

describe("each preset resolves to the window it names", () => {
  // A Thursday, in a month that follows a 31-day one, in a year that follows a leap year.
  const TODAY = "2026-09-03";
  const CASES: [string, string, string][] = [
    ["today", "2026-09-03", "2026-09-03"],
    ["yesterday", "2026-09-02", "2026-09-02"],
    ["this-week", "2026-08-31", "2026-09-03"],
    ["last-week", "2026-08-24", "2026-08-30"],
    ["this-month", "2026-09-01", "2026-09-03"],
    ["last-month", "2026-08-01", "2026-08-31"],
    ["30d", "2026-08-05", "2026-09-03"],
    ["this-year", "2026-01-01", "2026-09-03"],
    ["last-year", "2025-01-01", "2025-12-31"],
  ];
  for (const [preset, from, to] of CASES) {
    test(preset, () => {
      expect(auditPresetRange(preset as never, TODAY)).toEqual({ from, to });
    });
  }

  // The month whose length the naive "subtract 30 days" answer gets wrong, and the one where
  // "the same day last month" does not exist.
  test("last-month closes on the last day of February, in a leap year", () => {
    expect(auditPresetRange("last-month", "2024-03-15")).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
  });
  test("last-month from the 31st does not overshoot into the same month", () => {
    expect(auditPresetRange("last-month", "2026-03-31")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });
  test("30d is thirty days, counting today", () => {
    const { from, to } = auditPresetRange("30d", "2026-01-30");
    expect({ from, to }).toEqual({ from: "2026-01-01", to: "2026-01-30" });
  });
});

describe("a pair of dates knows which preset it is", () => {
  const TODAY = "2026-09-03";
  // Every preset round-trips, which is what makes a pasted URL select a row instead of "custom"
  // holding the same two dates.
  for (const preset of AUDIT_PERIOD_PRESETS) {
    if (preset === "custom") continue;
    test(`${preset} round-trips`, () => {
      const { from, to } = auditPresetRange(preset, TODAY);
      expect(auditPresetOf(from, to, TODAY)).toBe(preset);
    });
  }

  test("a window no preset names is custom", () => {
    expect(auditPresetOf("2026-08-11", "2026-08-19", TODAY)).toBe("custom");
  });
  test("half a window is custom, not a guess", () => {
    expect(auditPresetOf("2026-09-03", "", TODAY)).toBe("custom");
  });
  test("a date the input cannot emit is custom rather than an error", () => {
    expect(auditPresetOf("2026-9-3", "2026-09-03", TODAY)).toBe("custom");
  });
});

describe("a window is committed only as a usable pair", () => {
  test("two dates in order", () => {
    expect(isUsableRange("2026-08-01", "2026-08-31")).toBe(true);
  });
  test("one day is a window", () => {
    expect(isUsableRange("2026-08-01", "2026-08-01")).toBe(true);
  });
  test("inverted is refused rather than swapped", () => {
    expect(isUsableRange("2026-08-31", "2026-08-01")).toBe(false);
  });
  // THE STATE A DATE INPUT REPORTS WHILE IT IS BEING TYPED. Refusing to HOLD it is what makes
  // keyboard entry impossible; refusing to COMMIT it is the point.
  test("an empty bound is not a window", () => {
    expect(isUsableRange("", "2026-08-31")).toBe(false);
    expect(isUsableRange("2026-08-01", "")).toBe(false);
  });
  test("a half-typed year is not a window", () => {
    expect(isUsableRange("0202-08-01", "2026-08-31")).toBe(false);
  });
  test("a shape the input cannot emit is not a window", () => {
    expect(isUsableRange("2026-8-1", "2026-08-31")).toBe(false);
  });
});

describe("which row the period control shows", () => {
  const TODAY = "2026-09-03";
  // THE CASE THE DERIVED VERSION GOT WRONG, and it is the reason the mode is carried at all: the
  // window Custom opens with is also Today's window, so a selection derived from the dates reads
  // back as Today and the two inputs never appear.
  test("custom stays custom even on a window a preset also names", () => {
    expect(selectedPreset("custom", TODAY, TODAY, TODAY)).toBe("custom");
  });
  test("custom stays custom while its bounds are edited", () => {
    expect(selectedPreset("custom", "2026-08-01", "2026-09-03", TODAY)).toBe(
      "custom",
    );
  });
  test("no mode and no dates is no period", () => {
    expect(selectedPreset("", "", "", TODAY)).toBe("");
  });
  // A pasted link carrying only bounds still lands on the row that names them, which is what keeps
  // a shared URL from reading as "custom" to the person who opens it.
  test("bounds alone resolve to the preset that names them", () => {
    expect(selectedPreset("", "2026-08-01", "2026-08-31", TODAY)).toBe(
      "last-month",
    );
  });
  test("bounds no preset names are custom", () => {
    expect(selectedPreset("", "2026-08-11", "2026-08-19", TODAY)).toBe(
      "custom",
    );
  });
});

// PRESET RANGES ARE NOT UNIQUE, which is the half of the problem the mode was first carried only for
// `custom` to solve. On the days below two named rows resolve to the same two dates, and deriving
// picks whichever comes first in the list — so picking "This week" on a Monday silently showed
// "Today", and the operator's own click was the thing being dropped.
describe("two presets naming the same window", () => {
  const MONDAY = "2026-08-31";
  const FIRST_OF_MONTH = "2026-09-01";
  const NEW_YEAR = "2026-01-01";

  test("on a Monday, this-week is honoured over today", () => {
    expect(selectedPreset("this-week", MONDAY, MONDAY, MONDAY)).toBe(
      "this-week",
    );
  });
  test("with no mode the same bounds still derive to the first match", () => {
    expect(selectedPreset("", MONDAY, MONDAY, MONDAY)).toBe("today");
  });
  test("on the 1st, this-month is honoured over today", () => {
    expect(
      selectedPreset(
        "this-month",
        FIRST_OF_MONTH,
        FIRST_OF_MONTH,
        FIRST_OF_MONTH,
      ),
    ).toBe("this-month");
  });
  test("on January 1, this-year is honoured over today", () => {
    expect(selectedPreset("this-year", NEW_YEAR, NEW_YEAR, NEW_YEAR)).toBe(
      "this-year",
    );
  });

  // THE HINT EXPIRES BY ITSELF, and this is what makes it safe to put a named mode in a URL at all.
  // A link says `period=today` with Thursday's dates in it; opened on Friday, `today` no longer
  // resolves to those dates, so the name is dropped and the dates answer.
  test("a named mode whose arithmetic no longer yields these bounds is ignored", () => {
    expect(
      selectedPreset("today", "2026-09-03", "2026-09-03", "2026-09-04"),
    ).toBe("yesterday");
  });
  test("a mode naming a different window than the bounds is ignored", () => {
    expect(
      selectedPreset("last-month", "2026-09-03", "2026-09-03", "2026-09-03"),
    ).toBe("today");
  });
  // The value comes off a URL, so it is whatever somebody typed.
  test("a mode that is not a preset at all is ignored", () => {
    expect(
      selectedPreset(
        "this-fortnight",
        "2026-09-03",
        "2026-09-03",
        "2026-09-03",
      ),
    ).toBe("today");
  });
  test("a bogus mode with no dates is still no period", () => {
    expect(selectedPreset("this-fortnight", "", "", "2026-09-03")).toBe("");
  });
});

describe("a single bound is still a period", () => {
  const TODAY = "2026-09-03";
  // The mutation `!from || !to` survives every test above and shows the control as "Any period"
  // while the page is filtered by a start date.
  test("from alone opens custom rather than reading as unfiltered", () => {
    expect(selectedPreset("", "2026-08-01", "", TODAY)).toBe("custom");
  });
  test("to alone opens custom too", () => {
    expect(selectedPreset("", "", "2026-08-31", TODAY)).toBe("custom");
  });
});

// The pair rule and the one-sided rule are the same function, and which one applies is decided by
// the window ALREADY APPLIED rather than by what is being typed.
describe("what a draft window may commit", () => {
  const PAIR = { from: "2026-01-01", to: "2026-01-31" };
  const ONE_SIDED = { from: "2026-01-01", to: "" };
  const NONE = { from: "", to: "" };

  test("a usable pair commits over a pair", () => {
    expect(
      isCommittableRange({ from: "2026-03-01", to: "2026-03-31" }, PAIR),
    ).toBe(true);
  });
  test("an inverted pair does not", () => {
    expect(
      isCommittableRange({ from: "2026-03-01", to: "2026-01-31" }, PAIR),
    ).toBe(false);
  });
  // A date input reports "" mid-edit, so half a pair must not fire a request off a window nobody
  // asked for -- and must not drop a bound from the URL on the way.
  test("half a pair does not commit while a pair is applied", () => {
    expect(isCommittableRange({ from: "", to: "2026-01-31" }, PAIR)).toBe(
      false,
    );
    expect(isCommittableRange(NONE, PAIR)).toBe(false);
  });

  // THE CASE THAT COULD NOT BE EDITED AT ALL. With one bound applied, every candidate fails the pair
  // rule, so the input held the new date forever while the query kept the old one.
  test("one bound commits over a one-sided window", () => {
    expect(isCommittableRange({ from: "2026-03-01", to: "" }, ONE_SIDED)).toBe(
      true,
    );
  });
  test("the other bound too", () => {
    expect(isCommittableRange({ from: "", to: "2026-03-01" }, ONE_SIDED)).toBe(
      true,
    );
  });
  test("emptying the last bound removes the filter", () => {
    expect(isCommittableRange(NONE, ONE_SIDED)).toBe(true);
  });
  test("a completed pair still commits over a one-sided window", () => {
    expect(
      isCommittableRange({ from: "2026-01-01", to: "2026-01-31" }, ONE_SIDED),
    ).toBe(true);
  });
  test("a bound that is not a date does not commit", () => {
    expect(isCommittableRange({ from: "0202-01-01", to: "" }, ONE_SIDED)).toBe(
      false,
    );
    expect(isCommittableRange({ from: "2026-1-1", to: "" }, NONE)).toBe(false);
  });
});

describe("how long until the day turns", () => {
  // A second of slack past the boundary, so the timer never lands on a clock that still reads the
  // old day and re-arms for zero.
  test("a minute before midnight is a minute plus the slack", () => {
    expect(
      msUntilNextLocalMidnight("2026-08-31", new Date(2026, 7, 31, 23, 59, 0)),
    ).toBe(60_000 + 1000);
  });
  test("noon is half a day away", () => {
    expect(
      msUntilNextLocalMidnight("2026-08-31", new Date(2026, 7, 31, 12, 0, 0)),
    ).toBe(43_200_000 + 1000);
  });
  test("it crosses the end of a month", () => {
    const at = new Date(2026, 7, 31, 12, 0, 0);
    const fires = new Date(
      at.getTime() + msUntilNextLocalMidnight("2026-08-31", at),
    );
    expect([fires.getMonth(), fires.getDate()]).toEqual([8, 1]);
  });
  test("and the end of a year", () => {
    const at = new Date(2026, 11, 31, 23, 30, 0);
    const fires = new Date(
      at.getTime() + msUntilNextLocalMidnight("2026-12-31", at),
    );
    expect([fires.getFullYear(), fires.getMonth(), fires.getDate()]).toEqual([
      2027, 0, 1,
    ]);
  });
  // It aims at the end of THE DAY GIVEN, which is the day on screen. A clock that has already moved
  // past it must arm a positive delay rather than a zero a timer would spin on.
  test("a day already past arms the floor, never a zero", () => {
    expect(
      msUntilNextLocalMidnight("2026-08-31", new Date(2026, 8, 4, 10, 0, 0)),
    ).toBe(1000);
  });
});
