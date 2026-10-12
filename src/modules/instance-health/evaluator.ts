import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import { asFleetForInstanceHealth } from "./fleet-tx";
import { SIGNALS, type SignalUnit, signalDef } from "./signals";

// "Above X for Y seconds", per signal. A signal goes from quiet to breaching on the first sample
// above its threshold, and FIRES once it has stayed above for the duration; the next sample at or
// under the threshold ends the breach. Every sample then brings each matching channel to where the
// signal is: a channel last told something else gets one delivery (see `reconcile`).

const THRESHOLD_TTL_MS = 30_000;

interface Threshold {
  threshold: number;
  durationSeconds: number;
  enabled: boolean;
}

interface SignalState {
  breachSince: number | null;
  firing: boolean;
  // Where the last judged sample says each channel should be; null while above but not yet held.
  want: Wanted | null;
  // When the sample last judged was taken: an older one arriving late (the database half of an
  // earlier tick) never overrides a newer judgement.
  judgedAt: number;
}

interface EvaluatorState {
  thresholds: Map<string, Threshold> | null;
  loadedAt: number;
  // Bumped by every invalidation: a read that spans one may predate the change it announces.
  generation: number;
  signals: Map<string, SignalState>;
  base: PrismaClient;
}

const KEY = Symbol.for("fazerai.instanceHealth.evaluator");

function state(): EvaluatorState {
  const g = globalThis as unknown as Record<symbol, EvaluatorState | undefined>;
  g[KEY] ??= {
    thresholds: null,
    loadedAt: 0,
    generation: 0,
    signals: new Map(),
    base: instanceHealthPrisma,
  };
  return g[KEY];
}

// Test-only: the client the evaluator reads thresholds and writes deliveries with, and a clean slate.
export function resetEvaluator(base?: PrismaClient): void {
  const s = state();
  s.thresholds = null;
  s.loadedAt = 0;
  s.signals = new Map();
  if (base) s.base = base;
}

// Test-only: swap the client without forgetting the signals' state, to fail one write.
export function setEvaluatorBase(base: PrismaClient): void {
  state().base = base;
}

// A super admin's change takes effect on the next sample, not after the cache expires.
export function invalidateThresholds(): void {
  const s = state();
  s.generation++;
  s.loadedAt = Number.NEGATIVE_INFINITY;
}

const THRESHOLD_READ_ATTEMPTS = 3;

function readThresholdRows(base: PrismaClient) {
  return asFleetForInstanceHealth(base, (db) =>
    db.instanceAlertThreshold.findMany(),
  );
}

async function thresholds(now: number): Promise<Map<string, Threshold>> {
  const s = state();
  if (s.thresholds && now - s.loadedAt < THRESHOLD_TTL_MS) return s.thresholds;
  // A change landing while the read is out may not be in it: read again, a bounded number of times,
  // and if changes keep landing, use the last read but leave the cache due for the next sample.
  let rows: Awaited<ReturnType<typeof readThresholdRows>> = [];
  let current = false;
  for (let i = 0; i < THRESHOLD_READ_ATTEMPTS && !current; i++) {
    const generation = s.generation;
    rows = await readThresholdRows(s.base);
    current = s.generation === generation;
  }
  const byKey = new Map(rows.map((r) => [r.signal, r]));
  const out = new Map<string, Threshold>();
  for (const def of SIGNALS) {
    const r = byKey.get(def.name);
    out.set(def.name, {
      threshold: r?.threshold ?? def.defaultThreshold,
      durationSeconds: r?.durationSeconds ?? def.defaultDurationSeconds,
      enabled: r?.enabled ?? true,
    });
  }
  // A breach measured against the old limit says nothing about the new one: it restarts.
  if (s.thresholds) {
    for (const [signal, t] of out) {
      const old = s.thresholds.get(signal);
      const st = s.signals.get(signal);
      if (
        st &&
        old &&
        (old.threshold !== t.threshold ||
          old.durationSeconds !== t.durationSeconds ||
          old.enabled !== t.enabled)
      ) {
        // Nor does a judgement made against it: the signal says nothing until judged again.
        st.breachSince = null;
        st.firing = false;
        st.want = null;
      }
    }
  }
  s.thresholds = out;
  s.loadedAt = current ? now : Number.NEGATIVE_INFINITY;
  return out;
}

