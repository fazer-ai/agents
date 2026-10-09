import { afterEach, expect, test } from "bun:test";
import {
  startScheduler,
  stopScheduler,
  wakeScheduler,
} from "@/modules/scheduler/worker";

// A job a person is watching for (a document just approved) runs now rather than on the scheduler's
// next interval: a wake drains at once, a wake during a tick drains once more when it ends, and with
// no worker started in the process a wake does nothing.

afterEach(() => stopScheduler());

function gatedTicks() {
  let ticks = 0;
  let release: () => void = () => {};
  const runTick = () => {
    ticks += 1;
    return new Promise<void>((r) => {
      release = r;
    });
  };
  return {
    runTick,
    ticks: () => ticks,
    finish: async () => {
      release();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

test("a wake drains now, and a wake during a tick drains once more when it ends", async () => {
  const g = gatedTicks();
  startScheduler({ intervalMs: 3_600_000, runTick: g.runTick });
  expect(g.ticks()).toBe(0);
  wakeScheduler();
  expect(g.ticks()).toBe(1);
  wakeScheduler();
  wakeScheduler();
  expect(g.ticks()).toBe(1);
  await g.finish();
  expect(g.ticks()).toBe(2);
  await g.finish();
  expect(g.ticks()).toBe(2);
});

test("with no worker started, a wake does nothing", async () => {
  const g = gatedTicks();
  startScheduler({ intervalMs: 3_600_000, runTick: g.runTick });
  stopScheduler();
  wakeScheduler();
  expect(g.ticks()).toBe(0);
});
