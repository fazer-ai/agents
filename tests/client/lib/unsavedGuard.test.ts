/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  acquireBeforeUnload,
  leaveViaBackTrap,
  pushBackBlocker,
} from "@/client/lib/unsavedGuard";

// The guard manager is a module-level singleton (the listeners must survive
// component unmounts), so each test fully releases what it acquires to keep the
// shared state balanced for the next one.

// A browser's history.back() always ends in a popstate; mocks that land it at once keep the trap's
// cleanup from waiting on a pop that never comes.
const landPop = () => {
  window.dispatchEvent(new Event("popstate"));
};

describe("unsavedGuard: beforeunload", () => {
  test("ref-counts the beforeunload listener (attach once, detach on last release)", () => {
    const add = spyOn(window, "addEventListener");
    const remove = spyOn(window, "removeEventListener");
    const adds = () =>
      add.mock.calls.filter((c) => c[0] === "beforeunload").length;
    const removes = () =>
      remove.mock.calls.filter((c) => c[0] === "beforeunload").length;

    const r1 = acquireBeforeUnload();
    const r2 = acquireBeforeUnload();
    expect(adds()).toBe(1); // only the first acquire attaches
    r1();
    expect(removes()).toBe(0); // still one holder
    r2();
    expect(removes()).toBe(1); // last release detaches

    add.mockRestore();
    remove.mockRestore();
  });

  test("the attached listener prevents the unload, and stops after release", () => {
    const release = acquireBeforeUnload();
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);

    release();
    const e2 = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e2);
    expect(e2.defaultPrevented).toBe(false);
  });
});

