// In-process cache for the receiver's route-token resolution.
//
// THE ACK PATH MUST NOT DEPEND ON POSTGRES BEING HEALTHY, AND MUST NOT PROMISE MORE THAN POSTGRES
// CAN DELIVER. Those pull in opposite directions and the whole design is the line between them.
//
// Chatwoot gives the receiver ~5s to answer (`WEBHOOK_TIMEOUT`) and escalates the conversation
// `pending -> open` when it does not, which takes the bot off a conversation it was about to answer
// correctly (issue #225). Measured against a real Chatwoot + Sidekiq: one stalled ack, and the
// activity note "marked open by system due to an error with the bot" lands 5.24s after the
// customer's message. Resolving the bot is an interactive transaction (RLS needs `set_config`), so
// under pool pressure it can burn that whole budget for a row that changes almost never.
//
// But a 200 is a promise. Chatwoot does not retry a 2xx and the payload is not stored (see
// docs/chatwoot.md, "No durable payload store"), so acking on the strength of a cached row while
// Postgres is actually down does not save the event, it loses it in silence, which is strictly worse
// than the escalation. THE CACHE THEREFORE ANSWERS ONLY WHAT THE PROCESS CAN STILL BACK UP:
//
//   1. inside the TTL              -> served, no questions
//   2. past it, last lookup OK     -> served, and refreshed behind the ack
//   3. past it, last lookup FAILED -> miss, so the ack blocks and fails honestly, and Chatwoot's
//                                     own retry ladder carries the event instead
//
// Rule 3 is what keeps rule 2 truthful, and it costs nothing in the case rule 2 exists for: an idle
// instance on a HEALTHY database, where the entry is merely old and the refresh will succeed.
//
// Lives in its own module so the writers that have to invalidate it (provisioning, instance
// connect/disconnect, deletion) can reach it without importing the receiver, which imports them.

// How long a resolution is served without questioning it.
export const ROUTE_TOKEN_CACHE_TTL_MS = 30_000;

// Backstop on the stale window. The health gate above is what actually ends a stale serve, so this
// only bites if a lookup somehow never reports either way. Short enough that a bug there costs
// minutes of blocked acks rather than a day of lost events.
export const ROUTE_TOKEN_STALE_MS = 10 * 60_000;

// How long a request will wait on somebody else's refresh before giving up on it. Chatwoot allows the
// whole receiver ~5s, so a wait longer than this has already lost: what remains would not cover the
// rest of the handler, and the delivery would be escalated anyway. A refresh that overruns it is not
// merely slow, it is a lookup nothing can bound (a hung socket rather than a rejected query), and the
// waiter fails honestly onto Chatwoot's retry ladder rather than holding the bot's whole webhook.
export const ROUTE_TOKEN_REFRESH_WAIT_MS = 2_000;

// Negative entries are attacker-reachable: the receiver is public and unauthenticated, and an
// unknown token is exactly what a prober loops on. Cached so the probe does not put its load on the
// ack path, bounded so it cannot put its load on the heap. Oldest-first eviction (Map preserves
// insertion order) is enough: the entries exist to absorb a burst on ONE token, not to be a hit rate.
export const ROUTE_TOKEN_NEGATIVE_MAX = 1_024;

export interface CachedRouteTokenBot {
  tenantId: bigint;
  instanceId: bigint;
  agentBotId: number;
  webhookSecret: string;
}

export interface RouteTokenCacheHit {
  // `null` is a real answer (this token resolves to nothing), distinct from a miss.
  bot: CachedRouteTokenBot | null;
  // Past the TTL and still servable: answer from here, and refresh behind the ack. Only ever true
  // for a positive entry, and only while the last lookup succeeded.
  stale: boolean;
}

interface Entry {
  bot: CachedRouteTokenBot | null;
  freshUntil: number;
}

const KEY = Symbol.for("fazerai.chatwoot.routeTokens");

