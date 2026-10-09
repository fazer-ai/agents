import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { consoleUrl } from "@/modules/mcp/console-links";

// THE PER-CONVERSATION TURN LIMIT. An automated counterpart (another company's bot, an e-mail
// auto-responder) answers every reply with a legitimate incoming message, and the agent answers that
// too, forever. Counting the agent's own deliveries in a rolling hour is what tells that loop apart
// from a person: a human conversation stays far below the limit, a bot-to-bot loop runs well past it.
//
// The count lives in `agent_turn_deliveries`, written when a turn ends, and starts again after the
// last trip (`conversations.turn_limit_tripped_at`), so a conversation handed back to the bot is not
// handed over again on its first reply. See docs/graph.md, "Turn limit".

export const TURN_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Best-effort: a lost row costs one turn of slack in the count, while a throw here would fail a turn
// that already reached the customer.
export async function recordTurnDelivery(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  proactive: boolean;
  base?: PrismaClient;
}): Promise<void> {
  try {
    await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      (db) =>
        db.agentTurnDelivery.create({
          data: {
            tenantId: params.tenantId,
            conversationId: params.conversationDbId,
            proactive: params.proactive,
          },
        }),
    );
  } catch (err) {
    logger.warn(
      { err, conversationDbId: String(params.conversationDbId) },
      "turn limit: could not record a delivered turn",
    );
  }
}

export interface TurnLimitVerdict {
  over: boolean;
  count: number;
  limit: number;
  // Tripped inside the window and no change of holder has reached the mirror since: the hand-over is
  // in flight (its webhook lags), so the conversation is a person's and nothing restarts the count.
  handoverPending: boolean;
  // The mirror's ownership mark as read here, which a trip stores as the version it handed over from.
  ownershipMark: number | null;
}

// Over when the turns already delivered in the window reach the limit: the turn about to run would
// be one past it, so it never reaches the customer.
export function turnLimitReached(count: number, limit: number): boolean {
  return count >= limit;
}

// An unreadable count ALLOWS the turn: the limit guards against a runaway, and silencing a customer
// because a read failed is the worse failure.
export async function turnLimitVerdict(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  limit: number;
  base?: PrismaClient;
  now?: Date;
}): Promise<TurnLimitVerdict> {
  const now = params.now ?? new Date();
  try {
    const count = await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      async (db) => {
        const conv = await db.conversation.findUnique({
          where: { id: params.conversationDbId },
          select: {
            turnLimitTrippedAt: true,
            turnLimitTripMark: true,
            chatwootOwnershipChangedAt: true,
          },
        });
        const windowStart = new Date(now.getTime() - TURN_LIMIT_WINDOW_MS);
        const tripped = conv?.turnLimitTrippedAt ?? null;
        const trippedInWindow = tripped !== null && tripped > windowStart;
        // The count restarts on a hand-back, not on the trip: the holder has to have moved at the
        // source past the version the trip handed over from. Both marks absent (an older Chatwoot)
        // trusts the trip stamp.
        const mark = conv?.chatwootOwnershipChangedAt ?? null;
        const from = conv?.turnLimitTripMark ?? null;
        const handedBack =
          trippedInWindow &&
          (mark === null ? from === null : from === null || mark > from);
        const since = handedBack ? tripped : windowStart;
        const delivered = await db.agentTurnDelivery.count({
          where: {
            conversationId: params.conversationDbId,
            deliveredAt: { gt: since },
          },
        });
        return { delivered, pending: trippedInWindow && !handedBack, mark };
      },
    );
    return {
      over: turnLimitReached(count.delivered, params.limit),
      count: count.delivered,
      limit: params.limit,
      handoverPending: count.pending,
      ownershipMark: count.mark,
    };
  } catch (err) {
    logger.warn(
      { err, conversationDbId: String(params.conversationDbId) },
      "turn limit: could not count the window, the turn goes ahead",
    );
    return {
      over: false,
      count: 0,
      limit: params.limit,
      handoverPending: false,
      ownershipMark: null,
    };
  }
}

export async function markTurnLimitTripped(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  // The ownership mark read before the transfer (TurnLimitVerdict.ownershipMark).
  fromMark: number | null;
  base?: PrismaClient;
  now?: Date;
}): Promise<void> {
  try {
    await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      (db) =>
        db.conversation.update({
          where: { id: params.conversationDbId },
          data: {
            turnLimitTrippedAt: params.now ?? new Date(),
            turnLimitTripMark: params.fromMark,
          },
        }),
    );
  } catch (err) {
    logger.warn(
      { err, conversationDbId: String(params.conversationDbId) },
      "turn limit: could not stamp the trip; a hand-back will count the old window",
    );
  }
}

// The agent editor's Execution limits card, where the operator raises or turns off the limit. A
// query parameter and not a hash: `consoleUrl` appends the tenant switch after the path, which a
// hash would swallow.
export function turnLimitSettingsUrl(
  tenantId: bigint | null,
  agentId: bigint,
): string {
  return consoleUrl(`/agents/${agentId}/behavior?focus=limits`, { tenantId });
}

// The private note left for the person who receives the conversation (pt-BR, the register of the
// other operator notes). It has to answer three questions on its own: why the agent stopped, whether
// giving the conversation back is safe, and where the limit is changed.
export function turnLimitNoteText(params: {
  count: number;
  limit: number;
  handedOff: boolean;
  settingsUrl: string;
}): string {
  const head = `O agente parou de responder: ele já respondeu ${params.count} vezes nesta conversa na última hora (limite: ${params.limit}), o que costuma indicar que do outro lado há um remetente automático, como outro bot ou uma resposta automática de e-mail.`;
  const handoff = params.handedOff
    ? " A conversa foi aberta para atendimento humano. Se for um cliente de verdade, é seguro devolvê-la ao agente: a contagem recomeça do zero."
    : " Não consegui abrir a conversa para atendimento humano; ela continua com o agente, que não vai responder enquanto o limite estiver atingido.";
  return `${head}${handoff} Para aumentar ou desligar o limite: ${params.settingsUrl}`;
}

// The line in the Logs, which the alert channels deliver. In English like every other flow-log
// sentence, and with the numbers, so an alert read alone says which limit and how far.
export function turnLimitLogMessage(
  count: number,
  limit: number,
  handedOff: boolean,
): string {
  const outcome = handedOff
    ? "The conversation was handed to a person."
    : "The hand-over to a person failed; the agent stays silent while the limit holds.";
  return `Turn limit reached: the agent replied ${count} times in this conversation in the last hour (limit ${limit}). ${outcome}`;
}