export function formatValue(value: number, unit: SignalUnit): string {
  if (unit === "count") return String(Math.round(value));
  if (unit === "per_minute") return `${Math.round(value)}/min`;
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)} min`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} s`;
  return `${Math.round(value)} ms`;
}

export function firingSummary(
  signal: string,
  value: number,
  t: Threshold,
): string {
  const unit = signalDef(signal)?.unit ?? "count";
  const held = t.durationSeconds > 0 ? ` for ${t.durationSeconds} s` : "";
  return `${signal} is ${formatValue(value, unit)}, above ${formatValue(t.threshold, unit)}${held}.`;
}

export function recoverySummary(
  signal: string,
  value: number,
  t: Threshold,
): string {
  const unit = signalDef(signal)?.unit ?? "count";
  return `${signal} is back to ${formatValue(value, unit)}, at or under ${formatValue(t.threshold, unit)}.`;
}

// Judges a sample against the limits already read, in memory, so the in-process signals are judged
// every tick even while the database (thresholds, deliveries) is slow. Before any limits were read
// nothing is judged, but the sample is still marked as seen: a tick older than it, judged later
// once the limits arrive, must not stand in for it.
export function judge(values: Record<string, number>, now: number): void {
  const limits = state().thresholds;
  if (limits) {
    judgeWith(limits, values, now);
    return;
  }
  for (const signal of Object.keys(values)) {
    const st = signalState(signal);
    st.judgedAt = Math.max(st.judgedAt, now);
  }
}

function signalState(signal: string): SignalState {
  const s = state();
  const st = s.signals.get(signal) ?? {
    breachSince: null,
    firing: false,
    want: null,
    judgedAt: Number.NEGATIVE_INFINITY,
  };
  s.signals.set(signal, st);
  return st;
}

function judgeWith(
  limits: Map<string, Threshold>,
  values: Record<string, number>,
  now: number,
): void {
  for (const [signal, value] of Object.entries(values)) {
    const t = limits.get(signal);
    if (!t) continue;
    const st = signalState(signal);
    if (now < st.judgedAt) continue;
    st.judgedAt = now;
    if (!t.enabled) {
      // Muting is not a recovery: the value may still be above, so nothing is said either way.
      st.breachSince = null;
      st.firing = false;
      st.want = null;
      continue;
    }
    if (value > t.threshold) {
      st.breachSince ??= now;
      st.firing = now - st.breachSince >= t.durationSeconds * 1000;
      // Above but not held yet says nothing: a channel keeps what it last heard.
      st.want = st.firing
        ? { kind: "firing", summary: firingSummary(signal, value, t) }
        : null;
    } else {
      st.breachSince = null;
      st.firing = false;
      st.want = {
        kind: "recovered",
        summary: recoverySummary(signal, value, t),
      };
    }
  }
}

// Re-reads the limits when due, judges `values` (the database signals, or a sample nothing judged
// yet), and brings every channel to where each signal stands now.
export async function evaluateSample(
  values: Record<string, number>,
  now: number,
): Promise<void> {
  const s = state();
  let limits: Map<string, Threshold>;
  try {
    limits = await thresholds(now);
  } catch (err) {
    logger.warn({ err }, "instance health: thresholds unreadable");
    // The last limits read still judge the sample, so a dip during the outage still ends a breach.
    // Never read yet means no breach has started either.
    if (!s.thresholds) return;
    limits = s.thresholds;
  }
  judgeWith(limits, values, now);
  const want = new Map<string, Wanted>();
  for (const [signal, st] of s.signals) if (st.want) want.set(signal, st.want);
  await reconcile(s.base, want);
}

// Which signals are firing right now, for the screen.
export function firingSignals(): string[] {
  return [...state().signals.entries()]
    .filter(([, st]) => st.firing)
    .map(([k]) => k);
}