interface Store {
  // Split by sign on purpose: one shared map with a size bound would let a prober's misses evict the
  // handful of real bots, which is the eviction an attacker would pick.
  positive: Map<string, Entry>;
  negative: Map<string, Entry>;
  // The refresh in flight per token, not merely the fact of one. A second request arriving mid-refresh
  // AWAITS it instead of being served stale: on a healthy database that costs a millisecond, and when
  // the database is gone it is the difference between one acked-and-lost event and every event that
  // arrives before the refresh reports back.
  refreshing: Map<string, Promise<void>>;
  // Did the last lookup reach Postgres? Store-level rather than per key, so the first token to
  // discover an outage protects every other token from promising a 200 it cannot honour.
  lookupHealthy: boolean;
  // Bumped by every invalidation. A lookup that started before the bump must not write its result
  // afterwards: the writer already committed and cleared the cache, and the in-flight read holds the
  // row as it was BEFORE that commit, so landing it would resurrect exactly what was retired.
  generation: number;
}

function store(): Store {
  const g = globalThis as unknown as Record<symbol, Store | undefined>;
  // SHAPE-CHECKED, NOT JUST NULL-CHECKED. `globalThis` outlives a module reload under `bun --hot`,
  // and this symbol has held a different shape before, so `??=` would hand back an object whose
  // `negative` is undefined and the first read on the ack path would throw. Checking the shape
  // covers any prior one without anyone having to remember to bump a version.
  const held = g[KEY];
  if (
    !held ||
    !(held.positive instanceof Map) ||
    !(held.negative instanceof Map) ||
    !(held.refreshing instanceof Map)
  ) {
    g[KEY] = {
      positive: new Map(),
      negative: new Map(),
      refreshing: new Map(),
      lookupHealthy: true,
      generation: 0,
    };
  }
  return g[KEY] as Store;
}

// Snapshot to pass back to `writeRouteTokenCache` after the lookup returns.
export function routeTokenCacheGeneration(): number {
  return store().generation;
}

// Reports whether a lookup reached Postgres. A failure is what closes the stale window.
export function noteRouteTokenLookup(ok: boolean): void {
  store().lookupHealthy = ok;
}

// Returns the cached resolution, or undefined when there is none to trust.
export function readRouteTokenCache(
  routeTokenHash: string,
  now: number = Date.now(),
): RouteTokenCacheHit | undefined {
  const s = store();
  const neg = s.negative.get(routeTokenHash);
  if (neg) {
    if (neg.freshUntil > now) return { bot: null, stale: false };
    s.negative.delete(routeTokenHash);
    return undefined;
  }
  const pos = s.positive.get(routeTokenHash);
  if (!pos) return undefined;
  if (pos.freshUntil > now) return { bot: pos.bot, stale: false };
  if (pos.freshUntil + ROUTE_TOKEN_STALE_MS <= now) {
    s.positive.delete(routeTokenHash);
    return undefined;
  }
  if (!s.lookupHealthy) return undefined;
  // A refresh already in flight means the answer is being questioned right now. Serving stale beside
  // it would ack events the refresh is about to prove unbackable; the caller waits on it instead.
  if (s.refreshing.has(routeTokenHash)) return undefined;
  return { bot: pos.bot, stale: true };
}

export interface WriteRouteTokenOptions {
  now?: number;
  // The value `routeTokenCacheGeneration()` returned before the lookup ran. Omit only where no
  // lookup preceded the write.
  generation?: number;
}

export function writeRouteTokenCache(
  routeTokenHash: string,
  bot: CachedRouteTokenBot | null,
  opts: WriteRouteTokenOptions = {},
): void {
  const s = store();
  if (opts.generation !== undefined && opts.generation !== s.generation) return;
  const now = opts.now ?? Date.now();
  const entry: Entry = { bot, freshUntil: now + ROUTE_TOKEN_CACHE_TTL_MS };
  if (bot === null) {
    // Removed, not shadowed. A negative entry expires in 30s and a positive one is held far longer,
    // so an entry merely shadowed resurfaces the moment the negative one is evicted.
    s.positive.delete(routeTokenHash);
    s.negative.delete(routeTokenHash); // re-insert so eviction order is recency, not first sight
    s.negative.set(routeTokenHash, entry);
    while (s.negative.size > ROUTE_TOKEN_NEGATIVE_MAX) {
      const oldest = s.negative.keys().next().value;
      if (oldest === undefined) break;
      s.negative.delete(oldest);
    }
    return;
  }
  s.negative.delete(routeTokenHash);
  s.positive.set(routeTokenHash, entry);
}

