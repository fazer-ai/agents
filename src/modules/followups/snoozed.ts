import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import { isRepairableNudgeRefusal, nextNudgeRetry } from "@/graph/nudge-retry";
import { resetLandedAfter } from "@/graph/reset-episode";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import {
  isOpenAt,
  nextOpenAt,
  parseSchedule,
} from "@/modules/business-hours/hours";
import { overlayMediaAnnotations } from "@/modules/chatwoot/annotations";
import { resetAckSendId } from "@/modules/chatwoot/constants";
import {
  instanceAgentBotChatwootIds,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  type ChatwootMessageRow,
  chatwootMessageListLength,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  isSnoozedForAPerson,
  parseLiveConversation,
  providerReservesEchoIds,
  SESSION_SENDER_NAME,
} from "@/modules/chatwoot/normalize";
import { renderAttendantMessage } from "@/modules/chatwoot/render";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";
import { fillMissingVisuals } from "@/modules/debounce/handler";
import { renderTranscript, transcriptFromRows } from "@/modules/observe/job";
import {
  type ClaimedJob,
  enqueueJobUnlessClaimed,
  jobNotRetiredSql,
  jobRetired,
  jobRetiredStrict,
} from "@/modules/scheduler/service";
import type { JobContext, JobResult } from "@/modules/scheduler/worker";
import { closesWithoutModel, stepDelayMinutes } from "./settings";
import {
  pickSnoozedCadence,
  readSnoozedFollowUpConfig,
  SNOOZED_DEDUPE_PREFIX,
  snoozedDedupeKey,
} from "./snoozed-settings";

export { snoozedDedupeKey } from "./snoozed-settings";

// THE SNOOZED LADDER. A person asked the customer for something and snoozed the
// conversation in Chatwoot "until next reply"; if the customer never answers, nothing happens and the
// snoozed list grows until the team stops trusting it. This ladder reminds the customer on the
// person's behalf, step by step, and can close the conversation on the last step.

// It runs beside the bot's ladder (./handlers.ts), never in it: that one chases a conversation the BOT
// holds, this one a conversation a PERSON holds, and the ownership question each asks rules the other
// out, so no conversation is in both.

// THE SOURCE OF TRUTH IS CHATWOOT, READ LIVE AT EVERY STEP. The mirror carries neither the snooze's
// end date nor the person's last message, so the sweep only nominates candidates from the mirror and
// the handler decides from a live read: the conversation (status, holder, end date, labels) and its
// newest messages (which message of the person the ladder chases, and whether the customer spoke
// after it). The conversation row keeps only where the ladder stands on that message.

// How many message pages the handler walks back looking for the person's message. The newest page is
// twenty messages; the ladder adds at most ten of its own, so three pages cover any ladder with room
// for the activity lines automations write. Past that, the anchor is too old to chase anyway.
const MAX_MESSAGE_PAGES = 3;
// How many messages of the conversation the reminder reads, the newest ones: the agent's memory of a
// conversation a person has been running is not a record of it (compaction folds it, a colleague's
// reply can fail to be remembered, a test-mode agent keeps only its own turns), so the reminder is
// written from the conversation itself, rendered as the observer renders it.
const SNOOZED_WINDOW_MESSAGES = 20;
// Chatwoot's message page, reactions aside (the observer's paging reads it the same way).
const CHATWOOT_MESSAGES_PAGE = 20;
// Same backoffs as the bot's ladder, for the same reasons (see ./handlers.ts).
const IN_FLIGHT_FREE_BACKOFF_MS = 30_000;
const LIVE_UNAVAILABLE_BACKOFF_MS = 60_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// A message page read for a decision. `parseChatwootMessages` folds an empty page, a non-list body and
// unreadable rows into one empty array, and here empty means "nobody spoke": a degraded answer throws
// instead, so the caller treats it as a failed read and not as silence.
function readMessagePage(raw: unknown): ChatwootMessageRow[] {
  const rows = parseChatwootMessages(raw);
  if (chatwootMessageListLength(raw) !== rows.length) {
    throw new Error("snoozedFollowUp: degraded message page");
  }
  return rows;
}

