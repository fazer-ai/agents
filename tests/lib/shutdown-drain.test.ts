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
import { POLL_DEADLINE_MS } from "@/tests/utils/poll";

// The drain itself, without a database: what it waits for, when it stops waiting, what it reports and
// what it ends. The job lanes' side (a cut run is failed for retry, the claims stop) is
// tests/modules/scheduler-shutdown-drain.test.ts; the real signal is tests/lib/shutdown-signal.test.ts.

// A bound the test waits out in full, so it is kept short: what is asserted is that it was reached.
const BOUND_MS = 100;

// A drain that does not wait for the work has returned once this resolves: it gets there in
// microtasks alone, and a macrotask runs only after all of them.
const pastMicrotasks = () => new Promise<void>((r) => setImmediate(r));

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
    // The work runs until the test lets it end, which it does only once the drain is waiting.
    const gate = Promise.withResolvers<void>();
    let finished = false;
    void trackWork("DEBOUNCE", async () => {
      await gate.promise;
      finished = true;
    });
    // What the drain saw of the work at the moment it returned.
    const drained = drainInFlight({ boundMs: POLL_DEADLINE_MS }).then(
      (result) => ({ result, finished }),
    );
    await pastMicrotasks();
    gate.resolve();
    const { result, finished: endedFirst } = await drained;
    expect(endedFirst).toBe(true);
    // Drained, so it returned on the work's end: the bound would have reported it still running.
    expect(result.drained).toBe(true);
    expect(result.waitedMs).toBeLessThan(POLL_DEADLINE_MS);
  });

  test("at the bound it cuts what is still running and reports exactly that", async () => {
    const cutWith: Error[] = [];
    // One finishes inside the bound, two do not: only the two are counted and cut.
    const quick = beginWork("DEBOUNCE");
    for (let i = 0; i < 2; i++) {
      const end = beginWork("DEBOUNCE", (reason) => {
        cutWith.push(reason);
        end();
      });
    }
    const t = performance.now();
    const drained = drainInFlight({ boundMs: BOUND_MS, settleMs: 5_000 });
    // Ended once the drain is waiting on all three, well inside the bound.
    quick();
    const result = await drained;
    const waited = performance.now() - t;
    expect(result.drained).toBe(false);
    expect(result.stillRunning).toEqual({
      total: 2,
      byKind: { DEBOUNCE: 2 },
    });
    expect(cutWith).toHaveLength(2);
    expect(cutWith.every((e) => e instanceof ShutdownCutError)).toBe(true);
    expect(result.unsettled).toBe(0);
    // It waited out the bound, and the cut ends them at once, so the settle wait is not spent.
    expect(waited).toBeGreaterThanOrEqual(BOUND_MS - 10);
    expect(waited).toBeLessThan(5_000);
  });

  // A claim query in flight at the bound returns its rows during the settle wait: they are cut as
  // they register, or they would start and be left behind by the exit.
  test("work registered after the bound is cut as it registers", async () => {
    // The bound is over once it cuts the work in flight: that cut is the moment to register late.
    // The first run ends once the late one has been cut, which keeps the drain in its settle wait.
    const boundCut = Promise.withResolvers<void>();
    const end = beginWork("DEBOUNCE", () => boundCut.resolve());
    const drained = drainInFlight({ boundMs: 100, settleMs: 1_000 });
    await boundCut.promise;
    const lateCut: Error[] = [];
    const lateEnd = beginWork("HEARTBEAT", (reason) => {
      lateCut.push(reason);
      lateEnd();
      end();
    });
    const result = await drained;
    expect(lateCut).toHaveLength(1);
    expect(lateCut[0]).toBeInstanceOf(ShutdownCutError);
    expect(result.unsettled).toBe(0);
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
    // The work ends only when the test lets it, after the signal: an exit that did not wait for it
    // lands before "work done".
    const gate = Promise.withResolvers<void>();
    void trackWork("DEBOUNCE", async () => {
      await gate.promise;
      order.push("work done");
    });
    const signalled = shutdown("SIGTERM", {
      stop: () => order.push("stop"),
      boundMs: POLL_DEADLINE_MS,
      exit: (code) => order.push(`exit ${code}`),
    });
    await pastMicrotasks();
    gate.resolve();
    await signalled;
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
    // The first signal starts draining before it first yields.
    expect(isDraining()).toBe(true);
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