// The refresh in flight for this token, if any. A caller that finds one waits on it rather than
// starting its own (the burst this module exists to keep off Postgres) or being served stale (an ack
// the database may not be able to honour).
export function routeTokenRefreshInFlight(
  routeTokenHash: string,
): Promise<void> | undefined {
  return store().refreshing.get(routeTokenHash);
}

// Wait on the refresh in flight, if any, for at most `timeoutMs`. Rejects on the refresh's own
// failure (see trackRouteTokenRefresh) and rejects on the bound, which are the same answer to the
// caller: this ack cannot be honoured, so let Chatwoot redeliver. The overrunning refresh is detached
// on the way out — a hang that stayed registered would put every later delivery for this token behind
// a promise that never answers.
export async function awaitRouteTokenRefresh(
  routeTokenHash: string,
  timeoutMs: number = ROUTE_TOKEN_REFRESH_WAIT_MS,
): Promise<void> {
  const s = store();
  const inFlight = s.refreshing.get(routeTokenHash);
  if (!inFlight) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      inFlight,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // A REFRESH THAT OVERRAN IS A FAILED LOOKUP, and rule three is about failed lookups, not
          // about which shape the failure took. Dropping it quietly would leave the entry servable:
          // the next delivery is answered from memory and acked 2xx while Postgres is exactly as
          // unreachable as it was a moment ago, and a 2xx is never redelivered. That is one event
          // lost per timeout cycle, in silence, which is strictly worse than the escalation a
          // blocked ack causes.
          noteRouteTokenLookup(false);
          if (s.refreshing.get(routeTokenHash) === inFlight) {
            s.refreshing.delete(routeTokenHash);
          }
          reject(new Error("route token refresh did not answer in time"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Registers `run` as THE refresh for this token and returns it, or returns the one already running.
// Registering and starting are one step on purpose: any gap between them is a window where a second
// caller sees no refresh and starts one.
//
// THE RETURNED PROMISE REJECTS WHEN THE REFRESH FAILS, and that is the point: everyone waiting on it
// resumes into a cache the failure has just closed, so a resolved promise would send each of them
// down the blocking path to open its own transaction — a burst against the pool at the moment the
// pool is what is broken. Rejecting spends one lookup for all of them. The caller that STARTS a
// refresh is detached, so it attaches the log; nothing else may swallow it.
export function trackRouteTokenRefresh(
  routeTokenHash: string,
  run: () => Promise<void>,
): Promise<void> {
  const s = store();
  const existing = s.refreshing.get(routeTokenHash);
  if (existing) return existing;
  let p: Promise<void>;
  p = run().finally(() => {
    // BY IDENTITY, not by key. This refresh can be detached before it settles — an invalidation
    // retires it, or a waiter's bound drops it — and a later request registers its own under the same
    // key. Deleting by key here would remove THAT one while its lookup is still running, leaving the
    // map empty and the request after it opening a third.
    if (s.refreshing.get(routeTokenHash) === p) {
      s.refreshing.delete(routeTokenHash);
    }
  });
  s.refreshing.set(routeTokenHash, p);
  return p;
}

// Called by whoever changes what a route token resolves to, so an operator's action takes effect now
// instead of at the TTL. Clearing everything (no argument) is what the rotation, disconnect and
// delete paths want: they do not hold the hash that is being retired.
export function invalidateRouteTokenCache(routeTokenHash?: string): void {
  const s = store();
  s.generation++;
  // The refresh in flight goes with them. It began before the writer committed, so the answer it is
  // about to produce is about the world this invalidation just retired — and a request arriving after
  // the commit would otherwise wait on it, and inherit its failure, for a question nobody is asking
  // any more. Detached, not cancelled: the lookup runs to completion and its write is refused by the
  // generation guard.
  if (routeTokenHash === undefined) {
    s.positive.clear();
    s.negative.clear();
    s.refreshing.clear();
    return;
  }
  s.positive.delete(routeTokenHash);
  s.negative.delete(routeTokenHash);
  s.refreshing.delete(routeTokenHash);
}
