import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import type { RuntimeDeps } from "@/graph/runtime";
import { isDraining, trackWork } from "@/lib/shutdown";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { normalizeChatwootEvent } from "./normalize";
import { handToRecovery, processRecordedChatwootDelivery } from "./webhook";

// Admission and drain for the Chatwoot deliveries the ack recorded (docs/chatwoot.md, "Webhook
// receiver"). The ack writes the ledger row and answers; processing happens here, at most
// `config.chatwoot.deliveryConcurrency` at a time per lane, the rest waiting in memory in arrival
// order with their row PENDING. What does not get processed here goes one of two ways. A customer
// message the delivery recovery can rebuild (`isRecoverableStrand`) is handed to it at once: DEAD and
// a `DELIVERY_RECOVERY` job in one transaction (`handToRecovery`, ./webhook.ts). Anything else (a status or
// assignment change, a colleague's reply) has no recovery, so the ack stored its body and the drain
// processes it from that body later.

// A PENDING row whose body is still stored is the drain's up to this age, the same ceiling as the
// recovery's `MAX_RECOVERY_AGE_MS`; past it the body goes and the sweep reports the row.
export const STORED_DELIVERY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// How old an unheld PENDING row must be before the periodic pass treats it as nobody's: a younger one
// is most likely waiting in the queue of the process that acked it. The boot pass uses zero.
export const STORED_DELIVERY_MIN_AGE_MS = 60_000;

// Rows one pass reads, per kind.
const DRAIN_BATCH = 500;

// How many deliveries may wait in memory, in each lane. Past it a customer message goes to the
// recovery and anything else stays a PENDING row with its body for the drain.
export const ADMISSION_MAX_WAITING = 5_000;

// Two lanes with the same limits each: customer messages the recovery can rebuild, which may hold
// a slot for a whole model call, and everything else, which includes what tells a running turn it lost
// the conversation and so must not wait behind them.
export type AdmissionLane = "turn" | "meta";

interface Pending {
  rowId: string;
  id: bigint;
  run: () => Promise<unknown>;
  // When the delivery was received (epoch ms), so a slot that opens past the age ceiling skips it.
  receivedAt?: number;
}

interface Lane {
  running: number;
  waiting: Pending[];
}

interface Admission {
  limit: number;
  lanes: Record<AdmissionLane, Lane>;
  // Row ids waiting or running here: a drain or a redelivery of a row this process already holds is
  // not admitted twice.
  held: Map<string, bigint>;
  // Row ids whose last processing here threw. A row that fails before its claim stays PENDING with its
  // body, and if the drain read it first the same oldest rows could fill every pass and starve the
  // ones behind them, so the drain reads these last, with whatever room the batch has left.
  failed: Map<string, bigint>;
}

// On globalThis, like the shutdown registry, so `bun --hot` does not split the count.
const KEY = Symbol.for("fazerai.chatwoot.admission");

function fresh(limit: number): Admission {
  return {
    limit,
    lanes: {
      turn: { running: 0, waiting: [] },
      meta: { running: 0, waiting: [] },
    },
    held: new Map(),
    failed: new Map(),
  };
}

function admission(): Admission {
  const g = globalThis as unknown as Record<symbol, Admission | undefined>;
  const held = g[KEY];
  if (
    !held ||
    !(held.held instanceof Map) ||
    !(held.failed instanceof Map) ||
    !Array.isArray(held.lanes?.turn?.waiting) ||
    !Array.isArray(held.lanes?.meta?.waiting)
  ) {
    g[KEY] = fresh(config.chatwoot.deliveryConcurrency);
  }
  return g[KEY] as Admission;
}

const waitingCount = (a: Admission) =>
  a.lanes.turn.waiting.length + a.lanes.meta.waiting.length;

const failedBound = 2 * ADMISSION_MAX_WAITING;

// Totals over both lanes; `limit` is each lane's.
export function chatwootAdmissionState(): {
  running: number;
  waiting: number;
  limit: number;
} {
  const a = admission();
  return {
    running: a.lanes.turn.running + a.lanes.meta.running,
    waiting: waitingCount(a),
    limit: a.limit,
  };
}

