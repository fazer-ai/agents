import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import type { RuntimeDeps } from "@/graph/runtime";
import { isDraining, trackWork } from "@/lib/shutdown";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadChatwootClient } from "./instance";
import { mirrorChatwootEvent } from "./mirror";
import { normalizeChatwootEvent, parseLiveConversation } from "./normalize";
import { reconcileMirrorFromLive } from "./reconcile";
import type { NormalizedChatwootEvent } from "./types";
import {
  inboxBindingGenerationIn,
  processRecordedChatwootDelivery,
} from "./webhook";

// Admission and drain for the Chatwoot deliveries the ack recorded (docs/chatwoot.md, "Webhook
// receiver"). The ack writes the ledger row with the body and answers; processing happens
// here, at most `config.chatwoot.deliveryConcurrency` at a time. The rest WAIT, in memory in the
// order they came, with their row PENDING in the ledger: a burst costs latency instead of a pool where
// every delivery fails `maxWait` at once, and a process that dies with deliveries waiting leaves rows a
// later drain processes from their body.

// A PENDING row whose body is still stored and that nothing in this process holds is the drain's, at any
// age up to this one: the sweep skips it, because the body is a better source than the recovery's
// rebuild, which refuses whole classes of rows (no conversation mirror, an observer's unstated route).
// Past it the body goes and the sweep reports the row like any other strand. The same ceiling as the
// recovery's `MAX_RECOVERY_AGE_MS`, restated rather than imported (the sweep's handler runs this drain,
// a module cycle); tests/modules/chatwoot-delivery-queue.test.ts pins both.
export const STORED_DELIVERY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// How old a stored row must be before the periodic pass treats it as nobody's: a younger one is most
// likely waiting in the queue of the process that acked it (this one or another replica). The boot
// pass uses zero, since nothing in a process that just started holds anything.
export const STORED_DELIVERY_MIN_AGE_MS = 60_000;

// One drain pass's ceiling. A pass admits into the same bounded queue the ack does; the rest waits
// for the next pass.
const DRAIN_BATCH = 500;

// How many batches one pass may read when a full lane turns rows away and the pass pages on for the
// other lane: the waiting list's own bound.
const DRAIN_MAX_PAGES = 10;

// How many deliveries may wait in memory, in each lane. Past it a delivery is not queued here and stays a PENDING
// row with its body, which the periodic drain takes once it is old enough: memory stays bounded by
// this, never by the size of a burst.
export const ADMISSION_MAX_WAITING = 5_000;

// Two lanes with the same limits each. A customer's incoming message, created or updated (late media
// runs its transcription or vision there), may hold its slot for a whole model call; every other event
// (a status or assignment change, an agent's or a colleague's reply) is what tells a running turn it
// lost the conversation, so it must not wait behind those, or a takeover stays invisible to the turn.
export type AdmissionLane = "turn" | "meta";

export function admissionLaneOf(event: NormalizedChatwootEvent): AdmissionLane {
  return event.message?.messageType === "incoming" && !event.message.private
    ? "turn"
    : "meta";
}

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

interface StoredRow {
  id: bigint;
  tenantId: bigint;
  chatwootInstanceId: bigint;
  routeAgentBotId: number | null;
  bindingGeneration: number | null;
  payload: string | null;
  receivedAt: Date;
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
  // Tests: the Chatwoot client and the turn's seams.
  deps?: RuntimeDeps;
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
  const ceiling = new Date(now - STORED_DELIVERY_MAX_AGE_MS);
  const run = <T>(fn: Parameters<typeof asSuperAdminOn<T>>[1]) =>
    params.tenantId === undefined
      ? asSuperAdminOn(base, fn)
      : runScopedOn(base, sysCtx(params.tenantId), fn);