// The fork's `MessageFinder::CATCH_UP_LIMIT`: a catch-up read this full may have more behind it.
const CATCH_UP_PAGE = 100;

// How much of the person's message goes into the reminder's directive.
const ANCHOR_TEXT_MAX = 1500;

// ── the sweep's half ───────────────────────────────────────────────────────────────────────────────

// Called by the per-tenant FOLLOWUP_SWEEP pass with the agents whose snoozed ladder is ON. Nominates
// every conversation the mirror says is snoozed and held by a person, on an inbox one of those agents
// serves, that has no job in flight, or whose job is older than the conversation's last event (the
// person wrote again, the customer answered, the labels changed, the snooze or the holder moved: the
// handler re-decides from scratch).
// The handler is what judges the end date, the anchor and the cadence, live.
export async function sweepSnoozedFollowUps(
  base: PrismaClient,
  tenantId: bigint,
  agentIds: bigint[],
): Promise<number> {
  if (agentIds.length === 0) return 0;
  const idsSql = Prisma.sql`ARRAY[${Prisma.join(agentIds)}]::bigint[]`;
  const threads = await runScopedOn(
    base,
    sysCtx(tenantId),
    (db) =>
      db.$queryRaw<
        Array<{ thread_id: string; finished: boolean; waiting: boolean }>
      >`
      SELECT c.thread_id,
             -- A row whose run finished (DONE or DEAD) spent its budget on what that run saw; what
             -- re-arms it now is an event after it, so the arm is new work with a fresh budget.
             EXISTS (
               SELECT 1
                 FROM scheduler_jobs jf
                WHERE jf.tenant_id = c.tenant_id
                  AND jf.kind = 'SNOOZED_FOLLOWUP'
                  AND jf.dedupe_key = ${SNOOZED_DEDUPE_PREFIX} || c.thread_id
                  AND jf.status IN ('DONE', 'DEAD')
             ) AS finished,
             -- A row still waiting to run (PENDING, or FAILED and backing off) carries state of the
             -- step it is on, the refusal budget among it: re-armed, it keeps its payload.
             EXISTS (
               SELECT 1
                 FROM scheduler_jobs jw
                WHERE jw.tenant_id = c.tenant_id
                  AND jw.kind = 'SNOOZED_FOLLOWUP'
                  AND jw.dedupe_key = ${SNOOZED_DEDUPE_PREFIX} || c.thread_id
                  AND jw.status IN ('PENDING', 'FAILED')
             ) AS waiting
        FROM conversations c
        JOIN inboxes i ON i.id = c.inbox_id
        JOIN agents a ON a.id = i.agent_id
        -- The schedule the handler reads (follow-up hours, else business hours), for its version.
        LEFT JOIN business_hours h
          ON h.id = COALESCE(a.follow_up_hours_id, a.business_hours_id)
       WHERE c.tenant_id = ${tenantId}
         AND c.status = 'snoozed'
         AND c.assignee_type = 'User'
         AND a.enabled = true
         AND a.id = ANY(${idsSql})
         -- The arms the bot's ladder has (./eligibility.ts): a monitoring agent never speaks, and a
         -- test agent speaks only in a conversation activated with /teste.
         AND a.mode <> 'monitoring'
         AND (a.mode <> 'test' OR c.test_activated_at IS NOT NULL)
         -- Never armed: the ladder was never switched on for this agent (fail-safe skip).
         AND a.snoozed_follow_up_armed_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1
             FROM scheduler_jobs j
            WHERE j.tenant_id = c.tenant_id
              AND j.kind = 'SNOOZED_FOLLOWUP'
              AND j.dedupe_key = ${SNOOZED_DEDUPE_PREFIX} || c.thread_id
              AND (
                -- A run in flight is left alone. Otherwise the watermark is the last run's START
                -- (its live read comes after the claim), or the arming for a row never run: an event
                -- after it is one no run has seen, even when that run completed later. What counts
                -- as an event: the last message; the last status or holder change, which
                -- last_event_at (Chatwoot last_activity_at) does not move with; an edit of the agent
                -- or of its schedule, and a new responder bound to the inbox, any of which can change
                -- the cadence, the due time or whether one applies at all. The epoch is read as UTC, the zone the stored columns are in.
                -- Chatwoot's two instants are whole seconds: an event stamped S may have happened up to
                -- S + 1s, so a run that started inside that second has not seen it.
                j.status = 'CLAIMED'
                OR COALESCE(j.claimed_at, j.updated_at) >= GREATEST(
                  c.last_event_at + interval '1 second',
                  to_timestamp(c.chatwoot_status_at + 1) AT TIME ZONE 'UTC',
                  a.updated_at,
                  h.updated_at,
                  i.responder_bound_at
                )
              )
         )
       LIMIT 500`,
  );
  for (const t of threads) {
    // Never over a CLAIMED row (its outcome would be discarded): the handler re-decides from Chatwoot
    // anyway, so arming for `now` only asks it to look again.
    await enqueueJobUnlessClaimed({
      tenantId,
      kind: "SNOOZED_FOLLOWUP",
      dedupeKey: snoozedDedupeKey(t.thread_id),
      runAt: new Date(),
      rearm: t.finished ? "new-work" : "same-work",
      // Absent = the row's own payload is kept (the handler resets what belongs to an older anchor).
      payload: t.waiting ? undefined : { threadId: t.thread_id },
      base,
    });
  }
  return threads.length;
}