// Tests only: an empty queue, optionally with another limit.
export function resetChatwootAdmissionForTest(limit?: number): void {
  const g = globalThis as unknown as Record<symbol, Admission | undefined>;
  g[KEY] = fresh(limit ?? config.chatwoot.deliveryConcurrency);
}

function pump(a: Admission, laneName: AdmissionLane): void {
  const lane = a.lanes[laneName];
  // NOTE: A draining process starts nothing new. What waits is a PENDING row with its body, which the
  // next boot or another replica drains; finishing it here would only race the shutdown bound.
  while (lane.running < a.limit && lane.waiting.length > 0 && !isDraining()) {
    const next = lane.waiting.shift() as Pending;
    lane.running++;
    const receivedAt = next.receivedAt;
    const work =
      receivedAt !== undefined &&
      Date.now() - receivedAt > STORED_DELIVERY_MAX_AGE_MS
        ? async () => {
            logger.warn(
              "chatwoot: delivery row %s waited past the age ceiling and is left to the sweep",
              next.rowId,
            );
            return "skipped";
          }
        : next.run;
    void trackWork("chatwoot_delivery", work)
      .then(
        () => {
          a.failed.delete(next.rowId);
        },
        (err) => {
          logger.error(
            "chatwoot: delivery row %s failed: %s",
            next.rowId,
            err instanceof Error ? err.message : String(err),
          );
          a.failed.delete(next.rowId);
          a.failed.set(next.rowId, next.id);
          // Bounded like the waiting list, dropping the oldest failure first.
          if (a.failed.size > failedBound) {
            const oldest = a.failed.keys().next().value;
            if (oldest !== undefined) a.failed.delete(oldest);
          }
        },
      )
      .finally(() => {
        lane.running--;
        a.held.delete(next.rowId);
        pump(a, laneName);
      });
  }
}

// Whether a lane's waiting list is at its bound, so it turns rows away.
export function admissionLaneFull(lane: AdmissionLane): boolean {
  return admission().lanes[lane].waiting.length >= ADMISSION_MAX_WAITING;
}

