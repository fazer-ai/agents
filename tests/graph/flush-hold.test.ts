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
// It exists because the first version of issue #588's fix used `markTurnReserved`, which IS counted
// by `isTurnInFlight` — and two subsystems ask that before doing their own work on the thread:
// `undoRefusedTurn` refuses to roll back a superseded answer while it reads true, and
// `claimIngestWrite` answers busy so `drainPendingIngest` reaches none of the queued messages. A hold
// across the whole turn therefore made every debounce rollback skip, leaving answers the customer
// never received in memory, and sent replies without the history they were supposed to carry.
//
// The whole suite passed with that defect present. Nothing covered either behaviour, which is why
// this file asserts the PROPERTY rather than waiting for a test of the consequences: whatever the
// flush holds must not be visible to the questions those two ask.
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
