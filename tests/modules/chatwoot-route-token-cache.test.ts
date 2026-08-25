import { beforeEach, describe, expect, test } from "bun:test";
import {
  awaitRouteTokenRefresh,
  invalidateRouteTokenCache,
  noteRouteTokenLookup,
  ROUTE_TOKEN_CACHE_TTL_MS,
  ROUTE_TOKEN_NEGATIVE_MAX,
  ROUTE_TOKEN_STALE_MS,
  readRouteTokenCache,
  routeTokenCacheGeneration,
  routeTokenRefreshInFlight,
  trackRouteTokenRefresh,
  writeRouteTokenCache,
} from "@/modules/chatwoot/route-token-cache";

const bot = {
  tenantId: 1n,
  instanceId: 2n,
  agentBotId: 9,
  webhookSecret: "enc",
};
const T0 = 1_800_000_000_000;

describe("route token cache", () => {
  beforeEach(() => {
    invalidateRouteTokenCache();
    noteRouteTokenLookup(true); // store-level and global: a prior test's failure would leak
  });

  test("a fresh positive entry is served without being marked stale", () => {
    writeRouteTokenCache("h", bot, { now: T0 });
    expect(readRouteTokenCache("h", T0 + ROUTE_TOKEN_CACHE_TTL_MS - 1)).toEqual(
      {
        bot,
        stale: false,
      },
    );
  });

  // THE ONE THAT MATTERS. An instance quiet for longer than the TTL is cold on every message, so if
  // expiry meant a miss, the first message of every conversation would put a Postgres transaction
  // back inside the 5s ack budget — the exact cost that escalates the conversation (measured: 5.24s
  // from customer message to "marked open by system" against a real Chatwoot).
  test("a positive entry past the TTL is still served, flagged for refresh", () => {
    writeRouteTokenCache("h", bot, { now: T0 });
    const hit = readRouteTokenCache("h", T0 + ROUTE_TOKEN_CACHE_TTL_MS + 1);
    expect(hit).toEqual({ bot, stale: true });
  });

  test("past the stale window it finally becomes a miss", () => {
    writeRouteTokenCache("h", bot, { now: T0 });
    const past = T0 + ROUTE_TOKEN_CACHE_TTL_MS + ROUTE_TOKEN_STALE_MS + 1;
    expect(readRouteTokenCache("h", past)).toBeUndefined();
  });

  // A negative answer is attacker-supplied input, so it never earns the background query a stale
  // read would trigger.
  test("a negative entry expires hard instead of going stale", () => {
    writeRouteTokenCache("h", null, { now: T0 });
    expect(readRouteTokenCache("h", T0 + 1)).toEqual({
      bot: null,
      stale: false,
    });
    expect(
      readRouteTokenCache("h", T0 + ROUTE_TOKEN_CACHE_TTL_MS + 1),
    ).toBeUndefined();
  });

  // The receiver is public and unauthenticated: unique tokens are free to generate, and an unbounded
  // map turns that into memory the process never gets back.
  test("the negative cache is bounded no matter how many unknown tokens arrive", () => {
    for (let i = 0; i < ROUTE_TOKEN_NEGATIVE_MAX * 3; i++) {
      writeRouteTokenCache(`probe-${i}`, null, { now: T0 });
    }
    let alive = 0;
    for (let i = 0; i < ROUTE_TOKEN_NEGATIVE_MAX * 3; i++) {
      if (readRouteTokenCache(`probe-${i}`, T0 + 1) !== undefined) alive++;
    }
    expect(alive).toBeLessThanOrEqual(ROUTE_TOKEN_NEGATIVE_MAX);
    // And the eviction is oldest-first, so the newest probes are the survivors.
    expect(
      readRouteTokenCache(`probe-${ROUTE_TOKEN_NEGATIVE_MAX * 3 - 1}`, T0 + 1),
    ).toEqual({ bot: null, stale: false });
  });

  // A prober cannot evict the handful of real bots: the two kinds of entry do not share a bound.
  test("probing does not evict a real resolution", () => {
    writeRouteTokenCache("real", bot, { now: T0 });
    for (let i = 0; i < ROUTE_TOKEN_NEGATIVE_MAX * 2; i++) {
      writeRouteTokenCache(`probe-${i}`, null, { now: T0 });
    }
    expect(readRouteTokenCache("real", T0 + 1)).toEqual({ bot, stale: false });
  });

  test("a token that flips sign does not keep its old answer", () => {
    writeRouteTokenCache("h", bot, { now: T0 });
    writeRouteTokenCache("h", null, { now: T0 });
    expect(readRouteTokenCache("h", T0 + 1)).toEqual({
      bot: null,
      stale: false,
    });
    writeRouteTokenCache("h", bot, { now: T0 });
    expect(readRouteTokenCache("h", T0 + 1)).toEqual({ bot, stale: false });
  });

  // The sign flip has to REMOVE the old answer, not shadow it. A negative entry expires in 30s while
  // a positive one is held for a day, so an entry merely shadowed comes back the moment the negative
  // one is evicted: two requests arriving together past the TTL, the first evicts and goes to query,
  // the second reads what is left and gets the bot of an instance that is disconnected.
  test("a disconnect does not resurface once the negative entry is evicted", () => {
    writeRouteTokenCache("h", bot, { now: T0 });
    writeRouteTokenCache("h", null, { now: T0 }); // the instance went disconnected
    const past = T0 + ROUTE_TOKEN_CACHE_TTL_MS + 1;
    expect(readRouteTokenCache("h", past)).toBeUndefined(); // evicts the negative entry
    expect(readRouteTokenCache("h", past)).toBeUndefined(); // nothing older may surface behind it
  });

  // THE RULE THAT KEEPS THE STALE SERVE HONEST. A 200 is a promise Chatwoot never revisits: it does
  // not retry a 2xx, and the payload is not stored. Answering from a cached row while Postgres is
  // unreachable does not save the event, it loses it in silence, which is worse than the escalation
  // a blocked ack causes. So the moment a lookup cannot reach the database, the window shuts.
  test("a failed lookup closes the stale window for every token", () => {
    writeRouteTokenCache("a", bot, { now: T0 });
    writeRouteTokenCache("b", bot, { now: T0 });
    const past = T0 + ROUTE_TOKEN_CACHE_TTL_MS + 1;
    expect(readRouteTokenCache("a", past)).toEqual({ bot, stale: true });

    noteRouteTokenLookup(false);
    expect(readRouteTokenCache("a", past)).toBeUndefined();
    // Store-level on purpose: the first token to discover the outage protects the rest.
    expect(readRouteTokenCache("b", past)).toBeUndefined();

    noteRouteTokenLookup(true);
    expect(readRouteTokenCache("a", past)).toEqual({ bot, stale: true });
  });

  // An unhealthy lookup never blocks a FRESH answer: inside the TTL the row was read recently enough
  // that the detached half has the same chance it always had.
  test("a failed lookup does not touch a fresh entry", () => {
    writeRouteTokenCache("h", bot, { now: T0 });
    noteRouteTokenLookup(false);
    expect(readRouteTokenCache("h", T0 + 1)).toEqual({ bot, stale: false });
  });

  // A lookup that started before an invalidation holds the row as it was BEFORE the writer's commit.
  // Letting it land afterwards resurrects exactly what the writer retired, and the entry then keeps
  // authenticating until some later refresh happens to succeed.
  test("a lookup that started before an invalidation cannot write after it", () => {
    const generation = routeTokenCacheGeneration();
    invalidateRouteTokenCache(); // a disconnect, a delete or a re-provision commits here
    writeRouteTokenCache("h", bot, { now: T0, generation });
    expect(readRouteTokenCache("h", T0 + 1)).toBeUndefined();
  });

  test("a lookup with the current generation still writes", () => {
    invalidateRouteTokenCache();
    const generation = routeTokenCacheGeneration();
    writeRouteTokenCache("h", bot, { now: T0, generation });
    expect(readRouteTokenCache("h", T0 + 1)).toEqual({ bot, stale: false });
  });

  test("invalidation clears both signs, by key and wholesale", () => {
    writeRouteTokenCache("pos", bot, { now: T0 });
    writeRouteTokenCache("neg", null, { now: T0 });
    invalidateRouteTokenCache("pos");
    expect(readRouteTokenCache("pos", T0 + 1)).toBeUndefined();
    expect(readRouteTokenCache("neg", T0 + 1)).not.toBeUndefined();
    invalidateRouteTokenCache();
    expect(readRouteTokenCache("neg", T0 + 1)).toBeUndefined();
  });

  // `globalThis` outlives a module reload under `bun --hot`, and this symbol has held a different
  // shape before ({ entries: Map }). A null check alone hands that object back and the first read on
  // the ack path throws on a property that is not there.
  test("a store left under the symbol in an older shape is replaced, not adopted", () => {
    const g = globalThis as unknown as Record<symbol, unknown>;
    g[Symbol.for("fazerai.chatwoot.routeTokens")] = { entries: new Map() };
    expect(() => readRouteTokenCache("h", T0)).not.toThrow();
    writeRouteTokenCache("h", bot, { now: T0 });
    expect(readRouteTokenCache("h", T0 + 1)).toEqual({ bot, stale: false });
  });

  // Without coalescing, the moment an entry goes stale is the moment every in-flight request starts
  // its own lookup: the burst the cache exists to keep off Postgres.
  test("one refresh per token, and later callers get that same promise", async () => {
    let started = 0;
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const run = () => {
      started++;
      return gate;
    };
    const first = trackRouteTokenRefresh("h", run);
    const second = trackRouteTokenRefresh("h", run);
    expect(started).toBe(1);
    expect(second).toBe(first);
    expect(trackRouteTokenRefresh("other", run)).not.toBe(first);
    expect(started).toBe(2);
    release();
    await first;
    expect(routeTokenRefreshInFlight("h")).toBeUndefined();
  });

  // A REFRESH THAT NEVER SETTLES MUST NOT WEDGE THE BOT. Waiting on the one in flight is what keeps a
  // dead database from being acked, but a hang is not a rejection: without a bound, every later
  // delivery for this token queues behind a promise that never answers, and each one burns Chatwoot's
  // whole 5s budget before anything else in the receiver runs. The wait is bounded, and the refresh
  // that overran stops being THE refresh so the next request can start a live one.
  test("a refresh that hangs is waited on for a bounded time, then dropped", async () => {
    const gate = new Promise<void>(() => {}); // never settles
    trackRouteTokenRefresh("h", () => gate);
    expect(routeTokenRefreshInFlight("h")).toBeDefined();

    const started = Date.now();
    await expect(awaitRouteTokenRefresh("h", 20)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
    // Dropped, so the NEXT delivery opens a fresh lookup instead of inheriting the hang.
    expect(routeTokenRefreshInFlight("h")).toBeUndefined();
  });

  // AND A TIMED-OUT REFRESH IS A FAILED LOOKUP, which is the whole of rule three. Dropping the hung
  // refresh without saying so leaves the entry servable: the next delivery is answered from memory
  // and acked 2xx while Postgres is exactly as unreachable as it was a moment ago, and Chatwoot never
  // redelivers a 2xx. One event lost per timeout cycle, silently, which is the failure this module
  // exists to refuse.
  test("a refresh that timed out closes the stale window", () => {
    writeRouteTokenCache("h", bot, { now: T0 });
    const past = T0 + ROUTE_TOKEN_CACHE_TTL_MS + 1;
    trackRouteTokenRefresh("h", () => new Promise<void>(() => {}));
    return awaitRouteTokenRefresh("h", 20).then(
      () => {
        throw new Error("the bounded wait should have rejected");
      },
      () => {
        expect(readRouteTokenCache("h", past)).toBeUndefined();
      },
    );
  });

  // AND THE ONE THAT OVERRAN CANNOT EVICT ITS REPLACEMENT when it finally settles. `finally` deletes
  // by key, so a late arrival would remove the refresh a later request registered, putting the map
  // back to empty while a live lookup is still running — and the request after that would open a
  // third.
  test("a late refresh does not evict the one that replaced it", async () => {
    let releaseFirst = () => {};
    const first = new Promise<void>((r) => {
      releaseFirst = r;
    });
    trackRouteTokenRefresh("h", () => first);
    await expect(awaitRouteTokenRefresh("h", 20)).rejects.toThrow();

    const second = new Promise<void>(() => {});
    trackRouteTokenRefresh("h", () => second);
    expect(routeTokenRefreshInFlight("h")).toBeDefined();

    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(routeTokenRefreshInFlight("h")).toBeDefined();
  });

  // AND AN INVALIDATION DETACHES IT. The writer already committed, so the answer that refresh is
  // about to produce is about the world before the change. A request arriving after the commit would
  // otherwise wait on it — and now inherit its failure — for a question it is no longer asking.
  test("an invalidation detaches the refresh in flight", async () => {
    trackRouteTokenRefresh("h", () => new Promise<void>(() => {}));
    expect(routeTokenRefreshInFlight("h")).toBeDefined();
    invalidateRouteTokenCache("h");
    expect(routeTokenRefreshInFlight("h")).toBeUndefined();

    trackRouteTokenRefresh("other", () => new Promise<void>(() => {}));
    invalidateRouteTokenCache();
    expect(routeTokenRefreshInFlight("other")).toBeUndefined();
  });

  // AND A STALE ENTRY IS NOT SERVED BESIDE A REFRESH. The refresh exists because the answer is in
  // doubt; handing the old one out next to it acks events the refresh may be about to prove
  // unbackable, and a 2xx is never redelivered.
  test("a refresh in flight makes a stale read a miss, not a stale hit", async () => {
    writeRouteTokenCache("h", bot, { now: T0 });
    const past = T0 + ROUTE_TOKEN_CACHE_TTL_MS + 1;
    expect(readRouteTokenCache("h", past)).toEqual({ bot, stale: true });

    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const p = trackRouteTokenRefresh("h", () => gate);
    expect(readRouteTokenCache("h", past)).toBeUndefined();
    release();
    await p;
    expect(readRouteTokenCache("h", past)).toEqual({ bot, stale: true });
  });
});
