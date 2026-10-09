import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { isDraining, trackWork } from "@/lib/shutdown";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { normalizeChatwootEvent } from "./normalize";
import { processRecordedChatwootDelivery } from "./webhook";

// Admission and drain for the Chatwoot deliveries the ack recorded (docs/chatwoot.md, "Webhook
// receiver"). The ack writes the ledger row with the body and answers; processing happens
// here, at most `config.chatwoot.deliveryConcurrency` at a time. The rest WAIT, in memory in the
// order they came, with their row PENDING in the ledger: a burst costs latency instead of a pool where
// every delivery fails `maxWait` at once, and a process that dies with deliveries waiting leaves rows a
// later drain processes from their body.

// A PENDING row whose body is still stored and that nothing in this process holds is drained from the
// ledger. Past the sweep's window the body is dropped where the conversation is mirrored, and the row
// becomes the sweep's (`DEAD` and a recovery that rebuilds the body from Chatwoot's live state). The
// same number as the sweep's `STALE_AFTER_MS`, restated rather than imported because the sweep's
// handler runs this drain (a module cycle); tests/modules/chatwoot-delivery-queue.test.ts pins both.
export const STORED_DELIVERY_STALE_MS = 30 * 60 * 1000;

// Where the conversation is NOT mirrored the recovery cannot rebuild the delivery, so the stored body
// is the only way to answer it and the drain keeps trying past the window, up to this age. Past it the
// body goes too and the sweep reports the row like any other strand.
export const STORED_DELIVERY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// How old a stored row must be before the periodic pass treats it as nobody's: a younger one is most
// likely waiting in the queue of the process that acked it (this one or another replica). The boot
// pass uses zero, since nothing in a process that just started holds anything.
export const STORED_DELIVERY_MIN_AGE_MS = 60_000;

// One drain pass's ceiling. A pass admits into the same bounded queue the ack does; the rest waits
// for the next pass.
const DRAIN_BATCH = 500;

// How many deliveries may wait in memory. Past it a delivery is not queued here and stays a PENDING
// row with its body, which the periodic drain takes once it is old enough: memory stays bounded by
// this, never by the size of a burst.
export const ADMISSION_MAX_WAITING = 5_000;

interface Pending {
  rowId: string;
  run: () => Promise<unknown>;
}

interface Admission {
  limit: number;
  running: number;
  waiting: Pending[];
  // Row ids waiting or running here: a drain or a redelivery of a row this process already holds is
  // not admitted twice.
  held: Set<string>;
}

// On globalThis, like the shutdown registry, so `bun --hot` does not split the count.
const KEY = Symbol.for("fazerai.chatwoot.admission");

function admission(): Admission {
  const g = globalThis as unknown as Record<symbol, Admission | undefined>;
  const held = g[KEY];
  if (!held || !(held.held instanceof Set) || !Array.isArray(held.waiting)) {
    g[KEY] = {
      limit: config.chatwoot.deliveryConcurrency,
      running: 0,
      waiting: [],
      held: new Set(),
    };
  }
  return g[KEY] as Admission;
}

export function chatwootAdmissionState(): {
  running: number;
  waiting: number;
  limit: number;
} {
  const a = admission();
  return { running: a.running, waiting: a.waiting.length, limit: a.limit };
}

// Tests only: an empty queue, optionally with another limit.
export function resetChatwootAdmissionForTest(limit?: number): void {
  const g = globalThis as unknown as Record<symbol, Admission | undefined>;
  g[KEY] = {
    limit: limit ?? config.chatwoot.deliveryConcurrency,
    running: 0,
    waiting: [],
    held: new Set(),
  };
}

function pump(a: Admission): void {
  // NOTE: A draining process starts nothing new. What waits is a PENDING row with its body, which the
  // next boot or another replica drains; finishing it here would only race the shutdown bound.
  while (a.running < a.limit && a.waiting.length > 0 && !isDraining()) {
    const next = a.waiting.shift() as Pending;
    a.running++;
    void trackWork("chatwoot_delivery", next.run)
      .catch((err) => {
        logger.error(
          "chatwoot: delivery row %s failed: %s",
          next.rowId,
          err instanceof Error ? err.message : String(err),
        );
      })
      .finally(() => {
        a.running--;
        a.held.delete(next.rowId);
        pump(a);
      });
  }
}

