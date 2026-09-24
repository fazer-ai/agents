import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { isTurnInFlight } from "@/graph/inflight";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import { isRepairableNudgeRefusal, nextNudgeRetry } from "@/graph/nudge-retry";
import type { RuntimeDeps } from "@/graph/runtime";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { hasLiveAppointment } from "@/modules/appointments/reminders";
import {
  isOpenAt,
  NEXT_OPEN_SCAN_DAYS,
  nextOpenAt,
  parseSchedule,
} from "@/modules/business-hours/hours";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { appointmentPauseApplies } from "@/modules/followups/appointment-pause";
import {
  isFollowUpLive,
  ourSideHasSpoken,
} from "@/modules/followups/eligibility";
import {
  type ClaimedJob,
  enqueueJob,
  enqueueJobUnlessClaimed,
  jobNotRetiredSql,
  jobRetired,
  jobRetiredStrict,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  type FollowUpStep,
  isNewFollowUpEpisode,
  lastActivityAt,
  readFollowUpConfig,
  silenceStartedAt,
  stepDelayMinutes,
} from "./settings";

// Follow-up handlers for the scheduler. The SWEEP is coarse: it enqueues a FOLLOWUP per inactive,
// bot-handled conversation and re-arms itself. The FOLLOWUP is precise: it re-checks the gate
// (a human may have taken over), the per-agent inactivity threshold, and business hours
// (rescheduling to the next open window rather than messaging out of hours), then lets the agent
// DECIDE whether a proactive nudge is warranted (it may stay silent). Both run under the job's
// tenant scope.

