import { describe, expect, test } from "bun:test";
import { nextRoundAt } from "@/client/pages/resources/OccurrenceStatus";

// The status line under the monitor's switch says when the next round is expected, the way the
// round job re-arms itself (round.ts, occurrenceRoundHandler; agents-master#427).
describe("nextRoundAt", () => {
  const t0 = "2026-11-06T12:00:00.000Z";
  test("one cadence after the last round started, not after it ended", () => {
    expect(
      nextRoundAt(
        { startedAt: t0, finishedAt: "2026-11-06T12:01:30.000Z" },
        5,
      ).toISOString(),
    ).toBe("2026-11-06T12:05:00.000Z");
  });
  test("right when it ended, when the round ran longer than the cadence", () => {
    expect(
      nextRoundAt(
        { startedAt: t0, finishedAt: "2026-11-06T12:01:30.000Z" },
        1,
      ).toISOString(),
    ).toBe("2026-11-06T12:01:30.000Z");
  });
  test("a round with no end yet counts from its start", () => {
    expect(
      nextRoundAt({ startedAt: t0, finishedAt: null }, 2).toISOString(),
    ).toBe("2026-11-06T12:02:00.000Z");
  });
});
