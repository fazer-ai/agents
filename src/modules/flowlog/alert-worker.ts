import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { nextBackoffMs } from "@/modules/webhooks/outbound/service";
import { alertErrMsg, sendAlert } from "./alert-send";
import { emitDeadLetter } from "./dead-letter";

// Alert delivery worker (claim + deliver). Mirrors the outbound-webhook worker: a single-replica
// tick reaps stale SENDING rows, claims due PENDING deliveries cross-tenant (FOR UPDATE SKIP
// LOCKED), hands each one to `sendAlert` (which decrypts the channel URL, vets it, signs and POSTs,
// OUTSIDE any transaction), and records the outcome (DELIVERED / back to PENDING with full-jitter
// backoff / DEAD). The send itself lives in ./alert-send.ts because the console's Test button
// performs the same one (#605), and a probe that took a different path would approve channels whose
// real alerts never arrive.
//
// A DEBOUNCE WINDOW gates fresh rows: a just-created delivery (no next_attempt_at) is only claimed
// once it is older than ALERT_COALESCE_WINDOW_MS, so concurrent burst events accumulate into its
// `count` before the single POST. Retries (next_attempt_at set) are claimed when due, ignoring the
// window.

const MAX_ATTEMPTS = 8;
const CLAIM_LIMIT = 50;
const DELIVERY_CONCURRENCY = 10;
const STALE_SENDING_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface AlertWorkerOptions {
  base?: PrismaClient;
  claimLimit?: number;
  staleMs?: number;
  coalesceWindowMs?: number;
  requestTimeoutMs?: number;
  // Injectable for tests — default to the real network/SSRF path / wall clock.
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<URL>;
  now?: () => number;
  // NOTE: test-only isolation. Scopes the claim + reap to one tenant so concurrent test runs on the
  // shared test DB can't steal each other's deliveries (the claim is otherwise cross-tenant). Unset in
  // production = global claim, which is correct under the single-leader invariant.
  tenantId?: bigint;
}