const SWEEP_INTERVAL_MS = 60_000;
// Back-off when a turn for this conversation is executing right now: re-check shortly instead of
// nudging mid-turn. Anchored on lastEventAt, which the agent's own reply advances, so once the turn
// finishes the follow-up naturally measures inactivity from the reply.
const IN_FLIGHT_BACKOFF_MS = 30_000;
// Back-off when the conversation has a LIVE appointment (queued reminder OR one already fired with
// the start still ahead) and the agent pauses follow-ups during appointments: hold the sequence and
// re-check later rather than nudging or dying, so it resumes once the appointment passes / is
// cancelled. Coarse (1h) because the sweep already filters these out — this only catches a FOLLOWUP
// that was in flight before the booking.
const APPOINTMENT_BACKOFF_MS = 3_600_000;
// How long a follow-up the live gate declined waits before it is offered again (issue #796). The
// decline stamps nothing, so the sweep would select the conversation on its next pass; parked for
// this long instead, the pass leaves the row alone. An hour rather than never, because the mirror the
// sweep read may be the stale half and the live gate is the only thing that repairs it.
const LIVE_DECLINE_BACKOFF_MS = 3_600_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function sweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const tenantId = job.tenantId;

  // Compute the minimum follow-up delay across enabled agents of this tenant to use as the sweep
  // cutoff. If no agent has follow-up enabled there is nothing to do — reschedule cheaply.
  const agents = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.agent.findMany({
      where: { enabled: true },
      select: { id: true, settings: true },
    }),
  );
  const configs = agents.map((a) => ({
    id: a.id,
    cfg: readFollowUpConfig(a.settings),
  }));
  // The sweep only ever STARTS a sequence (step 0), so its cutoff is the minimum FIRST-step delay
  // across enabled agents. Later steps are scheduled precisely by the handler, not the sweep.
  const enabledDelays = configs
    .filter(({ cfg }) => cfg.enabled)
    .map(({ cfg }) => cfg.steps[0])
    .filter((s): s is FollowUpStep => s !== undefined)
    .map((s) => stepDelayMinutes(s));
  if (enabledDelays.length === 0) {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    };
  }
  const cutoffMin = Math.min(...enabledDelays);
  const sweptAt = Date.now();
  const cutoff = new Date(sweptAt - cutoffMin * 60_000);
  // NOTE: the instant the appointment fence is judged against, passed in rather than left to SQL's
  // now(). Every DateTime column in this schema is `timestamp` without a zone (Prisma's default,
  // storing UTC), so comparing one to `now()` would cast it through the SESSION TimeZone — correct
  // only while that happens to be UTC. Every other due clause in this repo passes the instant the
  // same way.
  const now = new Date(sweptAt);

  // Agents the appointment fence does not apply to, asked of `appointmentPauseApplies` — the same
  // function the handler and the console ask — about `cfg.steps[0]`, the only step this sweep ever
  // starts a sequence with.
  //
  // Asked HERE, in TypeScript, and not mirrored in the query. Two JSON predicates used to live in
  // the SQL, and three review rounds in a row found a way for them to disagree with the reader: raw
  // index 0 is not the reader's step 0 (non-object entries are dropped BEFORE numbering), `->>`
  // renders a JSON string and a JSON boolean identically while the reader does not, and an
  // unbounded `jsonb_array_elements` expands whatever the opaque REST settings write happened to
  // store, per conversation, every minute. All three are one defect: a second implementation of a
  // reader that already exists and had already RUN, right above, to compute the cutoff. What is
  // left in SQL is the liveness of the appointment, which is rows rather than settings.
  //
  // NOTE: read one tick before the query, so a settings change lands on the NEXT pass at worst
  // (60s). Nothing is sent on this read: the handler re-checks against fresh settings before the
  // nudge, which is where correctness lives.
  //
  // NOTE: `cfg.enabled` first, and it is not redundant. An agent whose follow-up is OFF can still
  // carry a step-0 exemption from when it was on, and `appointmentPauseApplies` would answer about
  // it — correctly, since it decides the pause and nothing else. The sweep now selects only agents
  // whose follow-up is on (below), so an exemption from an OFF agent would reach no row; the filter
  // stays so this list says what it means on its own.
  const unfencedAgentIds = configs
    .filter(
      ({ cfg }) => cfg.enabled && !appointmentPauseApplies(cfg, cfg.steps[0]),
    )
    .map(({ id }) => id);
  // NOTE: -1 stands in for the empty set. Prisma.join refuses an empty list, and an agent id is a
  // positive bigint, so the sentinel can never match a row — `<> ALL` then holds for everyone,
  // which is what "nobody is exempt" has to mean.
  const unfencedIdsSql = Prisma.sql`ARRAY[${Prisma.join(
    unfencedAgentIds.length > 0 ? unfencedAgentIds : [-1n],
  )}]::bigint[]`;
  // THE AGENTS WHOSE FOLLOW-UP IS ON, and only those are swept (issue #796). The SQL tests
  // `follow_up_armed_at`, which is stamped on the OFF→ON transition and never cleared going back, so
  // an agent switched off kept every one of its conversations in the selection: armed each minute,
  // claimed, and dropped by the handler's first look, forever, each holding a slot of the LIMIT 500.
  // Read from the same `cfg.enabled` that computes the cutoff above, so the two cannot disagree.
  // Never empty here: the early return above left when no agent has follow-up on.
  const followUpAgentIds = configs
    .filter(({ cfg }) => cfg.enabled)
    .map(({ id }) => id);
  const followUpIdsSql = Prisma.sql`ARRAY[${Prisma.join(followUpAgentIds)}]::bigint[]`;

  // NOTE: column-to-column comparison (lastInboundAt > lastFollowUpAt) requires raw SQL;
  // Prisma's query builder cannot express it. The filter mirrors the handler's watermark gate
  // so ineligible conversations are excluded before even enqueuing a FOLLOWUP job. The JOIN onto
  // the inbox's agent also drops conversations whose agent is in TEST mode but not yet activated
  // with /teste (isTestSilenced) — a silenced conversation must never get a proactive follow-up.
  const threads = await runScopedOn(
    base,
    sysCtx(tenantId),
    (db) =>
      db.$queryRaw<
        Array<{
          thread_id: string;
          agent_updated_at: Date;
          hours_updated_at: Date | null;
          other_episode: boolean;
          episode: string;
        }>
      >`
      SELECT c.thread_id,
             a.updated_at AS agent_updated_at,
             h.updated_at AS hours_updated_at,
             -- A row armed for another episode (or before episodes were written) spent its budget on
             -- that one, whether it ended DEAD or was retired by a reply with its attempts still
             -- counted, so the arm is new work, with a fresh budget. A DEAD row of THIS episode never
             -- gets here: the NOT EXISTS below keeps the conversation out.
             EXISTS (
               SELECT 1
                 FROM scheduler_jobs jd
                WHERE jd.tenant_id = c.tenant_id
                  AND jd.kind = 'FOLLOWUP'
                  AND jd.dedupe_key = 'followup:' || c.thread_id
                  AND jd.payload->>'episode' IS DISTINCT FROM
                        (floor(extract(epoch from GREATEST(c.last_inbound_at, c.last_replied_at)) * 1000))::bigint::text
             ) AS other_episode,
             -- The episode, as followUpEpisodeKey() writes it: the silence start in epoch ms.
             (floor(extract(epoch from GREATEST(c.last_inbound_at, c.last_replied_at)) * 1000))::bigint::text
               AS episode
      FROM conversations c
      JOIN inboxes i ON i.id = c.inbox_id
      JOIN agents a ON a.id = i.agent_id
      -- The schedule the handler reads (follow-up hours, else business hours), for the configuration
      -- version a deferral is compared against below.
      LEFT JOIN business_hours h
        ON h.id = COALESCE(a.follow_up_hours_id, a.business_hours_id)
      WHERE c.tenant_id = ${tenantId}
        AND c.status = 'pending'
        -- NOTE: Bot-owned = anything but a human, mirroring shouldBotHandle: NULL (unassigned — Chatwoot
        -- < 4.16.2, Dialogflow-style hooks) AND 'AgentBot' (the NORMAL state since Chatwoot 4.16.2
        -- auto-assigns the connected bot at conversation creation). IS DISTINCT FROM because
        -- NULL <> 'User' evaluates to NULL.
        AND c.assignee_type IS DISTINCT FROM 'User'
        -- A foreign bot's AgentBot is deliberately NOT filtered here: the mirror's assignee can be
        -- stale (a lost assignment webhook), and the nudge's live gate is what reads Chatwoot and
        -- repairs it. What keeps that from costing a job cycle every minute is the handler's own
        -- backoff on a live decline (LIVE_DECLINE_BACKOFF_MS) together with the re-arm below leaving
        -- a deferred row alone (issue #796).
        AND c.inbox_id IS NOT NULL
        AND a.enabled = true
        AND a.id = ANY(${followUpIdsSql})
        -- The same arms isFollowUpLive has (followups/eligibility.ts): a monitoring agent chases
        -- nobody, and excluding it HERE is what keeps its silent conversations from filling the
        -- batch the handler would only drop — LIMIT below is over eligible rows or it is nothing.
        AND a.mode <> 'monitoring'
        AND (a.mode <> 'test' OR c.test_activated_at IS NOT NULL)
        -- Inactivity counts OUR reply too (issue #750): last_event_at comes from Chatwoot and only
        -- advances when the webhook for the message we sent comes back, and the conversation
        -- recovered from the backlog carries an old one. Without the floor it is selected as idle for
        -- days at the very instant the customer receives the answer. Mirrors lastActivityAt() in TS.
        AND GREATEST(c.last_event_at, c.last_replied_at) < ${cutoff}
        -- WHEN THE CURRENT SILENCE BEGAN, and not "when the customer last spoke" (issue #750). The
        -- two disagree on exactly the conversation this sweep is for: a row the mirror created from
        -- an event that is not a message carries NO inbound instant, so the old form answered "no
        -- silence here" about a conversation whose silence had started minutes ago, with our own
        -- request for a document sitting in it. GREATEST ignores NULLs, and silenceStartedAt() is
        -- the same expression in TS, because the handler re-checks this and the console estimates
        -- from it: three readers of one question.
        AND GREATEST(c.last_inbound_at, c.last_replied_at) IS NOT NULL
        -- Mirrors ourSideHasSpoken (issue #652), whose header carries the measurement and why the OR
        -- is not redundancy. Asked here as well because this is the SELECTION: a conversation that
        -- can never be sent to must not hold a slot of the LIMIT below.
        AND (
          c.last_replied_message_id IS NOT NULL
          OR c.chatwoot_first_reply_at IS NOT NULL
          OR c.last_proactive_at IS NOT NULL
        )
        AND (
          c.last_follow_up_at IS NULL
          OR GREATEST(c.last_inbound_at, c.last_replied_at) > c.last_follow_up_at
        )
        -- A FOLLOW-UP THAT DIED IN THIS EPISODE is not offered again (issue #796, found by the
        -- verifier). A row goes DEAD when its handler threw MAX_ATTEMPTS times (a model that keeps
        -- failing), and the death stamps nothing on the conversation, so the next pass re-armed it
        -- and the handler ran, and called the model, once a minute without end. Dated by the row's
        -- updated_at against when the current silence began: a death in an EARLIER episode does not
        -- keep a new one out, and either side speaking again opens that new episode.
        --
        -- WHICH episode the row died in is read from the row (its payload's episode, written when it
        -- was armed), not from when it died: a claim of the previous episode can die after the new
        -- silence began, and it spent none of this episode's budget. A row armed before the episode
        -- was written falls back to the death time.
        AND NOT EXISTS (
          SELECT 1
            FROM scheduler_jobs j
           WHERE j.tenant_id = c.tenant_id
             AND j.kind = 'FOLLOWUP'
             AND j.dedupe_key = 'followup:' || c.thread_id
             AND j.status = 'DEAD'
             AND CASE
                   WHEN j.payload->>'episode' IS NOT NULL THEN
                     j.payload->>'episode'
                       = (floor(extract(epoch from GREATEST(c.last_inbound_at, c.last_replied_at)) * 1000))::bigint::text
                   ELSE j.updated_at >= GREATEST(c.last_inbound_at, c.last_replied_at)
                 END
        )
        -- Activation fence: only conversations that became LIVE after follow-up was armed for this
        -- agent (Agent.followUpArmedAt, stamped on the effective OFF→ON transition and re-stamped
        -- on promotion to production). Without it, flipping an agent to production with follow-up
        -- on would blast every eligible conversation in the historical backlog at once.
        -- NULL = never armed → fail-safe skip.
        --
        -- DATED BY OUR OWN LAST REPLY, and the customer's only when we have never spoken (issue
        -- #750). The fence used to read c.last_inbound_at, which dates the SILENCE, and for a
        -- conversation the agent answered today on an old inbound the two dates disagree by the
        -- whole age of the conversation: the silence the ladder chases is the one WE opened by
        -- asking for a document, and it starts at our reply. Measured in production on 20/09/2026,
        -- an email inbox: 19 old conversations re-engaged, last_replied_message_id set on all 19,
        -- 13 left pending holding a request for documents — and not one entered this sweep,
        -- because every inbound predated the arming.
        --
        -- The fence's own purpose survives intact, which is why this is the right column and not a
        -- relaxation: on the historical backlog we have not spoken since arming either, so flipping
        -- an agent on still blasts nobody.
        --
        -- GREATEST and not COALESCE, which was the first shape of this and is a bug: on a
        -- conversation whose customer spoke AFTER arming but whose last reply of ours predates it,
        -- COALESCE would take the old reply and fence out a conversation that is eligible today.
        -- The question is "is the latest word here after the arming", and that is a max.
        --
        -- NULL on both sides is the row that predates the column and was never answered: GREATEST
        -- answers NULL, the IS NOT NULL clause above drops it, and nothing eligible today stops
        -- being eligible.
        --
        -- The nudge itself does NOT move last_replied_at (it never claims a reply burst), so a
        -- ladder cannot feed itself through this column: step 2 reads the same instant step 1 read,
        -- and only a real new word, the client's or ours, opens the next episode.
        AND a.follow_up_armed_at IS NOT NULL
        AND GREATEST(c.last_inbound_at, c.last_replied_at) >= a.follow_up_armed_at
        -- NOTE: Pause re-engagement while the conversation holds a LIVE appointment, unless this
        -- agent is exempt (unfencedAgentIds above, issue #103).
        --
        -- One predicate over one row, the same one loadAppointmentContext reads: not cancelled, and
        -- the start still ahead. It used to project the reminder JOBS here, with a hand-written CASE
        -- normalizing the payload's startISO that had to keep agreeing with parseStartMs in JS; the
        -- start is parsed once now, at write time, and both readers compare the column (issue #376).
        AND NOT (
          a.id <> ALL(${unfencedIdsSql})
          AND EXISTS (
            SELECT 1
              FROM appointments ap
             WHERE ap.tenant_id = c.tenant_id
               AND ap.thread_id = c.thread_id
               AND ap.cancelled_at IS NULL
               AND ap.start_at > ${now}
          )
        )
        -- Skip a conversation managed by a WhatsApp→chat redirect (channelRedirect): both the WIDGET
        -- inbox (its own REDIRECT_FOLLOWUP chases the chat) and the WhatsApp ENTRY inbox (the redirect
        -- re-sends the link and its cross-channel stage owns the WhatsApp re-engagement) are handled by
        -- the redirect itself, so the generic follow-up must not ALSO fire for either. Each id is
        -- guarded against NULL (not yet set) so this never spuriously excludes an unrelated conversation.
        -- Mirrored in followUpHandler (defense in depth) for a job enqueued before the config changed.
        AND NOT (
          coalesce(a.settings->'channelRedirect'->>'enabled', 'false') = 'true'
          AND (
            (
              a.settings->'channelRedirect'->>'widgetInboxId' IS NOT NULL
              AND (a.settings->'channelRedirect'->>'widgetInboxId')::int = i.chatwoot_inbox_id
            )
            OR (
              a.settings->'channelRedirect'->>'entryInboxId' IS NOT NULL
              AND (a.settings->'channelRedirect'->>'entryInboxId')::int = i.chatwoot_inbox_id
            )
          )
        )
      LIMIT 500
    `,
  );
  for (const t of threads) {
    // NOTE: Never over a CLAIMED row (issue #786). Step 0 stays eligible until it stamps, after its
    // model call, and a pass inside that window superseded the run: its reschedule to the next step
    // was discarded and the ladder never reached the step that labels and resolves. The run in
    // flight IS the episode this arm would start.
    await enqueueJobUnlessClaimed({
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: `followup:${t.thread_id}`,
      runAt: new Date(),
      // NOTE: A CLOCK arms this, not the world: the sweep re-enqueues every eligible thread once a
      // minute, and a thread stays eligible until its follow-up actually goes out. So a re-arm here
      // is the same episode being pushed again, and clearing the budget would hand a follow-up that
      // keeps failing five fresh attempts every minute forever. A follow-up that DID go out
      // completes, which is what clears the count for the next episode.
      //
      // Except over a row of an earlier episode: its budget was spent on that one, and keeping it
      // would dead-letter this episode on its first transient failure, after which the exclusion
      // above would keep it out for good (review rounds 6 and 8).
      rearm: t.other_episode ? "new-work" : "same-work",
      payload: { threadId: t.thread_id, episode: t.episode },
      // Nor over a run its handler put off on purpose (issue #796): the retry backoff, business
      // hours, a step-0 cadence longer than this sweep's cutoff. Pulled back to now, each became a
      // run every minute, and the retry count the backoff was keeping was replaced with it. Only a
      // STEP-0 deferral is this episode's: the sweep selects a thread only at the start of a fresh
      // episode, so a later step still pending is left over from an earlier one (our own reply opens
      // a new episode without cancelling it), and waiting for it would delay this episode's first
      // follow-up by that step's cadence. And only while the configuration it was computed from still
      // holds: a cadence shortened, or a schedule opened, after the deferral must not wait out the
      // old instant, so a row marked with an older version is re-armed and the handler recomputes.
      leaveLaterRun: (row) =>
        isDeferralOfThisEpisode(
          row,
          t.episode,
          followUpConfigVersion(t.agent_updated_at, t.hours_updated_at),
        ),
      base,
    });
  }
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
  };
}

