// In-process cache for the receiver's route-token resolution.
//
// THE ACK PATH MUST NOT DEPEND ON POSTGRES BEING HEALTHY. Chatwoot gives the receiver ~5s to answer
// (`WEBHOOK_TIMEOUT`) and escalates the conversation `pending → open` when it does not, which takes
// the bot off a conversation it was about to answer correctly (issue #225). Resolving the bot is an
// interactive transaction (RLS needs `set_config`), so under pool pressure it could burn that whole
// budget waiting on `maxWait`, for a row that changes almost never.
//
// Lives in its own module so the writers that have to invalidate it (provisioning, instance
// connect/disconnect) can reach it without importing the receiver, which imports them.
//
// The TTL is short because this is a latency shield, not a source of truth: a rotated route token or
// a disconnected instance is honoured within it even if nobody calls invalidate.

export const ROUTE_TOKEN_CACHE_TTL_MS = 30_000;

export interface CachedRouteTokenBot {
  tenantId: bigint;
  instanceId: bigint;
  agentBotId: number;
  webhookSecret: string;
}

interface Entry {
  // `null` is cached too: an unknown or disconnected token is exactly what a prober loops on, and
  // re-querying every miss would put that load straight on the ack path.
  bot: CachedRouteTokenBot | null;
  expiresAt: number;
}

const KEY = Symbol.for("fazerai.chatwoot.routeTokens");

function cache(): Map<string, Entry> {
  const g = globalThis as unknown as Record<
    symbol,
    { entries: Map<string, Entry> }
  >;
  g[KEY] ??= { entries: new Map() };
  return g[KEY].entries;
}

// Returns the cached resolution, or undefined when there is none to trust. `null` is a real answer
// (this token resolves to nothing) and is distinct from a miss.
export function readRouteTokenCache(
  routeTokenHash: string,
  now: number = Date.now(),
): CachedRouteTokenBot | null | undefined {
  const hit = cache().get(routeTokenHash);
  if (!hit || hit.expiresAt <= now) return undefined;
  return hit.bot;
}

export function writeRouteTokenCache(
  routeTokenHash: string,
  bot: CachedRouteTokenBot | null,
  now: number = Date.now(),
): void {
  cache().set(routeTokenHash, {
    bot,
    expiresAt: now + ROUTE_TOKEN_CACHE_TTL_MS,
  });
}

// Called by whoever changes what a route token resolves to, so an operator's action takes effect now
// instead of at the TTL. Clearing everything (no argument) is what the rotation and disconnect paths
// want: they do not hold the hash that is being retired.
export function invalidateRouteTokenCache(routeTokenHash?: string): void {
  const c = cache();
  if (routeTokenHash === undefined) c.clear();
  else c.delete(routeTokenHash);
}
