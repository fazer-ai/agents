import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";

// THE PER-CONVERSATION PROACTIVE LIMIT. An inbound integration that fires events with fresh ids in a
// loop sends one proactive message per event to the same contact, each billed by Meta outside the
// 24h window. Counting the proactive messages delivered in a rolling day stops that loop without
// silencing the conversation: the customer may still write, and the agent still answers.

// The count reads the proactive rows of `agent_turn_deliveries`, the turn limit's ledger. The gate
// RESERVES its row under a lock on the conversation, because a nudge's send is recorded after it
// releases the thread, and nudges arriving together would otherwise each count the window before any
// of them is written. See docs/graph.md, "Proactive limit".

export const PROACTIVE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type ProactiveLimitVerdict =
  // Under the limit: a pending row is reserved for this nudge, confirmed when its send reaches the
  // customer and released otherwise.
  | { over: false; reservationId: bigint | null }
  | { over: true; count: number; limit: number };

// Over when the proactive messages already delivered in the window reach the limit: the one about
// to run would be one past it.
export function proactiveLimitReached(count: number, limit: number): boolean {
  return count >= limit;
}

// An unreadable count ALLOWS the send, with no reservation: the limit guards against a runaway, and
// dropping a legitimate follow-up because a read failed is the worse failure.
export async function reserveProactiveSend(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  limit: number;
  base?: PrismaClient;
  now?: Date;
}): Promise<ProactiveLimitVerdict> {
  const now = params.now ?? new Date();
  try {
    return await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      (db) =>
        withEntityLock(
          db,
          `proactive-limit:${params.conversationDbId}`,
          async () => {
            const windowStart = new Date(
              now.getTime() - PROACTIVE_LIMIT_WINDOW_MS,
            );
            const count = await db.agentTurnDelivery.count({
              where: {
                conversationId: params.conversationDbId,
                proactive: true,
                deliveredAt: { gt: windowStart },
              },
            });
            if (!proactiveLimitReached(count, params.limit)) {
              const row = await db.agentTurnDelivery.create({
                data: {
                  tenantId: params.tenantId,
                  conversationId: params.conversationDbId,
                  proactive: true,
                  pending: true,
                  deliveredAt: now,
                },
                select: { id: true },
              });
              return { over: false as const, reservationId: row.id };
            }
            return { over: true as const, count, limit: params.limit };
          },
        ),
    );
  } catch (err) {
    logger.warn(
      { err, conversationDbId: String(params.conversationDbId) },
      "proactive limit: could not count the window, the send goes ahead",
    );
    return { over: false, reservationId: null };
  }
}

// The reservation's send reached the customer: from here on it is a delivery the turn limit counts.
// Best-effort like the delivery it stands for, since a throw would fail a nudge that already spoke.
export async function confirmProactiveReservation(params: {
  tenantId: bigint;
  reservationId: bigint;
  base?: PrismaClient;
}): Promise<void> {
  try {
    await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      (db) =>
        db.agentTurnDelivery.updateMany({
          where: { id: params.reservationId },
          data: { pending: false, deliveredAt: new Date() },
        }),
    );
  } catch (err) {
    logger.warn(
      { err, reservationId: String(params.reservationId) },
      "proactive limit: could not confirm a reservation; the turn limit misses one delivery",
    );
  }
}

// Whether this refusal is the first since the last alert a day ago or more, claiming the window if
// so. One conditional write, so two refusals at once cannot both page the alert channels. Asked
// apart from the count, after the caller has confirmed the occasion is still wanted, so a retired
// nudge never takes the alert a later real refusal needs. A failed write reports no alert.
export async function claimProactiveAlert(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  base?: PrismaClient;
  now?: Date;
}): Promise<boolean> {
  const now = params.now ?? new Date();
  const windowStart = new Date(now.getTime() - PROACTIVE_LIMIT_WINDOW_MS);
  try {
    const { count } = await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      (db) =>
        db.conversation.updateMany({
          where: {
            id: params.conversationDbId,
            OR: [
              { proactiveLimitAlertedAt: null },
              { proactiveLimitAlertedAt: { lte: windowStart } },
            ],
          },
          data: { proactiveLimitAlertedAt: now },
        }),
    );
    return count === 1;
  } catch (err) {
    logger.warn(
      { err, conversationDbId: String(params.conversationDbId) },
      "proactive limit: could not claim the alert window",
    );
    return false;
  }
}