// Queues one delivery's processing. False when this process already holds the row, or when the
// waiting list is full (the row stays PENDING with its body for the drain).
export function admitChatwootDelivery(
  rowId: bigint,
  run: () => Promise<unknown>,
): boolean {
  const a = admission();
  const key = String(rowId);
  if (a.held.has(key)) return false;
  if (a.waiting.length >= ADMISSION_MAX_WAITING) {
    logger.warn(
      "chatwoot: %d deliveries already waiting; row %s stays in the ledger for the drain",
      a.waiting.length,
      key,
    );
    return false;
  }
  a.held.add(key);
  a.waiting.push({ rowId: key, run });
  pump(a);
  return true;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

interface StoredRow {
  id: bigint;
  tenantId: bigint;
  chatwootInstanceId: bigint;
  routeAgentBotId: number | null;
  bindingGeneration: number | null;
  payload: string | null;
}

export interface DrainStoredParams {
  base?: PrismaClient;
  // One tenant (the sweep's pass) or every tenant (boot).
  tenantId?: bigint;
  // Rows younger than this are left to whoever holds them; see `STORED_DELIVERY_MIN_AGE_MS`.
  minAgeMs?: number;
  now?: number;
  // Rows read per pass; tests shrink it to reach the paging past held rows.
  batch?: number;
}

// Admits the stored rows nothing here holds, and clears the body of those past the sweep's window.
export async function drainStoredChatwootDeliveries(
  params: DrainStoredParams = {},
): Promise<{ admitted: number; cleared: number }> {
  const base = params.base ?? basePrisma;
  const now = params.now ?? Date.now();
  const youngest = new Date(
    now - (params.minAgeMs ?? STORED_DELIVERY_MIN_AGE_MS),
  );
  const oldest = new Date(now - STORED_DELIVERY_STALE_MS);
  const ceiling = new Date(now - STORED_DELIVERY_MAX_AGE_MS);
  const run = <T>(fn: Parameters<typeof asSuperAdminOn<T>>[1]) =>
    params.tenantId === undefined
      ? asSuperAdminOn(base, fn)
      : runScopedOn(base, sysCtx(params.tenantId), fn);

  // The body leaves every row that will not be processed from it: one that left PENDING by a road that
  // does not clear it (an older release's claim during a rolling deploy), one past the window whose
  // conversation the recovery can rebuild from its mirror, and one past the ceiling. Both statements
  // read the partial index of the rows that still hold a body.
  const cleared = await run(
    (db) =>
      db.$executeRaw`
      UPDATE chatwoot_webhook_deliveries d SET payload = NULL
      WHERE d.payload IS NOT NULL
        AND (d.status <> 'PENDING'
          OR d.received_at <= ${ceiling}
          OR (d.received_at <= ${oldest}
            AND (d.conversation_id IS NULL OR EXISTS (
              SELECT 1 FROM conversations c
              WHERE c.tenant_id = d.tenant_id
                AND c.chatwoot_instance_id = d.chatwoot_instance_id
                AND c.chatwoot_conversation_id = d.conversation_id))))`,
  );
  // Rows this process already holds are skipped in the query, not after it: otherwise a full batch of
  // them would hide every row a dead process left behind.
  const held = [...admission().held].map((id) => BigInt(id));
  const rows = (await run((db) =>
    db.chatwootWebhookDelivery.findMany({
      where: {
        status: "PENDING",
        payload: { not: null },
        receivedAt: { lte: youngest },
        ...(held.length > 0 ? { id: { notIn: held } } : {}),
      },
      orderBy: { id: "asc" },
      take: params.batch ?? DRAIN_BATCH,
      select: {
        id: true,
        tenantId: true,
        chatwootInstanceId: true,
        routeAgentBotId: true,
        bindingGeneration: true,
        payload: true,
      },
    }),
  )) as StoredRow[];

  let admitted = 0;
  for (const row of rows) {
    const normalized = parseStored(row.payload);
    // NOTE: Unreachable for a row the ack wrote (it normalized this same body before writing it); a
    // body that does not parse is dropped, which hands the row to the sweep and its report.
    if (normalized === null) {
      logger.error(
        "chatwoot: stored delivery row %s holds a body that no longer normalizes; left to the sweep",
        String(row.id),
      );
      await run((db) =>
        db.chatwootWebhookDelivery.updateMany({
          where: { id: row.id, status: "PENDING" },
          data: { payload: null },
        }),
      );
      continue;
    }
    const ok = admitChatwootDelivery(row.id, () =>
      processRecordedChatwootDelivery({
        tenantId: row.tenantId,
        instanceId: row.chatwootInstanceId,
        deliveryRowId: row.id,
        agentBotId: row.routeAgentBotId,
        normalized,
        receiptBindingGeneration: row.bindingGeneration,
        base,
      }),
    );
    if (ok) admitted++;
  }
  if (admitted > 0 || cleared > 0) {
    logger.warn(
      "chatwoot: drained %d stored deliveries%s; %d bodies cleared",
      admitted,
      params.tenantId === undefined ? "" : ` for tenant ${params.tenantId}`,
      cleared,
    );
  }
  return { admitted, cleared };
}

function parseStored(payload: string | null) {
  if (payload === null) return null;
  try {
    return normalizeChatwootEvent(JSON.parse(payload));
  } catch {
    return null;
  }
}