// Queues one delivery's processing in its lane. False when this process already holds the row, or
// when the waiting list is full (the row stays PENDING with its body for the drain).
export function admitChatwootDelivery(
  rowId: bigint,
  run: () => Promise<unknown>,
  lane: AdmissionLane = "turn",
  receivedAt?: number,
): boolean {
  const a = admission();
  const key = String(rowId);
  if (a.held.has(key)) return false;
  if (a.lanes[lane].waiting.length >= ADMISSION_MAX_WAITING) {
    logger.warn(
      "chatwoot: %d deliveries already waiting in the %s lane; row %s stays in the ledger for the drain",
      a.lanes[lane].waiting.length,
      lane,
      key,
    );
    return false;
  }
  a.held.set(key, rowId);
  a.lanes[lane].waiting.push({ rowId: key, id: rowId, run, receivedAt });
  pump(a, lane);
  return true;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface DrainStoredParams {
  base?: PrismaClient;
  // One tenant (the sweep's pass) or every tenant (boot).
  tenantId?: bigint;
  // Rows younger than this are left to whoever holds them; see `STORED_DELIVERY_MIN_AGE_MS`.
  minAgeMs?: number;
  now?: number;
  // Rows read per pass, per kind; tests shrink it.
  batch?: number;
  // Tests: the turn's seams.
  deps?: RuntimeDeps;
}

// One pass over the rows nothing here holds: customer messages to the recovery, stored events into the
// queue from their body, and the bodies that will not be processed cleared.
export async function drainStoredChatwootDeliveries(
  params: DrainStoredParams = {},
): Promise<{ admitted: number; recovered: number; cleared: number }> {
  const base = params.base ?? basePrisma;
  const now = params.now ?? Date.now();
  const youngest = new Date(
    now - (params.minAgeMs ?? STORED_DELIVERY_MIN_AGE_MS),
  );
  const ceiling = new Date(now - STORED_DELIVERY_MAX_AGE_MS);
  const batch = params.batch ?? DRAIN_BATCH;
  const run = <T>(fn: Parameters<typeof asSuperAdminOn<T>>[1]) =>
    params.tenantId === undefined
      ? asSuperAdminOn(base, fn)
      : runScopedOn(base, sysCtx(params.tenantId), fn);

  // The body leaves every row that will not be processed from it: one that left PENDING by a road that
  // does not clear it, and one past the ceiling. Both statements read the partial index of the rows
  // that still hold a body.
  const { count: cleared } = await run((db) =>
    db.chatwootWebhookDelivery.updateMany({
      where: {
        payload: { not: null },
        OR: [{ status: { not: "PENDING" } }, { receivedAt: { lte: ceiling } }],
      },
      data: { payload: null },
    }),
  );
  const a = admission();
  const held = [...a.held.values()];

  // Customer messages left PENDING with nothing here holding them: a restart's leftovers, or a live
  // attempt that threw before its claim. Read by the sweep's partial index of PENDING rows.
  let recovered = 0;
  const strands = await run((db) =>
    db.chatwootWebhookDelivery.findMany({
      where: {
        status: "PENDING",
        payload: null,
        conversationId: { not: null },
        inboundMessageId: { not: null },
        receivedAt: { lte: youngest, gt: ceiling },
        ...(held.length > 0 ? { id: { notIn: held } } : {}),
      },
      orderBy: { id: "asc" },
      take: batch,
      select: {
        id: true,
        tenantId: true,
        chatwootInstanceId: true,
        event: true,
        conversationId: true,
        inboundMessageId: true,
      },
    }),
  );
  for (const row of strands) {
    const handed = await handToRecovery(base, {
      tenantId: row.tenantId,
      instanceId: row.chatwootInstanceId,
      rowId: row.id,
      from: "PENDING",
      event: row.event,
      conversationId: row.conversationId,
      messageId: row.inboundMessageId,
      reason: "left_unprocessed",
    });
    if (handed) recovered++;
  }

  // Stored events, read with the rows that just failed here last, so a few that keep failing cannot
  // fill every pass.
  const failed = [...a.failed.entries()]
    .filter(([key]) => !a.held.has(key))
    .map(([, id]) => id);
  const read = (id: Prisma.BigIntFilter, take: number) =>
    run((db) =>
      db.chatwootWebhookDelivery.findMany({
        where: {
          status: "PENDING",
          payload: { not: null },
          receivedAt: { lte: youngest },
          id,
        },
        orderBy: { id: "asc" },
        take,
        select: {
          id: true,
          tenantId: true,
          chatwootInstanceId: true,
          routeAgentBotId: true,
          bindingGeneration: true,
          payload: true,
        },
      }),
    );
  let admitted = 0;
  const rows = await read({ notIn: [...held, ...failed] }, batch);
  const room = batch - rows.length;
  if (room > 0 && failed.length > 0)
    rows.push(...(await read({ in: failed }, room)));
  for (const row of rows) {
    const normalized = parseStored(row.payload);
    if (normalized === null) {
      // NOTE: A body that neither decrypts nor normalizes (the encryption key changed since) is dropped,
      // never read another way, which hands the row to the sweep's report.
      logger.error(
        "chatwoot: stored delivery row %s holds a body that no longer decrypts or normalizes; left to the sweep",
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
    const ok = admitChatwootDelivery(
      row.id,
      () =>
        processRecordedChatwootDelivery({
          tenantId: row.tenantId,
          instanceId: row.chatwootInstanceId,
          deliveryRowId: row.id,
          agentBotId: row.routeAgentBotId,
          normalized,
          receiptBindingGeneration: row.bindingGeneration,
          base,
          deps: params.deps,
        }),
      "meta",
    );
    if (ok) admitted++;
    else if (admissionLaneFull("meta")) break;
  }

  if (admitted > 0 || recovered > 0 || cleared > 0) {
    logger.warn(
      "chatwoot: drained %d stored deliveries and handed %d customer messages to the recovery%s; %d bodies cleared",
      admitted,
      recovered,
      params.tenantId === undefined ? "" : ` for tenant ${params.tenantId}`,
      cleared,
    );
  }
  return { admitted, recovered, cleared };
}

function parseStored(payload: string | null) {
  if (payload === null) return null;
  try {
    return normalizeChatwootEvent(JSON.parse(decryptJson<string>(payload)));
  } catch {
    return null;
  }
}
