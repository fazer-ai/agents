import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";

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
  // Under the limit: a row is reserved for this nudge, released if nothing reaches the customer.
  | { over: false; reservationId: bigint | null }
  | {
      over: true;
      count: number;
      limit: number;
      // The first refusal since the last alert a day ago or more: the one line written at `error`.
      alert: boolean;
    };

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
                  deliveredAt: now,
                },
                select: { id: true },
              });
              return { over: false as const, reservationId: row.id };
            }
            const conv = await db.conversation.findUnique({
              where: { id: params.conversationDbId },
              select: { proactiveLimitAlertedAt: true },
            });
            const last = conv?.proactiveLimitAlertedAt ?? null;
            const alert = last === null || last <= windowStart;
            if (alert)
              await db.conversation.update({
                where: { id: params.conversationDbId },
                data: { proactiveLimitAlertedAt: now },
              });
            return {
              over: true as const,
              count,
              limit: params.limit,
              alert,
            };
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
      return "channel redirect";
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