describe("unsavedGuard: back-button trap", () => {
  // The trap waits a bounded time for its own cleanup pop. Each test reads a clock that starts well
  // past whatever an earlier test file left in flight, and stands still within the test.
  let clock = Date.now();
  let now: ReturnType<typeof spyOn> | null = null;
  beforeEach(() => {
    clock += 60_000;
    now = spyOn(Date, "now").mockImplementation(() => clock);
  });
  afterEach(() => {
    now?.mockRestore();
  });

  test("arms a sentinel, re-arms on Back, and notifies the top blocker", () => {
    const push = spyOn(window.history, "pushState");
    const back = spyOn(window.history, "back").mockImplementation(landPop);
    let calls = 0;
    const unregister = pushBackBlocker(() => {
      calls += 1;
    });

    expect(push.mock.calls.length).toBe(1); // armed on first blocker
    window.dispatchEvent(new Event("popstate")); // simulate Back
    expect(calls).toBe(1); // top blocker notified
    expect(push.mock.calls.length).toBe(2); // re-armed to keep protecting

    unregister();
    push.mockRestore();
    back.mockRestore();
  });

  test("only one sentinel for the whole stack; LIFO notification order", () => {
    const push = spyOn(window.history, "pushState");
    const back = spyOn(window.history, "back").mockImplementation(landPop);
    let a = 0;
    let b = 0;
    const ra = pushBackBlocker(() => {
      a += 1;
    });
    const rb = pushBackBlocker(() => {
      b += 1;
    });
    // A single sentinel is pushed when the stack goes empty→non-empty.
    expect(push.mock.calls.length).toBe(1);

    window.dispatchEvent(new Event("popstate"));
    expect(b).toBe(1); // topmost first
    expect(a).toBe(0);

    rb();
    window.dispatchEvent(new Event("popstate"));
    expect(a).toBe(1); // next one down after the top is removed

    ra();
    push.mockRestore();
    back.mockRestore();
  });

  // A modal's guard releases (its sentinel cleanup is a back() whose popstate arrives
  // later) and the page's guard arms before that pop lands. The pop is the trap's own, not a Back.
  test("a cleanup pop that lands after another guard armed is not a Back for it", () => {
    const push = spyOn(window.history, "pushState");
    let pendingPop = false;
    const back = spyOn(window.history, "back").mockImplementation(() => {
      pendingPop = true;
    });
    const modal = pushBackBlocker(() => {});
    modal(); // modal saved and closed: cleanup back() is on the way
    expect(back.mock.calls.length).toBe(1);

    let pageBacks = 0;
    const pushesBefore = push.mock.calls.length;
    const page = pushBackBlocker(() => {
      pageBacks += 1;
    });
    // No sentinel while the cleanup pop is on the way: it would be the entry that pop leaves from.
    expect(push.mock.calls.length).toBe(pushesBefore);
    expect(pendingPop).toBe(true);
    pendingPop = false;
    // The cleanup pop lands: the browser is back on the page's own entry, sentinel gone.
    window.history.replaceState({}, "");
    window.dispatchEvent(new Event("popstate"));
    expect(pageBacks).toBe(0);
    // ...and the page is protected: a sentinel is on top and the user's Back reaches it.
    expect(
      (window.history.state as Record<string, unknown> | null)
        ?.__unsavedBackGuard,
    ).toBe(true);
    window.dispatchEvent(new Event("popstate"));
    expect(pageBacks).toBe(1);

    back.mockImplementation(landPop);
    page();
    push.mockRestore();
    back.mockRestore();
  });

  test("released, armed and released again before the cleanup pop lands: one back()", () => {
    let pendingPops = 0;
    const back = spyOn(window.history, "back").mockImplementation(() => {
      pendingPops += 1;
    });
    const a = pushBackBlocker(() => {});
    a();
    const b = pushBackBlocker(() => {});
    b();
    // A second back() would traverse past the guarded page itself.
    expect(back.mock.calls.length).toBe(1);
    expect(pendingPops).toBe(1);
    window.dispatchEvent(new Event("popstate")); // the one cleanup pop lands

    // Settled: a fresh guard arms with its own sentinel and sees the next Back.
    back.mockImplementation(landPop);
    let calls = 0;
    const c = pushBackBlocker(() => {
      calls += 1;
    });
    window.dispatchEvent(new Event("popstate"));
    expect(calls).toBe(1);
    c();
    back.mockRestore();
  });

  test("the listener is detached once the cleanup pop lands with no guard left", () => {
    const remove = spyOn(window, "removeEventListener");
    const back = spyOn(window.history, "back").mockImplementation(landPop);
    const r = pushBackBlocker(() => {});
    r();
    expect(remove.mock.calls.filter((c) => c[0] === "popstate").length).toBe(1);
    remove.mockRestore();
    back.mockRestore();
  });

  test("leaving through the trap clears a pending cleanup, so the next guard arms its sentinel", () => {
    const back = spyOn(window.history, "back").mockImplementation(() => {});
    const go = spyOn(window.history, "go").mockImplementation(() => {});
    const modal = pushBackBlocker(() => {});
    modal(); // cleanup pop on the way...
    const page = pushBackBlocker(() => {});
    leaveViaBackTrap(); // ...and the page is left before it lands
    page();

    const push = spyOn(window.history, "pushState");
    back.mockImplementation(landPop);
    const next = pushBackBlocker(() => {});
    expect(push.mock.calls.length).toBe(1);
    next();
    push.mockRestore();
    back.mockRestore();
    go.mockRestore();
  });

  test("a cleanup pop that never lands stops being awaited, and the next guard arms its sentinel", () => {
    const back = spyOn(window.history, "back").mockImplementation(() => {});
    const gone = pushBackBlocker(() => {});
    gone(); // its cleanup back() never produces a popstate

    clock += 5_000;
    const push = spyOn(window.history, "pushState");
    let calls = 0;
    const next = pushBackBlocker(() => {
      calls += 1;
    });
    expect(push.mock.calls.length).toBe(1);
    window.dispatchEvent(new Event("popstate")); // the user's Back
    expect(calls).toBe(1);

    back.mockImplementation(landPop);
    next();
    push.mockRestore();
    back.mockRestore();
  });

  test("a cleanup pop that lands with no guard armed is heard, so a guard right after arms its sentinel", () => {
    const back = spyOn(window.history, "back").mockImplementation(() => {});
    const gone = pushBackBlocker(() => {});
    gone();
    window.dispatchEvent(new Event("popstate")); // the cleanup pop lands, nobody armed

    const push = spyOn(window.history, "pushState");
    let calls = 0;
    const next = pushBackBlocker(() => {
      calls += 1;
    });
    expect(push.mock.calls.length).toBe(1);
    window.dispatchEvent(new Event("popstate"));
    expect(calls).toBe(1);

    back.mockImplementation(landPop);
    next();
    push.mockRestore();
    back.mockRestore();
  });
});