// ── what the live read decides ─────────────────────────────────────────────────────────────────────

// The message the ladder chases: the newest PUBLIC message a PERSON sent. A private note is not
// something the customer saw, and the bot's own messages (this ladder's reminders included) are not
// the person asking. `undefined` = the pages read hold no such message.
export interface SnoozedAnchor {
  messageId: number;
  at: Date;
  // Whether the customer wrote after it. Chatwoot unsnoozes on an incoming message, so this is the
  // second line behind the status: a page read just after the customer wrote, before the status moved.
  customerSpokeAfter: boolean;
  // The newest message id the pages named, the baseline the send-time check compares against.
  newestMessageId: number;
  // What the person asked, from the live read: the agent's thread may not hold it (a test-mode agent
  // ingests only its own turns), and a reminder about something else is worse than none.
  text: string;
}

// A message a PERSON on the team wrote to the customer, by either route `foreignReplyBoundary` trusts:
// the Chatwoot composer (a `user` row the platform did not post under an admin token), or the phone
// paired to the inbox's number (a sender-less row marked as the session's, trusted only where the
// provider reserves echo ids). A WhatsApp template a person sent is theirs too (`template`, as there).
// A reaction is a nod, not a request, and an imported row is old history sorted under a new id.
function personWrote(
  r: ChatwootMessageRow,
  opts: { whatsappProvider: string | null },
): boolean {
  if (r.messageType !== "outgoing" && r.messageType !== "template")
    return false;
  if (r.private || r.isReaction || r.imported) return false;
  if (r.senderType === "user") return !r.platformSent;
  return (
    r.senderType === null &&
    r.externalSenderName === SESSION_SENDER_NAME &&
    providerReservesEchoIds(opts.whatsappProvider)
  );
}

function customerWrote(r: ChatwootMessageRow): boolean {
  return (
    r.messageType === "incoming" && !r.private && !r.isReaction && !r.imported
  );
}

