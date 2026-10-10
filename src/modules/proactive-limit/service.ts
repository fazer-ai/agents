import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import {
  breakerLockKey,
  checkBreakerLocked,
  refreshAutoPeak,
} from "@/modules/proactive-breaker/service";

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
  | { over: true; reason: "conversation"; count: number; limit: number }
  // The account-wide breaker is tripped (docs/proactive-breaker.md). `trippedNow` is the send that
  // tripped it, whose line is the one that alerts.
  | {
      over: true;
      reason: "breaker";
      trippedNow: boolean;
      trippedAt: Date;
      count: number;
      limit: number;
    };

// Over when the proactive messages already delivered in the window reach the limit: the one about
// to run would be one past it.
export function proactiveLimitReached(count: number, limit: number): boolean {
  return count >= limit;
}

// An unreadable count ALLOWS the send, with no reservation: the limit guards against a runaway, and
// dropping a legitimate follow-up because a read failed is the worse failure. The account's breaker
// is asked first, under the tenant's lock, then the conversation's limit (0 = none) under its own.
export async function reserveProactiveSend(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  limit: number;
  base?: PrismaClient;
  now?: Date;
}): Promise<ProactiveLimitVerdict> {
  const now = params.now ?? new Date();
  await refreshAutoPeak(params.tenantId, params.base ?? basePrisma, now);
  try {
    return await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      (db) =>
        withEntityLock(db, breakerLockKey(params.tenantId), async () => {
          const breaker = await checkBreakerLocked(db, params.tenantId, now);
          if (!breaker.open)
            return {
              over: true as const,
              reason: "breaker" as const,
              trippedNow: breaker.trippedNow,
              trippedAt: breaker.trippedAt,
              count: breaker.count,
              limit: breaker.limit,
            };
          return withEntityLock(
            db,
            `proactive-limit:${params.conversationDbId}`,
            async () => {
              const windowStart = new Date(
                now.getTime() - PROACTIVE_LIMIT_WINDOW_MS,
              );
              const count =
                params.limit > 0
                  ? await db.agentTurnDelivery.count({
                      where: {
                        conversationId: params.conversationDbId,
                        proactive: true,
                        deliveredAt: { gt: windowStart },
                      },
                    })
                  : 0;
              if (
                params.limit <= 0 ||
                !proactiveLimitReached(count, params.limit)
              ) {
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
              return {
                over: true as const,
                reason: "conversation" as const,
                count,
                limit: params.limit,
              };
            },
          );
        }),
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

// Gives back an alert window claimed by a refusal that then stood down, so the next real refusal still
// pages. CAS'd on the instant the claim wrote; null reads the same as an alert a day old.
export async function releaseProactiveAlert(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  claimedAt: Date;
  base?: PrismaClient;
}): Promise<void> {
  try {
    await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      (db) =>
        db.conversation.updateMany({
          where: {
            id: params.conversationDbId,
            proactiveLimitAlertedAt: params.claimedAt,
          },
          data: { proactiveLimitAlertedAt: null },
        }),
    );
  } catch (err) {
    logger.warn(
      { err, conversationDbId: String(params.conversationDbId) },
      "proactive limit: could not release an alert window",
    );
  }
}

// The account breaker's line. The send that tripped it writes `error`, which the alert channels
// deliver with a link to the card where an admin resumes; every refusal while it stays tripped is
// `info`, so the Logs say why each message did not go without paging anyone again.
export function emitProactiveBreakerRefusal(
  flow: FlowContext,
  p: {
    trippedNow: boolean;
    trippedAt: Date;
    count: number;
    limit: number;
    // What fired, as the operator recognizes it (proactiveSourceLabel).
    source: string;
    detail: Record<string, unknown>;
  },
): void {
  emitFlowEvent(flow, {
    stage: "proactive_breaker",
    level: p.trippedNow ? "error" : "info",
    status: p.trippedNow ? "error" : "skipped",
    detail: {
      outcome: "not_sent",
      limit: p.limit,
      count: p.count,
      trippedAt: p.trippedAt.toISOString(),
      ...p.detail,
    },
    errorMessage: p.trippedNow
      ? `Proactive messages paused for the whole account: ${p.count} proactive messages were delivered in the last 24 hours (limit ${p.limit}). No agent sends a proactive message until an admin resumes them in Components > Advanced, where the limit can also be raised or turned off. The ${p.source} message was not sent. Replies to customers are not affected.`
      : `Proactive messages are paused for the whole account since ${p.trippedAt.toISOString()} (${p.count} in 24 hours, limit ${p.limit}). The ${p.source} message was not sent. An admin resumes them in Components > Advanced.`,
  });
}

function refusalFlow(
  p: {
    tenantId: bigint;
    instanceId: bigint;
    chatwootConversationId: number;
    agentId: bigint;
  },
  row: { id: bigint; inboxId: bigint | null },
  base: PrismaClient,
): FlowContext {
  return {
    tenantId: p.tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    conversationId: row.id,
    agentId: p.agentId,
    inboxId: row.inboxId,
    threadId: `${p.tenantId}:${p.instanceId}:${p.chatwootConversationId}`,
    base,
  };
}

// A FIXED proactive send (no model turn): the redirect ladder's link and its goodbye. Counted and
// refused like a nudge, against the conversation it goes to. `send` runs only under the limit; a send
// that throws gives the reservation back and rethrows. A conversation with no mirror row sends
// without counting; a limit of 0 skips the conversation's check, never the account's breaker. `stillWanted` is the last await before the send or the refusal on
// every path that did I/O here, since that I/O is what the caller's own fences did not cover: a false
// answer gives back the reservation and the alert window and writes no line.
export async function sendWithinProactiveLimit(p: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  agentId: bigint;
  limit: number;
  // proactiveSourceLabel's input, and the `trigger` the line carries.
  source: string;
  base?: PrismaClient;
  stillWanted?: () => Promise<boolean>;
  send: () => Promise<void>;
}): Promise<"sent" | "over" | "stood-down"> {
  const base = p.base ?? basePrisma;
  const wanted = async () => !p.stillWanted || (await p.stillWanted());
  const row = await runScopedOn(base, sysCtx(p.tenantId), (db) =>
    db.conversation.findFirst({
      where: {
        chatwootInstanceId: p.instanceId,
        chatwootConversationId: p.chatwootConversationId,
      },
      select: { id: true, inboxId: true },
    }),
  ).catch(() => null);
  if (!row) {
    if (!(await wanted())) return "stood-down";
    await p.send();
    return "sent";
  }
  const verdict = await reserveProactiveSend({
    tenantId: p.tenantId,
    conversationDbId: row.id,
    limit: p.limit,
    base,
  });
  if (verdict.over && verdict.reason === "breaker") {
    const stillWanted = await wanted();
    if (verdict.trippedNow || stillWanted)
      emitProactiveBreakerRefusal(refusalFlow(p, row, base), {
        ...verdict,
        source: proactiveSourceLabel(p.source, null),
        detail: { trigger: p.source },
      });
    return stillWanted ? "over" : "stood-down";
  }
  if (verdict.over) {
    const claimedAt = new Date();
    const alert = await claimProactiveAlert({
      tenantId: p.tenantId,
      conversationDbId: row.id,
      base,
      now: claimedAt,
    });
    if (!(await wanted())) {
      if (alert)
        await releaseProactiveAlert({
          tenantId: p.tenantId,
          conversationDbId: row.id,
          claimedAt,
          base,
        });
      return "stood-down";
    }
    emitProactiveLimitRefusal(refusalFlow(p, row, base), {
      count: verdict.count,
      limit: verdict.limit,
      alert,
      source: proactiveSourceLabel(p.source, null),
      detail: { trigger: p.source },
    });
    return "over";
  }
  const release = async () => {
    if (verdict.reservationId !== null)
      await releaseProactiveReservation({
        tenantId: p.tenantId,
        reservationId: verdict.reservationId,
        base,
      });
  };
  if (!(await wanted())) {
    await release();
    return "stood-down";
  }
  try {
    await p.send();
  } catch (err) {
    await release();
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
