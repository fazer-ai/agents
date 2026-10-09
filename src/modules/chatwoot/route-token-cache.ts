// In-process cache for the receiver's route-token resolution: Chatwoot escalates the conversation
// on an ack slower than ~5s, and the lookup is an interactive transaction pool pressure can stretch
// past that. Served inside the TTL, and past it (refreshed behind the ack) up to the stale backstop,
// also while that refresh fails: the ledger row the ack writes before answering is what backs a 200.
// Only an invalidated or never-seen token goes to Postgres on the ack path (docs/chatwoot.md,
// "Webhook receiver"). Its own module because the receiver imports the writers that invalidate it.
// How long a resolution is served without questioning it.
export const ROUTE_TOKEN_CACHE_TTL_MS = 30_000;

// Backstop on the stale window: how long past the TTL an entry is served while its refresh keeps
// failing. Invalidation is per process, so on another replica this is also how long a retired token
// can still be answered from memory; past it the ack goes to Postgres and fails honestly if Postgres
// cannot answer.
export const ROUTE_TOKEN_STALE_MS = 10 * 60_000;

// After a refresh fails, how long before the next delivery may start another. Without it every
// delivery in an outage would open its own lookup against the pool that just refused, which is the
// burst the cache exists to keep off Postgres.
export const ROUTE_TOKEN_REFRESH_BACKOFF_MS = 5_000;

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
  // Past the TTL and still servable: answer from here, and refresh behind the ack when one is due
  // (`routeTokenRefreshDue`). Only ever true for a positive entry.
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
  // The refresh in flight per token, so a burst at expiry starts one between all of its deliveries,
  // and a miss can wait on the one deciding it instead of opening its own.
  refreshing: Map<string, Promise<void>>;
  // Per token, until when a failed refresh holds the next one back (`ROUTE_TOKEN_REFRESH_BACKOFF_MS`).
  refreshFailedUntil: Map<string, number>;
  // Bumped by every invalidation. A lookup that started before the bump must not write its result
  // afterwards: the writer already committed and cleared the cache, and the in-flight read holds the
  // row as it was BEFORE that commit, so landing it would resurrect exactly what was retired.
  generation: number;
  // What a full invalidation asks of the receiver: look the tokens it dropped up again right away.
  rewarm?: ((routeTokenHashes: string[]) => void) | null;
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
    !(held.refreshing instanceof Map) ||
    !(held.refreshFailedUntil instanceof Map)
  ) {
    g[KEY] = {
      positive: new Map(),
      negative: new Map(),
      refreshing: new Map(),
      refreshFailedUntil: new Map(),
      generation: 0,
    };
  }
  return g[KEY] as Store;
}

// Installed once by the server at boot (`enableRouteTokenRewarm` in ./webhook.ts); tests that do not
// install it get the plain clear.
export function setRouteTokenRewarm(
  fn: ((routeTokenHashes: string[]) => void) | null,
): void {
  store().rewarm = fn;
}

// Snapshot to pass back to `writeRouteTokenCache` after the lookup returns.
export function routeTokenCacheGeneration(): number {
  return store().generation;
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
  return { bot: pos.bot, stale: true };
}

// Whether a stale hit should start a refresh: none in flight for this token, and none failed within
// the backoff. The stale entry is answered either way.
export function routeTokenRefreshDue(
  routeTokenHash: string,
  now: number = Date.now(),
): boolean {
  const s = store();
  if (s.refreshing.has(routeTokenHash)) return false;
  const until = s.refreshFailedUntil.get(routeTokenHash);
  return until === undefined || until <= now;
}

function noteRefreshFailed(routeTokenHash: string): void {
  store().refreshFailedUntil.set(
    routeTokenHash,
    Date.now() + ROUTE_TOKEN_REFRESH_BACKOFF_MS,
  );
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

// Wait on the refresh in flight, if any, for at most `timeoutMs`. Only a MISS waits (a hit is served,
// stale or not): with nothing to answer from, the refresh is the answer. Rejects on the refresh's own
// failure (see trackRouteTokenRefresh) and on the bound, which are the same answer to the caller:
// this token cannot be resolved now, so the ack fails and Chatwoot redelivers. The overrunning refresh
// is detached on the way out: a hang that stayed registered would put every later delivery for this
// token behind a promise that never answers.
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
          // A REFRESH THAT OVERRAN IS A FAILED LOOKUP, and backs off like one: otherwise the next
          // stale delivery starts another lookup that hangs the same way, one per delivery.
          noteRefreshFailed(routeTokenHash);
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
// Registering and starting are one step, or a second caller could see no refresh and start one.
// The returned promise REJECTS when the refresh fails, and the failure starts the backoff: a waiter
// (a miss) has nothing to answer from, and a resolved promise would send each down the blocking path
// to open its own transaction, a burst against the pool exactly when the pool is broken. The caller
// that STARTS a refresh is detached, so it attaches the log; nothing else may swallow it.
export function trackRouteTokenRefresh(
  routeTokenHash: string,
  run: () => Promise<void>,
): Promise<void> {
  const s = store();
  const existing = s.refreshing.get(routeTokenHash);
  if (existing) return existing;
  let p: Promise<void>;
  p = run()
    .then(
      () => {
        s.refreshFailedUntil.delete(routeTokenHash);
      },
      (err: unknown) => {
        noteRefreshFailed(routeTokenHash);
        throw err;
      },
    )
    .finally(() => {
      // BY IDENTITY, not by key. This refresh can be detached before it settles (an invalidation
      // retires it, or a waiter's bound drops it), and a later request registers its own under the same
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
  // about to produce is about the world this invalidation just retired, and a request arriving after
  // the commit would otherwise wait on it, and inherit its failure, for a question nobody is asking
  // any more. Detached, not cancelled: the lookup runs to completion and its write is refused by the
  // generation guard.
  if (routeTokenHash === undefined) {
    // The writers that retire a token (an agent deleted, an instance disconnected) do not name
    // it, so they clear everything, and a full clear would leave every other bot with nothing to
    // serve if the lookup fails next. The dropped tokens are looked up again at once, while the
    // database that just took the writer's commit is answering; each lookup writes only what it finds
    // (a retired token comes back as nothing), under the generation guard.
    const dropped = [...s.positive.keys()];
    s.positive.clear();
    s.negative.clear();
    s.refreshing.clear();
    s.refreshFailedUntil.clear();
    if (s.rewarm && dropped.length > 0) s.rewarm(dropped);
    return;
  }
  s.positive.delete(routeTokenHash);
  s.negative.delete(routeTokenHash);
  s.refreshing.delete(routeTokenHash);
  s.refreshFailedUntil.delete(routeTokenHash);
}