// WHICH CONFIGURATION A DEFERRAL WAS COMPUTED FROM (issue #796, review round 4). The cadence and the
// business-hours deferrals are functions of the agent's settings and of its schedule, and a change to
// either makes the stored instant wrong. Both rows stamp `updated_at` on every write, so the pair is
// a version that moves whenever the inputs can have moved; an unrelated edit to the agent also moves
// it, which costs one extra handler pass and nothing else.
export function followUpConfigVersion(
  agentUpdatedAt: Date,
  hoursUpdatedAt: Date | null | undefined,
): string {
  return `${agentUpdatedAt.getTime()}:${hoursUpdatedAt?.getTime() ?? 0}`;
}

// A deferral that does not depend on the configuration (a retry backoff, a turn in flight, a live
// decline) says so, and is kept whatever the configuration does.
const BACKOFF_DEFERRAL = "backoff";
// An appointment hold, which the sweep re-arms whenever it selects the conversation (see the hold).
const APPOINTMENT_HOLD = "appointment";

// The sweep enqueues step 0 without a stepIndex; the handler's reschedules carry one. A deferral is
// kept only when it says why it is safe to keep: a backoff, or a version that is still current. One
// that says nothing (written before deferrals were marked, review round 5) is re-armed once, and the
// handler recomputes it under the current configuration and marks it.
function isDeferralOfThisEpisode(
  {
    payload,
    lastError,
  }: { payload: Prisma.JsonValue; lastError: string | null },
  episode: string,
  configVersion: string,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const {
    stepIndex,
    deferredUnder,
    episode: deferredEpisode,
  } = payload as Record<string, unknown>;
  // Armed for another episode (review round 7): our own reply opens a new one without cancelling
  // the old deferral, and the new episode must not inherit its backoff or its retry count.
  if (deferredEpisode !== episode) return false;
  if (stepIndex !== undefined && stepIndex !== 0) return false;
  // The scheduler's own retry backoff: the handler threw, and `failJob` re-pended the row with the
  // error and a delay, leaving the payload as it was. `lastError` is what the scheduler itself reads
  // to tell a backoff from a stand-down (claimWhere), and pulling it back spent the whole budget one
  // attempt per pass instead of across the backoff (found by the acceptance run).
  if (lastError !== null) return true;
  return deferredUnder === BACKOFF_DEFERRAL || deferredUnder === configVersion;
}

