import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { mediaAnnotationFor } from "@/modules/chatwoot/annotations";
import {
  channelErrorCode,
  mediaFallbackDedupeKey,
  resendExpected,
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
import { foreignReplyBoundary } from "@/modules/debounce/watermark";

// Whether the bot's newest reply in a conversation reached the customer, asked before a follow-up
// nudges about it. The channel refuses a message AFTER Chatwoot accepted it, and the refusal stays on
// the message (`external_error`). The reply is every message carrying the newest one's reply key
// (balloons, a voice note and the text after it, their replacements): it arrived when each refused
// message of it has a replacement that was not refused. Otherwise it is about to be resent (the job
// of channel-failure.ts is still queued) or lost. Something public after the reply supersedes the
// question: a customer message not yet handled has a turn coming for it, and a handled one or a
// person's reply has already moved the conversation past the reply.
export type LastReplyDelivery =
  // `repliedAt` is when the reply's newest message was sent, a replacement included: a resend that
  // landed late is activity the inactivity delay counts from.
  | { state: "delivered"; repliedAt?: Date }
  | { state: "customer_spoke" }
  | { state: "resend_pending"; until: Date }
  | {
      state: "undelivered";
      messageId: number;
      code: string | null;
      // The newest message the read assessed, which pins the hand-over: the newest incoming one
      // read, or the reply's own first message when none was read.
      assessedThrough: number;
    };

// How long after the resend's own instant the follow-up asks again: the send and the webhook that
// mirrors it take a moment, and asking at the exact instant would find the job still claimed.
export const RESEND_SETTLE_MS = 60_000;

// How long after a refused message was sent the follow-up waits for its resend to be armed, when the
// refusal is on Chatwoot and the webhook that arms the resend has not arrived yet.
export const RESEND_ARM_GRACE_MS = 10 * 60_000;

// How far back the read looks for the agent's newest reply and where it starts. A conversation whose
// last reply sits past this many pages of notes and activity has moved on from it.
const MAX_PAGES = 5;

// The fork's catch-up read (by id), and how many of them the read past the reply's start takes.
const CATCH_UP_PAGE = 100;
const CATCH_UP_MAX_READS = 5;

export type Row = ReturnType<typeof parseChatwootMessages>[number];

function replaces(row: Row, messageId: number): boolean {
  return new RegExp(
    `(?:^|:)(?:channel-resend|media-fallback):${messageId}$`,
  ).test(row.sendId ?? "");
}

// Whether a refusal on this message would carry text to resend, from the sources `handleChannelFailure`
// reads: a voice note's reply or transcription (or the one this process kept when it sent it), and a
// text message's own content. A file is resent as nothing.
function resendTextKnown(
  tenantId: bigint,
  instanceId: bigint,
  m: Row,
): boolean {
  if (m.attachmentTypes.length === 0) return m.content.trim().length > 0;
  return !!(
    m.replyText?.trim() ||
    m.transcribedText?.trim() ||
    mediaAnnotationFor(tenantId, instanceId, m.id)?.transcribedText?.trim()
  );
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
  // The inbox's WhatsApp provider, which says whether a sender-less outgoing row can be a person on
  // the phone or only an echo of our own send.
  whatsappProvider: string | null;
  // The newest customer message already handled (answered or deliberately skipped): the mirror's
  // watermark. A customer message at or below it marks where a reply starts.
  handledThrough: number | null;
  // Which of the customer messages read are still owed a reply: the flush's own selection
  // (`selectOpenMessages`), so a message a gate dispensed is not read as a turn coming. `settled`
  // are those a turn claimed or a gate dispensed, the record that one was handled.
  stillOpen: (
    rows: Row[],
  ) => Promise<{ open: Set<number>; settled: Set<number> }>;
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
  // A reaction counts, as it does for the flush (`pendingIncoming`).
  const customer = (m: Row) =>
    m.messageType === "incoming" &&
    !m.private &&
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
    // The newest reply's key. Past that reply, paging goes on until a message of ours from another
    // reply ends it. Notes, activity and customer messages say nothing for sure: a handled one may
    // sit between two of its balloons, with the earlier one on an older page.
    const key = newest ? replyKeyOf(newest.sendId) : null;
    const found = newest;
    if (
      found &&
      (key === null ||
        read.some(
          (m) => m.id < found.id && ours(m) && replyKeyOf(m.sendId) !== key,
        ))
    ) {
      bounded = true;
      break;
    }
    before = oldest.id;
  }
  if (newest === null) return { state: "delivered" };
  const key = replyKeyOf(newest.sendId);
  const replyOf = (rows: Row[], head: Row) =>
    rows.filter(
      (m) =>
        ours(m) &&
        (m.id === head.id || (key !== null && replyKeyOf(m.sendId) === key)),
    );
  const start = replyOf(read, newest).reduce(
    (a, m) => (m.id < a ? m.id : a),
    newest.id,
  );
  // NOTE: with the pages run out, a customer message already handled says enough: before the reply
  // it is where the reply starts, and inside it it supersedes the reply (below). Without one, the
  // reply's earlier messages are unread, and an unread one may be the refused one.
  if (
    !bounded &&
    !read.some(
      (m) =>
        customer(m) &&
        params.handledThrough !== null &&
        m.id <= params.handledThrough,
    )
  )
    throw new Error("follow-up: the reply's start is past the pages read");
  // The fork's pages carry only the reactions to their own messages, so a reaction to an older one is
  // missing from them: the catch-up read brings it, as for the flush (`readBurstPage`). It starts at
  // the newest handled message when that is older than the reply, since the reply may answer a
  // reaction the pages left out.
  let cursor =
    Math.min(start, params.handledThrough ?? Number.MAX_SAFE_INTEGER) - 1;
  for (let n = 0; ; n++) {
    const raw = await client.getMessages(params.chatwootConversationId, {
      after: cursor,
    });
    const rows = parseChatwootMessages(raw);
    if (chatwootMessageListLength(raw) !== rows.length)
      throw new Error("follow-up: the catch-up read did not read");
    // NOTE: the later copy wins: a refusal written between the two reads is on it.
    for (const m of rows) {
      const at = read.findIndex((r) => r.id === m.id);
      if (at === -1) read.push(m);
      else read[at] = m;
    }
    if (rows.length < CATCH_UP_PAGE) break;
    if (n + 1 >= CATCH_UP_MAX_READS)
      throw new Error("follow-up: the history after the reply did not read");
    cursor = Math.max(...rows.map((m) => m.id));
  }
  // The reply judged on the merged history: a replacement that landed between the reads joins it,
  // and a newer reply of ours means the conversation moved while it was read, so it is read again.
  const head = read
    .filter(ours)
    .reduce((a, m) => (m.id > a.id ? m : a), newest);
  if (
    head.id !== newest.id &&
    (key === null || replyKeyOf(head.sendId) !== key)
  )
    throw new Error(
      "follow-up: the agent replied again while the reply was read",
    );
  const reply = replyOf(read, newest);
  const { open, settled } = await params.stillOpen(read);
  // NOTE: any the read holds, before the reply too: one that arrived after the turn's last look and
  // before its reply was written is still queued for its own turn.
  if (read.some((m) => customer(m) && open.has(m.id)))
    return { state: "customer_spoke" };
  // A person's public reply or template that was not refused, written after a refused message,
  // moved the conversation past it. Attributed the way the flush attributes it
  // (`foreignReplyBoundary`): a sender-less row counts only where the provider tells a phone apart
  // from an echo of our own send.
  const identity = {
    managedBotId: params.agentBotIds[0] ?? null,
    whatsappProvider: params.whatsappProvider,
  };
  const person = (m: Row) =>
    !m.externalError && !ours(m) && foreignReplyBoundary([m], identity) > 0;
  // A customer message from where the reply starts that was handled, in silence or by a gate, moved
  // the conversation past the reply. Handled is on record (the watermark, a claim, a dispensal): an
  // answer somebody else wrote is the person's reply below, and a refused one closes nothing.
  if (
    read.some(
      (m) =>
        m.id > start &&
        customer(m) &&
        ((params.handledThrough !== null && m.id <= params.handledThrough) ||
          settled.has(m.id)),
    )
  )
    return { state: "delivered" };
  const missing = reply.filter(
    (m) =>
      m.externalError &&
      !reply.some((r) => !r.externalError && replaces(r, m.id)) &&
      !read.some((p) => p.id > m.id && person(p)),
  );
  if (missing.length === 0) {
    const sent = reply
      .map((m) => m.createdAt?.getTime() ?? 0)
      .reduce((a, t) => (t > a ? t : a), 0);
    return sent > 0
      ? { state: "delivered", repliedAt: new Date(sent) }
      : { state: "delivered" };
  }
  const jobs = await runScopedOn(params.base, sysCtx(params.tenantId), (db) =>
    db.schedulerJob.findMany({
      where: {
        kind: "MEDIA_TEXT_FALLBACK",
        dedupeKey: {
          in: missing.map((m) =>
            mediaFallbackDedupeKey(params.instanceId, m.id),
          ),
        },
      },
      select: { runAt: true, status: true, dedupeKey: true },
    }),
  );
  const now = params.now ?? new Date();
  const queued = jobs.filter(
    (j) => j.status === "PENDING" || j.status === "CLAIMED",
  );
  if (queued.length > 0) {
    const latest = queued.reduce((a, j) => (j.runAt > a ? j.runAt : a), now);
    return {
      state: "resend_pending",
      until: new Date(latest.getTime() + RESEND_SETTLE_MS),
    };
  }
  // No job at all is not a resend that ran: the webhook that arms it may still be on its way.
  // A refusal that gets one waits a bounded while for it, measured from when the message was sent.
  const armed = new Set(jobs.map((j) => j.dedupeKey));
  const awaited = missing
    .filter(
      (m) =>
        !armed.has(mediaFallbackDedupeKey(params.instanceId, m.id)) &&
        !!m.externalError &&
        resendExpected(
          m.externalError,
          m.sendId ?? null,
          resendTextKnown(params.tenantId, params.instanceId, m),
        ) &&
        m.createdAt != null &&
        now.getTime() < m.createdAt.getTime() + RESEND_ARM_GRACE_MS,
    )
    .map((m) => (m.createdAt as Date).getTime() + RESEND_ARM_GRACE_MS);
  if (awaited.length > 0)
    return { state: "resend_pending", until: new Date(Math.max(...awaited)) };
  const lost = missing.reduce((a, m) => (m.id > a.id ? m : a));
  // The newest incoming message read, not only the one answered: any after the reply was
  // already assessed above (a blank one, a reaction no turn runs for), and the hand-over's fence
  // compares against the mirror's newest inbound, which counts them.
  // Without one, the reply's start: a page behind the mirror says nothing about what came after.
  const assessed = read
    .filter((m) => m.messageType === "incoming" && !m.private)
    .reduce<number>((a, m) => (m.id > a ? m.id : a), 0);
  return {
    state: "undelivered",
    messageId: lost.id,
    code: lost.externalError ? channelErrorCode(lost.externalError) : null,
    assessedThrough: assessed > 0 ? assessed : start,
  };
}
