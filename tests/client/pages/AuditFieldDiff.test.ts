import { describe, expect, test } from "bun:test";
import { diffProjection, localDayBounds } from "@/client/pages/AuditPage";

// THE ONE THING THAT MAKES THIS PAGE READABLE (issue #401).
//
// Measured on a real self-hosted tenant: 20 of 40 rows are `mcp.prompt_set`, and that action takes
// the WHOLE prompt rather than a patch, so those rows carry two system prompts of roughly 11k
// characters each. Rendered as two JSON blobs the page is unusable, and the row that says the most
// is the one that shows the least. What the operator came for is which field moved.
//
// The function is exported for this file and used by nothing else on the page's outside, because
// what it decides — which keys are a change, how a create and a delete differ from an edit, and what
// a change nobody is allowed to see looks like — is the whole answer the page gives.

describe("the field-level diff", () => {
  test("only the keys that moved, over the union of both sides", () => {
    expect(
      diffProjection(
        { name: "a", model: "gpt", temperature: 0.2 },
        { name: "b", model: "gpt", topP: 1 },
      ),
    ).toEqual({
      changes: [
        { key: "name", before: "a", after: "b" },
        // Present on one side only: a key that was removed and a key that appeared are both changes,
        // and dropping either would make the row claim less than it recorded.
        { key: "temperature", before: 0.2, after: undefined },
        { key: "topP", before: undefined, after: 1 },
      ],
      undisclosed: false,
    });
  });

  test("a projection that did not move produces no rows", () => {
    expect(diffProjection({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual({
      changes: [],
      undisclosed: false,
    });
  });

  // A create has only an `after` and a delete only a `before`. Neither is a diff, and pairing the
  // present side against an absent one would render every field as a change from nothing — which is
  // true, and is exactly what the row means.
  test("a create shows what was written and a delete what was lost", () => {
    expect(diffProjection(null, { name: "novo", id: "7" }).changes).toEqual([
      { key: "id", before: undefined, after: "7" },
      { key: "name", before: undefined, after: "novo" },
    ]);
    expect(diffProjection({ name: "ido", id: "7" }, null).changes).toEqual([
      { key: "id", before: "7", after: undefined },
      { key: "name", before: "ido", after: undefined },
    ]);
  });

  test("a row with no projection at all has nothing to show", () => {
    expect(diffProjection(null, null)).toEqual({
      changes: [],
      undisclosed: false,
    });
    expect(diffProjection(undefined, undefined)).toEqual({
      changes: [],
      undisclosed: false,
    });
  });

  // A projection is an object or it is null: every writer in the tree builds one through its own
  // `auditProjection`/`auditSafe` helper, and `null` is how a create says there was no before and a
  // delete says there is no after (measured across every `auditMutation` call site). A scalar or a
  // list has no fields to show, so there is nothing here to render and no branch that could be
  // proven — this pins the shape rather than inventing a rendering for a case nothing produces.
  test("a projection with no fields in it has no fields to show", () => {
    expect(diffProjection("antes", "depois").changes).toEqual([]);
    expect(diffProjection([1], [2]).changes).toEqual([]);
  });

  // The measured case. The keys are compared, not the values' length, so a pair of 11k-character
  // prompts is one row and not a page.
  test("two whole system prompts are one changed field", () => {
    const before = { systemPrompt: "x".repeat(11_000), name: "Ana" };
    const after = { systemPrompt: "y".repeat(11_000), name: "Ana" };
    expect(diffProjection(before, after).changes.map((c) => c.key)).toEqual([
      "systemPrompt",
    ]);
  });

  // `markUndisclosed` puts the SAME marker on both sides on purpose: it says a write moved something
  // the projection does not carry (an encrypted secret, a header block), which is a fact about the
  // change and not about either end of it. A diff by equality therefore erases it, and the one row
  // that says "a value you cannot see here changed" would render as "nothing was recorded" — the
  // exact opposite of what it means, on the rows where the trail matters most.
  test("a change nobody may see is reported, not filtered away as equal", () => {
    const d = diffProjection(
      { id: "7", name: "Tool", undisclosedChanged: true },
      { id: "7", name: "Tool", undisclosedChanged: true },
    );
    expect(d.undisclosed).toBe(true);
    // And it is not a FIELD: rendering `true → true` as a diff row says nothing, and counting it
    // would make the card claim a changed field that has no before and no after to show.
    expect(d.changes).toEqual([]);
  });

  // The OTHER marker, and the one the page did not know. #394 puts `unreadConfigChanged` on the
  // FIELD's projection rather than at the top (`{ settings: { … } }`), so a top-level check finds
  // nothing; and when the edit moved only unread configuration, both sides are the same marker
  // object and the equality filter drops the field. The card then said "this action recorded no
  // field values" about a row that exists precisely to report that something changed.
  test("the agent family's marker is found where it actually rides", () => {
    const d = diffProjection(
      { id: "3", settings: { unreadConfigChanged: true } },
      { id: "3", settings: { unreadConfigChanged: true } },
    );
    expect(d.undisclosed).toBe(true);
    expect(d.changes).toEqual([]);
  });

  test("a nested marker alongside a visible change keeps both", () => {
    const d = diffProjection(
      { name: "antes", settings: { tts: "off", unreadConfigChanged: true } },
      { name: "depois", settings: { tts: "on", unreadConfigChanged: true } },
    );
    expect(d.undisclosed).toBe(true);
    expect(d.changes).toEqual([
      { key: "name", before: "antes", after: "depois" },
      {
        key: "settings",
        before: { tts: "off", unreadConfigChanged: true },
        after: { tts: "on", unreadConfigChanged: true },
      },
    ]);
  });

  test("a hidden change alongside a visible one keeps both", () => {
    const d = diffProjection(
      { name: "antes", undisclosedChanged: true },
      { name: "depois", undisclosedChanged: true },
    );
    expect(d.undisclosed).toBe(true);
    expect(d.changes).toEqual([
      { key: "name", before: "antes", after: "depois" },
    ]);
  });

  test("a create that carries the marker reports it too", () => {
    const d = diffProjection(null, { id: "7", undisclosedChanged: true });
    expect(d.undisclosed).toBe(true);
    expect(d.changes).toEqual([{ key: "id", before: undefined, after: "7" }]);
  });

  test("an ordinary projection does not claim a hidden change", () => {
    expect(diffProjection({ a: 1 }, { a: 2 }).undisclosed).toBe(false);
  });
});

// The date range is the filter the issue's own measurement says pays, because of how an operator
// arrives here: with a day, and no idea which action to look for. The day has to be THEIR day.
//
// The boundary function is passed in, and that is the whole reason these assertions mean anything:
// this suite runs at UTC (measured — `getTimezoneOffset()` is 0 inside the harness), so a version
// that bounded the UTC day instead of the local one passed every test written against the ambient
// clock. Each fake below answers "the instant this local date begins", which is what the browser's
// own `new Date(y, m, d)` answers in production.
describe("the day an operator picked", () => {
  // A zone with one fixed offset, in minutes to ADD to local to reach UTC. São Paulo is +180.
  const fixed = (offsetMinutes: number) => (y: number, m: number, d: number) =>
    Date.UTC(y, m - 1, d) + offsetMinutes * 60_000;
  const SP = fixed(180);

  test("the bounds are that browser's day, not UTC's", () => {
    const b = localDayBounds("2026-01-01", SP);
    expect(b).not.toBeNull();
    // Local midnight in São Paulo is 03:00 UTC, and the day closes a millisecond before the next.
    expect(b?.since).toBe("2026-01-01T03:00:00.000Z");
    expect(b?.until).toBe("2026-01-02T02:59:59.999Z");
  });

  // The row a UTC bound loses: displayed as Jan 1 at 22:00 in São Paulo, stamped Jan 2 in UTC. It
  // has to fall inside the filter for the day the screen is showing it under.
  test("a row at the edge of the local day falls inside the local bounds", () => {
    const b = localDayBounds("2026-01-01", SP);
    const since = new Date(b?.since ?? "").getTime();
    const until = new Date(b?.until ?? "").getTime();
    const shownAsJan1At22 = Date.parse("2026-01-02T01:00:00.000Z");
    expect(shownAsJan1At22 >= since && shownAsJan1At22 <= until).toBe(true);
    expect(shownAsJan1At22 > Date.parse("2026-01-02T00:00:00.000Z")).toBe(true);
    expect(Date.parse("2026-01-01T02:59:59.999Z") < since).toBe(true);
    expect(Date.parse("2026-01-02T03:00:00.000Z") > until).toBe(true);
  });

  test("a whole day is a whole day, minus exactly one millisecond", () => {
    for (const off of [0, 180, -120, 330]) {
      const b = localDayBounds("2026-03-15", fixed(off));
      const span =
        new Date(b?.until ?? "").getTime() - new Date(b?.since ?? "").getTime();
      expect(span).toBe(86_400_000 - 1);
    }
  });

  // Twice a year the day is not 24 hours, and a fixed 24 loses rows the screen is showing: it reaches
  // into the next day when the clock springs forward, and ends an hour early when it falls back,
  // dropping every row from the last hour of the day being displayed.
  test("a day that is not 24 hours long still ends at its own midnight", () => {
    const spring = (y: number, m: number, d: number) =>
      Date.UTC(y, m - 1, d) + (d <= 3 ? 180 : 120) * 60_000;
    const b1 = localDayBounds("2018-11-03", spring);
    expect(
      new Date(b1?.until ?? "").getTime() - new Date(b1?.since ?? "").getTime(),
    ).toBe(23 * 3_600_000 - 1);
    const fall = (y: number, m: number, d: number) =>
      Date.UTC(y, m - 1, d) + (d <= 16 ? 120 : 180) * 60_000;
    const b2 = localDayBounds("2019-02-16", fall);
    expect(
      new Date(b2?.until ?? "").getTime() - new Date(b2?.since ?? "").getTime(),
    ).toBe(25 * 3_600_000 - 1);
  });

  // A zone that springs forward AT midnight: that local midnight never happens, so the day starts at
  // 01:00 local. Asking for an OFFSET at a non-existent instant answers from the far side of the
  // transition, and adding it to a nominal UTC midnight lands an hour early — the day would drop its
  // last hour and the next day would claim it. Santiago moves at midnight; this is that shape.
  test("a day whose midnight does not exist starts when the day actually starts", () => {
    // -04:00 before, -03:00 from 2026-09-06 00:00 local, which does not occur.
    const santiago = (y: number, m: number, d: number) => {
      const beforeJump = Date.UTC(y, m - 1, d) + 240 * 60_000;
      const afterJump = Date.UTC(y, m - 1, d) + 180 * 60_000;
      return d <= 5 ? beforeJump : afterJump;
    };
    const jumpDay = localDayBounds("2026-09-06", santiago);
    const dayBefore = localDayBounds("2026-09-05", santiago);
    // No gap and no overlap: one day ends exactly where the next begins.
    expect(new Date(dayBefore?.until ?? "").getTime() + 1).toBe(
      new Date(jumpDay?.since ?? "").getTime(),
    );
    // And the short day is 23 hours, not 24: the hour that never happened is not filtered for.
    expect(
      new Date(dayBefore?.until ?? "").getTime() -
        new Date(dayBefore?.since ?? "").getTime(),
    ).toBe(23 * 3_600_000 - 1);
  });

  // The overflow cases the arithmetic must not special-case.
  test("the last day of a month, a year and a leap February all close correctly", () => {
    for (const [day, nextMidnightUtc] of [
      ["2026-01-31", "2026-02-01T03:00:00.000Z"],
      ["2026-12-31", "2027-01-01T03:00:00.000Z"],
      ["2024-02-29", "2024-03-01T03:00:00.000Z"],
    ] as const) {
      const b = localDayBounds(day, SP);
      expect(new Date(b?.until ?? "").getTime()).toBe(
        Date.parse(nextMidnightUtc) - 1,
      );
    }
  });

  test("a date the picker never produces yields no bound at all", () => {
    for (const bad of ["", "garbage", "2026-01"]) {
      expect(localDayBounds(bad, SP)).toBeNull();
    }
  });

  // `<input type="date">` emits zero-padded ISO and blanks anything else, so these came from a
  // hand-edited URL. Accepted, they would filter by a day the input cannot display — and the page
  // would keep the parameter, since the helper answered.
  test("a date the input could never show is refused", () => {
    for (const noncanonical of [
      "2026-1-1",
      "2026-01-1",
      "2026-1-01",
      " 2026-01-01",
      "2026-01-01 ",
      "26-01-01",
      "2026/01/01",
      "2026-01-01T00:00:00Z",
    ]) {
      expect([noncanonical, localDayBounds(noncanonical, SP)]).toEqual([
        noncanonical,
        null,
      ]);
    }
  });

  // A day that does not exist is REFUSED, never normalised: `Date.UTC` answers February 30 with
  // March 2 in silence, so the page would query one day while its input displays another.
  test("a date that does not exist is refused, not rolled into the next month", () => {
    for (const impossible of [
      "2026-02-30",
      "2026-13-01",
      "2026-04-31",
      "2025-02-29",
      "2026-00-10",
      "2026-01-32",
    ]) {
      expect([impossible, localDayBounds(impossible, SP)]).toEqual([
        impossible,
        null,
      ]);
    }
    // The leap day that DOES exist still works, so the check is not just refusing February.
    expect(localDayBounds("2024-02-29", SP)).not.toBeNull();
  });
});
