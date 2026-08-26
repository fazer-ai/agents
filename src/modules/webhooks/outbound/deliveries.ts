import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { assertUsableCount, badQueryParam } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitDeliveryRequeued } from "@/modules/flowlog/webhook";

// THE DELIVERY LEDGER AS A SUPPORTED SURFACE (issue #305).
//
// The worker's side of this table is `worker.ts`; this is the operator's side. It exists because
// the only way to see a delivery that reached `DEAD` was to open Postgres and read
// `outbound_webhook_deliveries` with a read-only role — which works, and which we answered we
// cannot promise to keep: `attempts` and `lastError` are owned by the worker, and the outbound
// headers were renamed inside one cycle without anything announcing it to a table reader.
//
// The payload never crosses this surface. It is the tenant's own data, it does NOT go through the
// PII scrub that `execution_logs` rows get at write, and the subscriber already receives it at
// their endpoint — a ledger answers whether the event arrived, not what was in it. The same call
// was made for the dead-delivery alert line in #325.

export interface WebhookDeliveryDto {
  id: string;
  subscriptionId: string;
  // Whether the subscription is currently enabled, and it is here rather than one join away for a
  // reason: the worker's claim joins `enabled = true`, so a delivery belonging to a disabled
  // subscription sits at PENDING and is never picked up. Without this field a requeue into a
  // disabled subscription looks exactly like a requeue that did nothing.
  subscriptionEnabled: boolean;
  event: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequeuedDelivery {
  delivery: WebhookDeliveryDto;
  // What the row was when the lock was taken, i.e. what this requeue actually undid.
  before: { status: string; attempts: number };
}

export interface ListDeliveriesOpts {
  status?: string;
  subscriptionId?: bigint;
  event?: string;
  since?: Date;
  until?: Date;
  limit?: number;
  // Keyset: return rows with id < cursor.
  cursor?: bigint;
}

export interface ListDeliveriesResult {
  items: WebhookDeliveryDto[];
  // Pass back as `cursor` to fetch the next (older) page; null when no more rows.
  nextCursor: string | null;
}

// Every column except `payload`. Written as an explicit projection rather than an omit so that a
// column added to the model later does not silently join this surface.
const SELECT = {
  id: true,
  subscriptionId: true,
  event: true,
  status: true,
  attempts: true,
  nextAttemptAt: true,
  deliveredAt: true,
  lastError: true,
  createdAt: true,
  updatedAt: true,
  subscription: { select: { enabled: true } },
} as const;

type DeliveryRow = Prisma.OutboundWebhookDeliveryGetPayload<{
  select: typeof SELECT;
}>;

// The four statuses an OUTBOUND delivery can actually hold. `WebhookDeliveryStatus` also carries
// `FAILED`, which only the inbound side writes: accepting it here would answer "no rows" to a
// filter that can never match, so it is refused as an unknown status instead.
export const OUTBOUND_DELIVERY_STATUSES = [
  "PENDING",
  "SENDING",
  "DELIVERED",
  "DEAD",
] as const;
export type OutboundDeliveryStatus =
  (typeof OUTBOUND_DELIVERY_STATUSES)[number];

export function isOutboundDeliveryStatus(
  s: string,
): s is OutboundDeliveryStatus {
  return (OUTBOUND_DELIVERY_STATUSES as readonly string[]).includes(s);
}

function toDto(r: DeliveryRow): WebhookDeliveryDto {
  return {
    id: String(r.id),
    subscriptionId: String(r.subscriptionId),
    subscriptionEnabled: r.subscription.enabled,
    event: r.event,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt?.toISOString() ?? null,
    deliveredAt: r.deliveredAt?.toISOString() ?? null,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// The RANGE of the filters lives here, not in the controller, so MCP is held to the same rule: its
// `since`/`until` arrive as `new Date(string)` and its `limit` as a plain number, and both reach
// Prisma and throw on a value the caller got wrong. A 500 for a caller's typo is the wrong answer
// however the call arrived.
function assertUsableFilters(opts: ListDeliveriesOpts): void {
  for (const key of ["since", "until"] as const) {
    const d = opts[key];
    if (d && Number.isNaN(d.getTime())) badQueryParam(key);
  }
  assertUsableCount(opts.limit, "limit");
}

// An event name is free text (the closed set lives in OUTBOUND_EVENTS, and a delivery can outlive
// an event being retired), so the only thing to refuse here is the empty one.
function assertUsableEvent(e: string): string {
  if (e === "") badQueryParam("event");
  return e;
}

function assertKnownStatus(s: string): OutboundDeliveryStatus {
  if (!isOutboundDeliveryStatus(s)) {
    throw new AppError(
      `unknown delivery status: ${s}`,
      400,
      "errors.unknownDeliveryStatus",
      { status: s },
      "status",
    );
  }
  return s;
}

export async function listWebhookDeliveries(
  ctx: TenantContext,
  opts: ListDeliveriesOpts = {},
  base: PrismaClient = basePrisma,
): Promise<ListDeliveriesResult> {
  assertUsableFilters(opts);
  const take = Math.min(opts.limit ?? 50, 200);
  const createdAt: Prisma.DateTimeFilter = {};
  if (opts.since) createdAt.gte = opts.since;
  if (opts.until) createdAt.lte = opts.until;
  const where: Prisma.OutboundWebhookDeliveryWhereInput = {
    ...(opts.since || opts.until ? { createdAt } : {}),
    // `!== undefined`, never truthiness: a filter the caller SENT is a filter, and an empty one is
    // unusable rather than absent. `status: ""` under a truthiness check answers a request for one
    // status with every status, which is the same widening the id parsers refuse one layer up —
    // and this is the layer MCP arrives at, so the rule has to live here to hold for both.
    ...(opts.status !== undefined
      ? { status: assertKnownStatus(opts.status) }
      : {}),
    ...(opts.subscriptionId !== undefined
      ? { subscriptionId: opts.subscriptionId }
      : {}),
    ...(opts.event !== undefined
      ? { event: assertUsableEvent(opts.event) }
      : {}),
    ...(opts.cursor !== undefined ? { id: { lt: opts.cursor } } : {}),
  };
  const rows = await runScopedOn(base, ctx, (db) =>
    db.outboundWebhookDelivery.findMany({
      where,
      orderBy: { id: "desc" },
      take: take + 1, // one extra row tells us whether a next page exists
      select: SELECT,
    }),
  );
  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;
  return {
    items: page.map(toDto),
    nextCursor: hasMore ? String(page[page.length - 1]?.id) : null,
  };
}

export async function getWebhookDelivery(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<WebhookDeliveryDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.outboundWebhookDelivery.findFirst({ where: { id }, select: SELECT }),
  );
  // RLS makes a foreign id indistinguishable from a missing one, which is the point.
  if (!row)
    throw new NotFoundError(
      "webhook delivery not found",
      "errors.webhookDeliveryNotFound",
    );
  return toDto(row);
}

// PUT A DEAD DELIVERY BACK IN THE WORKER'S QUEUE.
//
// `attempts` goes back to 0, and that is the whole difference between a requeue and a gesture.
// Measured against the real worker with a receiver answering 500: a DEAD row at `attempts: 8`
// flipped to PENDING with its count untouched comes back DEAD on the FIRST post (`attempts: 9`),
// because `finalizeFailure` gives up at `attempts + 1 >= MAX_ATTEMPTS`. The same row with the
// count zeroed goes back to PENDING with a fresh backoff (`attempts: 1`). Anything that does not
// reset buys exactly one attempt, which is not what "reprocess" means to anyone asking for it.
//
// `lastError` is kept on purpose. It is not stale state: a row retrying today already carries the
// error of its last failure while sitting at PENDING, so this matches what the ledger already
// means. The count the row died at is not lost either — it is in the `webhook` log line #325
// writes at death, and it is repeated in the line this function emits.
//
// DEAD is the ONLY status that can be requeued, and the guard is the `status: "DEAD"` in the
// update's own `where`, not a branch above it. SENDING is why: the worker is holding that row with
// a POST in flight, and putting it back to PENDING opens a window for a second claim to deliver it
// again. Refusing in the same statement that writes means no reader-then-writer gap to lose the
// race in. PENDING is already queued, and replaying a DELIVERED event is a different promise with
// a different consequence — re-sending data the receiver already took.
// The pre-state travels back with the row, and it is the LOCKED read rather than a caller's own
// earlier look. A caller that audits this mutation (the MCP tool does, and the contract in
// docs/mcp.md requires `before`/`after` to describe the write that happened) would otherwise have
// to read the row itself, outside the lock — and between that read and this one the row can have
// been requeued by somebody else and died again, which for an SSRF-refused URL takes one tick. The
// `before` it recorded would then belong to the previous death.
export async function requeueWebhookDelivery(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<RequeuedDelivery> {
  const { row, before } = await runScopedOn(base, ctx, async (db) => {
    // `FOR UPDATE`, and the lock is the design of this function rather than an optimisation. Two
    // writers reach this row: another operator requeueing it, and the WORKER finishing with it.
    // Without the lock, both things this function then says can be stale by the time it says them
    // — the status it refuses on (two operators both read DEAD; the second's update matches
    // nothing and it would answer "this one is DEAD" about a row already PENDING) and the count it
    // logs (a read of SENDING/7 while the worker is committing DEAD/8 still passes the update, and
    // the line preserves 7 for a delivery that died at 8). Taking the lock first collapses both:
    // whatever this reads is what the row is, and nobody can move it until this transaction ends.
    //
    // RLS is active on this connection (`runScopedOn`), so a foreign id selects nothing here — the
    // same 404 a foreign id gets from every other read on this surface.
    const locked = await db.$queryRaw<
      Array<{ status: string; attempts: number }>
    >`
      SELECT status::text AS status, attempts
      FROM outbound_webhook_deliveries
      WHERE id = ${id}
      FOR UPDATE
    `;
    const current = locked[0];
    if (!current)
      throw new NotFoundError(
        "webhook delivery not found",
        "errors.webhookDeliveryNotFound",
      );
    if (current.status !== "DEAD")
      throw new AppError(
        `only a dead delivery can be requeued (this one is ${current.status})`,
        409,
        "errors.webhookDeliveryNotDead",
        { status: current.status },
        "status",
      );
    const updated = await db.outboundWebhookDelivery.update({
      where: { id },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: null },
      select: SELECT,
    });
    return {
      row: updated,
      before: { status: current.status, attempts: current.attempts },
    };
  });
  if (!row)
    throw new NotFoundError(
      "webhook delivery not found",
      "errors.webhookDeliveryNotFound",
    );
  const dto = toDto(row);
  if (ctx.tenantId !== null) {
    emitDeliveryRequeued({
      tenantId: ctx.tenantId,
      deliveryId: id,
      subscriptionId: BigInt(dto.subscriptionId),
      event: dto.event,
      attemptsBefore: before.attempts,
      subscriptionEnabled: dto.subscriptionEnabled,
      base,
    });
  }
  // `before` is what the LOCKED read returned, not the constant "DEAD" the guard above proved it
  // to be. The two are the same value and only one of them is evidence.
  return { delivery: dto, before };
}
