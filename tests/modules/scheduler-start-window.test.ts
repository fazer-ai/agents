import { describe, expect, test } from "bun:test";
import { StartWindow } from "@/modules/scheduler/start-window";

// The traffic drain's per-minute ceiling (src/modules/scheduler/start-window.ts), driven with its
// own clock.
describe("StartWindow", () => {
  test("admits up to its ceiling, then nothing until the oldest start has left the window", () => {
    const w = new StartWindow(3, 1_000);
    expect(w.available(0)).toBe(3);
    w.record(0, 2);
    w.record(400, 1);
    expect(w.available(400)).toBe(0);
    expect(w.nextFreeAt(400)).toBe(1_001);
    // A start at t still counts at t + window, so a closed window never holds more than the ceiling.
    expect(w.available(1_000)).toBe(0);
    expect(w.available(1_001)).toBe(2);
    expect(w.nextFreeAt(1_001)).toBe(1_001);
    expect(w.available(1_401)).toBe(3);
  });

  test("with room left, the next start is now", () => {
    const w = new StartWindow(2, 1_000);
    w.record(0, 1);
    expect(w.nextFreeAt(10)).toBe(10);
  });
});
