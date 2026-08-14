import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { getConversationDetail } from "@/modules/conversations/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// Regression guard for the follow-up "next step" estimate in getConversationDetail. The estimate's
// eligibility MUST match the sweep/handler's "fresh episode" predicate (isNewFollowUpEpisode): a
// follow-up that already fired does NOT end the indicator if the customer has since replied (a reply
// restarts the sequence at step 0 and the sweep re-arms it). The earlier bug used `lastFollowUpAt ===
// null`, so after the first send the indicator wrongly read "complete" while a follow-up was pending.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenant = 0n;
let inst = 0n;
let convNewEpisode = 0n;
let convSameEpisode = 0n;
let convBusinessHours = 0n;
let convBusinessHoursJob = 0n;
let convTestPreActivation = 0n;
let convTestPostActivation = 0n;
let convRedirectWidget = 0n;
let convRedirectWidgetJob = 0n;
let convRedirectEntry = 0n;
let convAppointmentLive = 0n;
let convAppointmentPast = 0n;
let convAppointmentCancelled = 0n;
let convAppointmentOptOut = 0n;
let convAppointmentResolved = 0n;
let convAppointmentDone = 0n;

// The redirect follow-up job's run time, asserted verbatim as the widget conversation's redirectNext.
const REDIRECT_JOB_RUN_AT = new Date("2026-06-18T23:30:00Z");

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

// Mirrors conv 21761 from the investigation: a 2-minute single-step follow-up already fired at 23:06,
// the customer replied at 23:18, the last activity (the bot's reply) is 23:18:45.
const FOLLOW_UP_AT = new Date("2026-06-18T23:06:59Z");
const REPLY_AT = new Date("2026-06-18T23:18:25Z");
const LAST_EVENT_AT = new Date("2026-06-18T23:18:45Z");

// Business-hours estimate: a daily 09:00–10:00 UTC window. A follow-up coming due at 20:02 UTC (well
// outside it) must be estimated at the NEXT open window — the following day at 09:00 UTC.
const BH_WINDOWS = Array.from({ length: 7 }, (_, day) => ({
  day,
  start: "09:00",
  end: "10:00",
}));
const BH_LAST_EVENT_AT = new Date("2026-06-15T20:00:00Z"); // dueAt = +2min = 20:02 UTC (closed)
const BH_EXPECTED_RUN_AT = "2026-06-16T09:00:00.000Z";