// WHAT A FOLLOW-UP STEP SAYS IT IS. Pure, and separate from the handler for the reason the redirect
// ladder's own `chatFollowupNudge` is: "what do we say" is trivially testable and "when do we say it"
// is not, and the occasion the spend ceiling keys its refusal by is decided HERE.
export function inactivityNudge(params: {
  idleMin: number;
  instructions: string | null | undefined;
  // 1-based, the rung of the ladder that fired.
  step: number;
  // WHICH EPISODE OF SILENCE this step belongs to. `source`, `kind` and `step` describe the RUNG and
  // not the climb: a conversation that goes quiet, is followed up at step 1, replies, and goes quiet
  // again starts a SECOND episode whose step 1 describes itself identically. Inside the two-hour
  // window the ceiling's occasion key spans, the second refusal would then lose its `error` row and
  // its alert to the first — two customers unreached, one on the record.
  //
  // WHEN THE SILENCE BEGAN is what an episode IS here, and since issue #750 that is the LATER of the
  // customer's last message and our own last reply — the same expression `isNewFollowUpEpisode`
  // judges freshness by, which is the whole reason this field exists. Reading the customer's column
  // alone would hand two genuinely distinct episodes one key the moment the second is opened by our
  // reply with no new inbound behind it: a re-engagement on a conversation the customer never
  // answered again. Stable across the steps of one episode by construction (either side speaking is
  // what ends it). Null means neither side ever spoke, which is one episode and not two.
  episodeStartedAt: Date | null;
}): AgentNudge {
  return {
    source: "followup",
    kind: "inactivity",
    summary: `The customer has been inactive for about ${params.idleMin} minutes.`,
    instructions: params.instructions || undefined,
    step: params.step,
    occasionId: `episode:${params.episodeStartedAt?.toISOString() ?? "none"}`,
  };
}

