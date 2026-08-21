import type { ContactAuthOutcome } from "./check";

// In-process cache of authorization verdicts, keyed by `${tenantId}:${agentId}:${contactDbId}`. It
// holds ids and a verdict (outcome, status, reason code) and never the phone the endpoint was asked
// about, so nothing here is worth reading. Memory only, by design: the single-replica deploy
// invariant (docs/deploy.md) makes this process's memory reach the webhook, the debounce flush and
// the follow-up worker alike, and a verdict is cheap to ask for again after a restart.
//
// Two bounds keep it from growing without limit, and the first is active rather than lazy: a
// rescheduled sweep wakes at the earliest expiry and deletes what has expired, so an idle process
// FORGETS old verdicts instead of holding them until restart (same idiom as the media annotations
// store). Entries expire per their own TTL (an agent's `cacheTtlSeconds`, or the short error TTL),
// so unlike that store insertion order says nothing about expiry order and the next wake-up is
// found by scanning.

// A failed check is remembered only briefly: long enough to absorb a burst of messages during an
// outage, short enough that the next message after it retries.
export const ERROR_TTL_MS = 30_000;
const MAX_ENTRIES = 10_000;

// What is retained: the outcome (the gate's four answers), the HTTP status and a reason CODE. The
// phone the endpoint was asked about is not part of it, by type.
export interface StoredVerdict {
  outcome: ContactAuthOutcome;
  status?: number;
  reason?: string;
}

interface Entry {
  verdict: StoredVerdict;
  expiresAt: number;
}

const store = new Map<string, Entry>();
let sweepTimer: ReturnType<typeof setTimeout> | undefined;
let sweepAt = 0;

export function contactAuthCacheKey(
  tenantId: bigint,
  agentId: bigint,
  contactDbId: bigint,
): string {
  return `${tenantId}:${agentId}:${contactDbId}`;
}

// The live verdict for a key, or null. An expired entry is reclaimed on the way out rather than
// hidden: the sweep would get to it, but there is no reason to keep it until then.
export function readCachedVerdict(
  key: string,
  nowMs: number = Date.now(),
): StoredVerdict | null {
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= nowMs) {
    store.delete(key);
    return null;
  }
  return hit.verdict;
}

// Deletes every verdict past its expiry. Called on each store AND by the scheduled sweeper.
export function sweepContactAuthCache(nowMs: number = Date.now()): void {
  for (const [k, v] of store) {
    // NOTE: Inclusive boundary: the scheduled sweep wakes exactly at `expiresAt`, so a strict `<`
    // would leave the entry in place and re-arm a zero-delay timer instead of reclaiming it.
    if (v.expiresAt <= nowMs) store.delete(k);
  }
}

// NOTE: Second, independent bound: a burst that outruns every TTL is capped by entry count. Map
// iteration is insertion-ordered and store() re-inserts on update, so the front is the oldest.
function enforceSizeCap(): void {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

// Delay until the EARLIEST retained verdict expires (null when the cache is empty).
export function nextSweepDelayMs(nowMs: number = Date.now()): number | null {
  let earliest: number | null = null;
  for (const v of store.values()) {
    if (earliest === null || v.expiresAt < earliest) earliest = v.expiresAt;
  }
  return earliest === null ? null : Math.max(0, earliest - nowMs);
}

// NOTE: One timer, armed for the earliest expiry and re-armed when a newer entry expires sooner,
// unref'd so a pending sweep never keeps the process alive at shutdown.
function scheduleSweep(nowMs: number): void {
  const delay = nextSweepDelayMs(nowMs);
  if (delay === null) {
    if (sweepTimer) clearTimeout(sweepTimer);
    sweepTimer = undefined;
    return;
  }
  const at = nowMs + delay;
  if (sweepTimer && at >= sweepAt) return;
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepAt = at;
  sweepTimer = setTimeout(() => {
    sweepTimer = undefined;
    const now = Date.now();
    sweepContactAuthCache(now);
    scheduleSweep(now);
  }, delay);
  sweepTimer.unref?.();
}

// Remembers a verdict for `ttlMs`. A non-positive TTL stores nothing (the operator asked to check on
// every message), and the stored copy is a fresh object so a caller cannot mutate what is cached.
export function storeVerdict(
  key: string,
  verdict: StoredVerdict,
  ttlMs: number,
  nowMs: number = Date.now(),
): void {
  if (ttlMs <= 0) return;
  store.delete(key);
  store.set(key, { verdict: { ...verdict }, expiresAt: nowMs + ttlMs });
  sweepContactAuthCache(nowMs);
  enforceSizeCap();
  scheduleSweep(nowMs);
}

// Single-flight per key: two messages from one contact arriving together must not both ask the
// endpoint. The second caller awaits the first caller's promise and is told the verdict was SHARED,
// which the gate reads as "already acted on" (the same as a cache hit). Same idiom as the OAuth
// refresh coalescing in modules/vault/mcp-oauth.ts.
const inFlight = new Map<string, Promise<StoredVerdict>>();

export async function singleFlight(
  key: string,
  run: () => Promise<StoredVerdict>,
): Promise<{ verdict: StoredVerdict; shared: boolean }> {
  const existing = inFlight.get(key);
  if (existing) return { verdict: await existing, shared: true };
  const p = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, p);
  return { verdict: await p, shared: false };
}

// NOTE: Test isolation only. Production never clears the cache wholesale; the TTL sweep does.
export function clearContactAuthCache(): void {
  store.clear();
  inFlight.clear();
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = undefined;
  }
}

// NOTE: How many verdicts are actually RETAINED (not merely hidden from readers). Exposed so the
// TTL-deletion contract is assertable.
export function contactAuthCacheSize(): number {
  return store.size;
}

// NOTE: Test-only view of what is retained, so a test can prove the cache holds ids and verdicts
// and nothing it was asked about.
export function contactAuthCacheEntries(): Array<{
  key: string;
  verdict: StoredVerdict;
  expiresAt: number;
}> {
  return [...store].map(([key, v]) => ({
    key,
    verdict: v.verdict,
    expiresAt: v.expiresAt,
  }));
}
