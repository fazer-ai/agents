import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  beginWork,
  drainInFlight,
  isDraining,
  resetShutdownForTest,
  ShutdownCutError,
  shutdown,
  trackWork,
} from "@/lib/shutdown";

// The drain itself, without a database: what it waits for, when it stops waiting, what it reports and
// what it ends. The job lanes' side (a cut run is failed for retry, the claims stop) is
// tests/modules/scheduler-shutdown-drain.test.ts; the real signal is tests/lib/shutdown-signal.test.ts.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The registry is process-wide: a suite that claimed rows without running them leaves them held.
beforeEach(() => {
  resetShutdownForTest();
});

afterEach(() => {
  resetShutdownForTest();
});

describe("the shutdown drain", () => {
  test("nothing in flight: it returns at once", async () => {
    const t = performance.now();
    const result = await drainInFlight({ boundMs: 5_000 });
    expect(performance.now() - t).toBeLessThan(200);
    expect(result.drained).toBe(true);
    expect(result.stillRunning.total).toBe(0);
  });

  test("it waits for the work in flight and returns when it ends, not at the bound", async () => {
    let finished = false;
    void trackWork("DEBOUNCE", async () => {
      await sleep(300);
      finished = true;
    });
    const t = performance.now();
    const result = await drainInFlight({ boundMs: 5_000 });
    const waited = performance.now() - t;
    expect(finished).toBe(true);
    expect(result.drained).toBe(true);
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(2_000);
  });

  test("at the bound it cuts what is still running and reports exactly that", async () => {
    const cutWith: Error[] = [];
    // One finishes inside the bound, two do not: only the two are counted and cut.
    void trackWork("DEBOUNCE", () => sleep(100));
    for (let i = 0; i < 2; i++) {
      const end = beginWork("DEBOUNCE", (reason) => {
        cutWith.push(reason);
        end();
      });
    }
    const t = performance.now();
    const result = await drainInFlight({ boundMs: 400, settleMs: 1_000 });
    const waited = performance.now() - t;
    expect(result.drained).toBe(false);
    expect(result.stillRunning).toEqual({
      total: 2,
      byKind: { DEBOUNCE: 2 },
    });
    expect(cutWith).toHaveLength(2);
    expect(cutWith.every((e) => e instanceof ShutdownCutError)).toBe(true);
    expect(result.unsettled).toBe(0);
    // The cut ends them at once, so the settle wait is not spent.
    expect(waited).toBeGreaterThanOrEqual(350);
    expect(waited).toBeLessThan(900);
  });

  test("work that does not end when cut is abandoned after the settle wait", async () => {
    beginWork("chatwoot_delivery");
    const t = performance.now();
    const result = await drainInFlight({ boundMs: 200, settleMs: 300 });
    const waited = performance.now() - t;
    expect(result.drained).toBe(false);
    expect(result.unsettled).toBe(1);
    expect(waited).toBeGreaterThanOrEqual(450);
    expect(waited).toBeLessThan(1_200);
  });

  test("the signal stops the lanes first, then drains, then exits", async () => {
    const order: string[] = [];
    void trackWork("DEBOUNCE", async () => {
      await sleep(200);
      order.push("work done");
    });
    await shutdown("SIGTERM", {
      stop: () => order.push("stop"),
      boundMs: 5_000,
      exit: (code) => order.push(`exit ${code}`),
    });
    expect(order).toEqual(["stop", "work done", "exit 0"]);
    expect(isDraining()).toBe(true);
  });

  test("a second signal during the drain exits at once", async () => {
    const end = beginWork("DEBOUNCE");
    const exits: string[] = [];
    const opts = {
      stop: () => {},
      boundMs: 5_000,
      exit: (code: number) => exits.push(`exit ${code}`),
    };
    const first = shutdown("SIGTERM", opts);
    await sleep(50);
    const t = performance.now();
    await shutdown("SIGINT", opts);
    expect(performance.now() - t).toBeLessThan(100);
    expect(exits).toEqual(["exit 0"]);
    // The first drain ends with the work, and exits too (a real process is already gone by then).
    end();
    await first;
    expect(exits).toEqual(["exit 0", "exit 0"]);
  });
});
