import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import type { RuntimeDeps } from "@/graph/runtime";
import { withKeyedQueue } from "@/lib/locks";
import { runInPoolClass } from "@/lib/pool-class";
import { isDraining, trackWork } from "@/lib/shutdown";
import { asSuperAdminOn } from "@/lib/tenancy";
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
    // NOTE: Every delivery runs on the main pool, whoever admitted it: a customer message is a turn,
    // and the slot that frees here starts the next delivery from this callback's context, which may be
    // the delivery sweep's (background) and not the live webhook that queued it.
    void trackWork("chatwoot_delivery", () => runInPoolClass("main", work))
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

// The rows this process holds (waiting or running), which no other pass may treat as stranded.
export function heldDeliveryRowIds(): bigint[] {
  return [...admission().held.values()];
}

// Whether this process already holds the row, so a refusal is a duplicate and not a full lane.
export function admissionHolds(rowId: bigint): boolean {
  return admission().held.has(String(rowId));
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

// Customer messages the waiting bound turned away go to the recovery ONE AT A TIME: a sustained
// overflow must not open a handoff transaction per message against the pool the admission bound
// protects. Past this many queued here the handoff is refused and the row stays PENDING, which the
// next drain hands over in a bounded batch.
export const OVERFLOW_HANDOFF_MAX_WAITING = ADMISSION_MAX_WAITING;
let overflowHandoffs = 0;

// Queues one handoff behind the others. False when the handoff queue is full.
export function queueOverflowHandoff(handoff: () => Promise<unknown>): boolean {
  if (overflowHandoffs >= OVERFLOW_HANDOFF_MAX_WAITING) return false;
  overflowHandoffs++;
  void withKeyedQueue("chatwoot:overflow-handoff", handoff)
    .catch(() => {})
    .finally(() => {
      overflowHandoffs--;
    });
  return true;
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

interface DrainStrand {
  id: bigint;
  tenantId: bigint;
  chatwootInstanceId: bigint;
  event: string;
  conversationId: number | null;
  inboundMessageId: number | null;
}

// The strands read, written as SQL so `status = 'PENDING'` is a literal: the partial index of the open
// rows (`chatwoot_webhook_deliveries_sweep_idx`, `WHERE status IN ('PENDING','PROCESSING')`) is usable
// only when the planner can prove its predicate, and a parameter cast to the enum, which is what the
// client sends, proves nothing even outside the tenant policy. Exported for the plan test.
export function drainStrandsSql(p: {
  tenantId: bigint | undefined;
  youngest: Date;
  ceiling: Date;
  held: bigint[];
  batch: number;
}): Prisma.Sql {
  const tenant =
    p.tenantId === undefined
      ? Prisma.empty
      : Prisma.sql`AND tenant_id = ${p.tenantId}`;
  const notHeld =
    p.held.length > 0
      ? Prisma.sql`AND id NOT IN (${Prisma.join(p.held)})`
      : Prisma.empty;
  return Prisma.sql`
    SELECT id, tenant_id AS "tenantId", chatwoot_instance_id AS "chatwootInstanceId", event,
           conversation_id AS "conversationId", inbound_message_id AS "inboundMessageId"
      FROM chatwoot_webhook_deliveries
     WHERE status = 'PENDING'
       AND payload IS NULL
       AND conversation_id IS NOT NULL
       AND inbound_message_id IS NOT NULL
       AND received_at <= ${p.youngest}
       AND received_at > ${p.ceiling}
       ${tenant}
       ${notHeld}
     ORDER BY received_at, id
     LIMIT ${p.batch}`;
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
  // As the fleet, with the tenant as an explicit filter, and never under the tenant policy: there
  // `status = 'PENDING'` (an enum, not LEAKPROOF) stays above the security barrier, so no index can use
  // it, and the strands read walked the primary key over every row (16 s on 6.9M rows, measured in
  // production). Every row read here carries its own tenantId into what it hands on.
  const scope =
    params.tenantId === undefined ? {} : { tenantId: params.tenantId };
  const run = <T>(fn: Parameters<typeof asSuperAdminOn<T>>[1]) =>
    asSuperAdminOn(base, fn);

  // The body leaves every row that will not be processed from it: one that left PENDING by a road that
  // does not clear it, and one past the ceiling. Both statements read the partial index of the rows
  // that still hold a body.
  const { count: cleared } = await run((db) =>
    db.chatwootWebhookDelivery.updateMany({
      where: {
        ...scope,
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
    db.$queryRaw<DrainStrand[]>(
      drainStrandsSql({
        tenantId: params.tenantId,
        youngest,
        ceiling,
        held,
        batch,
      }),
    ),
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
  // Each lane reads its own batch: rows a full lane turns away stay first in id order, and read
  // together they would fill every pass and keep the other lane's rows from being read at all.
  // A stored customer message (a control command) may run a turn, so it takes the turn lane.
  const laneWhere = (
    lane: AdmissionLane,
  ): Prisma.ChatwootWebhookDeliveryWhereInput =>
    lane === "turn"
      ? { conversationId: { not: null }, inboundMessageId: { not: null } }
      : { OR: [{ conversationId: null }, { inboundMessageId: null }] };
  const pending = (lane: AdmissionLane, id: Prisma.BigIntFilter) => ({
    ...scope,
    status: "PENDING" as const,
    payload: { not: null },
    receivedAt: { lte: youngest },
    id,
    ...laneWhere(lane),
  });
  const read = (lane: AdmissionLane, id: Prisma.BigIntFilter, take: number) =>
    run((db) =>
      db.chatwootWebhookDelivery.findMany({
        where: pending(lane, id),
        orderBy: { id: "asc" },
        take,
        select: {
          id: true,
          tenantId: true,
          chatwootInstanceId: true,
          routeAgentBotId: true,
          bindingGeneration: true,
          payload: true,
          receivedAt: true,
        },
      }),
    );
  let admitted = 0;
  for (const lane of ["meta", "turn"] as const) {
    if (admissionLaneFull(lane)) continue;
    const rows = await read(lane, { notIn: [...held, ...failed] }, batch);
    const room = batch - rows.length;
    // The ones that failed longest ago first (the map moves a row to its end on every failure), so a
    // few that keep failing cannot hold the room against the others.
    if (room > 0 && failed.length > 0) {
      const inLane = new Set(
        (
          await run((db) =>
            db.chatwootWebhookDelivery.findMany({
              where: pending(lane, { in: failed }),
              select: { id: true },
            }),
          )
        ).map((r) => r.id),
      );
      const next = failed.filter((id) => inLane.has(id)).slice(0, room);
      if (next.length > 0) rows.push(...(await read(lane, { in: next }, room)));
    }
    for (const row of rows) {
      const normalized = parseStored(row.payload);
      if (normalized === null) {
        // NOTE: A body that neither decrypts nor normalizes (the encryption key changed since) is
        // dropped, never read another way, which hands the row to the sweep's report.
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
        lane,
        row.receivedAt.getTime(),
      );
      if (ok) admitted++;
      else if (admissionLaneFull(lane)) break;
    }
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
