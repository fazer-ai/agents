import { describe, expect, test } from "bun:test";
import {
  clearFlushHold,
  clearTurnInFlight,
  isFlushHeld,
  isTurnInFlight,
  isTurnRunning,
  markFlushHold,
  markTurnInFlight,
} from "@/graph/inflight";

// The flush's hold on a thread is invisible to everyone but the flush, and this is the fence on that.
//
// `markTurnReserved` is the wrong tool for this hold: `isTurnInFlight` counts it, and while that
// reads true `undoRefusedTurn` skips the debounce rollback (leaving undelivered answers in memory)
// and `claimIngestWrite` answers busy (so replies go out without the queued history). This asserts
// the PROPERTY, since the consequences have no other test: the flush's hold is invisible to both.
describe("a flush hold is not a turn", () => {
  const T = "tenant:1:ci:42";

  test("holding it says nothing to the writers that ask about turns", () => {
    expect(isTurnInFlight(T)).toBe(false);
    markFlushHold(T);
    try {
      expect(isFlushHeld(T)).toBe(true);
      // The two questions the rollback and the ingest barrier ask. Either one answering true here is
      // the regression this file exists for.
      expect(isTurnInFlight(T)).toBe(false);
      expect(isTurnRunning(T)).toBe(false);
    } finally {
      clearFlushHold(T);
    }
    expect(isFlushHeld(T)).toBe(false);
  });

  test("and a real turn still is one, so the flush's own check still sees it", () => {
    markTurnInFlight(T);
    try {
      expect(isTurnInFlight(T)).toBe(true);
      // Independent registries: a turn is not a flush hold either, or the flush would defer behind
      // its own turn.
      expect(isFlushHeld(T)).toBe(false);
    } finally {
      clearTurnInFlight(T);
    }
  });

  test("counted, not a set: two holds need two releases", () => {
    markFlushHold(T);
    markFlushHold(T);
    clearFlushHold(T);
    // An unbalanced release would hand the thread to the second flush while the first is still in
    // the window the hold covers.
    expect(isFlushHeld(T)).toBe(true);
    clearFlushHold(T);
    expect(isFlushHeld(T)).toBe(false);
  });
});
