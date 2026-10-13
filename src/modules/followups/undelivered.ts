import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  channelErrorCode,
  mediaFallbackDedupeKey,
} from "@/modules/chatwoot/channel-failure";
import {
  type LoadChatwootClientDeps,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  chatwootMessageListLength,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";

// Whether the bot's newest reply in a conversation reached the customer, asked before a follow-up
// nudges about it. The channel refuses a reply AFTER Chatwoot accepted it, and the refusal stays on
// the message (`external_error`), so the latest page answers it: the newest public message one of
// the agent's bots sent is the reply the customer is supposed to be silent about. A refused one is
// either about to be resent (the job of channel-failure.ts is still queued) or lost.
export type LastReplyDelivery =
  | { state: "delivered" }
  | { state: "resend_pending"; until: Date }
  | { state: "undelivered"; messageId: number; code: string | null };

// How long after the resend's own instant the follow-up asks again: the send and the webhook that
// mirrors it take a moment, and asking at the exact instant would find the job still claimed.
export const RESEND_SETTLE_MS = 60_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export async function lastReplyDelivery(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  // The Chatwoot ids of the agent's own bots on this instance: another bot's message is not this
  // agent's reply.
  agentBotIds: number[];
  base: PrismaClient;
  deps?: LoadChatwootClientDeps;
  now?: Date;
}): Promise<LastReplyDelivery> {
  const client = await loadChatwootClient(params.tenantId, params.instanceId, {
    ...params.deps,
    base: params.base,
  });
  const raw = await client.getMessages(params.chatwootConversationId);
  const rows = parseChatwootMessages(raw);
  // NOTE: a page read incompletely cannot say the reply is fine: THROW, and the caller waits.
  if (chatwootMessageListLength(raw) !== rows.length)
    throw new Error("follow-up: the latest page did not read");
  const bots = new Set(params.agentBotIds);
  const newest = rows
    .filter(
      (m) =>
        m.messageType === "outgoing" &&
        !m.private &&
        !m.isReaction &&
        m.senderType === "agent_bot" &&
        m.senderId !== null &&
        bots.has(m.senderId),
    )
    .reduce<(typeof rows)[number] | null>(
      (a, m) => (a === null || m.id > a.id ? m : a),
      null,
    );
  if (!newest?.externalError) return { state: "delivered" };
  const job = await runScopedOn(params.base, sysCtx(params.tenantId), (db) =>
    db.schedulerJob.findFirst({
      where: {
        kind: "MEDIA_TEXT_FALLBACK",
        dedupeKey: mediaFallbackDedupeKey(params.instanceId, newest.id),
        status: { in: ["PENDING", "CLAIMED"] },
      },
      select: { runAt: true },
    }),
  );
  if (job) {
    const now = params.now ?? new Date();
    const at = job.runAt > now ? job.runAt : now;
    return {
      state: "resend_pending",
      until: new Date(at.getTime() + RESEND_SETTLE_MS),
    };
  }
  return {
    state: "undelivered",
    messageId: newest.id,
    code: channelErrorCode(newest.externalError),
  };
}
