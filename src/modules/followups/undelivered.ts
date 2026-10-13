import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  channelErrorCode,
  mediaFallbackDedupeKey,
} from "@/modules/chatwoot/channel-failure";
import { replyKeyOf } from "@/modules/chatwoot/constants";
import {
  type LoadChatwootClientDeps,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  chatwootMessageListLength,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";

// Whether the bot's newest reply in a conversation reached the customer, asked before a follow-up
// nudges about it. The channel refuses a message AFTER Chatwoot accepted it, and the refusal stays on
// the message (`external_error`). The reply is every message carrying the newest one's reply key
// (balloons, a voice note and the text after it, their replacements): it arrived when each refused
// message of it has a replacement that was not refused. Otherwise it is about to be resent (the job
// of channel-failure.ts is still queued) or lost.
export type LastReplyDelivery =
  | { state: "delivered" }
  | { state: "resend_pending"; until: Date }
  | { state: "undelivered"; messageId: number; code: string | null };

// How long after the resend's own instant the follow-up asks again: the send and the webhook that
// mirrors it take a moment, and asking at the exact instant would find the job still claimed.
export const RESEND_SETTLE_MS = 60_000;

// How far back the read looks for the agent's newest reply. A conversation whose last reply sits
// past this many pages of notes and activity has moved on from it.
const MAX_PAGES = 5;

type Row = ReturnType<typeof parseChatwootMessages>[number];

function replaces(row: Row, messageId: number): boolean {
  return new RegExp(
    `(?:^|:)(?:channel-resend|media-fallback):${messageId}$`,
  ).test(row.sendId ?? "");
}

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
  const bots = new Set(params.agentBotIds);
  const ours = (m: Row) =>
    m.messageType === "outgoing" &&
    !m.private &&
    !m.isReaction &&
    m.senderType === "agent_bot" &&
    m.senderId !== null &&
    bots.has(m.senderId);
  const read: Row[] = [];
  let newest: Row | null = null;
  let before: number | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const raw = await client.getMessages(
      params.chatwootConversationId,
      before === undefined ? undefined : { before },
    );
    const rows = parseChatwootMessages(raw);
    // NOTE: a page read incompletely cannot say the reply is fine: THROW, and the caller waits.
    if (chatwootMessageListLength(raw) !== rows.length)
      throw new Error("follow-up: a page of the conversation did not read");
    read.push(...rows);
    newest ??= rows
      .filter(ours)
      .reduce<Row | null>((a, m) => (a === null || m.id > a.id ? m : a), null);
    const oldest = rows.reduce<Row | null>(
      (a, m) => (a === null || m.id < a.id ? m : a),
      null,
    );
    if (oldest === null) break;
    // The newest reply's key: past that reply, one more page is read only while the reply may
    // start on it.
    const key = newest ? replyKeyOf(newest.sendId) : null;
    if (newest && (key === null || replyKeyOf(oldest.sendId) !== key)) break;
    before = oldest.id;
  }
  if (newest === null) return { state: "delivered" };
  const key = replyKeyOf(newest.sendId);
  const reply = read.filter(
    (m) =>
      ours(m) &&
      (m.id === newest.id || (key !== null && replyKeyOf(m.sendId) === key)),
  );
  const missing = reply.filter(
    (m) =>
      m.externalError &&
      !reply.some((r) => !r.externalError && replaces(r, m.id)),
  );
  if (missing.length === 0) return { state: "delivered" };
  const jobs = await runScopedOn(params.base, sysCtx(params.tenantId), (db) =>
    db.schedulerJob.findMany({
      where: {
        kind: "MEDIA_TEXT_FALLBACK",
        dedupeKey: {
          in: missing.map((m) =>
            mediaFallbackDedupeKey(params.instanceId, m.id),
          ),
        },
        status: { in: ["PENDING", "CLAIMED"] },
      },
      select: { runAt: true },
    }),
  );
  if (jobs.length > 0) {
    const now = params.now ?? new Date();
    const last = jobs.reduce((a, j) => (j.runAt > a ? j.runAt : a), now);
    return {
      state: "resend_pending",
      until: new Date(last.getTime() + RESEND_SETTLE_MS),
    };
  }
  const lost = missing.reduce((a, m) => (m.id > a.id ? m : a));
  return {
    state: "undelivered",
    messageId: lost.id,
    code: lost.externalError ? channelErrorCode(lost.externalError) : null,
  };
}