// The rows the reminder's window may show: what the observer's transcript renders (it drops notes,
// reactions and activity lines itself), minus imported history, which is old words under new ids, and
// minus everything at or below the `/reset` boundary, an episode the operator withdrew, and minus the
// agent's own acknowledgement of that reset, which lands just above the boundary and narrates the
// wipe rather than the conversation (named by its send id, as the observer finds it).
function windowRows(
  rows: readonly ChatwootMessageRow[],
  resetAtMessageId: number | null,
): ChatwootMessageRow[] {
  // Sorted, since the pages arrive newest first and older ones are appended: the window is the
  // newest of these, taken from the end.
  return [...rows]
    .sort((a, b) => a.id - b.id)
    .filter(
      (r) =>
        !r.imported &&
        !r.private &&
        !r.isReaction &&
        (r.messageType === "incoming" ||
          r.messageType === "outgoing" ||
          r.messageType === "template") &&
        (resetAtMessageId === null ||
          (r.id > resetAtMessageId &&
            r.sendId !== resetAckSendId(resetAtMessageId))),
    );
}

// Whether the pages read cover the window: enough eligible rows, and every quote a window row makes
// already fetched, as the observer's `quotesResolved` asks, so a "sim" is not rendered without the
// question it answers while a page within the limit still holds it.
function windowCovered(
  rows: readonly ChatwootMessageRow[],
  resetAtMessageId: number | null,
): boolean {
  const eligible = windowRows(rows, resetAtMessageId);
  if (eligible.length < SNOOZED_WINDOW_MESSAGES) return false;
  const fetched = new Set(rows.map((r) => r.id));
  return eligible
    .slice(-SNOOZED_WINDOW_MESSAGES)
    .every((r) => r.inReplyTo === null || fetched.has(r.inReplyTo));
}

export function findSnoozedAnchor(
  rows: readonly ChatwootMessageRow[],
  // The inbox's WhatsApp provider, REQUIRED for the reason `isDeviceAttendantMessage` gives.
  opts: { whatsappProvider: string | null },
): SnoozedAnchor | undefined {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const newest = sorted.at(-1);
  if (!newest) return undefined;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    if (m && personWrote(m, opts) && m.createdAt) {
      return {
        messageId: m.id,
        at: m.createdAt,
        customerSpokeAfter: sorted.slice(i + 1).some(customerWrote),
        newestMessageId: newest.id,
        // Rendered as the agent's memory renders a person's reply: a voice note carries an empty
        // `content` and its words on the transcription, and a file with no caption is still named.
        text: clipText(
          renderAttendantMessage({
            text: m.content ?? "",
            attachmentTypes: m.attachmentTypes,
            transcribedText: m.transcribedText,
          }),
          ANCHOR_TEXT_MAX,
        ),
      };
    }
  }
  return undefined;
}

// Whether anything a PERSON or the CUSTOMER wrote arrived after the baseline: the question asked
// right before the reminder goes out, so a person who answered meanwhile is not followed by a reminder
// of what they just said. The bot's own messages and activity lines do not count.
export function someoneSpokeAfter(
  rows: readonly ChatwootMessageRow[],
  baselineId: number,
  opts: { whatsappProvider: string | null },
): boolean {
  return rows.some(
    (r) => r.id > baselineId && (customerWrote(r) || personWrote(r, opts)),
  );
}

// Which step is next and when it is due, from the anchor and from where the ladder stands on it.
// A different anchor than the stored one is a new message from the person: the ladder starts over.
// Step 0 counts from the person's message (not from the snooze, which can come later), every later
// step from when the previous one ran.
export function snoozedLadderPosition(params: {
  anchor: { messageId: number; at: Date };
  stored: {
    anchorId: number | null;
    step: number | null;
    at: Date | null;
  };
  delaysMin: number[];
}): { stepIndex: number; dueAt: Date } | { done: true } {
  const sameAnchor = params.stored.anchorId === params.anchor.messageId;
  const stepIndex = sameAnchor ? (params.stored.step ?? 0) : 0;
  if (stepIndex >= params.delaysMin.length) return { done: true };
  const from =
    stepIndex === 0 || !params.stored.at ? params.anchor.at : params.stored.at;
  const delay = params.delaysMin[stepIndex] ?? 0;
  return { stepIndex, dueAt: new Date(from.getTime() + delay * 60_000) };
}

