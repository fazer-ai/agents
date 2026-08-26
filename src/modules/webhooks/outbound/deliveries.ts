import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
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

function badParam(param: string): never {
  throw new AppError(
    `invalid value for ${param}`,
    400,
    "errors.invalidQueryParam",
    { param },
    param,
  );
}

// The RANGE of the filters lives here, not in the controller, so MCP is held to the same rule: its
// `since`/`until` arrive as `new Date(string)` and its `limit` as a plain number, and both reach
// Prisma and throw on a value the caller got wrong. A 500 for a caller's typo is the wrong answer
// however the call arrived.
function assertUsableFilters(opts: ListDeliveriesOpts): void {
  for (const key of ["since", "until"] as const) {
    const d = opts[key];
    if (d && Number.isNaN(d.getTime())) badParam(key);
  }
  if (
    opts.limit !== undefined &&
    (!Number.isInteger(opts.limit) || opts.limit < 1)
  )
    badParam("limit");
}

function assertKnownStatus(s: string): OutboundDeliveryStatus {
  if (!isOutboundDeliveryStatus(s)) {
    throw new AppError(
      `unknown delivery status: ${s}`,
      400,
      "errors.unknownDeliveryStatus",
      { status: s },
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
    ...(opts.status ? { status: assertKnownStatus(opts.status) } : {}),
    ...(opts.subscriptionId !== undefined
      ? { subscriptionId: opts.subscriptionId }
      : {}),
    ...(opts.event ? { event: opts.event } : {}),
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
export async function requeueWebhookDelivery(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<WebhookDeliveryDto> {
  const { row, attemptsBefore } = await runScopedOn(base, ctx, async (db) => {
    const current = await db.outboundWebhookDelivery.findFirst({
      where: { id },
      select: { id: true, status: true, attempts: true },
    });
    if (!current)
      throw new NotFoundError(
        "webhook delivery not found",
        "errors.webhookDeliveryNotFound",
      );
    const res = await db.outboundWebhookDelivery.updateMany({
      where: { id, status: "DEAD" },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: null },
    });
    // count 0 = it was not DEAD when the write ran. The status to report is re-read rather than
    // taken from the check above, because the two disagree in exactly the case that matters: two
    // operators requeueing the same dead delivery both read DEAD, the second update blocks on the
    // first and then matches nothing, and reporting the stale read would answer "this one is DEAD"
    // about a row that is now PENDING — the one refusal a caller would be right to retry.
    if (res.count === 0) {
      const now = await db.outboundWebhookDelivery.findFirst({
        where: { id },
        select: { status: true },
      });
      if (!now)
        throw new NotFoundError(
          "webhook delivery not found",
          "errors.webhookDeliveryNotFound",
        );
      throw new AppError(
        `only a dead delivery can be requeued (this one is ${now.status})`,
        409,
        "errors.webhookDeliveryNotDead",
        { status: now.status },
      );
    }
    const updated = await db.outboundWebhookDelivery.findFirst({
      where: { id },
      select: SELECT,
    });
    return { row: updated, attemptsBefore: current.attempts };
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
      attemptsBefore,
      subscriptionEnabled: dto.subscriptionEnabled,
      base,
    });
  }
  return dto;
}
