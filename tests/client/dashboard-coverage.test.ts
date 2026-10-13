import { describe, expect, test } from "bun:test";
import {
  coverageOf,
  type StreamState,
} from "@/client/pages/dashboard/useStream";

// A block is complete when each family it reads has every day in or out of reach on its own: the
// flow-log days the retention sweep emptied cannot stand in for ledger days still computing.

const state = (
  ledger: [number, number],
  log: [number, number],
): StreamState => ({
  figures: null,
  progress: null,
  coverage: {
    total: 45,
    ready: 0,
    computing: null,
    pending: [],
    families: {
      conv: { total: 45, ready: 45, noData: 0, gaps: [] },
      ledger: { total: 45, ready: ledger[0], noData: ledger[1], gaps: [] },
      log: { total: 45, ready: log[0], noData: log[1], gaps: [] },
      know: { total: 45, ready: 45, noData: 0, gaps: [] },
    },
  },
  done: false,
  graced: true,
  failed: false,
  status: null,
  field: null,
});

describe("a block's coverage", () => {
  test("is not complete while one family is still computing, whatever another cannot fill", () => {
    const c = coverageOf(state([25, 0], [25, 20]), ["ledger", "log"]);
    expect(c).toEqual({
      total: 45,
      ready: 25,
      noData: 20,
      done: false,
      gaps: [],
      none: [],
      refused: null,
      first: null,
      arriving: true,
      graced: true,
    });
  });

  test("is complete when every family is in or out of reach", () => {
    const c = coverageOf(state([45, 0], [25, 20]), ["ledger", "log"]);
    expect(c?.done).toBe(true);
  });

  test("of a flow-log block is its own section's, which past retention another section cannot blank", () => {
    const s = state([45, 0], [25, 20]);
    if (!s.coverage) throw new Error("no coverage");
    s.coverage.families.log.gaps = [["2026-08-29", "2026-09-17"]];
    s.coverage.sections = {
      "log.handoffs": { total: 45, ready: 45, noData: 0, gaps: [] },
      "log.followups": {
        total: 45,
        ready: 25,
        noData: 20,
        gaps: [["2026-08-29", "2026-09-17"]],
      },
    };
    expect(coverageOf(s, ["log.handoffs"])?.gaps).toEqual([]);
    expect(coverageOf(s, ["log.handoffs"])?.noData).toBe(0);
    expect(coverageOf(s, ["log.followups"])?.gaps).toEqual([
      ["2026-08-29", "2026-09-17"],
    ]);
  });
});