export async function followUpHandler(
  job: ClaimedJob,
  base: PrismaClient,
  deps?: RuntimeDeps,
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
        status: true,
        assigneeType: true,
        lastEventAt: true,
        lastInboundAt: true,
        lastFollowUpAt: true,
        inboxId: true,
        testActivatedAt: true,
        lastRepliedMessageId: true,
        // The fence's own axis (issue #750); see the note beside it below.
        lastRepliedAt: true,
        chatwootFirstReplyAt: true,
        lastProactiveAt: true,
      },
    });
    if (!conv?.inboxId) return null;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true, chatwootInboxId: true },
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
        followUpArmedAt: true,
        updatedAt: true,
      },
    });
    if (!agent) return null;
    // Everything that can have changed since the job was armed: the agent disabled, follow-up switched
    // off, the conversation taken by a human or resolved, a test agent's conversation never activated,
    // or a channelRedirect taking over re-engagement (its WIDGET inbox gets the dedicated
    // REDIRECT_FOLLOWUP job and its ENTRY inbox is owned by the redirect's own stage, so the generic
    // follow-up stays out of both). The sweep's SQL already filters most of these; this catches a job
    // enqueued BEFORE the config changed underneath it.
    //
    // Shared with the console's follow-up indicator, which must promise a countdown only for a job
    // that would survive this check — see the predicate's header and issue #72.
    const redirectCfg = readChannelRedirectConfig(agent.settings);
    const followUpCfg = readFollowUpConfig(agent.settings);
    if (
      !isFollowUpLive({
        agentEnabled: agent.enabled,
        followUpEnabled: followUpCfg.enabled,
        managedByRedirect:
          redirectCfg.enabled &&
          (redirectCfg.widgetInboxId === inbox.chatwootInboxId ||
            redirectCfg.entryInboxId === inbox.chatwootInboxId),
        agentMode: agent.mode,
        testActivatedAt: conv.testActivatedAt,
        status: conv.status,
        assigneeType: conv.assigneeType,
        // This path never decides WHICH bot holds the conversation from the mirror: `agentNudge`
        // runs with `requireLiveBotOwnership`, which GETs the real conversation, reconciles the
        // stale assignee and refuses to send before any model spend. Answering from the mirror here
        // would drop a follow-up the probe was about to allow (issue #214).
        mirrorHolder: "not-asked",
        // Alcançável pelo motivo que este bloco inteiro existe: um FOLLOWUP armado pela varredura
        // ANTIGA, numa conversa nunca respondida, já está PENDING no banco no instante do deploy, e
        // a cláusula nova não o apaga — só deixa de re-enfileirá-lo. Quem o descarta é este arm.
        ourSideHasSpoken: ourSideHasSpoken(conv),
      })
    ) {
      return null;
    }

    // Business hours gate: prefer followUpHoursId; fall back to businessHoursId; neither → no gate.
    const hoursId = agent.followUpHoursId ?? agent.businessHoursId;
    const hours = hoursId
      ? await db.businessHours.findUnique({
          where: { id: hoursId },
          select: {
            windows: true,
            exceptions: true,
            timezone: true,
            updatedAt: true,
          },
        })
      : null;
    return {
      conv,
      followUpCfg,
      hours,
      armedAt: agent.followUpArmedAt,
      configVersion: followUpConfigVersion(agent.updatedAt, hours?.updatedAt),
    };
  });
  if (!ctx) return { outcome: "done" };

  // Which step of the sequence this job is. The sweep enqueues step 0 (no stepIndex); each fired step
  // reschedules the SAME row with the next index. Out-of-range (config shrank) → end the sequence.
  const steps = ctx.followUpCfg.steps;
  const stepIndex =
    typeof job.payload.stepIndex === "number" &&
    Number.isInteger(job.payload.stepIndex)
      ? job.payload.stepIndex
      : 0;
  const step = steps[stepIndex];
  if (!step) return { outcome: "done" };
  const isLast = stepIndex === steps.length - 1;

  // Appointment suppression: hold the follow-up while this conversation has a LIVE appointment —
  // queued reminder OR already-fired one with the start still ahead (issue #39). Re-check later
  // instead of nudging OR ending the sequence, so it resumes once the appointment passes / is
  // cancelled. Defense in depth — the inbound that booked the appointment already cancels any prior
  // FOLLOWUP, and the sweep won't enqueue a new one meanwhile.
  //
  // NOTE: BELOW the step resolution, and that order is the feature: the pair that decides is
  // (agent, step), and the step is not known any earlier (issue #103). Moving it down costs nothing
  // the gate used to catch — the only thing between the two positions is the out-of-range check,
  // which ends the sequence outright, and a sequence that is over has nothing left to suppress.
  if (appointmentPauseApplies(ctx.followUpCfg, step)) {
    const blockedByAppointment = await hasLiveAppointment(
      tenantId,
      threadId,
      base,
    );
    if (blockedByAppointment) {
      return {
        outcome: "reschedule",
        runAt: new Date(Date.now() + APPOINTMENT_BACKOFF_MS),
        // Never kept by the sweep: it selects a conversation only when no live appointment holds it
        // (or the agent is exempt), so a selected conversation is one whose hold has lifted, by the
        // appointment ending or by the pause setting changing, and the hold must not be waited out
        // (review rounds 6 and 8). While the appointment is live the sweep does not reach it.
        payload: { ...job.payload, deferredUnder: APPOINTMENT_HOLD },
      };
    }
  }

  const { lastFollowUpAt, lastInboundAt, lastEventAt } = ctx.conv;

  // Episode gate (defense in depth + covers a job already CLAIMED when the client replied). True when
  // the conversation is at the START of a fresh episode of silence — either it was never followed up,
  // or the client has spoken since the last follow-up. Shared with the sweep SQL + the detail estimate.
  const newEpisode = isNewFollowUpEpisode(
    lastFollowUpAt,
    lastInboundAt,
    ctx.conv.lastRepliedAt,
  );
  if (stepIndex === 0) {
    // Step 0 (sequence start) only proceeds for a fresh episode — the sweep's SQL filter already
    // enforces this; re-checking here blocks a stale step-0 job on an already-handled conversation.
    if (!newEpisode) return { outcome: "done" };
    // NOTE: Activation fence (mirrors the sweep SQL): a sequence only STARTS for an episode that began
    // after follow-up was armed. Catches a step-0 job enqueued before a re-arm (disable → re-enable)
    // and any agent never armed (NULL → fail-safe). Later steps are exempt: an in-flight sequence
    // legitimately outlives a re-arm.
    // Same axis as the sweep's SQL, and it has to be the same or the two disagree on the conversation
    // that motivated it: our reply when we have one, the client's message when we do not (issue #750).
    const fenceAt = silenceStartedAt(lastInboundAt, ctx.conv.lastRepliedAt);
    if (ctx.armedAt == null || fenceAt == null || fenceAt < ctx.armedAt) {
      return { outcome: "done" };
    }
  } else if (newEpisode) {
    // A later step but the client spoke (or the watermark vanished): the episode is over. The inbound
    // webhook already cancels the PENDING job; a new period of silence restarts at step 0.
    return { outcome: "done" };
  }

  // Cadence: step 0 measures inactivity from the last conversation activity; later steps measure from
  // when the previous step fired (lastFollowUpAt). Not due yet → reschedule precisely, marking the
  // configuration the instant was computed from so the sweep can tell when it no longer holds.
  const anchor =
    stepIndex === 0
      ? lastActivityAt(lastEventAt, ctx.conv.lastRepliedAt)
      : lastFollowUpAt;
  if (anchor) {
    const dueAt = anchor.getTime() + stepDelayMinutes(step) * 60_000;
    if (Date.now() < dueAt) {
      return {
        outcome: "reschedule",
        runAt: new Date(dueAt),
        payload: { ...job.payload, deferredUnder: ctx.configVersion },
      };
    }
  }

  // The tombstone question, asked in this handler and not only inside runAgentNudge. Three writes
  // below touch the CONVERSATION directly — the never-opening schedule, the retry exhaustion, and the
  // watermark after the nudge — and `lastFollowUpAt` is exactly the column /reset clears. A stamp
  // landing after the command puts the sweep's anchor back on a conversation the operator was told
  // was cleared, and the third one also arms the next step, reviving the sequence the command ended.
  //
  // Read immediately before each write rather than once at the top: the command arrives whenever it
  // arrives, and the interesting moment is precisely while the nudge's model call runs. Returns
  // whether the stamp landed, so a caller that would continue the sequence can stop instead.
  //
  // ONE statement, not a read then a write. Everywhere else the two marks are read to decide whether
  // to keep going, and the gap between deciding and acting is covered by there being no I/O in it.
  // Here the gap cannot be closed that way, because the command does two things in ORDER: it retires
  // the job first and clears `last_follow_up_at` later, so a stamp that reads between them finds the
  // job live, and writes after the clear. The condition therefore has to be evaluated by the same
  // statement that writes — then the stamp lands strictly before the retirement or not at all.
  //
  // The condition is `jobNotRetiredSql`, the scheduler's own predicate, and not a copy of it written
  // here: the JS reader and this one are one rule, and they are kept side by side there so a change
  // to either is a change in front of the other. NOT-retired rather than live, so an absent row
  // still stamps — an unknown is not a retirement.
  const stampUnlessRetired = async (): Promise<boolean> => {
    const stamped = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.$executeRaw(Prisma.sql`
        UPDATE conversations
           SET last_follow_up_at = now()
         WHERE id = ${ctx.conv.id}
           AND ${jobNotRetiredSql(job)}`),
    );
    return stamped > 0;
  };

  // Business hours: reschedule into the next open window rather than messaging out of hours (the step
  // index is preserved, and the configuration version marked, as for the cadence above).
  if (ctx.hours) {
    const hours = parseSchedule(ctx.hours);
    const now = new Date();
    if (hours.windows.length > 0 && !isOpenAt(hours, now)) {
      const next = nextOpenAt(hours, now);
      if (next) {
        return {
          outcome: "reschedule",
          runAt: next,
          payload: { ...job.payload, deferredUnder: ctx.configVersion },
        };
      }
      // Nothing opens within the scan horizon — a schedule closed for a year, which before date
      // exceptions could not be expressed at all (a weekly grid always repeats inside the scan). There
      // is no instant to defer to, so the episode is abandoned WITH A STAMP, exactly like the
      // retry-exhaustion path below: a bare `done` leaves the episode untouched, the sweep matches it
      // again on the next pass, and every eligible conversation re-enters this scan once a minute
      // forever. The stamp keeps the sweep away until the customer speaks again.
      logger.warn(
        "followUpHandler: schedule never opens within %d days — abandoning the episode at step %d (thread=%s)",
        NEXT_OPEN_SCAN_DAYS,
        stepIndex,
        threadId,
      );
      await stampUnlessRetired();
      return { outcome: "done" };
    }
  }

  // A turn for this conversation is executing right now (a webhook turn in flight). Firing a nudge
  // now would race the agent's own reply, so back off briefly and re-check — by then the turn has
  // finished and advanced lastEventAt past the delay (or the client spoke and the episode is over).
  if (isTurnInFlight(threadId)) {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + IN_FLIGHT_BACKOFF_MS),
      payload: { ...job.payload, deferredUnder: BACKOFF_DEFERRAL },
    };
  }

  const idleMin = lastEventAt
    ? Math.round((Date.now() - lastEventAt.getTime()) / 60_000)
    : stepDelayMinutes(step);
  const nudgeOutcome = await runAgentNudge({
    tenantId,
    threadId,
    nudge: inactivityNudge({
      idleMin,
      instructions: step.instructions,
      step: stepIndex + 1,
      episodeStartedAt: silenceStartedAt(lastInboundAt, ctx.conv.lastRepliedAt),
    }),
    // Deterministic, system-applied actions for this step (fire even if the agent stays silent);
    // resolve is honored only on the LAST step (settings already strips it from earlier ones).
    postActions: {
      assignLabels:
        step.assignLabels && step.assignLabels.length > 0
          ? step.assignLabels
          : undefined,
      resolve: isLast && step.resolve === true,
    },
    // NOTE: An inactivity follow-up must verify the LIVE conversation state before posting: the mirror can
    // be stale forever (a lost resolve webhook has no reconciliation), and following up a resolved
    // conversation was the community-reported incident this gate exists for.
    requireLiveBotOwnership: true,
    // NOTE: And the live gate is not enough on its own, because it asks about OWNERSHIP and /reset can
    // give ownership back. A follow-up already inside the model call has passed the first probe; the
    // operator resets, which returns the conversation to the agent, and the second probe then finds
    // it bot-owned again and posts a nudge from the episode that was just erased. The tombstone is
    // the question the hand-back cannot answer yes to.
    stillWanted: async ({ strict }) =>
      !(await (strict ? jobRetiredStrict(job, base) : jobRetired(job, base))),
    base,
    deps,
  });

  // NOTE: Live gate: the conversation is no longer bot-owned in Chatwoot (resolved / human took over /
  // another bot holds it), or the run was retired. No watermark, no next step. A retired run ends here.
  // The reconciled mirror keeps the sweep away from a resolved or human-held conversation, so those
  // end here. Not from one another bot holds, which is pending and bot-assigned in both readings: a
  // bare `done` put it back in the selection every minute, forever (issue #796). That one is parked
  // for LIVE_DECLINE_BACKOFF_MS, which the sweep's re-arm leaves alone, and asked again then: a
  // conversation the other bot handed back is followed up, one that moved on ends at the first look.
  if (nudgeOutcome === "stale") {
    if (await jobRetired(job, base)) return { outcome: "done" };
    // Asked of the mirror AFTER the gate reconciled it, the same two columns the sweep selects on:
    // only a conversation the next pass would select again is parked.
    const after = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversation.findUnique({
        where: { id: ctx.conv.id },
        select: { status: true, assigneeType: true },
      }),
    );
    if (after?.status !== "pending" || after.assigneeType === "User")
      return { outcome: "done" };
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + LIVE_DECLINE_BACKOFF_MS),
      payload: { ...job.payload, deferredUnder: BACKOFF_DEFERRAL },
    };
  }
  // NOTE: Nothing was posted, for a reason that may not hold next time (the shared predicate names the
  // three). Retry the SAME step later instead of stamping a follow-up that never happened, but
  // bounded (NUDGE_RETRY_LIMIT): on exhaustion, abandon the episode with a stamp so the sweep stays
  // away until the customer speaks again. Dead-lettering alone would loop, because the sweep
  // re-enqueues any conversation with no stamp.
  if (isRepairableNudgeRefusal(nudgeOutcome)) {
    const retry = nextNudgeRetry(job.payload);
    if (!retry.retry) {
      logger.warn(
        "followUpHandler: giving up on step %d after %d %s retries (thread=%s) — stamping without posting",
        stepIndex,
        retry.attempt,
        nudgeOutcome,
        threadId,
      );
      await stampUnlessRetired();
      return { outcome: "done" };
    }
    return {
      outcome: "reschedule",
      runAt: retry.runAt,
      // A retry backoff is not derived from the configuration, so it is marked as a backoff and not
      // with a version: the sweep leaves it alone even after a settings change, which is what keeps
      // the retry count.
      payload: {
        ...job.payload,
        nudgeRetries: retry.attempt,
        deferredUnder: BACKOFF_DEFERRAL,
      },
    };
  }

  // Watermark: stamp regardless of whether the nudge sent or stayed silent, so the next step's
  // cadence anchors here and the episode-interruption check works. A retire that landed while the
  // nudge ran ends the episode here instead — no stamp, and no next step.
  if (!(await stampUnlessRetired())) return { outcome: "done" };

  // NOTE: The outside-window fallback note ENDS the sequence: with no usable template, every further step
  // would be equally undeliverable (only a customer reply reopens the 24h window, and that reply
  // ends the episode anyway). One explained note is the operator's cue — N would be noise. Any
  // configured resolve on the unreached last step deliberately does NOT run: the conversation stays
  // visible in the operator's queue instead of being silently closed.
  if (nudgeOutcome === "noted-window") return { outcome: "done" };

  // Advance to the next step on the SAME job row (reschedule carries the new stepIndex), or end.
  const nextIndex = stepIndex + 1;
  const nextStep = steps[nextIndex];
  if (nextStep) {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + stepDelayMinutes(nextStep) * 60_000),
      // The episode rides along, so a later step that dies is still dated to this one.
      payload: {
        threadId,
        stepIndex: nextIndex,
        ...(typeof job.payload.episode === "string"
          ? { episode: job.payload.episode }
          : {}),
      },
    };
  }
  return { outcome: "done" };
}