interface Wanted {
  kind: "firing" | "recovered";
  summary: string;
}

interface Recent {
  id: bigint;
  channel_id: bigint;
  signal: string;
  kind: string;
  status: string;
  attempts: number;
  // Rank among the rows that count as heard, for `heard` below; null for a row that does not.
  hn: number | null;
  rn: number;
}

// What each channel was last told is read from its deliveries, not kept in memory, so a channel
// enabled during a breach still hears the firing and a restart still owes the recovery of a firing
// sent before it. A channel with nothing on record counts as told "recovered". Only rows not yet
// attempted fold: a flap (this kind, then the opposite, both unsent) bumps the older and drops the
// newer, so the last unsent row always states where the signal is now. A failed write is retried
// by the next sample, which reads the same record. Each signal's judgement is read again right
// before its writes: the process half keeps judging while these reads wait, and a firing decided
// before a newer reading that ended it must not be written.
async function reconcile(
  base: PrismaClient,
  want: Map<string, Wanted>,
): Promise<void> {
  if (want.size === 0) return;
  try {
    await asFleetForInstanceHealth(base, async (db) => {
      const channels = await db.instanceAlertChannel.findMany({
        where: { enabled: true },
        select: { id: true, signals: true },
      });
      if (channels.length === 0) return;
      const recent = await db.$queryRaw<Recent[]>`
        SELECT id, channel_id, signal, kind, status::text AS status, attempts,
               rn::int AS rn, (CASE WHEN heard THEN hn END)::int AS hn
          FROM (
            SELECT d.id, d.channel_id, d.signal, d.kind, d.status, d.attempts, x.heard,
                   row_number() OVER (PARTITION BY d.channel_id, d.signal ORDER BY d.id DESC) AS rn,
                   row_number() OVER (PARTITION BY d.channel_id, d.signal, x.heard ORDER BY d.id DESC) AS hn
              FROM instance_alert_deliveries d
              JOIN instance_alert_channels c ON c.id = d.channel_id AND c.enabled
              -- A delivery that died on a configuration edited since (a fixed URL or secret, read
              -- from the version its last attempt was claimed with) was never heard: the repaired
              -- channel is told again, once, under the same retry limit.
              CROSS JOIN LATERAL (
                SELECT NOT (d.status = 'DEAD'
                            AND coalesce(d.channel_version, d.updated_at) < c.updated_at) AS heard) x
          ) r
         WHERE rn <= 2 OR (heard AND hn = 1)
         ORDER BY id DESC`;
      const byKey = new Map<string, Recent[]>();
      for (const r of recent) {
        const k = `${r.channel_id}:${r.signal}`;
        byKey.set(k, [...(byKey.get(k) ?? []), r]);
      }
      const unsent = (r: Recent | undefined): r is Recent =>
        r !== undefined && r.status === "PENDING" && r.attempts === 0;
      for (const c of channels) {
        for (const signal of want.keys()) {
          if (c.signals.length > 0 && !c.signals.includes(signal)) continue;
          const w = state().signals.get(signal)?.want;
          if (!w) continue;
          const rows = byKey.get(`${c.id}:${signal}`) ?? [];
          const [last, prev] = rows.filter((r) => r.rn <= 2);
          // What this channel last heard; nothing on record counts as recovered.
          const heard = rows.find((r) => r.hn === 1)?.kind ?? "recovered";
          if (heard === w.kind) continue;
          if (unsent(last) && unsent(prev) && prev.kind === w.kind) {
            await db.instanceAlertDelivery.update({
              where: { id: prev.id },
              data: { count: { increment: 1 } },
            });
            await db.instanceAlertDelivery.delete({ where: { id: last.id } });
            continue;
          }
          await db.instanceAlertDelivery.create({
            data: {
              channelId: c.id,
              signal,
              kind: w.kind,
              level: w.kind === "firing" ? "error" : "info",
              summary: w.summary,
            },
          });
        }
      }
    });
  } catch (err) {
    logger.error({ err }, "instance alerts not reconciled");
  }
}
