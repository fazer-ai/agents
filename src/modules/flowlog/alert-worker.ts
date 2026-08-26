import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { sanitizeErrorMessage } from "@/lib/redact";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import { tryResolveVaultSecret } from "@/modules/vault/service";
import { nextBackoffMs } from "@/modules/webhooks/outbound/service";
import { outboundHeaders } from "@/modules/webhooks/outbound/signing";
import { emitDeadLetter } from "./dead-letter";

// Alert delivery worker (claim + deliver). Mirrors the outbound-webhook worker: a single-replica
// tick reaps stale SENDING rows, claims due PENDING deliveries cross-tenant (FOR UPDATE SKIP
// LOCKED), decrypts the channel URL (SSRF-checked), POSTs OUTSIDE any transaction, and records the
// outcome (DELIVERED / back to PENDING with full-jitter backoff / DEAD). A DEBOUNCE WINDOW gates
// fresh rows: a just-created delivery (no next_attempt_at) is only claimed once it is older than
// ALERT_COALESCE_WINDOW_MS, so concurrent burst events accumulate into its `count` before the
// single POST. Retries (next_attempt_at set) are claimed when due, ignoring the window.

const MAX_ATTEMPTS = 8;
const CLAIM_LIMIT = 50;
const DELIVERY_CONCURRENCY = 10;
const STALE_SENDING_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_LEN = 500;

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
  attempts: number;
  type: string;
  url: string;
  secretRef: string | null;
}

type Outcome = "delivered" | "retried" | "dead";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// `sanitizeErrorMessage` rather than a bare cut: this string is stored in `last_error`, and the
// exceptions a delivery produces wrap what the remote endpoint answered. See issue #243 and the
// function's own header for why a NUL or an orphan surrogate costs the whole write.
function errMsg(err: unknown): string {
  return sanitizeErrorMessage(err, MAX_ERROR_LEN);
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
        a.attempts,
        picked.type,
        picked.url,
        picked.secret_ref AS "secretRef"
    `,
  );
}

async function finalizeDelivered(
  base: PrismaClient,
  a: ClaimedAlert,
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
): Promise<Outcome> {
  await runScopedOn(base, sysCtx(a.tenantId), (db) =>
    db.alertDelivery.update({
      where: { id: a.id },
      data: { status: "DEAD", attempts, lastError: error },
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
): Promise<Outcome> {
  const attemptsAfter = a.attempts + 1;
  if (attemptsAfter >= MAX_ATTEMPTS) {
    return finalizeDead(base, a, attemptsAfter, error);
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
      },
    }),
  );
  return "retried";
}

// Discord-native markdown (its webhook expects `{ content }`); the generic webhook gets a versioned
// JSON envelope. Both carry the coalesced burst count, never message text/PII.
function buildBody(a: ClaimedAlert): { rawBody: string; contentType: string } {
  const times = a.count > 1 ? ` (×${a.count})` : "";
  if (a.type === "discord") {
    const icon = a.level === "error" ? "🔴" : "🟠";
    const content = `${icon} **fazer.ai agents** \`${a.stage ?? "—"}\` ${a.level}${times}\n${a.summary}`;
    return {
      rawBody: JSON.stringify({ content: clipText(content, 1900) }),
      contentType: "application/json",
    };
  }
  return {
    rawBody: JSON.stringify({
      version: 1,
      type: "alert",
      stage: a.stage,
      level: a.level,
      count: a.count,
      summary: a.summary,
    }),
    contentType: "application/json",
  };
}

async function deliverClaimed(
  base: PrismaClient,
  a: ClaimedAlert,
  opts: AlertWorkerOptions,
): Promise<Outcome> {
  const assertSafe = opts.assertSafe ?? assertSafeOutboundUrl;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  // Decrypt the channel URL (a blocked/unparseable URL can never succeed → permanent failure).
  let url: string;
  try {
    url = decryptJson<string>(a.url);
    await assertSafe(url);
  } catch (err) {
    return finalizeDead(base, a, a.attempts + 1, errMsg(err));
  }

  // Optional HMAC secret (generic webhook), resolved through a tenant-scoped read (RLS active).
  let secret: string | null = null;
  if (a.secretRef && a.type === "webhook") {
    try {
      const ref = a.secretRef;
      secret = await runScopedOn(base, sysCtx(a.tenantId), (db) =>
        tryResolveVaultSecret<string>(db, ref),
      );
    } catch (err) {
      return finalizeFailure(
        base,
        a,
        `secret resolution failed: ${errMsg(err)}`,
        now,
      );
    }
  }

  const { rawBody, contentType } = buildBody(a);
  const ts = Math.floor(now() / 1000);
  const headers = outboundHeaders({
    contentType,
    deliveryId: String(a.id),
    timestampSeconds: ts,
    rawBody,
    secret,
  });

  let status: number;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
  } catch (err) {
    return finalizeFailure(base, a, `request failed: ${errMsg(err)}`, now);
  }

  if (status >= 200 && status < 300) {
    await finalizeDelivered(base, a);
    return "delivered";
  }
  return finalizeFailure(base, a, `non-2xx response: ${status}`, now);
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
    logger.error("Alert tick failed: %s", errMsg(err));
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