  // The body leaves every row that will not be processed from it: one that left PENDING by a road that
  // does not clear it (an older release's claim during a rolling deploy), and one past the ceiling.
  // Both statements read the partial index of the rows that still hold a body.
  const { count: cleared } = await run((db) =>
    db.chatwootWebhookDelivery.updateMany({
      where: {
        payload: { not: null },
        OR: [{ status: { not: "PENDING" } }, { receivedAt: { lte: ceiling } }],
      },
      data: { payload: null },
    }),
  );
  // Rows this process already holds are skipped in the query, not after it, and rows whose last attempt
  // here threw are read only with the room left after the others: otherwise a full batch of either
  // would hide every row behind it.
  const a = admission();
  const held = [...a.held.values()];
  const failed = [...a.failed.entries()]
    .filter(([key]) => !a.held.has(key))
    .map(([, id]) => id);
  const batch = params.batch ?? DRAIN_BATCH;
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
          receivedAt: true,
        },
      }),
    ) as Promise<StoredRow[]>;

  let admitted = 0;
  // Whether a lane turned a row away for being full: a full lane does not stop the pass, which pages
  // on for rows of the other lane, and both full ends it.
  const full = { turn: false, meta: false };
  const offer = async (row: StoredRow): Promise<void> => {
    const normalized = parseStored(row.payload);
    // NOTE: A row the ack wrote decrypts and normalizes unless the encryption key changed since; a body
    // that does neither is dropped, never read another way, which hands the row to the sweep's report.
    if (normalized === null) {
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
      return;
    }
    const lane = admissionLaneOf(normalized);
    if (full[lane]) return;
    const ok = admitChatwootDelivery(
      row.id,
      () => replayStored(row, normalized, base, run, params.deps),
      lane,
    );
    if (ok) admitted++;
    else if (admissionLaneFull(lane)) full[lane] = true;
  };

  // One batch per pass, and another only while a full lane is turning rows away and the other lane
  // still has room, so a backlog in one lane cannot hide the other lane's rows behind it.
  let cursor: bigint | null = null;
  let room = 0;
  for (let page = 0; page < DRAIN_MAX_PAGES; page++) {
    const rows = await read(
      {
        notIn: [...held, ...failed],
        ...(cursor === null ? {} : { gt: cursor }),
      },
      batch,
    );
    for (const row of rows) await offer(row);
    room = batch - rows.length;
    const oneFull = full.turn !== full.meta;
    if (room > 0 || !oneFull) break;
    cursor = rows[rows.length - 1]?.id ?? null;
  }
  // The rows whose last attempt here threw, with the room the others left.
  if (room > 0 && failed.length > 0) {
    for (const row of await read({ in: failed }, room)) await offer(row);
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

// What the queue runs for a stored row once its slot opens.
async function replayStored(
  row: StoredRow,
  normalized: NormalizedChatwootEvent,
  base: PrismaClient,
  run: <T>(fn: Parameters<typeof asSuperAdminOn<T>>[1]) => Promise<T>,
  deps: RuntimeDeps | undefined,
): Promise<unknown> {
  // NOTE: The ceiling is asked again when the slot opens, since a busy queue can hold a row past it; a
  // row that crossed it is handed to the sweep exactly as the clearing pass would.
  if (Date.now() - row.receivedAt.getTime() > STORED_DELIVERY_MAX_AGE_MS) {
    await run((db) =>
      db.chatwootWebhookDelivery.updateMany({
        where: { id: row.id, status: "PENDING" },
        data: { payload: null },
      }),
    );
    return "skipped";
  }
  // NOTE: The binding the row was received under must still stand. One that moved since (an observer
  // made the responder, a persona swapped) asks what the route's role was at receipt, which the
  // delivery recovery answers with its own fences: the body is dropped and the row goes to the sweep.
  if (row.bindingGeneration !== null) {
    const current = await run((db) =>
      inboxBindingGenerationIn(db, row.chatwootInstanceId, {
        chatwootInboxId: normalized.inboxId ?? null,
        chatwootConversationId: normalized.conversationId,
      }),
    );
    if (current !== row.bindingGeneration) {
      logger.warn(
        "chatwoot: stored delivery row %s was received under binding generation %d and the inbox is at %s now; left to the sweep and the delivery recovery",
        String(row.id),
        row.bindingGeneration,
        String(current),
      );
      await run((db) =>
        db.chatwootWebhookDelivery.updateMany({
          where: { id: row.id, status: "PENDING" },
          data: { payload: null },
        }),
      );
      return "skipped";
    }
  }
  const conversationId = normalized.conversationId;
  // NOTE: A stored customer message can be replayed long after it arrived, past a takeover whose own
  // webhooks never reached the mirror while this process was down. The live conversation is read
  // first and reconciled into the mirror, as the delivery recovery does, and the stored event is then
  // processed as it arrived: the mirror's ordering keeps what is newer, so ownership comes from the
  // live read while the message's own clock and pairing keep theirs. A conversation not mirrored yet
  // is mirrored from the stored event's conversation alone (no message) first, so there is a row for
  // the live state to land on. A read that fails, or that does not say who holds the conversation,
  // throws, and the row waits for the next pass with its body.
  if (admissionLaneOf(normalized) === "turn" && conversationId !== null) {
    const client = await loadChatwootClient(
      row.tenantId,
      row.chatwootInstanceId,
      { base, ...(deps?.makeClient ? { makeClient: deps.makeClient } : {}) },
    );
    const live = parseLiveConversation(
      await client.getConversation(conversationId),
    );
    if (live === null || !live.assigneeStated) {
      throw new Error(
        `the live conversation ${conversationId} does not say who holds it; replay deferred`,
      );
    }
    const mirrored = await run((db) =>
      db.conversation.findFirst({
        where: {
          tenantId: row.tenantId,
          chatwootInstanceId: row.chatwootInstanceId,
          chatwootConversationId: conversationId,
        },
        select: { id: true },
      }),
    );
    if (mirrored === null) {
      await mirrorChatwootEvent(
        row.tenantId,
        row.chatwootInstanceId,
        { ...normalized, event: "conversation_updated", message: undefined },
        base,
      );
    }
    await reconcileMirrorFromLive({
      tenantId: row.tenantId,
      instanceId: row.chatwootInstanceId,
      conversationId,
      live,
      base,
    });
  }
  return processRecordedChatwootDelivery({
    tenantId: row.tenantId,
    instanceId: row.chatwootInstanceId,
    deliveryRowId: row.id,
    agentBotId: row.routeAgentBotId,
    normalized,
    receiptBindingGeneration: row.bindingGeneration,
    base,
    deps,
  });
}

function parseStored(payload: string | null) {
  if (payload === null) return null;
  try {
    return normalizeChatwootEvent(JSON.parse(decryptJson<string>(payload)));
  } catch {
    return null;
  }
}