describe.skipIf(!dbUp)("getConversationDetail — follow-up estimate", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ConvFU", slug: `conv-fu-${process.pid}` },
    });
    tenant = t.id;
    const instance = await seedChatwootInstance(suDb, {
      tenantId: tenant,
      accountId: 9,
      baseUrl: "https://cw.example",
      adminToken: "enc",
    });
    inst = instance.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "FU Persona",
        systemPrompt: "x",
        followUpArmedAt: new Date("2026-01-01T00:00:00Z"),
        mode: "production",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 2, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootInboxId: 70,
        name: "Sup",
        agentId: agent.id,
      },
    });
    // New episode: a follow-up already fired, but the customer replied AFTER it.
    const c1 = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: 300,
        inboxId: inbox.id,
        status: "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:300`,
        lastEventAt: LAST_EVENT_AT,
        lastInboundAt: REPLY_AT,
        lastFollowUpAt: FOLLOW_UP_AT,
      },
    });
    convNewEpisode = c1.id;
    // Same episode: a follow-up fired and the customer has NOT spoken since.
    const c2 = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: 301,
        inboxId: inbox.id,
        status: "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:301`,
        lastEventAt: FOLLOW_UP_AT,
        lastInboundAt: new Date("2026-06-18T23:00:00Z"),
        lastFollowUpAt: FOLLOW_UP_AT,
      },
    });
    convSameEpisode = c2.id;

    // Business-hours agent: a fresh episode whose dueAt falls outside the configured follow-up window.
    const hours = await suDb.businessHours.create({
      data: {
        tenantId: tenant,
        name: "Comercial",
        timezone: "UTC",
        windows: BH_WINDOWS,
      },
    });
    const bhAgent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "FU Hours",
        systemPrompt: "x",
        followUpArmedAt: new Date("2026-01-01T00:00:00Z"),
        mode: "production",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        followUpHoursId: hours.id,
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 2, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
    });
    const bhInbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootInboxId: 71,
        name: "Sup BH",
        agentId: bhAgent.id,
      },
    });
    const c3 = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: 302,
        inboxId: bhInbox.id,
        status: "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:302`,
        lastEventAt: BH_LAST_EVENT_AT,
        lastInboundAt: BH_LAST_EVENT_AT,
        lastFollowUpAt: null,
      },
    });
    convBusinessHours = c3.id;

    // Same business-hours agent, but a PENDING FOLLOWUP job already exists with runAt OUTSIDE the
    // window — exactly what the sweep leaves behind (it enqueues step 0 with runAt=now and re-arms it
    // every pass) before the worker claims and reschedules. The estimate must STILL be pushed to the
    // next open window: the old code surfaced job.runAt raw, so the indicator dropped the business-hours
    // calculation between each sweep and the worker's reschedule.
    const c4 = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: 303,
        inboxId: bhInbox.id,
        status: "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:303`,
        lastEventAt: BH_LAST_EVENT_AT,
        lastInboundAt: BH_LAST_EVENT_AT,
        lastFollowUpAt: null,
      },
    });
    convBusinessHoursJob = c4.id;
    await suDb.schedulerJob.create({
      data: {
        tenantId: tenant,
        kind: "FOLLOWUP",
        dedupeKey: `followup:${tenant}:${inst}:303`,
        status: "PENDING",
        runAt: BH_LAST_EVENT_AT, // 20:00 UTC, outside the 09:00–10:00 window (mirrors a fresh sweep)
        payload: { threadId: `${tenant}:${inst}:303` },
      },
    });

    // Test-mode agent: /teste consumes a PRE-activation follow-up episode by stamping lastFollowUpAt =
    // activation time. A message received BEFORE activation must NOT leave a follow-up pending; a
    // message AFTER activation re-opens it. Both convs are activated (so not test-silenced).
    const testAgent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "FU Test",
        systemPrompt: "x",
        followUpArmedAt: new Date("2026-01-01T00:00:00Z"),
        mode: "test",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 2, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
    });
    const testInbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootInboxId: 72,
        name: "Sup Test",
        agentId: testAgent.id,
      },
    });
    const activatedAt = new Date("2026-06-18T23:10:00Z");
    // Post-/teste state for a conversation whose only message was PRE-activation: /teste clears both
    // anchors → "none" (no pending estimate, no "completed" signal).
    const c5 = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: 304,
        inboxId: testInbox.id,
        status: "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:304`,
        lastEventAt: activatedAt,
        lastInboundAt: null,
        lastFollowUpAt: null,
        testActivatedAt: activatedAt,
      },
    });
    convTestPreActivation = c5.id;
    // A genuine customer message AFTER activation re-anchors lastInboundAt → fresh episode, estimate shows.
    const postReplyAt = new Date("2026-06-18T23:15:00Z");
    const c6 = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: 305,
        inboxId: testInbox.id,
        status: "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:305`,
        lastEventAt: postReplyAt,
        lastInboundAt: postReplyAt,
        lastFollowUpAt: null,
        testActivatedAt: activatedAt,
      },
    });
    convTestPostActivation = c6.id;

    // Redirect-managed agent: the generic follow-up is enabled AND would estimate step 1, but the
    // WhatsApp→chat redirect owns re-engagement for its entry (80) + widget (81) inboxes, so the
    // conversation detail must SUPPRESS the generic estimate for both and, on the widget side, surface
    // the pending REDIRECT_FOLLOWUP instead (mirrors the followups sweep/handler exclusion).
    const redirectAgent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "FU Redirect",
        systemPrompt: "x",
        followUpArmedAt: new Date("2026-01-01T00:00:00Z"),
        mode: "production",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 2, delayUnit: "minutes", instructions: "" }],
          },
          channelRedirect: {
            enabled: true,
            entryInboxId: 80,
            widgetInboxId: 81,
          },
        },
      },
    });
    const entryInbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootInboxId: 80,
        name: "WA Entry",
        agentId: redirectAgent.id,
      },
    });
    const widgetInbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootInboxId: 81,
        name: "Web Widget",
        agentId: redirectAgent.id,
      },
    });
    const freshEpisode = new Date("2026-06-18T23:15:00Z");
    // Widget conversation, fresh episode (would otherwise estimate step 1). No redirect job yet.
    const c7 = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: 306,
        inboxId: widgetInbox.id,
        status: "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:306`,
        lastEventAt: freshEpisode,
        lastInboundAt: freshEpisode,
        lastFollowUpAt: null,
      },
    });
    convRedirectWidget = c7.id;
    // Widget conversation WITH a pending REDIRECT_FOLLOWUP job (stage "whatsapp") → surfaced as redirectNext.
    const c8 = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: 307,
        inboxId: widgetInbox.id,
        status: "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:307`,
        lastEventAt: freshEpisode,
        lastInboundAt: freshEpisode,
        lastFollowUpAt: null,
      },
    });
    convRedirectWidgetJob = c8.id;
    await suDb.schedulerJob.create({
      data: {
        tenantId: tenant,
        kind: "REDIRECT_FOLLOWUP",
        dedupeKey: `redirect-followup:${tenant}:${inst}:307`,
        status: "PENDING",
        runAt: REDIRECT_JOB_RUN_AT,
        payload: {
          stage: "whatsapp",
          widgetThreadId: `${tenant}:${inst}:307`,
          agentId: redirectAgent.id.toString(),
          entryInboxId: 80,
        },
      },
    });
    // Entry (WhatsApp) conversation, fresh episode: also suppressed, but no redirect job is keyed to it.
    const c9 = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: 308,
        inboxId: entryInbox.id,
        status: "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:308`,
        lastEventAt: freshEpisode,
        lastInboundAt: freshEpisode,
        lastFollowUpAt: null,
      },
    });
    convRedirectEntry = c9.id;

    // Same shape as the fresh-episode conversation (so an estimate WOULD be produced), differing
    // only in whether an appointment is live.
    convAppointmentLive = await seedAppointmentConv(310, inbox.id, {
      startISO: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    });
    convAppointmentPast = await seedAppointmentConv(311, inbox.id, {
      startISO: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    });
    convAppointmentCancelled = await seedAppointmentConv(312, inbox.id, {
      startISO: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      cancelledAt: new Date(Date.now() - 60_000).toISOString(),
    });
    // Live appointment on conversations the sweep would skip anyway: a human owns this one, and the
    // next one already ran its whole sequence (same episode, no reply since).
    convAppointmentResolved = await seedAppointmentConv(
      315,
      inbox.id,
      { startISO: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      { status: "resolved" },
    );
    convAppointmentDone = await seedAppointmentConv(
      316,
      inbox.id,
      { startISO: new Date(Date.now() + 2 * 3_600_000).toISOString() },
      {
        lastEventAt: FOLLOW_UP_AT,
        lastInboundAt: new Date("2026-06-18T23:00:00Z"),
        lastFollowUpAt: FOLLOW_UP_AT,
      },
    );

    // A second persona that opted OUT of the pause, on its own inbox.
    const optOutAgent = await suDb.agent.create({
      data: {
        tenantId: tenant,
        name: "FU No Pause",
        systemPrompt: "x",
        followUpArmedAt: new Date("2026-01-01T00:00:00Z"),
        mode: "production",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {
          followUp: {
            enabled: true,
            pauseWhileAppointment: false,
            steps: [{ delayValue: 2, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
    });
    const optOutInbox = await suDb.inbox.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootInboxId: 79,
        name: "Sup sem pausa",
        agentId: optOutAgent.id,
      },
    });
    convAppointmentOptOut = await seedAppointmentConv(313, optOutInbox.id, {
      startISO: new Date(Date.now() + 2 * 3_600_000).toISOString(),
    });
  });

  // A live appointment is the sweep's own fence (followUp.pauseWhileAppointment, on by default): it
  // skips the conversation, and the handler reschedules an already-armed job. The indicator has to
  // agree, or the operator reads a countdown for a follow-up that never fires (issue #60).
  async function seedAppointmentConv(
    chatwootId: number,
    inboxId: bigint,
    reminder: { startISO: string; cancelledAt?: string } | null,
    conv: {
      status?: string;
      lastEventAt?: Date;
      lastInboundAt?: Date;
      lastFollowUpAt?: Date;
    } = {},
  ): Promise<bigint> {
    const c = await suDb.conversation.create({
      data: {
        tenantId: tenant,
        chatwootInstanceId: inst,
        chatwootConversationId: chatwootId,
        inboxId,
        status: conv.status ?? "pending",
        assigneeType: null,
        threadId: `${tenant}:${inst}:${chatwootId}`,
        lastEventAt: conv.lastEventAt ?? LAST_EVENT_AT,
        lastInboundAt: conv.lastInboundAt ?? REPLY_AT,
        ...(conv.lastFollowUpAt ? { lastFollowUpAt: conv.lastFollowUpAt } : {}),
      },
    });
    if (reminder) {
      await suDb.schedulerJob.create({
        data: {
          tenantId: tenant,
          kind: "APPOINTMENT_REMINDER",
          dedupeKey: `reminder:ev_${chatwootId}:1`,
          // DONE on purpose: anchoring on PENDING rows alone went blind after the last reminder
          // fired, which is what #39 fixed in the sweep. The indicator reads the same projection.
          status: "DONE",
          runAt: new Date(Date.now() - 3_600_000),
          payload: {
            threadId: `${tenant}:${inst}:${chatwootId}`,
            eventId: `ev_${chatwootId}`,
            calendarId: "cal_x@group.calendar.google.com",
            credentialRef: null,
            startISO: reminder.startISO,
            offsetHours: 1,
            isLast: true,
            askConfirmation: false,
            summary: "Consulta",
            calendarLabel: "Agenda",
            ...(reminder.cancelledAt
              ? { cancelledAt: reminder.cancelledAt }
              : {}),
          },
        },
      });
    }
    return c.id;
  }

  afterAll(async () => {
    if (tenant) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM conversations WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM inboxes WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM business_hours WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id = ${tenant}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenant}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("new episode (follow-up fired, then the customer replied) → estimates step 1 even with lastFollowUpAt set", async () => {
    const d = await getConversationDetail(ctx(tenant), convNewEpisode, appDb);
    expect(d.followUp?.enabled).toBe(true);
    expect(d.followUp?.nextStep).toBe(1);
    // Estimate anchors on lastEventAt + the first step's delay (2 min).
    expect(d.followUp?.nextRunAt).toBe(
      new Date(LAST_EVENT_AT.getTime() + 2 * 60_000).toISOString(),
    );
    // No schedule here → the estimate matches the cadence exactly (not deferred).
    expect(d.followUp?.nextRunAtDeferred).toBe(false);
    // The previous send is still reported (for the "last fired" context), not used to end the journey.
    expect(d.followUp?.lastFollowUpAt).toBe(FOLLOW_UP_AT.toISOString());
  });

  test("same episode (no reply since the last follow-up) → no estimate (sequence complete)", async () => {
    const d = await getConversationDetail(ctx(tenant), convSameEpisode, appDb);
    expect(d.followUp?.enabled).toBe(true);
    expect(d.followUp?.nextStep).toBeNull();
    expect(d.followUp?.nextRunAt).toBeNull();
    expect(d.followUp?.lastFollowUpAt).toBe(FOLLOW_UP_AT.toISOString());
  });

  test("business-hours follow-up → estimate is pushed to the next open window", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convBusinessHours,
      appDb,
    );
    expect(d.followUp?.enabled).toBe(true);
    expect(d.followUp?.nextStep).toBe(1);
    // dueAt = lastEventAt + 2min = 20:02 UTC, outside the 09:00–10:00 window → next open: next day 09:00.
    expect(d.followUp?.nextRunAt).toBe(BH_EXPECTED_RUN_AT);
    // The cadence landed outside the window, so the estimate was deferred (item 3).
    expect(d.followUp?.nextRunAtDeferred).toBe(true);
  });

  test("business-hours follow-up WITH a pending job armed → estimate is still pushed to the next open window", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convBusinessHoursJob,
      appDb,
    );
    expect(d.followUp?.enabled).toBe(true);
    expect(d.followUp?.nextStep).toBe(1);
    // The job's runAt is 20:00 UTC (a fresh sweep), but the estimate must mirror what actually fires:
    // floor step 0 at lastEventAt + 2min = 20:02, then the next open window → next day 09:00.
    expect(d.followUp?.nextRunAt).toBe(BH_EXPECTED_RUN_AT);
  });

  test("/teste cleared the pre-activation episode → 'none', not 'complete'", async () => {
    // /teste clears both anchors, so there is neither a pending estimate NOR a lastFollowUpAt (which
    // would make the UI say "sequence complete" — implying a follow-up was sent, when none was).
    const d = await getConversationDetail(
      ctx(tenant),
      convTestPreActivation,
      appDb,
    );
    expect(d.followUp?.enabled).toBe(true);
    expect(d.followUp?.nextStep).toBeNull();
    expect(d.followUp?.nextRunAt).toBeNull();
    // The key assertion: lastFollowUpAt is null → the UI shows "none", never "complete".
    expect(d.followUp?.lastFollowUpAt).toBeNull();
  });

  test("a customer message AFTER /teste re-opens the episode → estimate shows step 1", async () => {
    // lastInboundAt (23:15) is newer than the activation watermark (23:10) → a genuine post-activation
    // episode; the estimate appears just like any production conversation.
    const d = await getConversationDetail(
      ctx(tenant),
      convTestPostActivation,
      appDb,
    );
    expect(d.followUp?.enabled).toBe(true);
    expect(d.followUp?.nextStep).toBe(1);
    expect(d.followUp?.nextRunAt).toBe(
      new Date("2026-06-18T23:17:00Z").toISOString(), // lastEventAt 23:15 + 2min
    );
  });

  test("redirect-managed WIDGET conversation → generic estimate suppressed, managedByRedirect set", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convRedirectWidget,
      appDb,
    );
    // The generic follow-up config is still 'enabled' (it applies to the agent's other channels), but the
    // estimate for THIS conversation is suppressed because its inbox is the redirect's widget inbox.
    expect(d.followUp?.enabled).toBe(true);
    expect(d.followUp?.managedByRedirect).toBe(true);
    expect(d.followUp?.nextStep).toBeNull();
    expect(d.followUp?.nextRunAt).toBeNull();
    // No REDIRECT_FOLLOWUP job armed for this thread yet → nothing to surface.
    expect(d.followUp?.redirectNext).toBeNull();
  });

  test("redirect-managed WIDGET conversation WITH a pending redirect job → surfaces redirectNext", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convRedirectWidgetJob,
      appDb,
    );
    expect(d.followUp?.managedByRedirect).toBe(true);
    expect(d.followUp?.nextStep).toBeNull();
    expect(d.followUp?.redirectNext).toEqual({
      stage: "whatsapp",
      runAt: REDIRECT_JOB_RUN_AT.toISOString(),
    });
  });

  test("redirect-managed ENTRY (WhatsApp) conversation → suppressed, no redirect job of its own", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convRedirectEntry,
      appDb,
    );
    expect(d.followUp?.managedByRedirect).toBe(true);
    expect(d.followUp?.nextStep).toBeNull();
    expect(d.followUp?.nextRunAt).toBeNull();
    // The entry side is re-engaged by the gate re-sending the link, not a scheduled job.
    expect(d.followUp?.redirectNext).toBeNull();
  });

  test("a live appointment suppresses the estimate and says why", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convAppointmentLive,
      appDb,
    );
    expect(d.followUp?.enabled).toBe(true);
    expect(d.followUp?.pausedByAppointment).toBe(true);
    // The whole point: no countdown for a follow-up the sweep will not enqueue.
    expect(d.followUp?.nextStep).toBeNull();
    expect(d.followUp?.nextRunAt).toBeNull();
  });

  test("an appointment already past does not suppress anything", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convAppointmentPast,
      appDb,
    );
    expect(d.followUp?.pausedByAppointment).toBe(false);
    expect(d.followUp?.nextStep).toBe(1);
  });

  test("a cancelled appointment does not suppress anything", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convAppointmentCancelled,
      appDb,
    );
    expect(d.followUp?.pausedByAppointment).toBe(false);
    expect(d.followUp?.nextStep).toBe(1);
  });

  // The flag has to name the reason the follow-up is not coming, and on these two the appointment is
  // not it. Saying "paused" here also costs the completion marker, which yields to this flag.
  test("a human already owns the conversation → not attributed to the appointment", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convAppointmentResolved,
      appDb,
    );
    expect(d.followUp?.pausedByAppointment).toBe(false);
    expect(d.followUp?.nextStep).toBeNull();
  });

  test("the sequence already finished → still reads as complete, not paused", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convAppointmentDone,
      appDb,
    );
    expect(d.followUp?.pausedByAppointment).toBe(false);
    expect(d.followUp?.nextStep).toBeNull();
    expect(d.followUp?.lastFollowUpAt).toBe(FOLLOW_UP_AT.toISOString());
  });

  test("an agent that opted out of the pause still gets its estimate", async () => {
    const d = await getConversationDetail(
      ctx(tenant),
      convAppointmentOptOut,
      appDb,
    );
    expect(d.followUp?.pausedByAppointment).toBe(false);
    expect(d.followUp?.nextStep).toBe(1);
  });
});
