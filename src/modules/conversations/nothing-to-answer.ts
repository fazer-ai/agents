import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { resetLandedAfter } from "@/graph/reset-episode";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { isMonitoring } from "@/modules/agents/mode";
import { isTestSilenced } from "@/modules/agents/test-mode";
import { episodeTestActivatedAt } from "@/modules/channel-redirect/episode";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import {
  type LoadChatwootClientDeps,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  type ChatwootMessageRow,
  chatwootMessageListLength,
  hasAnswerableContent,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  parseLiveConversation,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { recordResolutionOrigin } from "@/modules/conversations/record-resolution";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { ourSideHasSpoken } from "@/modules/followups/eligibility";
import { type ClaimedJob, upsertJobRow } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";

// A CONVERSATION WHOSE CUSTOMER SAID NOTHING, AND THAT NOBODY ON OUR SIDE EVER ANSWERED (issue #895).
//
// A message with no text, no attachment, no email subject and no image in the body is never selected
// for a turn (`hasAnswerableContent`), so no model runs and nothing is sent. That is right. What was
// wrong is what it left behind: the conversation stayed `pending` and bot-owned, and on a NEW
// conversation nothing ever moved it again. The follow-up only arms where our side has spoken, and
// here it never did. Measured on an email inbox: blank emails sat in the pending queue for days, with
// no log line for the agent at all.
//
// WHY A JOB, AND NOT A CLOSE IN THE FLUSH. The first version closed inside the flush and the direct
// turn, and every review round found another race on that hot path: a request older than the page,
// an attachment that lands a second later, an operator taking over mid-read, a /reset, a reply of
// ours in flight. Each needed its own fence at the write. Here the flush and the direct path only
// ARM one job per thread, and the job decides later, once, with every fence in one place:
//
//   - the delay absorbs content that arrives after the message (measured on two email inboxes over
//     14 days: attachments land within 0.4 s of a blank message, and within 813 s of any message at
//     the worst); `NOTHING_TO_ANSWER_DELAY_MS` sits well past that;
//   - a new incoming message retires the job (the receiver, beside the follow-up's retirement), and
//     a /reset is one, so a conversation that moved on is never judged by a stale arm;
//   - when it runs it reads everything fresh: the agent still speaks; the mirror says our side never
//     spoke and no /reset landed after the judged message; the WHOLE history (the catch-up read from
//     the first id, not the default page of twenty, which would hide an older unanswered request)
//     read in full, with no reply of ours, at least one incoming message and none answerable or a
//     reaction; and, last of the network reads, Chatwoot still has it `pending` with our bot or
//     nobody holding it. The agent's switch and the job's own retirement are asked again right
//     before the write. What is left is the one round trip of the write itself, half an hour after a
//     message that said nothing: accepted, where the flush version had the whole read in between.
//
// Recorded as `nothing_to_answer`, which the dashboard counts as a close by the agent's side (no
// model judged anything), with an `info` line: this is not a failure. A job that throws is retried by
// the scheduler and, past its attempts, dead-letters, which is the alert.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// A customer-facing message from our side: a reply, a nudge or a template. A private note is not.
function weSpoke(m: { messageType: string; private: boolean }): boolean {
  return (
    (m.messageType === "outgoing" || m.messageType === "template") && !m.private
  );
}

// A read this helper may judge by: a list, every row of it readable. A body that is not a list, or a
// row the parser dropped, is a read that could not tell, and "could not tell" must not become "the
// customer said nothing" (`chatwootMessageListLength`).
function readWhole(raw: unknown): ChatwootMessageRow[] | null {
  const rows = parseChatwootMessages(raw);
  return chatwootMessageListLength(raw) === rows.length ? rows : null;
}

// The history, judged: read whole, short enough for one batch, no customer-facing message from our
// side (the mirror row is a snapshot from before this read, and a nudge sent meanwhile is on it), at
// least one non-private incoming message, none of them answerable or a reaction, and none NEWER than
// the message the job was armed for. A newer one is still inside its own delay (its attachment may be
// on the way) and its own flush judges it; the receiver retires this job when it sees it, and this is
// the same rule for the stretch before it does. Returns the highest id it read, which the live read
// is checked against; null when there is something to answer or the read could not tell.
function nothingToAnswerIn(
  raw: unknown,
  triggerMessageId: number | null,
): number | null {
  const messages = readWhole(raw);
  if (messages === null || messages.length >= HISTORY_BATCH) return null;
  if (messages.some(weSpoke)) return null;
  const incoming = messages.filter(
    (m) => m.messageType === "incoming" && !m.private,
  );
  if (incoming.length === 0) return null;
  if (
    triggerMessageId !== null &&
    incoming.some((m) => m.id > triggerMessageId)
  )
    return null;
  if (incoming.some((m) => m.isReaction || hasAnswerableContent(m)))
    return null;
  return Math.max(...messages.map((m) => m.id));
}

// The fork's `MessageFinder::CATCH_UP_LIMIT`: a batch this full may have more behind it.
const HISTORY_BATCH = 100;

// Well past the worst measured delay of content after its message (813 s, above). A blank email
// staying in the queue half an hour costs nothing; closing over a voice note that was still arriving
// would bury it.
export const NOTHING_TO_ANSWER_DELAY_MS = 30 * 60_000;

export function nothingToAnswerDedupeKey(threadId: string): string {
  return `nothing-to-answer:${threadId}`;
}

// Called off by the receiver when a NEWER incoming message arrives (issue #895): the conversation
// moved on, and a later blank message arms it again from its own flush. Newer than the message the
// job judged, not merely delivered: an observer route receives the same event on its own delivery,
// and a redelivery repeats it, and neither may cancel the judgement of the message it carries. A
// message with no id retires unconditionally, the safe side.
//
// A row still waiting is deleted, since nothing will ever read it. A row a worker already claimed is
// tombstoned instead, as `retireJobsByDedupeKey` does, so the running handler sees `jobRetired` before
// it writes; that one stays as a DONE row, at most one per conversation, and the next arm reuses it.
export async function retireNothingToAnswer(params: {
  tenantId: bigint;
  threadId: string;
  messageId: number | null;
  base: PrismaClient;
}): Promise<void> {
  const key = nothingToAnswerDedupeKey(params.threadId);
  const older =
    params.messageId === null
      ? Prisma.sql`TRUE`
      : Prisma.sql`NOT (
          jsonb_typeof(payload->'triggerMessageId') = 'number'
          AND (payload->>'triggerMessageId')::bigint >= ${params.messageId}
        )`;
  const stamp = JSON.stringify({ cancelledAt: new Date().toISOString() });
  await runScopedOn(params.base, sysCtx(params.tenantId), async (db) => {
    await db.$executeRaw`
      DELETE FROM scheduler_jobs
       WHERE tenant_id = ${params.tenantId}
         AND kind = 'NOTHING_TO_ANSWER'::"SchedulerJobKind"
         AND dedupe_key = ${key}
         AND status = 'PENDING'
         AND ${older}`;
    await db.$executeRaw`
      UPDATE scheduler_jobs
         SET status = 'DONE',
             payload = payload || ${stamp}::jsonb,
             claim_seq = claim_seq + 1,
             updated_at = now()
       WHERE tenant_id = ${params.tenantId}
         AND kind = 'NOTHING_TO_ANSWER'::"SchedulerJobKind"
         AND dedupe_key = ${key}
         AND status = 'CLAIMED'
         AND ${older}`;
  });
}

// Armed by whoever found nothing to answer (the flush, the direct path). Best-effort: a failure to
// arm leaves the conversation where it was before this existed, and says so on stdout.
export async function armNothingToAnswer(params: {
  tenantId: bigint;
  instanceId: bigint;
  threadId: string;
  conversationId: number;
  conversationDbId: bigint;
  agentId: bigint;
  agentBotId: number | null;
  // The message judged empty: what a later /reset is ordered against.
  triggerMessageId: number | null;
  base?: PrismaClient;
  now?: Date;
}): Promise<void> {
  const dedupeKey = nothingToAnswerDedupeKey(params.threadId);
  const trigger = params.triggerMessageId;
  try {
    await runScopedOn(
      params.base ?? basePrisma,
      sysCtx(params.tenantId),
      async (db) => {
        // One arm at a time per thread, so the check below and the write are one step even when no
        // row exists yet to lock.
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dedupeKey}))`;
        // Monotonic: a live arm for a NEWER message stands. Deliveries on the direct path can finish
        // out of order, and letting the older one win would name a trigger the job then refuses to
        // judge (a newer incoming message is on the history), leaving the conversation with no arm.
        if (trigger !== null) {
          const live = await db.$queryRaw<Array<{ id: bigint }>>`
          SELECT id FROM scheduler_jobs
           WHERE tenant_id = ${params.tenantId}
             AND kind = 'NOTHING_TO_ANSWER'::"SchedulerJobKind"
             AND dedupe_key = ${dedupeKey}
             AND status IN ('PENDING', 'CLAIMED')
             AND NOT jsonb_exists(payload, 'cancelledAt')
             AND jsonb_typeof(payload->'triggerMessageId') = 'number'
             AND (payload->>'triggerMessageId')::bigint > ${trigger}`;
          if (live.length > 0) return;
        }
        await upsertJobRow(db, {
          tenantId: params.tenantId,
          kind: "NOTHING_TO_ANSWER",
          dedupeKey,
          // Every arm is a new judgement to make later: another blank message pushes it out again.
          rearm: "new-work",
          runAt: new Date(
            (params.now ?? new Date()).getTime() + NOTHING_TO_ANSWER_DELAY_MS,
          ),
          payload: {
            instanceId: String(params.instanceId),
            conversationId: params.conversationId,
            conversationDbId: String(params.conversationDbId),
            agentId: String(params.agentId),
            agentBotId: params.agentBotId,
            triggerMessageId: trigger,
          },
        });
      },
    );
  } catch (err) {
    logger.warn(
      "nothing to answer: could not arm the close (conv=%s): %s",
      String(params.conversationId),
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Whether this claim is still the job's, read strictly: a throw is a retry, never a close. Stricter
// than `jobRetiredStrict` in one way: a row that is GONE is retired too. The retirement deletes a
// waiting row, and a row can be waiting while an older run of it is still in flight (a re-arm puts a
// claimed row back to PENDING in place), so its absence is the only trace that run gets.
async function stillArmed(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<boolean> {
  const rows = await runScopedOn(
    base,
    sysCtx(job.tenantId),
    (db) =>
      db.$queryRaw<Array<{ claim_seq: number; cancelled: boolean }>>`
      SELECT claim_seq, jsonb_exists(payload, 'cancelledAt') AS cancelled
        FROM scheduler_jobs
       WHERE id = ${job.id} AND tenant_id = ${job.tenantId}`,
  );
  const row = rows[0];
  return row !== undefined && row.claim_seq === job.claimSeq && !row.cancelled;
}

// The database's half of the judgement, the same reads a follow-up makes before it speaks
// (../../graph/nudge.ts): the conversation is mirrored, our side never spoke in it and no /reset
// landed at or after the judged message; its inbox is still bound to the agent that armed the job;
// that agent is on, not monitoring, and not in a test mode this conversation never activated. Null
// when any of it fails; the row the close line needs otherwise.
async function stillOurs(p: {
  tenantId: bigint;
  instanceId: bigint;
  conversationDbId: bigint;
  agentId: bigint;
  triggerMessageId: number | null;
  base: PrismaClient;
}): Promise<{ inboxId: bigint | null; threadId: string | null } | null> {
  return runScopedOn(p.base, sysCtx(p.tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: { id: p.conversationDbId },
      select: {
        lastRepliedMessageId: true,
        chatwootFirstReplyAt: true,
        lastProactiveAt: true,
        resetAtMessageId: true,
        testActivatedAt: true,
        contactId: true,
        inboxId: true,
        threadId: true,
      },
    });
    if (!conv?.inboxId || ourSideHasSpoken(conv)) return null;
    if (resetLandedAfter(p.triggerMessageId, conv.resetAtMessageId))
      return null;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true, chatwootInboxId: true },
    });
    if (inbox?.agentId !== p.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: p.agentId },
      select: { enabled: true, mode: true, settings: true },
    });
    if (!agent?.enabled || isMonitoring(agent.mode)) return null;
    if (
      isTestSilenced(
        agent.mode,
        await episodeTestActivatedAt({
          tenantId: p.tenantId,
          instanceId: p.instanceId,
          cfg: readChannelRedirectConfig(agent.settings),
          agentMode: agent.mode,
          conv: {
            testActivatedAt: conv.testActivatedAt,
            contactId: conv.contactId,
            chatwootInboxId: inbox.chatwootInboxId,
          },
          base: p.base,
          scoped: db,
        }),
      )
    )
      return null;
    return { inboxId: conv.inboxId, threadId: conv.threadId };
  });
}

export async function nothingToAnswerHandler(
  job: ClaimedJob,
  base: PrismaClient,
  // Test seam, as the media fallback takes one; optional, so this stays assignable to `JobHandler`.
  makeClient?: LoadChatwootClientDeps["makeClient"],
): Promise<JobResult> {
  const p = job.payload as Record<string, unknown>;
  const instanceId =
    typeof p.instanceId === "string" ? parseDbId(p.instanceId) : null;
  const conversationDbId =
    typeof p.conversationDbId === "string"
      ? parseDbId(p.conversationDbId)
      : null;
  const agentId = typeof p.agentId === "string" ? parseDbId(p.agentId) : null;
  const conversationId =
    typeof p.conversationId === "number" ? p.conversationId : null;
  const agentBotId = typeof p.agentBotId === "number" ? p.agentBotId : null;
  const triggerMessageId =
    typeof p.triggerMessageId === "number" ? p.triggerMessageId : null;
  if (
    instanceId === null ||
    conversationDbId === null ||
    agentId === null ||
    conversationId === null
  )
    return { outcome: "done" };
  const tenantId = job.tenantId;

  // Asked before the network reads, so a conversation already out of scope costs no Chatwoot call,
  // and again after them, right before the write.
  const gate = () =>
    stillOurs({
      tenantId,
      instanceId,
      conversationDbId,
      agentId,
      triggerMessageId,
      base,
    });
  if ((await gate()) === null) return { outcome: "done" };

  const client = await loadChatwootClient(tenantId, instanceId, {
    base,
    makeClient,
  });
  const readUpTo = nothingToAnswerIn(
    await client.getMessages(conversationId, { after: 0 }),
    triggerMessageId,
  );
  if (readUpTo === null) return { outcome: "done" };
  // Ownership last among the network reads: an operator who took the conversation, or an escalation
  // that opened it, is never overruled.
  const live = parseLiveConversation(
    await client.getConversation(conversationId),
  );
  if (!live || !shouldBotHandle(live, { ourAgentBotId: agentBotId }))
    return { outcome: "done" };
  // A message that landed after the history read, before its webhook retired this job: the live
  // conversation already names it, and the judgement above never saw it.
  if (live.latestMessageId !== null && live.latestMessageId > readUpTo)
    return { outcome: "done" };
  // The database side again, after every network read and next to the write: a reply of ours, a
  // /reset, a rebinding or an agent switched off while Chatwoot was being asked; then the job's own
  // retirement, which a new incoming message sets.
  const row = await gate();
  if (row === null) return { outcome: "done" };
  // Strict, and a deleted row counts: a retirement this cannot read is a retry, never a licence to
  // close over a message that may have retired it.
  if (!(await stillArmed(job, base))) return { outcome: "done" };

  await client.toggleStatus(conversationId, "resolved", { asAdmin: true });
  await recordResolutionOrigin({
    tenantId,
    conversation: {
      chatwootInstanceId: instanceId,
      chatwootConversationId: conversationId,
    },
    origin: "nothing_to_answer",
    observed: { status: live.status, statusAt: live.updatedAt },
    base,
  });
  emitFlowEvent(
    {
      tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      conversationId: conversationDbId,
      agentId,
      inboxId: row.inboxId,
      threadId: row.threadId,
      base,
    },
    {
      stage: "route",
      level: "info",
      status: "ok",
      detail: { outcome: "resolved", reason: "nothingAnswerable" },
    },
  );
  return { outcome: "done" };
}

let registered = false;
export function registerNothingToAnswerJob(): void {
  if (registered) return;
  registered = true;
  // Wrapped, because the handler's third parameter is a test seam and not the JobContext.
  registerJobHandler("NOTHING_TO_ANSWER", (job, base) =>
    nothingToAnswerHandler(job, base),
  );
}

registerNothingToAnswerJob();
