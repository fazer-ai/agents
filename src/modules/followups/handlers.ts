import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { isTurnInFlight } from "@/graph/inflight";
import { parseThreadId, runAgentNudge } from "@/graph/nudge";
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
import { isFollowUpLive } from "@/modules/followups/eligibility";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  type FollowUpStep,
  isNewFollowUpEpisode,
  readFollowUpConfig,
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
// NOTE: Back-off when the nudge could not run to completion without posting anything: the live-state GET
// failed (fail-closed) or a pending human-in-the-loop interrupt deferred it. Retry the SAME step —
// nothing was sent, so the watermark must not advance.
const NUDGE_RETRY_BACKOFF_MS = 900_000;
// NOTE: Cap on consecutive same-step retries (payload `nudgeRetries`, reset when the step advances).
// A conversation whose live GET fails forever (e.g. deleted in Chatwoot) must not stay PENDING
// indefinitely. On exhaustion the CURRENT EPISODE is abandoned by stamping lastFollowUpAt WITHOUT
// posting — dead-lettering alone would loop, because the sweep re-enqueues any conversation with
// no stamp; the stamp keeps it away until the customer speaks again (which starts a new episode).
const NUDGE_RETRY_LIMIT = 8;

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
      select: { settings: true },
    }),
  );
  // The sweep only ever STARTS a sequence (step 0), so its cutoff is the minimum FIRST-step delay
  // across enabled agents. Later steps are scheduled precisely by the handler, not the sweep.
  const enabledDelays = agents
    .map((a) => readFollowUpConfig(a.settings))
    .filter((cfg) => cfg.enabled)
    .map((cfg) => cfg.steps[0])
    .filter((s): s is FollowUpStep => s !== undefined)
    .map((s) => stepDelayMinutes(s));
  if (enabledDelays.length === 0) {
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    };
  }
  const cutoffMin = Math.min(...enabledDelays);
  const cutoff = new Date(Date.now() - cutoffMin * 60_000);

  // NOTE: column-to-column comparison (lastInboundAt > lastFollowUpAt) requires raw SQL;
  // Prisma's query builder cannot express it. The filter mirrors the handler's watermark gate
  // so ineligible conversations are excluded before even enqueuing a FOLLOWUP job. The JOIN onto
  // the inbox's agent also drops conversations whose agent is in TEST mode but not yet activated
  // with /teste (isTestSilenced) — a silenced conversation must never get a proactive follow-up.
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
        AND c.status = 'pending'
        -- NOTE: Bot-owned = anything but a human, mirroring shouldBotHandle: NULL (unassigned — Chatwoot
        -- < 4.16.2, Dialogflow-style hooks) AND 'AgentBot' (the NORMAL state since Chatwoot 4.16.2
        -- auto-assigns the connected bot at conversation creation). IS DISTINCT FROM because
        -- NULL <> 'User' evaluates to NULL. A foreign bot's AgentBot is deliberately NOT filtered
        -- here: the nudge's own ownership gate (assignee bot id vs ours) re-checks before invoking
        -- the model, so a rare false positive costs one no-op job cycle.
        AND c.assignee_type IS DISTINCT FROM 'User'
        AND c.inbox_id IS NOT NULL
        AND a.enabled = true
        AND (a.mode <> 'test' OR c.test_activated_at IS NOT NULL)
        AND c.last_event_at < ${cutoff}
        AND c.last_inbound_at IS NOT NULL
        AND (
          c.last_follow_up_at IS NULL
          OR c.last_inbound_at > c.last_follow_up_at
        )
        -- Activation fence: only episodes of silence that BEGAN after follow-up was armed for this
        -- agent (Agent.followUpArmedAt, stamped on the effective OFF→ON transition and re-stamped
        -- on promotion to production). Without it, flipping an agent to production with follow-up
        -- on would blast every eligible conversation in the historical backlog at once.
        -- NULL = never armed → fail-safe skip.
        AND a.follow_up_armed_at IS NOT NULL
        AND c.last_inbound_at >= a.follow_up_armed_at
        -- NOTE: Pause re-engagement while the conversation has a LIVE future appointment, unless the
        -- agent opted out (followUp.pauseWhileAppointment = false). SQL mirror of
        -- projectAppointmentEvents (appointments/context.ts): a non-tombstoned reminder row counts
        -- while it is still queued (PENDING/CLAIMED) OR its startISO is still ahead — firing marks
        -- rows DONE, so after the LAST reminder only the future-start arm keeps suppression on
        -- (issue #39). The cast is guarded (CASE + pg_input_is_valid; deploy mandates pg17):
        -- startISO can be all-day (YYYY-MM-DD) or model-supplied garbage, and an unguarded cast
        -- would abort the WHOLE tenant sweep. Offset-less values are pinned to UTC exactly like
        -- parseStartMs (all-day → UTC midnight; offset-less datetime → 'Z'), so the SQL and JS
        -- liveness decisions agree regardless of the session/host time zones.
        -- Invalid/absent start = not-future (fail-safe: only the queued arm suppresses then).
        AND NOT (
          coalesce(a.settings->'followUp'->>'pauseWhileAppointment', 'true') <> 'false'
          AND EXISTS (
            SELECT 1
            FROM scheduler_jobs sj
            CROSS JOIN LATERAL (
              SELECT CASE
                WHEN sj.payload->>'startISO' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                  THEN sj.payload->>'startISO' || 'T00:00:00Z'
                WHEN sj.payload->>'startISO' ~ '[Tt ][0-9]{2}:'
                     AND sj.payload->>'startISO' !~ '([Zz]|[+-][0-9]{2}:?[0-9]{2})$'
                  THEN sj.payload->>'startISO' || 'Z'
                ELSE sj.payload->>'startISO'
              END AS start_iso
            ) norm
            WHERE sj.tenant_id = c.tenant_id
              AND sj.kind = 'APPOINTMENT_REMINDER'
              AND sj.payload->>'threadId' = c.thread_id
              AND sj.payload->>'cancelledAt' IS NULL
              AND (
                sj.status IN ('PENDING', 'CLAIMED')
                OR CASE
                  WHEN norm.start_iso IS NOT NULL
                       AND pg_input_is_valid(norm.start_iso, 'timestamptz')
                    THEN norm.start_iso::timestamptz > now()
                  ELSE false
                END
              )
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
    await enqueueJob({
      tenantId,
      kind: "FOLLOWUP",
      dedupeKey: `followup:${t.thread_id}`,
      runAt: new Date(),
      payload: { threadId: t.thread_id },
      base,
    });
  }
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
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
      })
    ) {
      return null;
    }

    // Business hours gate: prefer followUpHoursId; fall back to businessHoursId; neither → no gate.
    const hoursId = agent.followUpHoursId ?? agent.businessHoursId;
    const hours = hoursId
      ? await db.businessHours.findUnique({
          where: { id: hoursId },
          select: { windows: true, exceptions: true, timezone: true },
        })
      : null;
    return { conv, followUpCfg, hours, armedAt: agent.followUpArmedAt };
  });
  if (!ctx) return { outcome: "done" };

  // Appointment suppression: hold the follow-up while this conversation has a LIVE appointment —
  // queued reminder OR already-fired one with the start still ahead (issue #39). Re-check later
  // instead of nudging OR ending the sequence, so it resumes once the appointment passes / is
  // cancelled. Defense in depth — the inbound that booked the appointment already cancels any prior
  // FOLLOWUP, and the sweep won't enqueue a new one meanwhile.
  if (ctx.followUpCfg.pauseWhileAppointment) {
    const blockedByAppointment = await hasLiveAppointment(
      tenantId,
      threadId,
      base,
    );
    if (blockedByAppointment) {
      return {
        outcome: "reschedule",
        runAt: new Date(Date.now() + APPOINTMENT_BACKOFF_MS),
      };
    }
  }

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

  const { lastFollowUpAt, lastInboundAt, lastEventAt } = ctx.conv;

  // Episode gate (defense in depth + covers a job already CLAIMED when the client replied). True when
  // the conversation is at the START of a fresh episode of silence — either it was never followed up,
  // or the client has spoken since the last follow-up. Shared with the sweep SQL + the detail estimate.
  const newEpisode = isNewFollowUpEpisode(lastFollowUpAt, lastInboundAt);
  if (stepIndex === 0) {
    // Step 0 (sequence start) only proceeds for a fresh episode — the sweep's SQL filter already
    // enforces this; re-checking here blocks a stale step-0 job on an already-handled conversation.
    if (!newEpisode) return { outcome: "done" };
    // NOTE: Activation fence (mirrors the sweep SQL): a sequence only STARTS for an episode that began
    // after follow-up was armed. Catches a step-0 job enqueued before a re-arm (disable → re-enable)
    // and any agent never armed (NULL → fail-safe). Later steps are exempt: an in-flight sequence
    // legitimately outlives a re-arm.
    if (
      ctx.armedAt == null ||
      lastInboundAt == null ||
      lastInboundAt < ctx.armedAt
    ) {
      return { outcome: "done" };
    }
  } else if (newEpisode) {
    // A later step but the client spoke (or the watermark vanished): the episode is over. The inbound
    // webhook already cancels the PENDING job; a new period of silence restarts at step 0.
    return { outcome: "done" };
  }

  // Cadence: step 0 measures inactivity from the last conversation activity; later steps measure from
  // when the previous step fired (lastFollowUpAt). Not due yet → reschedule precisely (same payload).
  const anchor = stepIndex === 0 ? lastEventAt : lastFollowUpAt;
  if (anchor) {
    const dueAt = anchor.getTime() + stepDelayMinutes(step) * 60_000;
    if (Date.now() < dueAt) {
      return { outcome: "reschedule", runAt: new Date(dueAt) };
    }
  }

  // Business hours: reschedule into the next open window rather than messaging out of hours (same
  // payload — the step index is preserved).
  if (ctx.hours) {
    const hours = parseSchedule(ctx.hours);
    const now = new Date();
    if (hours.windows.length > 0 && !isOpenAt(hours, now)) {
      const next = nextOpenAt(hours, now);
      if (next) return { outcome: "reschedule", runAt: next };
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
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversation.update({
          where: { id: ctx.conv.id },
          data: { lastFollowUpAt: new Date() },
        }),
      );
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
    };
  }

  const idleMin = lastEventAt
    ? Math.round((Date.now() - lastEventAt.getTime()) / 60_000)
    : stepDelayMinutes(step);
  const nudgeOutcome = await runAgentNudge({
    tenantId,
    threadId,
    nudge: {
      source: "followup",
      kind: "inactivity",
      summary: `The customer has been inactive for about ${idleMin} minutes.`,
      instructions: step.instructions || undefined,
      step: stepIndex + 1,
    },
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
    base,
    deps,
  });

  // NOTE: Live gate: the conversation is no longer bot-owned in Chatwoot (resolved / human took over) —
  // the episode is moot. No watermark, no next step; the reconciled mirror keeps the sweep away.
  if (nudgeOutcome === "stale") return { outcome: "done" };
  // NOTE: Nothing was posted: the live-state GET failed (fail-closed) or a pending human-in-the-loop
  // interrupt deferred the nudge. Retry the SAME step later instead of stamping a follow-up that
  // never happened — but bounded (NUDGE_RETRY_LIMIT): on exhaustion, abandon the episode with a
  // stamp so the sweep stays away until the customer speaks again.
  if (nudgeOutcome === "live-unavailable" || nudgeOutcome === "deferred") {
    const priorRetries =
      typeof job.payload.nudgeRetries === "number" &&
      Number.isInteger(job.payload.nudgeRetries)
        ? job.payload.nudgeRetries
        : 0;
    if (priorRetries + 1 >= NUDGE_RETRY_LIMIT) {
      logger.warn(
        "followUpHandler: giving up on step %d after %d %s retries (thread=%s) — stamping without posting",
        stepIndex,
        priorRetries + 1,
        nudgeOutcome,
        threadId,
      );
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversation.update({
          where: { id: ctx.conv.id },
          data: { lastFollowUpAt: new Date() },
        }),
      );
      return { outcome: "done" };
    }
    return {
      outcome: "reschedule",
      runAt: new Date(Date.now() + NUDGE_RETRY_BACKOFF_MS),
      payload: { ...job.payload, nudgeRetries: priorRetries + 1 },
    };
  }

  // Watermark: stamp regardless of whether the nudge sent or stayed silent, so the next step's
  // cadence anchors here and the episode-interruption check works.
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.update({
      where: { id: ctx.conv.id },
      data: { lastFollowUpAt: new Date() },
    }),
  );

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
      payload: { threadId, stepIndex: nextIndex },
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
