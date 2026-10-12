import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import config from "@/config";
import { isDraining } from "@/lib/shutdown";
import {
  type AlertSendDeps,
  alertErrMsg,
  INSTANCE_CAUSE_PREFIX,
  sendAlert,
} from "@/modules/flowlog/alert-send";
import { mapWithConcurrency } from "@/modules/flowlog/alert-worker";
import { nextBackoffMs } from "@/modules/webhooks/outbound/service";
import { instanceSecretResolver } from "./channels";
import { asFleetForInstanceHealth } from "./fleet-tx";
import { SIGNALS } from "./signals";

// Delivers instance alerts with the tenant alert worker's shape (src/modules/flowlog/alert-worker.ts):
// reap stale SENDING rows, claim due PENDING rows (a fresh one only after the coalesce window, so a
// repeat folds into its count first), send OUTSIDE any transaction through the same `sendAlert`, and
// record DELIVERED, a retry with backoff, or DEAD. Runs on the sampler's own client: an alert about a
// saturated main pool must not wait for that pool to free a connection. Called from the alert
// worker's tick.

const MAX_ATTEMPTS = 8;
const CLAIM_LIMIT = 20;
const DELIVERY_CONCURRENCY = 10;
const STALE_SENDING_MS = 60_000;
const MUTED_BY_DEFAULT = SIGNALS.filter((d) => d.defaultEnabled === false).map(
  (d) => d.name,
);

export interface InstanceAlertWorkerOptions {
  base?: PrismaClient;
  coalesceWindowMs?: number;
  now?: () => number;
  send?: AlertSendDeps;
}

interface Claimed {
  id: bigint;
  channelId: bigint;
  signal: string;
  kind: string;
  level: string;
  summary: string;
  count: number;
  attempts: number;
  type: string;
  url: string;
  secret: string | null;
}