// Gives back a reservation whose nudge put nothing in front of the customer (silence, a note, a
// refusal further down). Best-effort: a row left behind costs one message of slack for a day, in the
// strict direction.
export async function releaseProactiveReservation(params: {
  tenantId: bigint;
  reservationId: bigint;
  base?: PrismaClient;
}): Promise<void> {
  try {
    await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      (db) =>
        db.agentTurnDelivery.deleteMany({
          where: { id: params.reservationId },
        }),
    );
  } catch (err) {
    logger.warn(
      { err, reservationId: String(params.reservationId) },
      "proactive limit: could not release a reservation; the window counts one send too many",
    );
  }
}

// What the refused message was, in the words an operator recognizes from the editor.
export function proactiveSourceLabel(
  source: string,
  integrationName: string | null,
): string {
  if (integrationName) return `integration "${integrationName}"`;
  switch (source) {
    case "followup":
      return "follow-up";
    case "appointment_reminder":
      return "appointment reminder";
    case "channel-redirect":
    case "channel-redirect-link":
      return "channel redirect";
    case "channel-redirect-closing":
      return "channel redirect goodbye";
    default:
      return `"${source}"`;
  }
}

// The line in the Logs, which the alert channels deliver when it is the first of the window. In
// English like every other flow-log sentence, and with the numbers, so an alert read alone says
// which limit, how far, and what kept firing.
export function proactiveLimitLogMessage(params: {
  count: number;
  limit: number;
  source: string;
}): string {
  return `Proactive limit reached: ${params.count} proactive messages were delivered in this conversation in the last 24 hours (limit ${params.limit}). The ${params.source} message was not sent. The conversation stays with the agent, which still answers the customer.`;
}

// The refusal line, one shape for every proactive sender: the nudge and the fixed sends of the
// redirect ladder. `alert` is the answer of `claimProactiveAlert`.
export function emitProactiveLimitRefusal(
  flow: FlowContext,
  p: {
    count: number;
    limit: number;
    alert: boolean;
    // What fired, as the operator recognizes it (proactiveSourceLabel).
    source: string;
    detail: Record<string, unknown>;
  },
): void {
  emitFlowEvent(flow, {
    stage: "proactive_limit",
    level: p.alert ? "error" : "info",
    status: p.alert ? "error" : "skipped",
    detail: {
      outcome: "not_sent",
      limit: p.limit,
      count: p.count,
      ...p.detail,
    },
    errorMessage: proactiveLimitLogMessage({
      count: p.count,
      limit: p.limit,
      source: p.source,
    }),
  });
}

// A FIXED proactive send (no model turn): the redirect ladder's link and its goodbye. Counted and
// refused like a nudge, against the conversation it goes to. `send` runs only under the limit; a send
// that throws gives the reservation back and rethrows. A conversation with no mirror row, or a limit
// of 0, sends without counting.
export async function sendWithinProactiveLimit(p: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  agentId: bigint;
  limit: number;
  // proactiveSourceLabel's input, and the `trigger` the line carries.
  source: string;
  base?: PrismaClient;
  send: () => Promise<void>;
}): Promise<"sent" | "over"> {
  const base = p.base ?? basePrisma;
  const row =
    p.limit > 0
      ? await runScopedOn(base, sysCtx(p.tenantId), (db) =>
          db.conversation.findFirst({
            where: {
              chatwootInstanceId: p.instanceId,
              chatwootConversationId: p.chatwootConversationId,
            },
            select: { id: true, inboxId: true },
          }),
        ).catch(() => null)
      : null;
  if (!row) {
    await p.send();
    return "sent";
  }
  const verdict = await reserveProactiveSend({
    tenantId: p.tenantId,
    conversationDbId: row.id,
    limit: p.limit,
    base,
  });
  if (verdict.over) {
    const alert = await claimProactiveAlert({
      tenantId: p.tenantId,
      conversationDbId: row.id,
      base,
    });
    emitProactiveLimitRefusal(
      {
        tenantId: p.tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: row.id,
        agentId: p.agentId,
        inboxId: row.inboxId,
        threadId: `${p.tenantId}:${p.instanceId}:${p.chatwootConversationId}`,
        base,
      },
      {
        count: verdict.count,
        limit: verdict.limit,
        alert,
        source: proactiveSourceLabel(p.source, null),
        detail: { trigger: p.source },
      },
    );
    return "over";
  }
  try {
    await p.send();
  } catch (err) {
    if (verdict.reservationId !== null)
      await releaseProactiveReservation({
        tenantId: p.tenantId,
        reservationId: verdict.reservationId,
        base,
      });
    throw err;
  }
  if (verdict.reservationId !== null)
    await confirmProactiveReservation({
      tenantId: p.tenantId,
      reservationId: verdict.reservationId,
      base,
    });
  return "sent";
}