export function snoozedNudge(params: {
  idleMin: number;
  instructions: string;
  step: number;
  anchorMessageId: number;
  anchorText: string;
  conversation: string;
}): AgentNudge {
  return {
    source: "followup",
    kind: "snoozed",
    // The directive itself is the framing's (renderNudge); the summary carries only the facts.
    framing: "snoozed_reminder",
    summary: `a person asked the customer ${params.idleMin} minutes ago; no reply yet`,
    // The person's message in the fenced text block, which keeps it whole: the summary is capped.
    text: params.anchorText.trim() || undefined,
    conversation: params.conversation.trim() || undefined,
    instructions: params.instructions || undefined,
    step: params.step,
    // One occasion per message of the person: a new message is a new ladder, and its refusals must
    // not share a window with the old one's.
    occasionId: `snoozed:${params.anchorMessageId}`,
  };
}

// The step stamped on a ladder ENDED on its anchor (no reminder could reach the customer), past any
// cadence: a stamp of the cadence's length would turn into an unfinished step the moment an operator
// adds one, and a resolve-only step would close a conversation nobody was reminded on. Only a new
// anchor clears it. The column's ceiling (int4).
export const SNOOZED_LADDER_ENDED = 2_147_483_647;

// ── the handler ────────────────────────────────────────────────────────────────────────────────────

