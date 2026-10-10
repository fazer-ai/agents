import { describe, expect, test } from "bun:test";
import { shareAbortableInFlight } from "@/lib/locks";

// A run the test settles by hand, recording the signal it was given.
function controllable<T>() {
  let resolve!: (v: T) => void;
  const seen: AbortSignal[] = [];
  let starts = 0;
  const fn = (signal: AbortSignal) => {
    starts++;
    seen.push(signal);
    return new Promise<T>((r) => {
      resolve = r;
    });
  };
  return { fn, seen, resolve: (v: T) => resolve(v), starts: () => starts };
}

describe("shareAbortableInFlight", () => {
  test("a caller that gives up is let go; the run goes on for the one still waiting", async () => {
    const work = controllable<string>();
    const a = new AbortController();
    const b = new AbortController();
    const first = shareAbortableInFlight("k1", work.fn, a.signal);
    const second = shareAbortableInFlight("k1", work.fn, b.signal);
    a.abort(new Error("first gave up"));
    await expect(first).rejects.toThrow("first gave up");
    expect(work.seen[0]?.aborted).toBe(false);
    work.resolve("read");
    expect(await second).toBe("read");
    expect(work.starts()).toBe(1);
  });

  test("the run is cut once every caller has given up, and the next caller starts afresh", async () => {
    const work = controllable<string>();
    const a = new AbortController();
    const b = new AbortController();
    const first = shareAbortableInFlight("k2", work.fn, a.signal);
    const second = shareAbortableInFlight("k2", work.fn, b.signal);
    a.abort(new Error("a"));
    b.abort(new Error("b"));
    await expect(first).rejects.toThrow("a");
    await expect(second).rejects.toThrow("b");
    expect(work.seen[0]?.aborted).toBe(true);
    const third = shareAbortableInFlight("k2", work.fn);
    expect(work.starts()).toBe(2);
    work.resolve("again");
    expect(await third).toBe("again");
  });

  test("a caller with no deadline keeps the run alive when the others give up", async () => {
    const work = controllable<string>();
    const a = new AbortController();
    const pinned = shareAbortableInFlight("k3", work.fn);
    const timed = shareAbortableInFlight("k3", work.fn, a.signal);
    a.abort(new Error("timed out"));
    await expect(timed).rejects.toThrow("timed out");
    expect(work.seen[0]?.aborted).toBe(false);
    work.resolve("kept");
    expect(await pinned).toBe("kept");
  });

  test("a caller whose deadline already passed is refused, and the run it started is cut at once", async () => {
    const work = controllable<string>();
    const a = new AbortController();
    a.abort(new Error("late"));
    await expect(
      shareAbortableInFlight("k4", work.fn, a.signal),
    ).rejects.toThrow("late");
    expect(work.seen[0]?.aborted).toBe(true);
  });
});
