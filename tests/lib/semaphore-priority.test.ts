import { describe, expect, test } from "bun:test";
import { type PermitClass, Semaphore } from "@/lib/semaphore";

// The model semaphore grants by class: a customer's reply goes ahead of observation and
// compaction, which nobody is waiting on this second, but the background keeps a minimum share and
// ages, so a flood of replies never starves it. The clock is injected where the aging is the claim.

const tick = () => new Promise((r) => setTimeout(r, 0));

// A held permit: the task runs until `release` is called. `started` says the permit was granted.
function holder(sem: Semaphore, cls: PermitClass, signal?: AbortSignal) {
  let release: () => void = () => {};
  const state = { started: false, settled: false };
  const done = sem
    .run(
      () =>
        new Promise<void>((resolve) => {
          state.started = true;
          release = resolve;
        }),
      signal,
      cls,
    )
    .finally(() => {
      state.settled = true;
    });
  return {
    state,
    done,
    release: () => release(),
  };
}

function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (ms: number) => (t = ms) };
}

describe("a contended model semaphore grants by class", () => {
  test("a reply queued after a background call is served first, once the background holds its share", async () => {
    const sem = new Semaphore(2, { backgroundMin: 1, agingMs: 60_000 });
    const bgHeld = holder(sem, "background");
    const replyHeld = holder(sem, "reply");
    await tick();
    const b1 = holder(sem, "background");
    const r1 = holder(sem, "reply");
    await tick();
    replyHeld.release();
    await tick();
    expect(r1.state.started).toBe(true);
    expect(b1.state.started).toBe(false);
    expect(sem.free).toBe(0);
    bgHeld.release();
    await tick();
    expect(b1.state.started).toBe(true);
    r1.release();
    b1.release();
    await Promise.all([bgHeld.done, replyHeld.done, r1.done, b1.done]);
    expect(sem.free).toBe(2);
  });

  test("below its minimum share, the background is served ahead of a reply", async () => {
    const sem = new Semaphore(2, { backgroundMin: 1, agingMs: 60_000 });
    const a = holder(sem, "reply");
    const b = holder(sem, "reply");
    await tick();
    const r1 = holder(sem, "reply");
    const b1 = holder(sem, "background");
    await tick();
    a.release();
    await tick();
    expect(b1.state.started).toBe(true);
    expect(r1.state.started).toBe(false);
    for (const h of [b, r1, b1]) h.release();
    await tick();
    r1.release();
    await Promise.all([a.done, b.done, r1.done, b1.done]);
  });

  test("a background waiter past the aging bound is served ahead of replies, which keep their order", async () => {
    const c = clock();
    const sem = new Semaphore(1, {
      backgroundMin: 0,
      agingMs: 1_000,
      now: c.now,
    });
    const held = holder(sem, "reply");
    await tick();
    const b1 = holder(sem, "background");
    c.set(500);
    const r1 = holder(sem, "reply");
    const r2 = holder(sem, "reply");
    await tick();
    c.set(1_000);
    held.release();
    await tick();
    expect([b1.state.started, r1.state.started, r2.state.started]).toEqual([
      true,
      false,
      false,
    ]);
    b1.release();
    await tick();
    expect([r1.state.started, r2.state.started]).toEqual([true, false]);
    r1.release();
    await tick();
    r2.release();
    await Promise.all([held.done, b1.done, r1.done, r2.done]);
  });

  test("a backlog of aged background calls takes turns with the replies, never every permit", async () => {
    const c = clock();
    const sem = new Semaphore(4, {
      backgroundMin: 0,
      agingMs: 1_000,
      now: c.now,
    });
    const first = Array.from({ length: 4 }, () => holder(sem, "reply"));
    await tick();
    const aged = Array.from({ length: 4 }, () => holder(sem, "background"));
    const replies = Array.from({ length: 4 }, () => holder(sem, "reply"));
    c.set(2_000);
    for (const h of first) h.release();
    await tick();
    expect(aged.filter((h) => h.state.started)).toHaveLength(2);
    expect(replies.filter((h) => h.state.started)).toHaveLength(2);
    for (const h of [...aged, ...replies]) h.release();
    await tick();
    for (const h of [...aged, ...replies]) h.release();
    await Promise.all([...first, ...aged, ...replies].map((h) => h.done));
    expect(sem.free).toBe(4);
  });

  // The turn-taking is between the grants of one backlog: once a reply was served after the aged
  // grant, or the semaphore went idle, the next aged waiter goes first again.
  test("after an aged grant, a reply grant or an idle spell lets the next aged waiter go first", async () => {
    const c = clock();
    const sem = new Semaphore(1, {
      backgroundMin: 0,
      agingMs: 1_000,
      now: c.now,
    });
    // Episode one: an aged background call goes ahead of a reply.
    let held = holder(sem, "reply");
    await tick();
    const b1 = holder(sem, "background");
    const r1 = holder(sem, "reply");
    c.set(1_000);
    held.release();
    await tick();
    expect([b1.state.started, r1.state.started]).toEqual([true, false]);
    b1.release();
    await tick();
    expect(r1.state.started).toBe(true);
    // A reply-only grant in between.
    const r2 = holder(sem, "reply");
    r1.release();
    await tick();
    expect(r2.state.started).toBe(true);
    const b2 = holder(sem, "background");
    const r3 = holder(sem, "reply");
    c.set(2_000);
    r2.release();
    await tick();
    expect([b2.state.started, r3.state.started]).toEqual([true, false]);
    b2.release();
    await tick();
    r3.release();
    await Promise.all([b1.done, r1.done, r2.done, b2.done, r3.done]);
    // An idle spell, then episode two.
    expect(sem.free).toBe(1);
    held = holder(sem, "reply");
    await tick();
    const b3 = holder(sem, "background");
    c.set(3_000);
    const r4 = holder(sem, "reply");
    c.set(3_100);
    held.release();
    await tick();
    expect([b3.state.started, r4.state.started]).toEqual([true, false]);
    b3.release();
    await tick();
    r4.release();
    await Promise.all([held.done, b3.done, r4.done]);
  });

  test("a background waiter not yet aged and over its share waits for the replies", async () => {
    const c = clock();
    const sem = new Semaphore(1, {
      backgroundMin: 0,
      agingMs: 1_000,
      now: c.now,
    });
    const held = holder(sem, "reply");
    await tick();
    const b1 = holder(sem, "background");
    const r1 = holder(sem, "reply");
    c.set(999);
    held.release();
    await tick();
    expect([r1.state.started, b1.state.started]).toEqual([true, false]);
    r1.release();
    await tick();
    expect(b1.state.started).toBe(true);
    b1.release();
    await Promise.all([held.done, r1.done, b1.done]);
  });

  // The test the issue asks for: replies arrive faster than they leave for many times the aging
  // bound, and the background still progresses, while the replies keep being served too.
  test("a flood of replies does not starve the background", async () => {
    const sem = new Semaphore(4, { backgroundMin: 0, agingMs: 40 });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const grants: Array<{ cls: PermitClass; at: number }> = [];
    const bgDoneAt: number[] = [];
    const t0 = Date.now();
    const call = (cls: PermitClass) =>
      sem.run(
        async () => {
          grants.push({ cls, at: Date.now() - t0 });
          await sleep(10);
          if (cls === "background") bgDoneAt.push(Date.now() - t0);
        },
        undefined,
        cls,
      );
    // The permits are already taken by replies when the background queues, so every background call
    // has to be granted against a reply queue that never empties.
    const replies: Promise<void>[] = Array.from({ length: 4 }, () =>
      call("reply"),
    );
    const background = Array.from({ length: 5 }, () => call("background"));
    let lastReplyQueuedAt = 0;
    // Two replies every 5 ms against four 10 ms permits: the reply queue never empties.
    while (Date.now() - t0 < 400) {
      replies.push(call("reply"), call("reply"));
      lastReplyQueuedAt = Date.now() - t0;
      await sleep(5);
    }
    await Promise.all(background);
    // Every background call ran while replies were still queueing.
    expect(bgDoneAt).toHaveLength(5);
    expect(Math.max(...bgDoneAt)).toBeLessThan(lastReplyQueuedAt);
    // The first one was served within the aging bound plus the call holding the permit it got.
    const firstBg = grants.find((g) => g.cls === "background");
    expect(firstBg?.at ?? Infinity).toBeLessThan(40 + 10 + 30);
    // The replies kept being served throughout: the background never took the semaphore over.
    const replyGrants = grants.filter((g) => g.cls === "reply");
    expect(replyGrants.some((g) => g.at > 300)).toBe(true);
    await Promise.all(replies);
    expect(sem.free).toBe(4);
  });

  test("one permit: the background still runs, alone, and the replies resume after it", async () => {
    const sem = new Semaphore(1, { backgroundMin: 0, agingMs: 30 });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let active = 0;
    let peak = 0;
    const order: PermitClass[] = [];
    const call = (cls: PermitClass) =>
      sem.run(
        async () => {
          active += 1;
          peak = Math.max(peak, active);
          order.push(cls);
          await sleep(5);
          active -= 1;
        },
        undefined,
        cls,
      );
    const t0 = Date.now();
    const replies: Promise<void>[] = [call("reply")];
    const bg = call("background");
    while (Date.now() - t0 < 200) {
      replies.push(call("reply"));
      await sleep(3);
    }
    await bg;
    await Promise.all(replies);
    expect(peak).toBe(1);
    const at = order.indexOf("background");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(order.length - 1);
    expect(order[at + 1]).toBe("reply");
  });

  test("uncontended, every call starts at once whatever its class, and no permit is held back", async () => {
    const sem = new Semaphore(20, { backgroundMin: 2, agingMs: 60_000 });
    const mixed = [
      ...Array.from({ length: 15 }, () => holder(sem, "reply")),
      ...Array.from({ length: 5 }, () => holder(sem, "background")),
    ];
    await tick();
    expect(mixed.every((h) => h.state.started)).toBe(true);
    for (const h of mixed) h.release();
    await Promise.all(mixed.map((h) => h.done));
    const replies = Array.from({ length: 20 }, () => holder(sem, "reply"));
    await tick();
    expect(replies.every((h) => h.state.started)).toBe(true);
    expect(sem.waiting).toBe(0);
    for (const h of replies) h.release();
    await Promise.all(replies.map((h) => h.done));
    expect(sem.free).toBe(20);
  });

  test("an aborted waiter leaves its class's queue and the permit goes to the other class", async () => {
    for (const [gone, other] of [
      ["reply", "background"],
      ["background", "reply"],
    ] as const) {
      const sem = new Semaphore(1, { backgroundMin: 0, agingMs: 60_000 });
      const held = holder(sem, "reply");
      await tick();
      const ac = new AbortController();
      const leaving = holder(sem, gone, ac.signal);
      const staying = holder(sem, other);
      const reason = new Error("deadline");
      ac.abort(reason);
      await expect(leaving.done).rejects.toBe(reason);
      expect(leaving.state.started).toBe(false);
      held.release();
      await tick();
      expect(staying.state.started).toBe(true);
      staying.release();
      await Promise.all([held.done, staying.done]);
      expect(sem.free).toBe(1);
    }
  });

  test("the reading says how many of each class hold and wait, and how long the oldest waited", async () => {
    const c = clock(1_000);
    const sem = new Semaphore(1, {
      backgroundMin: 0,
      agingMs: 60_000,
      now: c.now,
    });
    const held = holder(sem, "reply");
    await tick();
    const b1 = holder(sem, "background");
    c.set(1_400);
    const r1 = holder(sem, "reply");
    c.set(1_700);
    const b2 = holder(sem, "background");
    c.set(2_000);
    expect(sem.classReading()).toEqual({
      reply: { held: 1, waiting: 1, oldestWaitMs: 600 },
      background: { held: 0, waiting: 2, oldestWaitMs: 1_000 },
    });
    held.release();
    await tick();
    r1.release();
    await tick();
    b1.release();
    await tick();
    b2.release();
    await Promise.all([held.done, r1.done, b1.done, b2.done]);
  });
});
