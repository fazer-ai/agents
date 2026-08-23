import { beforeEach, describe, expect, test } from "bun:test";
import type { ContactAuthVerdict } from "@/modules/contact-auth/check";
import {
  claimContactAuthNotice,
  clearContactAuthState,
  contactAuthFlightKey,
  contactAuthNoticeCount,
  contactAuthNoticeEntries,
  contactAuthNoticeKey,
  nextSweepDelayMs,
  releaseContactAuthNotice,
  singleFlight,
  sweepContactAuthNotices,
} from "@/modules/contact-auth/state";

// The gate's in-process state with an injected clock: the notice cooldown (what is retained, for
// how long, and that the active sweep actually DELETES what lapsed) and the single-flight (dedupe
// of work in flight). There is deliberately NO verdict cache to test: every message re-asks the
// endpoint, and these are the only two things that outlive a single call.

const T0 = 1_000_000;
const ALLOWED: ContactAuthVerdict = { outcome: "allowed", status: 200 };

beforeEach(() => {
  clearContactAuthState();
});

describe("claimContactAuthNotice", () => {
  test("first claim voices; a second within the window is suppressed; the lapse reopens it", () => {
    expect(claimContactAuthNotice("k", 60_000, T0)).toBeTruthy();
    expect(claimContactAuthNotice("k", 60_000, T0 + 59_999)).toBe(false);
    // NOTE: Inclusive boundary, same as the sweep: at exactly the lapse the window is over.
    expect(claimContactAuthNotice("k", 60_000, T0 + 60_000)).toBeTruthy();
  });

  test("a suppressed claim does NOT extend the window", () => {
    expect(claimContactAuthNotice("k", 60_000, T0)).toBeTruthy();
    expect(claimContactAuthNotice("k", 60_000, T0 + 30_000)).toBe(false);
    // Had the suppressed claim renewed the window, this one would still be inside it.
    expect(claimContactAuthNotice("k", 60_000, T0 + 60_000)).toBeTruthy();
  });

  test("cooldown 0 always voices and retains nothing", () => {
    expect(claimContactAuthNotice("k", 0, T0)).toBeTruthy();
    expect(claimContactAuthNotice("k", 0, T0)).toBeTruthy();
    expect(contactAuthNoticeCount()).toBe(0);
  });

  test("distinct conversations have independent windows", () => {
    const a = contactAuthNoticeKey(1n, 2n, 30n, "note");
    const b = contactAuthNoticeKey(1n, 2n, 31n, "note");
    expect(claimContactAuthNotice(a, 60_000, T0)).toBeTruthy();
    expect(claimContactAuthNotice(b, 60_000, T0)).toBeTruthy();
    expect(claimContactAuthNotice(a, 60_000, T0 + 1)).toBe(false);
  });

  // An endpoint ERROR writes a note and speaks to nobody. Sharing one window with the customer copy
  // let it spend the copy's, so the denial right after it was refused in silence — and the copy is
  // usually the unlock instructions, with the handoff after it ending the bot's attribution.
  test("the customer copy and the operator note hold separate windows", () => {
    const copy = contactAuthNoticeKey(1n, 2n, 30n, "copy");
    const note = contactAuthNoticeKey(1n, 2n, 30n, "note");
    expect(claimContactAuthNotice(note, 60_000, T0)).toBeTruthy();
    expect(claimContactAuthNotice(copy, 60_000, T0 + 1)).toBeTruthy();
    expect(claimContactAuthNotice(note, 60_000, T0 + 2)).toBe(false);
  });

  // Release gives back the window this send claimed, and only that one. With a cooldown shorter
  // than a slow Chatwoot send, a lapsed claim can already have been replaced by somebody else's.
  test("a failed send releases its own window, never a newer one", () => {
    const a = claimContactAuthNotice("k", 10_000, T0);
    if (!a) throw new Error("first claim should have been granted");
    const b = claimContactAuthNotice("k", 10_000, T0 + 10_000);
    if (!b) throw new Error("second claim should have been granted");
    // A's send fails last: the window standing now is B's, and it stays.
    releaseContactAuthNotice(a);
    expect(claimContactAuthNotice("k", 10_000, T0 + 12_000)).toBe(false);
    // B's own release does open it again.
    releaseContactAuthNotice(b);
    expect(claimContactAuthNotice("k", 10_000, T0 + 12_000)).toBeTruthy();
  });

  test("releasing a cooldown-0 claim retains nothing", () => {
    const c = claimContactAuthNotice("k", 0, T0);
    if (!c) throw new Error("a zero cooldown always voices");
    releaseContactAuthNotice(c);
    expect(contactAuthNoticeCount()).toBe(0);
  });

  test("what is retained is ids and timestamps, nothing anyone said", () => {
    claimContactAuthNotice(
      contactAuthNoticeKey(1n, 2n, 3n, "note"),
      60_000,
      T0,
    );
    for (const entry of contactAuthNoticeEntries()) {
      expect(Object.keys(entry).sort()).toEqual(["key", "until"]);
      expect(typeof entry.key).toBe("string");
      expect(typeof entry.until).toBe("number");
    }
  });
});