export async function snoozedFollowUpHandler(
  job: ClaimedJob,
  base: PrismaClient,
  deps?: RuntimeDeps,
  run?: JobContext,
): Promise<JobResult> {
  const threadId =
    typeof job.payload.threadId === "string" ? job.payload.threadId : null;
  if (!threadId) return { outcome: "done" };
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return { outcome: "done" };
  const { instanceId, conversationId } = parsed;
  const tenantId = job.tenantId;

  const ctx = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: {
        id: true,
        inboxId: true,
        labels: true,
        testActivatedAt: true,
        snoozedFollowUpAnchorId: true,
        snoozedFollowUpStep: true,
        snoozedFollowUpAt: true,
        resetAtMessageId: true,
      },
    });
    if (!conv?.inboxId) return null;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true, provider: true },
    });
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: {
        enabled: true,
        mode: true,
        settings: true,
        businessHoursId: true,
        followUpHoursId: true,
        snoozedFollowUpArmedAt: true,
      },
    });
    if (!agent?.enabled) return null;
    if (agent.mode === "monitoring") return null;
    if (agent.mode === "test" && conv.testActivatedAt === null) return null;
    const cfg = readSnoozedFollowUpConfig(agent.settings);
    if (!cfg.enabled || agent.snoozedFollowUpArmedAt === null) return null;
    const hoursId = agent.followUpHoursId ?? agent.businessHoursId;
    const hours = hoursId
      ? await db.businessHours.findUnique({
          where: { id: hoursId },
          select: { windows: true, exceptions: true, timezone: true },
        })
      : null;
    return {
      conv,
      cfg,
      armedAt: agent.snoozedFollowUpArmedAt,
      hours,
      reply: { whatsappProvider: inbox.provider },
      agentId: inbox.agentId,
      settings: agent.settings,
    };
  });
  if (!ctx) return { outcome: "done" };

  // THE LIVE READ. Reads with the admin token: the bot token cannot list a conversation it does not
  // hold on every Chatwoot build, and a person holds this one.
  const client = await loadChatwootClient(tenantId, instanceId, {
    base,
    makeClient: deps?.makeClient,
  });
  let live: ReturnType<typeof parseLiveConversation> = null;
  let rows: ChatwootMessageRow[] = [];
  try {
    live = parseLiveConversation(await client.getConversation(conversationId));
    if (live && isSnoozedForAPerson(live)) {
      let before: number | undefined;
      for (let page = 0; page < MAX_MESSAGE_PAGES; page++) {
        const got = readMessagePage(
          await client.getMessages(
            conversationId,
            before === undefined ? undefined : { before },
          ),
        );
        if (got.length === 0) break;
        rows = rows.concat(got);
        // A page Chatwoot did not fill holds the conversation's first message: nothing older.
        if (got.filter((r) => !r.isReaction).length < CHATWOOT_MESSAGES_PAGE)
          break;
        if (
          findSnoozedAnchor(rows, ctx.reply) &&
          windowCovered(rows, ctx.conv.resetAtMessageId)
        )
          break;
        before = Math.min(...got.map((r) => r.id));
      }
    }
  } catch (err) {
    logger.warn(
      { err, conversationId: String(conversationId) },
      "snoozedFollowUp: live read failed; trying again later",
    );
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + LIVE_UNAVAILABLE_BACKOFF_MS),
    };
  }
  // A body the parser could not read, or a person's snooze whose end date the payload left out, is a
  // read that failed and not an answer: tried again, like a thrown one, and never taken as "not ours".
  const endDateMissing =
    live?.status === "snoozed" &&
    live.assigneeType === "User" &&
    live.snoozedUntil === undefined;
  if (!live || endDateMissing) {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + LIVE_UNAVAILABLE_BACKOFF_MS),
    };
  }
  // Unsnoozed, given to the bot, unassigned, resolved, or snoozed with an end date: not this ladder's.
  if (!isSnoozedForAPerson(live)) return { outcome: "done" };
  // An eager transcription or image description the fork could not write back lives only in this
  // process's annotation store; overlaid as the observer and the flush do, before anything is read.
  overlayMediaAnnotations(tenantId, instanceId, rows);
  const anchor = findSnoozedAnchor(rows, ctx.reply);
  if (!anchor || anchor.customerSpokeAfter) return { outcome: "done" };
  // The backlog fence: a person's message older than the switch-on is not chased. By the second:
  // Chatwoot's `created_at` is whole seconds, so a request later in the switch-on's own second reads
  // as that second's start.
  if (anchor.at.getTime() < Math.floor(ctx.armedAt.getTime() / 1000) * 1000)
    return { outcome: "done" };
  // The /reset fence: a message of the person at or below the command is work the operator withdrew,
  // whatever re-armed this job since. Ordered by Chatwoot's ids, as every withdrawal fence is.
  if (resetLandedAfter(anchor.messageId, ctx.conv.resetAtMessageId)) {
    return { outcome: "done" };
  }

  const cadence = pickSnoozedCadence(ctx.cfg, live.labels ?? ctx.conv.labels);
  if (!cadence) return { outcome: "done" };
  const position = snoozedLadderPosition({
    anchor,
    stored: {
      anchorId: ctx.conv.snoozedFollowUpAnchorId,
      step: ctx.conv.snoozedFollowUpStep,
      at: ctx.conv.snoozedFollowUpAt,
    },
    delaysMin: cadence.steps.map(stepDelayMinutes),
  });
  if ("done" in position) return { outcome: "done" };
  const { stepIndex, dueAt } = position;
  if (Date.now() < dueAt.getTime()) {
    return { outcome: "reschedule", runAt: dueAt };
  }

  // Business hours, as in the bot's ladder: never a reminder out of hours.
  if (ctx.hours) {
    const hours = parseSchedule(ctx.hours);
    const now = new Date();
    if (hours.windows.length > 0 && !isOpenAt(hours, now)) {
      const next = nextOpenAt(hours, now);
      if (next) return { outcome: "reschedule", runAt: next };
      return { outcome: "done" };
    }
  }

  const step = cadence.steps[stepIndex];
  if (!step) return { outcome: "done" };
  const isLast = stepIndex === cadence.steps.length - 1;

  // Records the step as spent on THIS anchor. Under the same retirement fence the bot's ladder uses:
  // a job retired while it ran does not move the ladder. `ended` spends the whole ladder instead.
  // ONE statement, as the bot's ladder stamps: /reset retires the job, and a separate read could find
  // it live and write after the retirement.
  const stampStep = async (ended = false): Promise<boolean> => {
    const step = ended ? SNOOZED_LADDER_ENDED : stepIndex + 1;
    const stamped = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.$executeRaw(Prisma.sql`
        UPDATE conversations
           SET snoozed_follow_up_anchor_id = ${anchor.messageId},
               snoozed_follow_up_step = ${step},
               -- In UTC, the zone every stored timestamp is in: a bare now() would store the
               -- session's wall time, and the ladder's next due time would move with it.
               snoozed_follow_up_at = now() AT TIME ZONE 'UTC'
         WHERE id = ${ctx.conv.id}
           AND ${jobNotRetiredSql(job)}`),
    );
    if (stamped > 0) run?.commit();
    return stamped > 0;
  };

  // The conversation the model reads, only for a step that reaches the model: a closing step with no
  // instructions labels and resolves without one, so it reads nothing and pays for nothing.
  let conversation = "";
  if (!closesWithoutModel(step, isLast)) {
    // Every eligible row fetched goes to the renderer, which keeps the newest ones and resolves a quote
    // against all of them (a "sim" keeps its question when the question is older than the window).
    const eligible = windowRows(rows, ctx.conv.resetAtMessageId);
    // Its images and documents nobody read yet are read first, as the re-engage reads them (`all`): a
    // person asked for this conversation, and the eager pass never runs on one a person holds. Never
    // under a contact authorization gate: this path does not ask it, so it opens nothing there.
    // Best-effort: what is left unread renders as unread. Voice notes are not transcribed here, as there.
    if (!readContactAuthConfig(ctx.settings).enabled) {
      await fillMissingVisuals({
        tenantId,
        instanceId,
        conversationId,
        settings: ctx.settings,
        messages: rows,
        pending: eligible
          .slice(-SNOOZED_WINDOW_MESSAGES)
          .filter((r) => r.messageType === "incoming"),
        fill: {
          mode: "all",
          signal: run?.signal,
          turnId: crypto.randomUUID(),
          convDbId: ctx.conv.id,
          agentId: ctx.agentId,
          inboxDbId: ctx.conv.inboxId,
          threadId,
        },
        base,
        deps,
      });
    }
    conversation = renderTranscript(
      transcriptFromRows(eligible, SNOOZED_WINDOW_MESSAGES, {
        ownBotIds: new Set(
          await instanceAgentBotChatwootIds(tenantId, instanceId, base),
        ),
        trustPhoneEcho: providerReservesEchoIds(ctx.reply.whatsappProvider),
      }),
    );
  }

  // A send-time message read that failed is not a withdrawal: the step is tried again, not dropped.
  let messageReadFailed = false;
  const outcome = await runAgentNudge({
    signal: run?.signal,
    tenantId,
    threadId,
    nudge: snoozedNudge({
      idleMin: Math.round((Date.now() - anchor.at.getTime()) / 60_000),
      instructions: step.instructions,
      step: stepIndex + 1,
      anchorMessageId: anchor.messageId,
      anchorText: anchor.text,
      conversation,
    }),
    postActions: {
      assignLabels:
        step.assignLabels && step.assignLabels.length > 0
          ? step.assignLabels
          : undefined,
      resolve: isLast && step.resolve === true,
    },
    postActionsOnly: closesWithoutModel(step, isLast),
    requireLiveBotOwnership: true,
    holder: "snoozed-human",
    signature: ctx.cfg.signature,
    // "Still snoozed by a person, and nobody spoke since the read above", at every boundary, strict
    // or not: the post-actions ask only this (the live probe runs before the model and the send),
    // and they come after the model's wait, when a person is likeliest to have acted.
    stillWanted: async ({ strict }) => {
      if (await (strict ? jobRetiredStrict(job, base) : jobRetired(job, base)))
        return false;
      try {
        // The conversation first: an operator who unsnoozed it, dated the snooze or took it over
        // while the model ran (or while the post-actions read the labels) has taken it back, and no
        // message marks that. Same reading as the handler's, so an unreadable body is a failed read.
        const now = parseLiveConversation(
          await client.getConversation(conversationId),
        );
        if (
          !now ||
          (now.status === "snoozed" && now.snoozedUntil === undefined)
        ) {
          messageReadFailed = true;
          return false;
        }
        if (!isSnoozedForAPerson(now)) return false;
        const since = readMessagePage(
          await client.getMessages(conversationId, {
            after: anchor.newestMessageId,
          }),
        );
        if (someoneSpokeAfter(since, anchor.newestMessageId, ctx.reply))
          return false;
        // A full catch-up read may have more behind it, a person's request among them: unproven
        // silence is a failed read, tried again from the top, never a reminder sent over it.
        if (since.length >= CATCH_UP_PAGE) {
          messageReadFailed = true;
          return false;
        }
        return true;
      } catch {
        messageReadFailed = true;
        return false;
      }
    },
    base,
    deps,
  });

  if (outcome === "stale") {
    if (!messageReadFailed) return { outcome: "done" };
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + LIVE_UNAVAILABLE_BACKOFF_MS),
    };
  }
  // No reminder reached the customer (the WhatsApp window closed and no template is configured): the
  // ladder ENDS on this message of the person, as the bot's does, and leaves the conversation to them,
  // unresolved. Recorded, because the note just written is itself an event the sweep would re-arm on,
  // and a re-armed run would write it again; spent whole, so no later closing step runs.
  if (outcome === "noted-window") {
    await stampStep(true);
    return { outcome: "done" };
  }
  if (outcome === "live-unavailable") {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + LIVE_UNAVAILABLE_BACKOFF_MS),
    };
  }
  if (outcome === "deferred") {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + IN_FLIGHT_FREE_BACKOFF_MS),
    };
  }
  if (isRepairableNudgeRefusal(outcome)) {
    // The budget belongs to one message of the person: a new one is a new ladder, and starts it fresh.
    const sameAnchor = job.payload.nudgeRetriesAnchorId === anchor.messageId;
    const retry = nextNudgeRetry(
      sameAnchor ? job.payload : { ...job.payload, nudgeRetries: 0 },
    );
    if (!retry.retry) {
      logger.warn(
        "snoozedFollowUp: giving up on step %d after %d %s retries (thread=%s)",
        stepIndex,
        retry.attempt,
        outcome,
        threadId,
      );
      // Ended, not spent: nothing reached the customer, and a step recorded as spent would let a
      // later closing step (re-armed by the very edit that repairs the credential) resolve a
      // conversation nobody was reminded on, as the window's end above.
      await stampStep(true);
      return { outcome: "done" };
    }
    return {
      outcome: "reschedule",
      runAt: retry.runAt,
      payload: {
        ...job.payload,
        nudgeRetries: retry.attempt,
        nudgeRetriesAnchorId: anchor.messageId,
      },
    };
  }
  if (outcome === "no-conversation" || outcome === "no-agent") {
    return { outcome: "done" };
  }

  // Sent, silent or noted: the step is spent on this anchor.
  if (!(await stampStep())) return { outcome: "done" };
  const next = cadence.steps[stepIndex + 1];
  if (!next) return { outcome: "done" };
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + stepDelayMinutes(next) * 60_000),
    payload: { threadId },
  };
}
