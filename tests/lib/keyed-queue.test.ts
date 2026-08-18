import { describe, expect, test } from "bun:test";
import { queuedKeyCount, withKeyedQueue } from "@/lib/locks";

// Deterministic gates instead of timers: the point is WHICH operations may overlap, and a timer
// would only make that probable.
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("withKeyedQueue", () => {
  test("work on the same key never overlaps", async () => {
    const order: string[] = [];
    const gate = deferred();
    const first = withKeyedQueue("same", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = withKeyedQueue("same", async () => {
      order.push("second:start");
    });
    // The second call is queued, not started: without the queue it would already have run, since
    // the first is parked on an await.
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("work on different keys does overlap", async () => {
    const order: string[] = [];
    const gate = deferred();
    const parked = withKeyedQueue("key-a", async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
    });
    // Completes while "key-a" is still parked — a single global lock would deadlock this await.
    await withKeyedQueue("key-b", async () => {
      order.push("b");
    });
    expect(order).toEqual(["a:start", "b"]);
    gate.resolve();
    await parked;
  });

  test("the queue is FIFO", async () => {
    const order: number[] = [];
    const gate = deferred();
    const head = withKeyedQueue("fifo", async () => {
      await gate.promise;
      order.push(0);
    });
    const tail = [1, 2, 3].map((i) =>
      withKeyedQueue("fifo", async () => {
        order.push(i);
      }),
    );
    gate.resolve();
    await Promise.all([head, ...tail]);
    expect(order).toEqual([0, 1, 2, 3]);
  });

  test("a rejection reaches its own caller and nobody else", async () => {
    // A failed Chatwoot write must not take the rest of the turn's writes down with it.
    const failing = withKeyedQueue("boom", async () => {
      throw new Error("chatwoot 500");
    });
    const behind = withKeyedQueue("boom", async () => "written");
    expect(failing).rejects.toThrow("chatwoot 500");
    expect(await behind).toBe("written");
  });

  test("a drained key is dropped from the map", async () => {
    // Otherwise the map keeps one promise per conversation for the lifetime of the process.
    const baseline = queuedKeyCount();
    await Promise.all([
      withKeyedQueue("drain-me", async () => {}),
      withKeyedQueue("drain-me", async () => {}),
    ]);
    await new Promise((r) => setTimeout(r, 0));
    expect(queuedKeyCount()).toBe(baseline);
  });
});
