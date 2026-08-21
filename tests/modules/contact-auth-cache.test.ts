import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearContactAuthCache,
  contactAuthCacheEntries,
  contactAuthCacheKey,
  contactAuthCacheSize,
  nextSweepDelayMs,
  readCachedVerdict,
  type StoredVerdict,
  singleFlight,
  storeVerdict,
  sweepContactAuthCache,
} from "@/modules/contact-auth/cache";

// The verdict cache with an injected clock: what is retained, for how long, and that the active
// sweep actually DELETES (not merely hides) what expired. Entries carry per-agent TTLs, so unlike
// the media-annotation store the earliest expiry has to be found, not assumed from insertion order.

const T0 = 1_000_000;
const ALLOWED: StoredVerdict = { outcome: "allowed", status: 200 };
const DENIED: StoredVerdict = {
  outcome: "denied",
  status: 200,
  reason: "not_customer",
};

beforeEach(() => {
  clearContactAuthCache();
});

describe("storeVerdict / readCachedVerdict", () => {
  test("a verdict lives exactly its TTL (inclusive expiry boundary)", () => {
    storeVerdict("k", ALLOWED, 300_000, T0);
    expect(readCachedVerdict("k", T0 + 299_999)).toEqual(ALLOWED);
    expect(readCachedVerdict("k", T0 + 300_000)).toBeNull();
    // Reclaimed on the way out, not merely hidden.
    expect(contactAuthCacheSize()).toBe(0);
  });

  test("a non-positive TTL stores nothing (ask on every message)", () => {
    storeVerdict("k", ALLOWED, 0, T0);
    expect(contactAuthCacheSize()).toBe(0);
    expect(readCachedVerdict("k", T0)).toBeNull();
  });

  test("the cached copy cannot be mutated by a caller", () => {
    const v: StoredVerdict = { outcome: "denied", status: 403 };
    storeVerdict("k", v, 60_000, T0);
    v.outcome = "allowed";
    expect(readCachedVerdict("k", T0 + 1)?.outcome).toBe("denied");
  });

  test("the cache retains ids and verdicts, nothing it was asked about", () => {
    storeVerdict(contactAuthCacheKey(1n, 2n, 3n), DENIED, 60_000, T0);
    const dump = JSON.stringify(contactAuthCacheEntries());
    expect(dump).toContain('"1:2:3"');
    expect(dump).toContain("not_customer");
    for (const entry of contactAuthCacheEntries()) {
      expect(Object.keys(entry).sort()).toEqual([
        "expiresAt",
        "key",
        "verdict",
      ]);
      expect(
        Object.keys(entry.verdict).every((k) =>
          ["outcome", "status", "reason"].includes(k),
        ),
      ).toBe(true);
    }
  });
});

describe("sweep", () => {
  test("nextSweepDelayMs finds the EARLIEST expiry regardless of insertion order", () => {
    storeVerdict("later", ALLOWED, 300_000, T0);
    storeVerdict("sooner", { outcome: "error", reason: "timeout" }, 30_000, T0);
    expect(nextSweepDelayMs(T0)).toBe(30_000);
    expect(nextSweepDelayMs(T0 + 40_000)).toBe(0);
  });

  test("sweeping at the earliest expiry removes only what expired", () => {
    storeVerdict("a", ALLOWED, 300_000, T0);
    storeVerdict("b", { outcome: "error", reason: "network" }, 30_000, T0);
    sweepContactAuthCache(T0 + 30_000);
    expect(contactAuthCacheSize()).toBe(1);
    expect(readCachedVerdict("a", T0 + 30_000)).toEqual(ALLOWED);
    expect(readCachedVerdict("b", T0 + 30_000)).toBeNull();
    // And the next wake-up is the survivor's expiry.
    expect(nextSweepDelayMs(T0 + 30_000)).toBe(270_000);
  });

  test("an empty cache has no next wake-up", () => {
    expect(nextSweepDelayMs(T0)).toBeNull();
  });
});

describe("singleFlight", () => {
  test("concurrent callers of one key share a single run", async () => {
    let runs = 0;
    let release: (v: StoredVerdict) => void = () => {};
    const gate = new Promise<StoredVerdict>((resolve) => {
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
    // The coalesced follower is told the verdict was shared, which the gate reads as "already
    // acted on": only one deny message ever leaves for one burst.
    expect(b).toEqual({ verdict: ALLOWED, shared: true });
  });

  test("distinct keys do not coalesce", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return ALLOWED;
    };
    await Promise.all([singleFlight("k1", run), singleFlight("k2", run)]);
    expect(runs).toBe(2);
  });

  test("a finished flight releases the key for the next check", async () => {
    let runs = 0;
    const run = async () => {
      runs += 1;
      return ALLOWED;
    };
    await singleFlight("k", run);
    await singleFlight("k", run);
    expect(runs).toBe(2);
  });

  test("a rejected flight releases the key too", async () => {
    let calls = 0;
    const failing = () => {
      calls += 1;
      return Promise.reject(new Error("boom"));
    };
    await expect(singleFlight("k", failing)).rejects.toThrow("boom");
    await expect(singleFlight("k", failing)).rejects.toThrow("boom");
    expect(calls).toBe(2);
  });
});
