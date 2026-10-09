import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import { isRepairableNudgeRefusal, nextNudgeRetry } from "@/graph/nudge-retry";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText } from "@/lib/text";
import {
  isOpenAt,
  nextOpenAt,
  parseSchedule,
} from "@/modules/business-hours/hours";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  type ChatwootMessageRow,
  chatwootMessageListLength,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  isSnoozedForAPerson,
  parseLiveConversation,
} from "@/modules/chatwoot/normalize";
import {
  type ClaimedJob,
  enqueueJobUnlessClaimed,
  jobRetired,
  jobRetiredStrict,
} from "@/modules/scheduler/service";
import type { JobContext, JobResult } from "@/modules/scheduler/worker";
import { closesWithoutModel, stepDelayMinutes } from "./settings";
import {
  pickSnoozedCadence,
  readSnoozedFollowUpConfig,
} from "./snoozed-settings";

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

const SNOOZED_DEDUPE_PREFIX = "snoozed-followup:";
// How many message pages the handler walks back looking for the person's message. The newest page is
// twenty messages; the ladder adds at most ten of its own, so three pages cover any ladder with room
// for the activity lines automations write. Past that, the anchor is too old to chase anyway.
const MAX_MESSAGE_PAGES = 3;
// Same backoffs as the bot's ladder, for the same reasons (see ./handlers.ts).
const IN_FLIGHT_FREE_BACKOFF_MS = 30_000;
const LIVE_UNAVAILABLE_BACKOFF_MS = 60_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function snoozedDedupeKey(threadId: string): string {
  return `${SNOOZED_DEDUPE_PREFIX}${threadId}`;
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

// How much of the person's message goes into the reminder's directive.
const ANCHOR_TEXT_MAX = 1500;

// ── the sweep's half ───────────────────────────────────────────────────────────────────────────────

// Called by the per-tenant FOLLOWUP_SWEEP pass with the agents whose snoozed ladder is ON. Nominates
// every conversation the mirror says is snoozed and held by a person, on an inbox one of those agents
// serves, that has no job in flight, or whose job is older than the conversation's last event (the
// person wrote again, the customer answered, the labels changed: the handler re-decides from scratch).
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
      db.$queryRaw<Array<{ thread_id: string }>>`
      SELECT c.thread_id
        FROM conversations c
        JOIN inboxes i ON i.id = c.inbox_id
        JOIN agents a ON a.id = i.agent_id
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
                -- after it is one no run has seen, even when that run completed later.
                j.status = 'CLAIMED'
                OR c.last_event_at IS NULL
                OR COALESCE(j.claimed_at, j.updated_at) >= c.last_event_at
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
      rearm: "same-work",
      payload: { threadId: t.thread_id },
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

export function findSnoozedAnchor(
  rows: readonly ChatwootMessageRow[],
): SnoozedAnchor | undefined {
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const newest = sorted.at(-1);
  if (!newest) return undefined;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const m = sorted[i];
    if (
      m &&
      m.messageType === "outgoing" &&
      !m.private &&
      m.senderType === "user" &&
      // Sent by the platform under an admin token (a cross-inbox case opening): a user row that no
      // person wrote.
      !m.platformSent &&
      m.createdAt
    ) {
      const after = sorted.slice(i + 1);
      return {
        messageId: m.id,
        at: m.createdAt,
        customerSpokeAfter: after.some(
          (r) => r.messageType === "incoming" && !r.private && !r.isReaction,
        ),
        newestMessageId: newest.id,
        text: clipText(m.content ?? "", ANCHOR_TEXT_MAX),
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
): boolean {
  return rows.some(
    (r) =>
      r.id > baselineId &&
      !r.private &&
      ((r.messageType === "incoming" && !r.isReaction) ||
        (r.messageType === "outgoing" &&
          r.senderType === "user" &&
          !r.platformSent)),
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
}): AgentNudge {
  return {
    source: "followup",
    kind: "snoozed",
    summary: `A person on the team asked the customer for something about ${params.idleMin} minutes ago and is waiting for the answer; the customer has not replied. Write ONE short reminder on that person's behalf, about what they asked, without asking for anything new and without promising anything the conversation does not already say.${params.anchorText.trim() ? ` What they wrote: «${params.anchorText.trim()}»` : ""}`,
    instructions: params.instructions || undefined,
    step: params.step,
    // One occasion per message of the person: a new message is a new ladder, and its refusals must
    // not share a window with the old one's.
    occasionId: `snoozed:${params.anchorMessageId}`,
  };
}

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
      },
    });
    if (!conv?.inboxId) return null;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true },
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
    return { conv, cfg, armedAt: agent.snoozedFollowUpArmedAt, hours };
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
        if (findSnoozedAnchor(rows)) break;
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
  // Unsnoozed, given to the bot, unassigned, resolved, or snoozed with an end date: not this ladder's.
  if (!live || !isSnoozedForAPerson(live)) return { outcome: "done" };
  const anchor = findSnoozedAnchor(rows);
  if (!anchor || anchor.customerSpokeAfter) return { outcome: "done" };
  // The backlog fence: a person's message older than the switch-on is not chased.
  if (anchor.at < ctx.armedAt) return { outcome: "done" };

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
  // a job retired while it ran does not move the ladder.
  const stampStep = async (): Promise<boolean> => {
    if (await jobRetired(job, base)) return false;
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversation.update({
        where: { id: ctx.conv.id },
        data: {
          snoozedFollowUpAnchorId: anchor.messageId,
          snoozedFollowUpStep: stepIndex + 1,
          snoozedFollowUpAt: new Date(),
        },
      }),
    );
    run?.commit();
    return true;
  };

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
    // The live probe answers "still snoozed by a person"; this answers "and nobody spoke since the
    // read above". Read at every boundary, strict or not: the send and the post-actions come after
    // the model's wait, when a person is likeliest to have answered. An unreadable answer is a no.
    stillWanted: async ({ strict }) => {
      if (await (strict ? jobRetiredStrict(job, base) : jobRetired(job, base)))
        return false;
      try {
        const since = readMessagePage(
          await client.getMessages(conversationId, {
            after: anchor.newestMessageId,
          }),
        );
        return !someoneSpokeAfter(since, anchor.newestMessageId);
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
  // ladder stops here, as the bot's does, and leaves the conversation to the person, unresolved.
  if (outcome === "noted-window") return { outcome: "done" };
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
    const retry = nextNudgeRetry(job.payload);
    if (!retry.retry) {
      logger.warn(
        "snoozedFollowUp: giving up on step %d after %d %s retries (thread=%s)",
        stepIndex,
        retry.attempt,
        outcome,
        threadId,
      );
      await stampStep();
      return { outcome: "done" };
    }
    return {
      outcome: "reschedule",
      runAt: retry.runAt,
      payload: { ...job.payload, nudgeRetries: retry.attempt },
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
