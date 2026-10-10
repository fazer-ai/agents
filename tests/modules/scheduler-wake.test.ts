import { afterEach, expect, test } from "bun:test";
import {
  startScheduler,
  stopScheduler,
  wakeScheduler,
} from "@/modules/scheduler/worker";
import { until } from "../utils/poll";

// A job a person is watching for (a document just approved) runs now rather than on the scheduler's
// next interval: a wake drains the traffic lane at once (the document approval kinds are traffic-
// proportional, so that is the drain that claims them), a wake during a drain drains once more when
// it ends, and with no worker started in the process a wake does nothing.

afterEach(() => stopScheduler());

const HOUR = 3_600_000;

function gatedDrains() {
  let drains = 0;
  let release: () => void = () => {};
  const runTraffic = () => {
    drains += 1;
    return new Promise<{
      claimed: number;
      waitMs: number | null;
      wantsPermit: boolean;
      settled: Promise<void>;
    }>((r) => {
      release = () =>
        r({
          claimed: 0,
          waitMs: null,
          wantsPermit: false,
          settled: Promise.resolve(),
        });
    });
  };
  return { runTraffic, drains: () => drains, release: () => release() };
}

function start(runTraffic: ReturnType<typeof gatedDrains>["runTraffic"]) {
  startScheduler({
    intervalMs: HOUR,
    observeIntervalMs: HOUR,
    runTraffic,
  });
}

test("a wake drains now, and a wake during a drain drains once more when it ends", async () => {
  const g = gatedDrains();
  start(g.runTraffic);
  expect(g.drains()).toBe(0);
  wakeScheduler();
  expect(g.drains()).toBe(1);
  wakeScheduler();
  wakeScheduler();
  expect(g.drains()).toBe(1);
  g.release();
  await until("the drain asked for during the first", () => g.drains() === 2);
  g.release();
  // Nothing asked for during the second, so it is the last.
  stopScheduler();
  wakeScheduler();
  expect(g.drains()).toBe(2);
});

test("with no worker started, a wake does nothing", () => {
  const g = gatedDrains();
  start(g.runTraffic);
  stopScheduler();
  wakeScheduler();
  expect(g.drains()).toBe(0);
});
