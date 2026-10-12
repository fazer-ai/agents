// Ingress lag: how long a Chatwoot webhook took to reach this process, from the signed
// `x-chatwoot-timestamp` (whole seconds, set when Chatwoot sent it) to the moment the receiver
// verified it. Kept as the last minute of observations; the sampler reads their p95.

const WINDOW_MS = 60_000;
const MAX_POINTS = 5_000;

const KEY = Symbol.for("fazerai.instanceHealth.ingress");

interface Obs {
  at: number;
  lagMs: number;
}

function points(): Obs[] {
  const g = globalThis as unknown as Record<symbol, Obs[] | undefined>;
  g[KEY] ??= [];
  return g[KEY];
}

function trim(list: Obs[], now: number): void {
  const cutoff = now - WINDOW_MS;
  let drop = 0;
  while (drop < list.length && (list[drop] as Obs).at < cutoff) drop++;
  if (list.length - drop > MAX_POINTS) drop = list.length - MAX_POINTS;
  if (drop > 0) list.splice(0, drop);
}

// Called by the receiver once the signature (and with it the timestamp) checked out. A clock a
// second ahead of ours reads as zero lag, never negative.
export function recordIngressLag(
  timestampSeconds: number,
  now: number = Date.now(),
): void {
  if (!Number.isFinite(timestampSeconds)) return;
  const list = points();
  list.push({ at: now, lagMs: Math.max(0, now - timestampSeconds * 1000) });
  trim(list, now);
}

export function ingressLagP95(now: number = Date.now()): number {
  const list = points();
  trim(list, now);
  if (list.length === 0) return 0;
  const sorted = list.map((o) => o.lagMs).sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)] as number;
}

// Test-only.
export function resetIngressLag(): void {
  points().length = 0;
}