let registered = false;
export function registerFollowUpHandlers(): void {
  if (registered) return;
  registerJobHandler("FOLLOWUP_SWEEP", sweepHandler);
  registerJobHandler("FOLLOWUP", followUpHandler);
  registered = true;
}

// Bootstraps the per-tenant sweep (idempotent — one live row per tenant). Called when an agent
// with follow-up enabled is saved, AND for every tenant at boot via ensureAllTenantSweeps. A sweep
// with no enabled agents is cheap (it just reschedules itself).
export async function ensureTenantSweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "FOLLOWUP_SWEEP",
    dedupeKey: "sweep",
    // NOTE: One perpetual row per tenant: this call bootstraps or self-heals it, and every pass
    // reschedules itself, so there is only ever one unit of work. Its budget is cleared by each
    // completed pass (issue #287); clearing it HERE would mean a restart loop, or an operator
    // saving an agent, resetting the count of a sweep that is genuinely broken.
    rearm: "same-work",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    base,
  });
}

// Arms the follow-up sweep for every existing tenant (called once at boot). The sweep is normally
// self-perpetuating (each run reschedules itself), but its single row can be lost — a DB reset, an
// external truncate, the destructive test suite against a shared DB — after which follow-ups would
// silently stop for the whole tenant until an agent is next saved. Re-arming at boot makes the
// sweep self-heal on restart. Idempotent (enqueueJob upserts one live row per tenant). Mirrors
// ensureAllFlowlogSweeps; a tenant created later is swept after its first agent save or the next
// restart.
export async function ensureAllTenantSweeps(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  // NOTE: per-tenant, best-effort. The list and the writes are not one transaction, so a tenant
  // deleted in between makes its enqueue fail on the FK — and a bare loop would abort there, leaving
  // EVERY tenant after it unswept until the next restart, silently. One tenant's failure must not
  // cost the rest their self-heal, so it is logged and the loop continues.
  for (const t of tenants) {
    try {
      await ensureTenantSweep(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "follow-up sweep re-arm failed for tenant; continuing",
      );
    }
  }
}
