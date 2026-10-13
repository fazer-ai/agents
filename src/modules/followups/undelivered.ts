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
  hasAnswerableContent,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";

// Whether the bot's newest reply in a conversation reached the customer, asked before a follow-up
// nudges about it. The channel refuses a message AFTER Chatwoot accepted it, and the refusal stays on
// the message (`external_error`). The reply is every message carrying the newest one's reply key
// (balloons, a voice note and the text after it, their replacements): it arrived when each refused
// message of it has a replacement that was not refused. Otherwise it is about to be resent (the job
// of channel-failure.ts is still queued) or lost. Something public after the reply supersedes the
// question: a customer message not yet handled has a turn coming for it, and a handled one or a
// person's reply has already moved the conversation past the reply.
export type LastReplyDelivery =
  | { state: "delivered" }
  | { state: "customer_spoke" }
  | { state: "resend_pending"; until: Date }
  | {
      state: "undelivered";
      messageId: number;
      code: string | null;
      // The customer message the reply was answering, when the pages read reach it.
      answeredId: number | null;
    };

// How long after the resend's own instant the follow-up asks again: the send and the webhook that
// mirrors it take a moment, and asking at the exact instant would find the job still claimed.
export const RESEND_SETTLE_MS = 60_000;

// How far back the read looks for the agent's newest reply and where it starts. A conversation whose
// last reply sits past this many pages of notes and activity has moved on from it.
const MAX_PAGES = 5;

export type Row = ReturnType<typeof parseChatwootMessages>[number];

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
  // The newest customer message already handled (answered or deliberately skipped): the mirror's
  // watermark. A customer message at or below it marks where a reply starts.
  handledThrough: number | null;
  // Which of the customer messages read are still owed a reply: the flush's own selection
  // (`selectOpenMessages`), so a message a gate dispensed is not read as a turn coming.
  stillOpen: (rows: Row[]) => Promise<Set<number>>;
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
    !m.imported &&
    m.senderType === "agent_bot" &&
    m.senderId !== null &&
    bots.has(m.senderId);
  const customer = (m: Row) =>
    m.messageType === "incoming" &&
    !m.private &&
    !m.isReaction &&
    !m.imported &&
    hasAnswerableContent(m);
  const read: Row[] = [];
  let newest: Row | null = null;
  let before: number | undefined;
  // Whether the read reached where the newest reply starts, or the start of the conversation.
  let bounded = false;
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
    if (oldest === null) {
      bounded = true;
      break;
    }
    // The newest reply's key. Past that reply, paging goes on until something older than it ends
    // it: a customer message already handled (the one it answered, or older), or a message of ours
    // from another reply. Notes, activity and a customer message written between its balloons say
    // nothing about where it starts.
    const key = newest ? replyKeyOf(newest.sendId) : null;
    const found = newest;
    if (
      found &&
      (key === null ||
        read.some(
          (m) =>
            m.id < found.id &&
            ((customer(m) &&
              params.handledThrough !== null &&
              m.id <= params.handledThrough) ||
              (ours(m) && replyKeyOf(m.sendId) !== key)),
        ))
    ) {
      bounded = true;
      break;
    }
    before = oldest.id;
  }
  if (newest === null) return { state: "delivered" };
  // NOTE: the newest reply was found and the pages ran out before where it starts: its earlier
  // messages are unread, and an unread one may be the refused one.
  if (!bounded)
    throw new Error("follow-up: the reply's start is past the pages read");
  const last = newest;
  const key = replyKeyOf(newest.sendId);
  const reply = read.filter(
    (m) =>
      ours(m) &&
      (m.id === newest.id || (key !== null && replyKeyOf(m.sendId) === key)),
  );
  const start = reply.reduce((a, m) => (m.id < a ? m.id : a), last.id);
  const open = await params.stillOpen(read);
  // NOTE: from where the reply starts, so one written between its balloons counts too.
  if (read.some((m) => m.id > start && customer(m) && open.has(m.id)))
    return { state: "customer_spoke" };
  if (
    read.some(
      (m) =>
        m.id > last.id &&
        !m.private &&
        (customer(m) ||
          ((m.messageType === "outgoing" || m.messageType === "template") &&
            !m.isReaction &&
            !m.imported &&
            !m.externalError &&
            !ours(m))),
    )
  )
    return { state: "delivered" };
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
    const latest = jobs.reduce((a, j) => (j.runAt > a ? j.runAt : a), now);
    return {
      state: "resend_pending",
      until: new Date(latest.getTime() + RESEND_SETTLE_MS),
    };
  }
  const lost = missing.reduce((a, m) => (m.id > a.id ? m : a));
  const answered = read
    .filter((m) => customer(m) && m.id < start)
    .reduce<number | null>((a, m) => (a === null || m.id > a ? m.id : a), null);
  return {
    state: "undelivered",
    messageId: lost.id,
    code: lost.externalError ? channelErrorCode(lost.externalError) : null,
    answeredId: answered,
  };
}