export interface AlertBatchSummary {
  reaped: number;
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

interface ClaimedAlert {
  id: bigint;
  tenantId: bigint;
  channelId: bigint;
  stage: string | null;
  level: string;
  summary: string;
  count: number;
  turnId: string | null;
  conversationId: bigint | null;
  attempts: number;
  type: string;
  url: string;
  secretRef: string | null;
}

type Outcome = "delivered" | "retried" | "dead";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

async function reapStaleSending(
  base: PrismaClient,
  staleMs: number,
  now: () => number,
  tenantId?: bigint,
): Promise<number> {
  const cutoff = new Date(now() - staleMs);
  const { count } = await asSuperAdminOn(base, (db) =>
    db.alertDelivery.updateMany({
      where: {
        status: "SENDING",
        updatedAt: { lt: cutoff },
        ...(tenantId != null ? { tenantId } : {}),
      },
      data: { status: "PENDING" },
    }),
  );
  return count;
}

// Claim due deliveries cross-tenant. Fresh rows (next_attempt_at NULL) wait out the coalesce window
// so their `count` accumulates; retries (next_attempt_at set) are claimed when due.
async function claimDue(
  base: PrismaClient,
  limit: number,
  coalesceWindowMs: number,
  tenantId?: bigint,
): Promise<ClaimedAlert[]> {
  const coalesceSeconds = Math.max(0, Math.floor(coalesceWindowMs / 1000));
  const tenantClause =
    tenantId != null
      ? Prisma.sql`AND a2.tenant_id = ${tenantId}`
      : Prisma.empty;
  return asSuperAdminOn(
    base,
    (db) =>
      db.$queryRaw<ClaimedAlert[]>`
      UPDATE alert_deliveries AS a
      SET status = 'SENDING', updated_at = now()
      FROM (
        SELECT a2.id, c2.type, c2.url, c2.secret_ref
        FROM alert_deliveries a2
        JOIN alert_channels c2 ON c2.id = a2.channel_id
        WHERE a2.status = 'PENDING'
          AND c2.enabled = true
          AND (
            (a2.next_attempt_at IS NOT NULL AND a2.next_attempt_at <= now())
            OR (a2.next_attempt_at IS NULL
                AND a2.created_at <= now() - make_interval(secs => ${coalesceSeconds}))
          )
          ${tenantClause}
        ORDER BY a2.next_attempt_at NULLS FIRST, a2.id
        FOR UPDATE OF a2 SKIP LOCKED
        LIMIT ${limit}
      ) picked
      WHERE a.id = picked.id
      RETURNING
        a.id,
        a.tenant_id   AS "tenantId",
        a.channel_id  AS "channelId",
        a.stage,
        a.level,
        a.summary,
        a.count,
        a.turn_id         AS "turnId",
        a.conversation_id AS "conversationId",
        a.attempts,
        picked.type,
        picked.url,
        picked.secret_ref AS "secretRef"
    `,
  );
}

// `unsignedReason` rides along on EVERY terminal write, including this one, because it describes the
// attempt and not its outcome (issue #724). The delivered row is the one that needed it most: it is
// the one nothing else marks, and a 2xx from a receiver that does not verify signatures looks
// exactly like a 2xx from one that does and just rejected the next alert.
async function finalizeDelivered(
  base: PrismaClient,
  a: ClaimedAlert,
  unsignedReason: string | null,
): Promise<void> {
  await runScopedOn(base, sysCtx(a.tenantId), (db) =>
    db.alertDelivery.update({
      where: { id: a.id },
      data: {
        status: "DELIVERED",
        deliveredAt: new Date(),
        attempts: a.attempts + 1,
        nextAttemptAt: null,
        lastError: null,
        unsignedReason,
      },
    }),
  );
}

// THE NOTIFICATION THAT WILL NEVER ARRIVE, AND THE ONE LINE THAT SAYS SO (issue #356).
//
// The sharpest site of the four, because the operator learns about everything else THROUGH this bus,
// and this is the bus failing. It cannot report itself, so the sink is the flow-log row: it costs
// nothing, it is not the failing path, and ../flowlog/alerts.ts refuses to turn this particular line
// back into an alert (the loop is written out there).
//
// Both roads to DEAD come here, which is the same collapse #325 did for the outbound bus. They were
// written apart and neither had a line to forget; a third added the same way would be silent again.
async function finalizeDead(
  base: PrismaClient,
  a: ClaimedAlert,
  attempts: number,
  error: string,
  unsignedReason: string | null,
): Promise<Outcome> {
  await runScopedOn(base, sysCtx(a.tenantId), (db) =>
    db.alertDelivery.update({
      where: { id: a.id },
      data: { status: "DEAD", attempts, lastError: error, unsignedReason },
    }),
  );
  // NOTE: fire-and-forget, and AFTER the write — the row is the fact, the line is the notification,
  // and a failed line must never leave a delivery claimed forever.
  emitDeadLetter({
    tenantId: a.tenantId,
    unit: "alert_delivery",
    // NOTE: the operator asked to be told about something and was not. Nothing recovers that.
    level: "error",
    error,
    detail: {
      deliveryId: String(a.id),
      channelId: String(a.channelId),
      // NOTE: the stage the UNDELIVERED alert was about, which is not this line's own stage.
      // `summary` is the body that never arrived — already sanitized and PII-free by construction,
      // since it is what would have been posted to Discord.
      alertStage: a.stage,
      alertLevel: a.level,
      summary: a.summary,
      count: a.count,
      attempts,
    },
    base,
  });
  return "dead";
}

async function finalizeFailure(
  base: PrismaClient,
  a: ClaimedAlert,
  error: string,
  now: () => number,
  unsignedReason: string | null,
): Promise<Outcome> {
  const attemptsAfter = a.attempts + 1;
  if (attemptsAfter >= MAX_ATTEMPTS) {
    return finalizeDead(base, a, attemptsAfter, error, unsignedReason);
  }
  const nextAttemptAt = new Date(now() + nextBackoffMs(attemptsAfter));
  await runScopedOn(base, sysCtx(a.tenantId), (db) =>
    db.alertDelivery.update({
      where: { id: a.id },
      data: {
        status: "PENDING",
        attempts: attemptsAfter,
        nextAttemptAt,
        lastError: error,
        unsignedReason,
      },
    }),
  );
  return "retried";
}

async function deliverClaimed(
  base: PrismaClient,
  a: ClaimedAlert,
  opts: AlertWorkerOptions,
): Promise<Outcome> {
  const now = opts.now ?? (() => Date.now());
  const res = await sendAlert(
    base,
    sysCtx(a.tenantId),
    { ...a, deliveryId: String(a.id) },
    {
      fetchImpl: opts.fetchImpl,
      assertSafe: opts.assertSafe,
      now: opts.now,
      requestTimeoutMs: opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    },
  );
  if (res.ok) {
    await finalizeDelivered(base, a, res.unsignedReason);
    return "delivered";
  }
  // A URL that cannot be decrypted or is not allowed to be reached is permanent: no amount of
  // retrying turns it into a deliverable one, so the ladder is skipped and the row goes straight to
  // DEAD (which is also what writes the flow-log line about the alert that never arrived).
  const error = res.error ?? "delivery failed";
  if (res.stoppedAt === "url") {
    return finalizeDead(base, a, a.attempts + 1, error, res.unsignedReason);
  }
  return finalizeFailure(base, a, error, now, res.unsignedReason);
}

export async function processAlertBatch(
  opts: AlertWorkerOptions = {},
): Promise<AlertBatchSummary> {
  const base = opts.base ?? basePrisma;
  const now = opts.now ?? (() => Date.now());
  const reaped = await reapStaleSending(
    base,
    opts.staleMs ?? STALE_SENDING_MS,
    now,
    opts.tenantId,
  );
  const claimed = await claimDue(
    base,
    opts.claimLimit ?? CLAIM_LIMIT,
    opts.coalesceWindowMs ?? config.alertWorker.coalesceWindowMs,
    opts.tenantId,
  );
  const outcomes = await mapWithConcurrency(
    claimed,
    DELIVERY_CONCURRENCY,
    (a) => deliverClaimed(base, a, opts),
  );
  return {
    reaped,
    claimed: claimed.length,
    delivered: outcomes.filter((o) => o === "delivered").length,
    retried: outcomes.filter((o) => o === "retried").length,
    dead: outcomes.filter((o) => o === "dead").length,
  };
}

// ── worker lifecycle ──

const WORKER_KEY = Symbol.for("agents.alertWorker");

interface WorkerState {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

function workerState(): WorkerState {
  const g = globalThis as unknown as Record<symbol, WorkerState | undefined>;
  if (!g[WORKER_KEY]) g[WORKER_KEY] = { running: false };
  return g[WORKER_KEY] as WorkerState;
}

async function tick(base: PrismaClient, state: WorkerState): Promise<void> {
  if (state.running) return; // single-replica reentrancy guard
  state.running = true;
  try {
    const summary = await processAlertBatch({ base });
    if (summary.claimed > 0 || summary.reaped > 0) {
      logger.info(
        "Alert tick: reaped=%d claimed=%d delivered=%d retried=%d dead=%d",
        summary.reaped,
        summary.claimed,
        summary.delivered,
        summary.retried,
        summary.dead,
      );
    }
  } catch (err) {
    logger.error("Alert tick failed: %s", alertErrMsg(err));
  } finally {
    state.running = false;
  }
}

export function startAlertWorker(opts: AlertWorkerOptions = {}): void {
  const state = workerState();
  if (state.timer) return; // singleton (survives bun --hot via globalThis)
  const base = opts.base ?? basePrisma;
  const intervalMs = config.alertWorker.intervalMs;
  state.timer = setInterval(() => void tick(base, state), intervalMs);
  state.timer.unref?.();
  logger.info("Alert worker started (interval %dms)", intervalMs);
}

export function stopAlertWorker(): void {
  const state = workerState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}
