import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { assertUsableCount, badQueryParam } from "@/lib/query-param";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { emitDeliveryRequeued } from "@/modules/flowlog/webhook";

// THE DELIVERY LEDGER AS A SUPPORTED SURFACE: the operator's side of the table whose worker side is
// `worker.ts`, so nobody has to read `outbound_webhook_deliveries` directly: the table is not a
// supported surface, since `attempts` and `lastError` are the worker's and change with it.
//
// The payload never crosses this surface: it does NOT go through the PII scrub `execution_logs` rows
// get, and the subscriber already has it. A ledger answers whether the event arrived, not what was
// in it; the dead-delivery alert line follows the same rule.

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
  // Set when the POST went out UNSIGNED although the subscription names a signing secret. It rides
  // on DELIVERED rows too, and that is the point: the receiver rejecting an unsigned
  // request does it in ITS log, so without this field the ledger shows a clean 2xx history for
  // deliveries nobody is accepting.
  unsignedReason: string | null;
  createdAt: string;
  updatedAt: string;
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
  unsignedReason: true,
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
    unsignedReason: r.unsignedReason,
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
// `attempts` goes back to 0: `finalizeFailure` gives up at `attempts + 1 >= MAX_ATTEMPTS`, so a row
// requeued with its count would die again on the first post. `lastError` is kept, as on any row
// retrying at PENDING; the count it died at is in the log line emitted here.
// DEAD is the ONLY requeueable status, guarded in the update's own `where`: a SENDING row has a POST
// in flight, and a DELIVERED one would re-send data the receiver already took.
// The audit row is written HERE, inside the lock, so its `before` is the state this call acted on.
export async function requeueWebhookDelivery(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<WebhookDeliveryDto> {
  const { row, before } = await runScopedOn(base, ctx, async (db) => {
    // NOTE: `FOR UPDATE` is the design, not an optimisation: another operator and the WORKER both
    // write this row, and without the lock the status refused on and the count logged could be
    // stale by the time they are said. RLS is active here, so a foreign id selects nothing (404).
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
    await auditMutation(db, ctx, {
      action: "webhook_delivery.requeue",
      target: `webhook_delivery:${id}`,
      // The LOCKED read, not the constant "DEAD" the guard above proved it to be. The two are the
      // same value and only one of them is evidence.
      before: { status: current.status, attempts: current.attempts },
      after: { status: updated.status, attempts: updated.attempts },
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
  return dto;
}
