import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { sanitizeErrorMessage } from "@/lib/redact";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitDeliveryDead } from "@/modules/flowlog/webhook";
import { tryResolveVaultSecret } from "@/modules/vault/service";
import { nextBackoffMs } from "./service";
import { outboundHeaders } from "./signing";

// Outbound webhook delivery worker (claim + deliver side). A single-replica tick claims due
// PENDING deliveries cross-tenant (asSuperAdmin / FOR UPDATE SKIP LOCKED), then for each:
// resolves the per-tenant signing secret (RLS-scoped), POSTs the signed payload OUTSIDE any
// transaction (SSRF-checked, no redirects, timeout), and records the outcome — DELIVERED,
// back to PENDING with full-jitter backoff, or DEAD after MAX_ATTEMPTS. The delivery id is a
// stable dedupe key (x-fazerai-delivery) so at-least-once retries are safe for receivers.
//
// Crash safety: the claim flips status to SENDING; a crash between claim and outcome would
// strand the row, so each tick first reaps stale SENDING rows back to PENDING. The reentrancy
// guard makes this safe under a single replica; FOR UPDATE SKIP LOCKED future-proofs it.

const MAX_ATTEMPTS = 8;
const CLAIM_LIMIT = 50;
const DELIVERY_CONCURRENCY = 10;
const STALE_SENDING_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_LEN = 500;

export interface OutboundWorkerOptions {
  base?: PrismaClient;
  claimLimit?: number;
  staleMs?: number;
  requestTimeoutMs?: number;
  // NOTE: injectable for tests — default to the real network/SSRF path / wall clock.
  fetchImpl?: typeof fetch;
  assertSafe?: (url: string) => Promise<URL>;
  now?: () => number;
  // NOTE: test-only isolation, mirroring the alert worker's. Scopes the claim + reap to one tenant
  // so two suites sharing the test database cannot steal each other's deliveries (the claim is
  // cross-tenant, and SKIP LOCKED hands a row to whoever gets there first). Unset in production =
  // global claim, which is correct under the single-leader invariant.
  tenantId?: bigint;
}

export interface OutboundBatchSummary {
  reaped: number;
  claimed: number;
  delivered: number;
  retried: number;
  dead: number;
}

interface ClaimedDelivery {
  id: bigint;
  tenantId: bigint;
  subscriptionId: bigint;
  event: string;
  payload: unknown;
  attempts: number;
  url: string;
  secretRef: string | null;
}

type DeliveryOutcome = "delivered" | "retried" | "dead";

// NOTE: system worker context. tenantId pins the RLS scope for the row's own tenant; role is
// only carried for the TenantContext shape (no authorization decision is made off it here).
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

