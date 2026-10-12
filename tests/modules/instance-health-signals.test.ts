import { describe, expect, test } from "bun:test";
import { Semaphore } from "@/lib/semaphore";
import {
  ingressLagP95,
  recordIngressLag,
  resetIngressLag,
} from "@/modules/instance-health/ingress";
import { laneAgesOf } from "@/modules/instance-health/sampler";

// The in-process signals, with no database: what the semaphore says about its queue, the ingress
// lag window, and how job kinds fold into lanes.

describe("Semaphore queue introspection", () => {
  test("counts waiters and ages the head of the queue (catches a sampler that reads 0 while turns queue)", async () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire() as () => void;
    const t0 = Date.now();
    const queued = [sem.run(async () => {}), sem.run(async () => {})];
    expect(sem.waiting).toBe(2);
    expect(sem.oldestWaitMs(t0 + 5_000)).toBeGreaterThanOrEqual(4_900);
    release();
    await Promise.all(queued);
    expect(sem.waiting).toBe(0);
    expect(sem.oldestWaitMs()).toBe(0);
  });

  test("the oldest wait is the longest of either class, and the count is both queues (catches a background call starving unseen)", async () => {
    let now = 1_000;
    const sem = new Semaphore(1, { now: () => now });
    const release = sem.tryAcquire() as () => void;
    const background = sem.run(async () => {}, undefined, "background");
    now = 3_000;
    const reply = sem.run(async () => {}, undefined, "reply");
    expect(sem.waiting).toBe(2);
    expect(sem.oldestWaitMs(4_000)).toBe(3_000);
    release();
    await Promise.all([background, reply]);
    expect(sem.oldestWaitMs()).toBe(0);
  });

  test("a waiter that aborts leaves the count (catches a stale waiter inflating the signal forever)", async () => {
    const sem = new Semaphore(1);
    const release = sem.tryAcquire() as () => void;
    const ac = new AbortController();
    const waiting = sem.run(async () => {}, ac.signal).catch(() => "aborted");
    expect(sem.waiting).toBe(1);
    ac.abort(new Error("gone"));
    expect(await waiting).toBe("aborted");
    expect(sem.waiting).toBe(0);
    expect(sem.oldestWaitMs()).toBe(0);
    release();
  });
});

describe("ingress lag window", () => {
  test("p95 of the last minute, older observations dropped (catches a lag that never recovers)", () => {
    resetIngressLag();
    const now = 1_000_000_000;
    // 19 fast deliveries and one slow one: the p95 is the slow one's neighbour, not the max.
    for (let i = 0; i < 19; i++) recordIngressLag(now / 1000 - 1, now);
    recordIngressLag(now / 1000 - 40, now);
    expect(ingressLagP95(now)).toBe(1_000);
    for (let i = 0; i < 5; i++) recordIngressLag(now / 1000 - 40, now);
    expect(ingressLagP95(now)).toBe(40_000);
    expect(ingressLagP95(now + 61_000)).toBe(0);
  });

  test("a sender clock ahead of ours reads as zero, never negative", () => {
    resetIngressLag();
    recordIngressLag(2_000, 1_000_000);
    expect(ingressLagP95(1_000_000)).toBe(0);
  });
});

describe("scheduler lane ages", () => {
  test("each lane takes its oldest kind (catches debounce lag hidden under the shared lane)", () => {
    expect(
      laneAgesOf({
        DELIVERY_SWEEP: 90_000,
        DEBOUNCE: 45_000,
        FOLLOWUP: 10_000,
      }),
    ).toEqual({ shared: 90_000, debounce: 45_000, compaction: 0, observe: 0 });
  });
});