export interface InstanceAlertBatchSummary {
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

async function claim(
  base: PrismaClient,
  coalesceWindowMs: number,
): Promise<Claimed[]> {
  if (isDraining()) return [];
  const coalesceSeconds = Math.max(0, Math.floor(coalesceWindowMs / 1000));
  return asFleetForInstanceHealth(base, async (db) => {
    await db.instanceAlertDelivery.updateMany({
      where: {
        status: "SENDING",
        updatedAt: { lt: new Date(Date.now() - STALE_SENDING_MS) },
      },
      data: { status: "PENDING" },
    });
    // What is still queued for a signal muted since, or one the channel no longer takes, is never
    // sent: dropping it leaves the channel's record at what it was actually told. Muted is the stored
    // override, or the signal's default when none is stored.
    await db.$executeRaw`
      DELETE FROM instance_alert_deliveries d
       WHERE d.status = 'PENDING'
         AND (
           coalesce(
             (SELECT NOT t.enabled FROM instance_alert_thresholds t
               WHERE t.signal = d.signal),
             d.signal = ANY(${MUTED_BY_DEFAULT}::text[]))
           OR EXISTS (
             SELECT 1 FROM instance_alert_channels c
              WHERE c.id = d.channel_id
                AND coalesce(cardinality(c.signals), 0) > 0
                AND NOT (d.signal = ANY(c.signals))))`;
    return db.$queryRaw<Claimed[]>`
      UPDATE instance_alert_deliveries AS d
      SET status = 'SENDING', updated_at = now(), channel_version = picked.channel_version
      FROM (
        SELECT d2.id, c.type, c.url, c.secret, c.updated_at AS channel_version
          FROM instance_alert_deliveries d2
          JOIN instance_alert_channels c ON c.id = d2.channel_id
         WHERE d2.status = 'PENDING'
           AND c.enabled = true
           AND c.url IS NOT NULL
           -- One at a time per channel and signal, oldest first: a recovery never goes out before
           -- the firing it follows.
           AND NOT EXISTS (
             SELECT 1 FROM instance_alert_deliveries o
              WHERE o.channel_id = d2.channel_id AND o.signal = d2.signal AND o.id < d2.id
                AND o.status IN ('PENDING', 'SENDING'))
           AND (
             (d2.next_attempt_at IS NOT NULL AND d2.next_attempt_at <= now())
             OR (d2.next_attempt_at IS NULL
                 AND d2.created_at <= now() - make_interval(secs => ${coalesceSeconds}))
           )
         ORDER BY d2.id
         FOR UPDATE OF d2 SKIP LOCKED
         LIMIT ${CLAIM_LIMIT}
      ) picked
      WHERE d.id = picked.id
      RETURNING d.id, d.channel_id AS "channelId", d.signal, d.kind, d.level, d.summary, d.count,
                d.attempts, picked.type, picked.url, picked.secret`;
  });
}

// Writes an attempt's outcome. Why it went out unsigned is about the secret the attempt was claimed
// with: if the channel's secret was replaced while it was out (the edit clears earlier reasons), the
// reason is dropped here too, in the same transaction, instead of restoring the warning.
async function finish(
  base: PrismaClient,
  a: Claimed,
  data: Record<string, unknown>,
): Promise<void> {
  await asFleetForInstanceHealth(base, async (db) => {
    await db.instanceAlertDelivery.update({ where: { id: a.id }, data });
    if (data.unsignedReason) {
      await db.$executeRaw`
        UPDATE instance_alert_deliveries d SET unsigned_reason = NULL
          FROM instance_alert_channels c
         WHERE d.id = ${a.id} AND c.id = d.channel_id
           AND c.secret IS DISTINCT FROM ${a.secret}`;
    }
  });
}

// The bus cannot alert about itself and an instance alert has no tenant flow log to land in, so the
// channel carries it instead: the console lists a channel whose newest finished delivery is DEAD as
// failing, with this error (`listInstanceAlertChannels`).
async function finalizeDead(
  base: PrismaClient,
  a: Claimed,
  attempts: number,
  error: string,
  unsignedReason: string | null,
): Promise<void> {
  await finish(base, a, {
    status: "DEAD",
    attempts,
    lastError: error,
    unsignedReason,
  });
  logger.error(
    { deliveryId: String(a.id), signal: a.signal, error },
    "instance alert undeliverable",
  );
}

export async function processInstanceAlertBatch(
  opts: InstanceAlertWorkerOptions = {},
): Promise<InstanceAlertBatchSummary> {
  const base = opts.base ?? instanceHealthPrisma;
  const now = opts.now ?? (() => Date.now());
  const claimed = await claim(
    base,
    opts.coalesceWindowMs ?? config.alertWorker.coalesceWindowMs,
  );
  const summary = {
    claimed: claimed.length,
    delivered: 0,
    retried: 0,
    dead: 0,
  };
  // One row per channel and signal is claimed at a time, so rows of one batch are independent: a
  // destination that hangs holds only its own pair back, as in the tenant alert worker.
  await mapWithConcurrency(claimed, DELIVERY_CONCURRENCY, async (a) => {
    const res = await sendAlert(
      base,
      null,
      {
        deliveryId: `instance-${a.id}`,
        type: a.type,
        url: a.url,
        secretRef: null,
        stage: "instance_health",
        level: a.level,
        summary: a.summary,
        count: a.count,
        tenantId: null,
        turnId: null,
        conversationId: null,
        causeKey: `${INSTANCE_CAUSE_PREFIX}${a.signal}`,
      },
      { ...opts.send, resolveSecret: instanceSecretResolver(a.type, a.secret) },
    );
    const attempts = a.attempts + 1;
    if (res.ok) {
      await finish(base, a, {
        status: "DELIVERED",
        deliveredAt: new Date(now()),
        attempts,
        nextAttemptAt: null,
        lastError: null,
        unsignedReason: res.unsignedReason,
      });
      summary.delivered++;
      return;
    }
    const error = res.error ?? "delivery failed";
    if (res.stoppedAt === "url" || attempts >= MAX_ATTEMPTS) {
      await finalizeDead(base, a, attempts, error, res.unsignedReason);
      summary.dead++;
      return;
    }
    await finish(base, a, {
      status: "PENDING",
      attempts,
      nextAttemptAt: new Date(now() + nextBackoffMs(attempts)),
      lastError: error,
      unsignedReason: res.unsignedReason,
    });
    summary.retried++;
  });
  return summary;
}

// Terminal rows past the flow log's retention go, a bounded batch per tick, like tenant alert
// deliveries do in the flow log sweep. The newest row of each channel and signal, and its newest
// delivered one, stay whatever their age: the evaluator reads them as what that channel last heard
// (a dead row can stop counting once the channel is repaired), and the console shows the newest.
export async function pruneInstanceAlertDeliveries(
  base: PrismaClient = instanceHealthPrisma,
  retentionDays: number = config.flowlog.retentionDays,
): Promise<number> {
  return asFleetForInstanceHealth(
    base,
    (db) =>
      db.$executeRaw`
      DELETE FROM instance_alert_deliveries
       WHERE id IN (
         SELECT id FROM instance_alert_deliveries
          WHERE status IN ('DELIVERED', 'DEAD')
            AND updated_at < now() - make_interval(days => ${retentionDays})
            AND EXISTS (
              SELECT 1 FROM instance_alert_deliveries n
               WHERE n.channel_id = instance_alert_deliveries.channel_id
                 AND n.signal = instance_alert_deliveries.signal
                 AND n.id > instance_alert_deliveries.id)
            AND (status = 'DEAD' OR EXISTS (
              SELECT 1 FROM instance_alert_deliveries n
               WHERE n.channel_id = instance_alert_deliveries.channel_id
                 AND n.signal = instance_alert_deliveries.signal
                 AND n.id > instance_alert_deliveries.id
                 AND n.status = 'DELIVERED'))
          LIMIT 500)`,
  );
}

// Its own loop, guard and client, apart from the tenant alert worker: a slow instance destination
// holds no tenant alert back, and a saturated main pool holds no instance alert back.
export async function instanceAlertTick(): Promise<void> {
  try {
    await pruneInstanceAlertDeliveries();
    const s = await processInstanceAlertBatch();
    if (s.claimed > 0) {
      logger.info(
        "Instance alert tick: claimed=%d delivered=%d retried=%d dead=%d",
        s.claimed,
        s.delivered,
        s.retried,
        s.dead,
      );
    }
  } catch (err) {
    logger.error("Instance alert tick failed: %s", alertErrMsg(err));
  }
}

const LOOP_KEY = Symbol.for("fazerai.instanceHealth.alertLoop");

interface LoopState {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

function loopState(): LoopState {
  const g = globalThis as unknown as Record<symbol, LoopState | undefined>;
  g[LOOP_KEY] ??= { running: false };
  return g[LOOP_KEY];
}

export function startInstanceAlertWorker(): void {
  const st = loopState();
  if (st.timer) return;
  st.timer = setInterval(() => {
    if (st.running) return;
    st.running = true;
    void instanceAlertTick().finally(() => {
      st.running = false;
    });
  }, config.alertWorker.intervalMs);
  st.timer.unref?.();
}

export function stopInstanceAlertWorker(): void {
  const st = loopState();
  if (st.timer) clearInterval(st.timer);
  st.timer = undefined;
}
