import { describe, expect, test } from "bun:test";
import { Semaphore } from "@/lib/semaphore";

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("Semaphore", () => {
  test("never runs more than `permits` tasks at once", async () => {
    const sem = new Semaphore(3);
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        sem.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await tick();
          active -= 1;
        }),
      ),
    );
    expect(maxActive).toBe(3);
    expect(active).toBe(0);
  });

  test("releases the permit when a task throws", async () => {
    const sem = new Semaphore(1);
    await expect(
      sem.run(() => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    // If the permit leaked, this second run would hang forever (permits=1).
    const ok = await sem.run(() => Promise.resolve("ok"));
    expect(ok).toBe("ok");
  });

  test("runs every task to completion, preserving result order", async () => {
    const sem = new Semaphore(2);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        sem.run(async () => {
          await tick();
          return i;
        }),
      ),
    );
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  // A released permit is handed straight to the next waiter. Bumping `available` on that path as
  // well would MINT a permit on every handoff, leaving the semaphore permanently wider than it was
  // built: measured on the mutation, a 3-permit semaphore came out of one 10-task burst with 10
  // permits. It is invisible INSIDE a burst, because the minted permits appear as the queue drains
  // and every caller has already acquired by then, so a second wave is the only place the invariant
  // is observable. Left untested, the leak surfaced only as a neighbouring suite failing, since the
  // agent model semaphore is a process-wide singleton.
  test("a burst that queued waiters does not widen the semaphore", async () => {
    const sem = new Semaphore(3);
    const burst = async () => {
      let active = 0;
      let maxActive = 0;
      await Promise.all(
        Array.from({ length: 10 }, () =>
          sem.run(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await tick();
            active -= 1;
          }),
        ),
      );
      return maxActive;
    };
    expect(await burst()).toBe(3);
    expect(await burst()).toBe(3);
  });

  // FIFO is a fairness claim, not an implementation detail: this bounds how long the conversation
  // that has been waiting longest can be overtaken. Under LIFO a sustained burst starves the oldest
  // waiter indefinitely, and the customer on the other end of that turn is the one already waiting.
  test("a freed permit goes to the waiter that queued first", async () => {
    const sem = new Semaphore(1);
    const order: string[] = [];
    let releaseHolder: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    // `run` calls acquire synchronously, so the map below queues the waiters in exactly this order.
    const holder = sem.run(async () => {
      order.push("holder");
      await held;
    });
    const queued = ["a", "b", "c"].map((name) =>
      sem.run(async () => {
        order.push(name);
      }),
    );
    releaseHolder();
    await Promise.all([holder, ...queued]);
    expect(order).toEqual(["holder", "a", "b", "c"]);
  });

  // Issue #834: a job past its deadline was left in the queue until a permit freed, which under
  // saturation is minutes. The waiter that leaves must take no permit with it and leave none behind:
  // the next waiter gets the one released, and the semaphore is exactly as wide afterwards.
  test("a waiter whose signal aborts leaves the queue at once, with the signal's reason", async () => {
    const sem = new Semaphore(1);
    let releaseHolder: () => void = () => {};
    const holder = sem.run(
      () =>
        new Promise<void>((resolve) => {
          releaseHolder = resolve;
        }),
    );
    const controller = new AbortController();
    let ran = false;
    const leaving = sem
      .run(async () => {
        ran = true;
      }, controller.signal)
      .then(
        () => "resolved",
        (err: Error) => err.message,
      );
    const behind = sem.run(async () => "behind");
    await tick();
    controller.abort(new Error("deadline exceeded after 240s"));
    // Out while the holder still holds: the wait ended with the abort, not with a release.
    expect(await leaving).toBe("deadline exceeded after 240s");
    expect(ran).toBe(false);
    releaseHolder();
    await holder;
    expect(await behind).toBe("behind");
  });

  test("a signal already aborted takes no permit, even a free one", async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    controller.abort(new Error("deadline exceeded after 240s"));
    let ran = false;
    await expect(
      sem.run(async () => {
        ran = true;
      }, controller.signal),
    ).rejects.toThrow("deadline exceeded after 240s");
    expect(ran).toBe(false);
    // The permit is still there, and there is still only one.
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        sem.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await tick();
          active -= 1;
        }),
      ),
    );
    expect(maxActive).toBe(1);
  });

  test("an abort after the permit was granted does not end the task, and the permit comes back once", async () => {
    const sem = new Semaphore(1);
    const controller = new AbortController();
    const task = sem.run(async () => {
      await tick();
      return "done";
    }, controller.signal);
    await tick();
    controller.abort(new Error("late"));
    expect(await task).toBe("done");
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 4 }, () =>
        sem.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await tick();
          active -= 1;
        }),
      ),
    );
    expect(maxActive).toBe(1);
  });

  test("waiters that left do not narrow or widen the semaphore", async () => {
    const sem = new Semaphore(3);
    const holders: Array<() => void> = [];
    const held = Array.from({ length: 3 }, () =>
      sem.run(
        () =>
          new Promise<void>((resolve) => {
            holders.push(resolve);
          }),
      ),
    );
    const controller = new AbortController();
    const leaving = Array.from({ length: 5 }, () =>
      sem.run(async () => {}, controller.signal).catch(() => "left"),
    );
    await tick();
    controller.abort(new Error("deadline"));
    expect(await Promise.all(leaving)).toEqual(Array(5).fill("left"));
    for (const release of holders) release();
    await Promise.all(held);
    const burst = async () => {
      let active = 0;
      let maxActive = 0;
      await Promise.all(
        Array.from({ length: 10 }, () =>
          sem.run(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await tick();
            active -= 1;
          }),
        ),
      );
      return maxActive;
    };
    expect(await burst()).toBe(3);
    expect(await burst()).toBe(3);
  });

  test("clamps non-positive permits to at least 1 (no deadlock)", async () => {
    const sem = new Semaphore(0);
    const ok = await sem.run(() => Promise.resolve("ran"));
    expect(ok).toBe("ran");
  });
});
