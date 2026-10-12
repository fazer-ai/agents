import { describe, expect, test } from "bun:test";
import { historyWithGaps } from "@/client/pages/admin/instance-health/signals";

// The chart plots each sample at its own time; a stretch with no sample has to break the line, or
// an outage reads as a straight run between its two ends (Sparkline.tsx).

describe("a signal's history for the chart", () => {
  test("a stretch with no samples becomes a break, at the samples' own times (catches an outage drawn as a line)", () => {
    const at = (s: number) => 1_000_000 + s * 1_000;
    const points = [
      { at: at(0), value: 1 },
      { at: at(5), value: 2 },
      { at: at(10), value: 3 },
      // The database half failed for a minute.
      { at: at(70), value: 9 },
      { at: at(75), value: 8 },
    ];
    expect(historyWithGaps(points)).toEqual([
      { at: at(0), value: 1 },
      { at: at(5), value: 2 },
      { at: at(10), value: 3 },
      { at: at(15), value: null },
      { at: at(70), value: 9 },
      { at: at(75), value: 8 },
    ]);
  });

  test("a steady series, at either cadence, has no break (catches a 15 s database signal broken at every sample)", () => {
    const steady = [0, 15, 30, 45, 60].map((s) => ({
      at: s * 1_000,
      value: s,
    }));
    expect(historyWithGaps(steady)).toEqual(steady);
    // A little jitter is not an outage.
    const jitter = [0, 5, 11, 15, 20].map((s) => ({ at: s * 1_000, value: 1 }));
    expect(historyWithGaps(jitter)).toEqual(jitter);
  });
});