describe("sweep", () => {
  test("nextSweepDelayMs finds the EARLIEST lapse regardless of insertion order", () => {
    claimContactAuthNotice("later", 300_000, T0);
    claimContactAuthNotice("sooner", 30_000, T0);
    expect(nextSweepDelayMs(T0)).toBe(30_000);
    expect(nextSweepDelayMs(T0 + 40_000)).toBe(0);
  });

  test("sweeping at the earliest lapse removes only what lapsed", () => {
    claimContactAuthNotice("a", 300_000, T0);
    claimContactAuthNotice("b", 30_000, T0);
    sweepContactAuthNotices(T0 + 30_000);
    expect(contactAuthNoticeCount()).toBe(1);
    expect(contactAuthNoticeEntries()[0]?.key).toBe("a");
    // And the next wake-up is the survivor's lapse.
    expect(nextSweepDelayMs(T0 + 30_000)).toBe(270_000);
  });

  test("an empty store has no next wake-up", () => {
    expect(nextSweepDelayMs(T0)).toBeNull();
  });
});

describe("singleFlight", () => {
  test("concurrent callers of one key share a single run", async () => {
    let runs = 0;
    let release: (v: ContactAuthVerdict) => void = () => {};
    const gate = new Promise<ContactAuthVerdict>((resolve) => {
      release = resolve;
    });
    const run = () => {
      runs += 1;
      return gate;
    };
    const first = singleFlight("k", run);
    const second = singleFlight("k", run);
    release(ALLOWED);
    const [a, b] = await Promise.all([first, second]);
    expect(runs).toBe(1);
    expect(a).toEqual({ verdict: ALLOWED, shared: false });
    // The coalesced follower is told the verdict was shared, which the gate reads as "the leader
    // acts, I stay silent": only one deny message ever leaves for one concurrent burst.
    expect(b).toEqual({ verdict: ALLOWED, shared: true });
  });

  test("distinct keys do not coalesce", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return ALLOWED;
    };
    await Promise.all([
      singleFlight(contactAuthFlightKey(1n, 2n, 3n, "inbox"), run),
      singleFlight(contactAuthFlightKey(1n, 2n, 4n, "inbox"), run),
    ]);
    expect(runs).toBe(2);
  });

  // The joiner is told `shared`, and `shared` is what suppresses its own deny copy, handoff and
  // note. A nudge and an incoming message are not the same question, so one must never answer for
  // the other: under an unlock flow the nudge carries no code and its refusal would land on the
  // very message that does.
  test("a nudge and an incoming message do not share a flight", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return ALLOWED;
    };
    await Promise.all([
      singleFlight(contactAuthFlightKey(1n, 2n, 3n, "nudge"), run),
      singleFlight(contactAuthFlightKey(1n, 2n, 3n, "msg:900"), run),
    ]);
    expect(runs).toBe(2);
  });

  test("two messages of the same contact are two questions, the same message one", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return ALLOWED;
    };
    await Promise.all([
      singleFlight(contactAuthFlightKey(1n, 2n, 3n, "msg:900"), run),
      singleFlight(contactAuthFlightKey(1n, 2n, 3n, "msg:901"), run),
      // Same delivery arriving twice: this is the case single-flight exists to collapse.
      singleFlight(contactAuthFlightKey(1n, 2n, 3n, "msg:900"), run),
    ]);
    expect(runs).toBe(2);
  });

  test("a finished flight releases the key: the next message asks again", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return ALLOWED;
    };
    await singleFlight("k", run);
    await singleFlight("k", run);
    // NOTE: This is the no-cache contract in miniature: nothing outlives the promise.
    expect(runs).toBe(2);
  });

  test("a rejected flight releases the key too", async () => {
    const boom = async (): Promise<ContactAuthVerdict> => {
      throw new Error("boom");
    };
    await expect(singleFlight("k", boom)).rejects.toThrow("boom");
    let runs = 0;
    await singleFlight("k", async () => {
      runs += 1;
      return ALLOWED;
    });
    expect(runs).toBe(1);
  });
});