// Reset SENDING rows stranded by a crash back to PENDING (cross-tenant; the reaper does not
// know tenants). attempts is untouched: the claim never incremented it.
async function reapStaleSending(
  base: PrismaClient,
  staleMs: number,
  now: () => number,
  tenantId?: bigint,
): Promise<number> {
  const cutoff = new Date(now() - staleMs);
  const { count } = await asSuperAdminOn(base, (db) =>
    db.outboundWebhookDelivery.updateMany({
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

// Claim due deliveries cross-tenant. FOR UPDATE OF d SKIP LOCKED locks only the delivery rows
// (not the joined subscription); the enabled=true join leaves a disabled subscription's
// deliveries PENDING until it is re-enabled rather than killing them.
async function claimDueDeliveries(
  base: PrismaClient,
  limit: number,
  tenantId?: bigint,
): Promise<ClaimedDelivery[]> {
  const tenantClause =
    tenantId != null
      ? Prisma.sql`AND d2.tenant_id = ${tenantId}`
      : Prisma.empty;
  return asSuperAdminOn(
    base,
    (db) =>
      db.$queryRaw<ClaimedDelivery[]>`
      UPDATE outbound_webhook_deliveries AS d
      SET status = 'SENDING', updated_at = now()
      FROM (
        SELECT d2.id, s2.url, s2.secret_ref
        FROM outbound_webhook_deliveries d2
        JOIN webhook_subscriptions s2 ON s2.id = d2.subscription_id
        WHERE d2.status = 'PENDING'
          AND (d2.next_attempt_at IS NULL OR d2.next_attempt_at <= now())
          AND s2.enabled = true
          ${tenantClause}
        ORDER BY d2.next_attempt_at NULLS FIRST, d2.id
        FOR UPDATE OF d2 SKIP LOCKED
        LIMIT ${limit}
      ) picked
      WHERE d.id = picked.id
      RETURNING
        d.id,
        d.tenant_id        AS "tenantId",
        d.subscription_id  AS "subscriptionId",
        d.event,
        d.payload,
        d.attempts,
        picked.url,
        picked.secret_ref  AS "secretRef"
    `,
  );
}

async function finalizeDelivered(
  base: PrismaClient,
  d: ClaimedDelivery,
): Promise<void> {
  await runScopedOn(base, sysCtx(d.tenantId), (db) =>
    db.outboundWebhookDelivery.update({
      where: { id: d.id },
      data: {
        status: "DELIVERED",
        deliveredAt: new Date(),
        attempts: d.attempts + 1,
        nextAttemptAt: null,
        lastError: null,
      },
    }),
  );
}

// THE ONLY WRITE OF DEAD, and it is one function for that reason rather than for tidiness. There
// are two roads here — the retry budget running out, and a URL the SSRF guard refuses on sight —
// and issue #325 is what happens when a road forgets to tell anybody: both of them wrote the row
// and returned, and the operator's only trace was a counter in a process log. A third road will be
// added one day; going through here is what makes it announce itself without anyone remembering to.
async function finalizeDead(
  base: PrismaClient,
  d: ClaimedDelivery,
  attempts: number,
  error: string,
): Promise<DeliveryOutcome> {
  await runScopedOn(base, sysCtx(d.tenantId), (db) =>
    db.outboundWebhookDelivery.update({
      where: { id: d.id },
      data: { status: "DEAD", attempts, lastError: error },
    }),
  );
  // Fire-and-forget, and AFTER the write: the row is the fact, the line is the notification, and a
  // failed notification must never leave a delivery claimed forever.
  emitDeliveryDead({
    tenantId: d.tenantId,
    deliveryId: d.id,
    subscriptionId: d.subscriptionId,
    event: d.event,
    attempts,
    error,
    base,
  });
  return "dead";
}

// Retryable failure: increment attempts, schedule next attempt with full-jitter backoff, or
// give up (DEAD) once MAX_ATTEMPTS is reached. The row's tenant scopes the update via RLS.
async function finalizeFailure(
  base: PrismaClient,
  d: ClaimedDelivery,
  error: string,
  now: () => number,
): Promise<DeliveryOutcome> {
  const attemptsAfter = d.attempts + 1;
  if (attemptsAfter >= MAX_ATTEMPTS)
    return finalizeDead(base, d, attemptsAfter, error);
  const nextAttemptAt = new Date(now() + nextBackoffMs(attemptsAfter));
  await runScopedOn(base, sysCtx(d.tenantId), (db) =>
    db.outboundWebhookDelivery.update({
      where: { id: d.id },
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

async function deliverClaimed(
  base: PrismaClient,
  d: ClaimedDelivery,
  opts: OutboundWorkerOptions,
): Promise<DeliveryOutcome> {
  const assertSafe = opts.assertSafe ?? assertSafeOutboundUrl;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  // A blocked URL can never succeed → permanent failure, not a retry loop.
  try {
    await assertSafe(d.url);
  } catch (err) {
    return finalizeDead(base, d, d.attempts + 1, errMsg(err));
  }

  // Per-tenant signing secret, resolved through a tenant-scoped read (RLS active, not the
  // cross-tenant bypass) — least privilege. A missing/failed secret is transient (the
  // operator may add it), so it falls through to retry/backoff.
  let secret: string | null = null;
  if (d.secretRef) {
    try {
      const ref = d.secretRef;
      secret = await runScopedOn(base, sysCtx(d.tenantId), (db) =>
        tryResolveVaultSecret<string>(db, ref),
      );
    } catch (err) {
      return finalizeFailure(
        base,
        d,
        `secret resolution failed: ${errMsg(err)}`,
        now,
      );
    }
  }

  const ts = Math.floor(now() / 1000);
  // The stored payload IS the versioned envelope (built at emit time by buildOutboundEnvelope):
  // { version, instance_id, event, occurred_at, tenant_id, data }. POST it verbatim — the
  // delivery id (retry dedupe key) travels in the x-fazerai-delivery header, not the body.
  const rawBody = JSON.stringify(d.payload ?? {});
  const headers = outboundHeaders({
    contentType: "application/json",
    deliveryId: String(d.id),
    timestampSeconds: ts,
    rawBody,
    secret,
  });

  let status: number;
  try {
    const res = await fetchImpl(d.url, {
      method: "POST",
      headers,
      body: rawBody,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
  } catch (err) {
    return finalizeFailure(base, d, `request failed: ${errMsg(err)}`, now);
  }

  if (status >= 200 && status < 300) {
    await finalizeDelivered(base, d);
    return "delivered";
  }
  return finalizeFailure(base, d, `non-2xx response: ${status}`, now);
}

export async function processOutboundBatch(
  opts: OutboundWorkerOptions = {},
): Promise<OutboundBatchSummary> {
  const base = opts.base ?? basePrisma;
  const now = opts.now ?? (() => Date.now());
  const reaped = await reapStaleSending(
    base,
    opts.staleMs ?? STALE_SENDING_MS,
    now,
    opts.tenantId,
  );
  const claimed = await claimDueDeliveries(
    base,
    opts.claimLimit ?? CLAIM_LIMIT,
    opts.tenantId,
  );
  const outcomes = await mapWithConcurrency(
    claimed,
    DELIVERY_CONCURRENCY,
    (d) => deliverClaimed(base, d, opts),
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

const WORKER_KEY = Symbol.for("agents.outboundWebhookWorker");

interface WorkerState {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

// NOTE: the state lives on globalThis (not a module `let`) so `bun --hot` re-evaluating this
// module does not orphan the old interval and spawn a phantom second worker.
function workerState(): WorkerState {
  const g = globalThis as unknown as Record<symbol, WorkerState | undefined>;
  if (!g[WORKER_KEY]) g[WORKER_KEY] = { running: false };
  return g[WORKER_KEY] as WorkerState;
}

async function tick(base: PrismaClient, state: WorkerState): Promise<void> {
  if (state.running) return; // single-replica reentrancy guard
  state.running = true;
  try {
    const summary = await processOutboundBatch({ base });
    if (summary.claimed > 0 || summary.reaped > 0) {
      logger.info(
        "Outbound webhook tick: reaped=%d claimed=%d delivered=%d retried=%d dead=%d",
        summary.reaped,
        summary.claimed,
        summary.delivered,
        summary.retried,
        summary.dead,
      );
    }
  } catch (err) {
    logger.error("Outbound webhook tick failed: %s", errMsg(err));
  } finally {
    state.running = false;
  }
}

export function startOutboundWorker(opts: OutboundWorkerOptions = {}): void {
  const state = workerState();
  if (state.timer) return; // singleton (survives bun --hot via globalThis)
  const base = opts.base ?? basePrisma;
  const intervalMs = config.webhookWorker.intervalMs;
  state.timer = setInterval(() => void tick(base, state), intervalMs);
  // NOTE: unref so the tick timer never keeps the process alive at shutdown.
  state.timer.unref?.();
  logger.info("Outbound webhook worker started (interval %dms)", intervalMs);
}

export function stopOutboundWorker(): void {
  const state = workerState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
}
