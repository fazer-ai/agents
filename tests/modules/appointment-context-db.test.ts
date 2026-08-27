import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadAppointmentContext } from "@/modules/appointments/context";
import {
  appointmentBooked,
  cancelAppointment,
  hasLiveAppointment,
} from "@/modules/appointments/reminders";
import { type ClaimedJob, jobRetired } from "@/modules/scheduler/service";
import { seedChatwootInstance } from "../utils/chatwoot";

// DB-backed mirror of issue #22: the appointment identity block must reach the system prompt after
// the last reminder fired, and a cancelled appointment must never resurface.
//
// And of issue #376: the block, and the follow-up pause behind it, follow the RECORD and not the
// reminder jobs. The two configurations that used to write no job at all — reminders switched off,
// and a booking sooner than the smallest offset — have a test each below, and both fail against a
// build where booking and arming are the same call.

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

let tenantId = 0n;
let instanceId = 0n;
let agentId = 0n;

function sysCtx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function threadOf(convId: number) {
  return `${tenantId}:${instanceId}:${convId}`;
}

function inHours(h: number): string {
  return new Date(Date.now() + h * 3_600_000).toISOString();
}

async function seedConversation(convId: number) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      threadId: threadOf(convId),
      lastEventAt: new Date(),
      lastInboundAt: new Date(),
    },
  });
}

async function promptFor(convId: number): Promise<string> {
  const cfg = await runScopedOn(appDb, sysCtx(), (db) =>
    loadAgentConfig(db, {
      tenantId,
      instanceId,
      conversationId: convId,
      agentId,
      threadId: threadOf(convId),
    }),
  );
  expect(cfg).not.toBeNull();
  return cfg?.systemPrompt ?? "";
}

describe.skipIf(!dbUp)("per-turn appointment context (issue #22)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ApCtx", slug: `apctx-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 7,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
      },
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "appointments",
        "scheduler_jobs",
        "conversations",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the turn after the LAST reminder still sees the appointment (record, future start)", async () => {
    await seedConversation(101);
    await appointmentBooked({
      tenantId,
      threadId: threadOf(101),
      eventId: "ev_ctx1",
      calendarId: "cal_x@group.calendar.google.com",
      credentialRef: null,
      startISO: inHours(2),
      summary: "Consulta – Ana",
      calendarLabel: "Agenda Dra. Ana",
      // Every offset of [24, 1] is already in the past for a booking 2h out except the 1h one, and
      // after it fires no job is left. The record is what carries the appointment into this turn.
      reminders: { offsetsHours: [24, 1], askConfirmationOnLast: true },
      base: appDb,
    });
    // NOTE: suDb, not appDb. The app connection is the RLS-fenced runtime role, and a statement
    // that does not go through runScopedOn carries no `app.tenant_id`, so it matches ZERO rows and
    // reports success. Written on appDb this DELETE removed nothing, and the test then proved the
    // prompt block survives reminder rows that were still sitting there — not what it says.
    await suDb.$executeRawUnsafe(
      `DELETE FROM scheduler_jobs WHERE tenant_id = ${tenantId}`,
    );
    const prompt = await promptFor(101);
    expect(prompt).toContain("## Agendamentos deste atendimento");
    expect(prompt).toContain('event_id="ev_ctx1"');
    expect(prompt).toContain('calendar_id="cal_x@group.calendar.google.com"');
    expect(prompt).toContain('summary="Consulta – Ana"');
    // No GOOGLE_CALENDAR tool grant on this agent ⇒ the block is read-only (no tool pointer).
    expect(prompt).not.toContain("calendar_update_event");
  });

  test("a conversation without appointments gets no block", async () => {
    await seedConversation(102);
    const prompt = await promptFor(102);
    expect(prompt).not.toContain("## Agendamentos deste atendimento");
  });

  test("cancelAppointment retires the record: the appointment never resurfaces", async () => {
    await seedConversation(103);
    await appointmentBooked({
      tenantId,
      threadId: threadOf(103),
      eventId: "ev_ctx2",
      calendarId: "primary",
      credentialRef: null,
      startISO: inHours(48),
      summary: "Retorno",
      calendarLabel: null,
      reminders: { offsetsHours: [24, 1], askConfirmationOnLast: true },
      base: appDb,
    });
    const before = await runScopedOn(appDb, sysCtx(), (db) =>
      loadAppointmentContext(db, tenantId, threadOf(103)),
    );
    expect(before.map((e) => e.eventId)).toEqual(["ev_ctx2"]);
    expect(before[0]?.summary).toBe("Retorno");

    await cancelAppointment(tenantId, "ev_ctx2", appDb);
    const after = await runScopedOn(appDb, sysCtx(), (db) =>
      loadAppointmentContext(db, tenantId, threadOf(103)),
    );
    expect(after).toEqual([]);
    const prompt = await promptFor(103);
    expect(prompt).not.toContain("## Agendamentos deste atendimento");
  });

  // NOTE: hasLiveAppointment is the follow-up suppression predicate (issue #39), reading the same
  // record the block above does. Covered here because this file already owns the fixtures.
  test("hasLiveAppointment: true while the start is ahead, false once cancelled", async () => {
    await seedConversation(104);
    await appointmentBooked({
      tenantId,
      threadId: threadOf(104),
      eventId: "ev_ctx3",
      calendarId: "primary",
      credentialRef: null,
      startISO: inHours(48),
      summary: null,
      calendarLabel: null,
      reminders: { offsetsHours: [24, 1], askConfirmationOnLast: true },
      base: appDb,
    });
    expect(await hasLiveAppointment(tenantId, threadOf(104), appDb)).toBe(true);
    await cancelAppointment(tenantId, "ev_ctx3", appDb);
    expect(await hasLiveAppointment(tenantId, threadOf(104), appDb)).toBe(
      false,
    );
  });

  // (#376) The two configurations that used to write no scheduler row, and so left the platform with
  // no appointment at all. Both assert the RECORD's consequences, not the row count: the pause
  // predicate and the prompt block.
  test("(#376) an appointment booked with reminders switched off still stands", async () => {
    await seedConversation(106);
    const res = await appointmentBooked({
      tenantId,
      threadId: threadOf(106),
      eventId: "ev_noreminders",
      calendarId: "primary",
      credentialRef: null,
      startISO: inHours(48),
      summary: "Avaliação",
      calendarLabel: null,
      // What the Calendar toolpack passes when `appointments.enabled` is off for the integration.
      reminders: null,
      base: appDb,
    });
    expect(res).toEqual({ record: "recorded", remindersArmed: 0 });
    expect(await hasLiveAppointment(tenantId, threadOf(106), appDb)).toBe(true);
    const prompt = await promptFor(106);
    expect(prompt).toContain('event_id="ev_noreminders"');
  });

  test("(#376) an appointment sooner than the smallest offset arms nothing and still stands", async () => {
    await seedConversation(107);
    const res = await appointmentBooked({
      tenantId,
      threadId: threadOf(107),
      eventId: "ev_soon",
      calendarId: "primary",
      credentialRef: null,
      // 30 minutes out: both default offsets are already behind us, so computeReminderJobs yields
      // nothing to enqueue. That is correct for a JOB and was fatal for the record.
      startISO: inHours(0.5),
      summary: "Encaixe",
      calendarLabel: null,
      reminders: { offsetsHours: [24, 1], askConfirmationOnLast: true },
      base: appDb,
    });
    expect(res).toEqual({ record: "recorded", remindersArmed: 0 });
    // Scoped, and by THIS appointment's dedupe prefix. Two ways to read zero here are wrong: an
    // unscoped count on the app connection answers zero under RLS whatever is in the table (the
    // assertion would hold with the fix reverted), and a tenant-wide count is answered by the rows
    // the tests above left behind.
    expect(
      await runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.count({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: { startsWith: "reminder:ev_soon:" },
          },
        }),
      ),
    ).toBe(0);
    // The control, on the same connection and the same shape: a booking far enough out DOES arm.
    expect(
      await runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.count({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: { startsWith: "reminder:ev_ctx2:" },
          },
        }),
      ),
    ).toBeGreaterThan(0);
    expect(await hasLiveAppointment(tenantId, threadOf(107), appDb)).toBe(true);
    const prompt = await promptFor(107);
    expect(prompt).toContain('event_id="ev_soon"');
  });

  // (#376) A reschedule is cancel-then-book on the SAME id, which is what `calendar_update_event`
  // does when the start changes. If the re-book did not clear the tombstone the appointment would
  // vanish from the platform at the exact moment the customer moved it, taking the pause and the
  // prompt block with it.
  test("(#376) rescheduling an appointment leaves it standing, at the new time", async () => {
    await seedConversation(109);
    await appointmentBooked({
      tenantId,
      threadId: threadOf(109),
      eventId: "ev_resched",
      calendarId: "primary",
      credentialRef: null,
      startISO: inHours(48),
      summary: "Consulta",
      calendarLabel: null,
      reminders: { offsetsHours: [24, 1], askConfirmationOnLast: true },
      base: appDb,
    });
    await cancelAppointment(tenantId, "ev_resched", appDb);
    expect(await hasLiveAppointment(tenantId, threadOf(109), appDb)).toBe(
      false,
    );

    const movedTo = inHours(72);
    await appointmentBooked({
      tenantId,
      threadId: threadOf(109),
      eventId: "ev_resched",
      calendarId: "primary",
      credentialRef: null,
      startISO: movedTo,
      summary: "Consulta",
      calendarLabel: null,
      reminders: { offsetsHours: [24, 1], askConfirmationOnLast: true },
      base: appDb,
    });
    expect(await hasLiveAppointment(tenantId, threadOf(109), appDb)).toBe(true);
    const events = await runScopedOn(appDb, sysCtx(), (db) =>
      loadAppointmentContext(db, tenantId, threadOf(109)),
    );
    // One appointment, not two: the record is keyed by the booking's own id.
    expect(events).toHaveLength(1);
    expect(events[0]?.startISO).toBe(movedTo);
  });

  // (#376) The order inside appointmentBooked is load-bearing in two directions, and this is the
  // one a concurrency test cannot reach: arming fails, and the appointment still has to be known,
  // because "the platform forgot the appointment" is the entire defect this unit exists for.
  test("(#376) arming that throws still leaves the appointment recorded, and still reports", async () => {
    await seedConversation(110);
    let thrown: unknown;
    try {
      await appointmentBooked(
        {
          tenantId,
          threadId: threadOf(110),
          eventId: "ev_armfail",
          calendarId: "primary",
          credentialRef: null,
          startISO: inHours(48),
          summary: "Consulta",
          calendarLabel: null,
          reminders: { offsetsHours: [24, 1], askConfirmationOnLast: true },
          base: appDb,
        },
        async () => {
          throw new Error("scheduler unavailable");
        },
      );
    } catch (e) {
      thrown = e;
    }
    // Reported, not swallowed: prepare.ts turns this into the operator-visible warn.
    expect((thrown as Error)?.message).toBe("scheduler unavailable");
    // And the appointment stands anyway.
    expect(await hasLiveAppointment(tenantId, threadOf(110), appDb)).toBe(true);
    expect(
      await runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.count({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: { startsWith: "reminder:ev_armfail:" },
          },
        }),
      ),
    ).toBe(0);
  });

  test("(#376) a start nobody can parse yields no record, and says so", async () => {
    await seedConversation(108);
    const res = await appointmentBooked({
      tenantId,
      threadId: threadOf(108),
      eventId: "ev_impossible",
      calendarId: "primary",
      credentialRef: null,
      // Date.parse rolls this to March 2; parseStartMs refuses it, and so must both halves.
      startISO: "2026-02-30T10:00:00Z",
      summary: "Impossível",
      calendarLabel: null,
      reminders: { offsetsHours: [24, 1], askConfirmationOnLast: true },
      base: appDb,
    });
    expect(res).toEqual({ record: "unreadable-start", remindersArmed: 0 });
    expect(await hasLiveAppointment(tenantId, threadOf(108), appDb)).toBe(
      false,
    );
  });

  // (#352) An id is only unique WITHIN the system that issued it, and a tool definition can now
  // declare bookings from a system that is not Google. Two systems that both count from 1 land on
  // the same id, and while the record's key was (tenant, external id) alone the second booking
  // MOVED the first one and a cancel on either retired both.
  test("(#352) two systems may issue the same id without touching each other", async () => {
    await seedConversation(111);
    const shared = "42";
    for (const provider of ["feegow", "clinicorp"]) {
      await appointmentBooked({
        tenantId,
        threadId: threadOf(111),
        provider,
        eventId: shared,
        calendarId: null,
        credentialRef: null,
        startISO: inHours(provider === "feegow" ? 48 : 72),
        summary: `Consulta ${provider}`,
        calendarLabel: null,
        reminders: { offsetsHours: [24], askConfirmationOnLast: false },
        base: appDb,
      });
    }
    const both = await runScopedOn(appDb, sysCtx(), (db) =>
      loadAppointmentContext(db, tenantId, threadOf(111)),
    );
    expect(both.map((e) => e.provider)).toEqual(["feegow", "clinicorp"]);
    // And no calendar is invented for them: the block would otherwise hand the model a calendar_id
    // for a booking Google has never heard of.
    expect(both.map((e) => e.calendarId)).toEqual([null, null]);
    expect(both.map((e) => e.summary)).toEqual([
      "Consulta feegow",
      "Consulta clinicorp",
    ]);
    // The reminder jobs are keyed the same way, or the second arm would have replaced the first.
    expect(
      await runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.count({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: {
              in: ["feegow/42:24", "clinicorp/42:24"].map(
                (k) => `reminder:${k}`,
              ),
            },
          },
        }),
      ),
    ).toBe(2);

    // Cancelling one leaves the other standing, record and reminder alike.
    await cancelAppointment(tenantId, shared, appDb, "feegow");
    const left = await runScopedOn(appDb, sysCtx(), (db) =>
      loadAppointmentContext(db, tenantId, threadOf(111)),
    );
    expect(left.map((e) => e.provider)).toEqual(["clinicorp"]);
    expect(
      await runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.count({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:clinicorp/42:24",
            status: "PENDING",
          },
        }),
      ),
    ).toBe(1);
    expect(await hasLiveAppointment(tenantId, threadOf(111), appDb)).toBe(true);
  });

  // (#352, and the reason the provider is a COLUMN.) The block's Google instruction is written into
  // the system prompt of a real turn, and the same block can hold appointments that answer to it and
  // appointments that do not. Measured on the prompt `loadAgentConfig` actually produces, with the
  // Calendar write tools genuinely granted — the configuration where the model was previously told
  // to cancel a Feegow booking with calendar_cancel_event.
  test("(#352) the real prompt scopes the Google instruction to Google bookings", async () => {
    await seedConversation(113);
    const instance = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "GOOGLE_CALENDAR",
        name: `cal-${process.pid}`,
        config: {},
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId,
        source: "INTEGRATION",
        integrationInstanceId: instance.id,
        knowledgeBaseIds: [],
        enabledTools: ["calendar_create_event", "calendar_cancel_event"],
      },
    });
    await appointmentBooked({
      tenantId,
      threadId: threadOf(113),
      eventId: "ev_google_mix",
      calendarId: "cal@group.calendar.google.com",
      credentialRef: "vault:1",
      startISO: inHours(24),
      summary: "Consulta Google",
      calendarLabel: "Agenda Dra. Ana",
      reminders: null,
      base: appDb,
    });
    await appointmentBooked({
      tenantId,
      threadId: threadOf(113),
      provider: "feegow",
      eventId: "77",
      calendarId: null,
      credentialRef: null,
      startISO: inHours(30),
      summary: "Consulta Feegow",
      calendarLabel: null,
      reminders: null,
      base: appDb,
    });
    const prompt = await promptFor(113);
    // The grant is real, so the Google affordance is there...
    expect(prompt).toContain("calendar_cancel_event");
    expect(prompt).toContain('event_id="ev_google_mix"');
    expect(prompt).toContain('calendar_id="cal@group.calendar.google.com"');
    // ...and the foreign booking is named as foreign, with no calendar invented for it and the
    // Google tools explicitly fenced off.
    expect(prompt).toContain('event_id="77"');
    expect(prompt).toContain('source="feegow"');
    expect(prompt).toContain("nunca calendar_update_event");
    expect(prompt).not.toContain('event_id="77" calendar_id=');
  });

  // A booking RE-STATED at an earlier time. Arming only writes the offsets whose reminder time is
  // still ahead, so the offsets the new start outran keep their old row: same dedupe key, old run
  // time, old start in the payload. Measured on the un-fixed build: a booking 30h out with [24, 1],
  // re-stated 2h out, left `reminder:<id>:24` PENDING to fire FOUR HOURS AFTER the appointment had
  // already happened, describing the wrong day — and nothing downstream catches it, because
  // `reminderAlreadyStarted` reads the payload's own stale start and a booking with no Google
  // credential has no live event to be corrected against.
  test("(#352) re-stating a booking earlier retires the reminders it outran", async () => {
    await seedConversation(114);
    const book = (hoursOut: number) =>
      appointmentBooked({
        tenantId,
        threadId: threadOf(114),
        provider: "feegow",
        eventId: "restated",
        calendarId: null,
        credentialRef: null,
        startISO: inHours(hoursOut),
        summary: null,
        calendarLabel: null,
        reminders: { offsetsHours: [24, 1], askConfirmationOnLast: false },
        base: appDb,
      });
    const rows = () =>
      runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.findMany({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: { startsWith: "reminder:feegow/restated:" },
          },
          orderBy: { dedupeKey: "asc" },
          select: { dedupeKey: true, status: true, payload: true },
        }),
      );

    await book(30);
    expect((await rows()).map((r) => [r.dedupeKey, r.status])).toEqual([
      ["reminder:feegow/restated:1", "PENDING"],
      ["reminder:feegow/restated:24", "PENDING"],
    ]);

    await book(2);
    const after = await rows();
    const tomb = (p: unknown) =>
      (p as { cancelledAt?: string } | null)?.cancelledAt !== undefined;
    // The 24h offset is 22 hours in the past for the new start, so nothing re-arms it: it has to be
    // retired, or it fires on its own old schedule.
    expect(after.map((r) => [r.dedupeKey, r.status, tomb(r.payload)])).toEqual([
      ["reminder:feegow/restated:1", "PENDING", false],
      ["reminder:feegow/restated:24", "DONE", true],
    ]);
    // And the survivor carries the NEW start, not the one it was armed with.
    const survivorStart = (after[0]?.payload as { startISO?: string } | null)
      ?.startISO;
    expect(typeof survivorStart).toBe("string");
    expect(Date.parse(survivorStart as string) - Date.now()).toBeLessThan(
      3 * 3_600_000,
    );
  });

  // The control, and the reason the retire is unconditional: reminders switched OFF between two
  // statements of the same booking must not leave the first statement's reminders firing.
  test("(#352) re-stating with reminders off leaves nothing armed", async () => {
    await seedConversation(115);
    await appointmentBooked({
      tenantId,
      threadId: threadOf(115),
      provider: "feegow",
      eventId: "off_after",
      calendarId: null,
      credentialRef: null,
      startISO: inHours(30),
      summary: null,
      calendarLabel: null,
      reminders: { offsetsHours: [24], askConfirmationOnLast: false },
      base: appDb,
    });
    await appointmentBooked({
      tenantId,
      threadId: threadOf(115),
      provider: "feegow",
      eventId: "off_after",
      calendarId: null,
      credentialRef: null,
      startISO: inHours(30),
      summary: null,
      calendarLabel: null,
      reminders: null,
      base: appDb,
    });
    expect(
      await runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.count({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: { startsWith: "reminder:feegow/off_after:" },
            status: "PENDING",
          },
        }),
      ),
    ).toBe(0);
    // The appointment itself still stands — retiring the reminders is not cancelling the booking.
    expect(await hasLiveAppointment(tenantId, threadOf(115), appDb)).toBe(true);
  });

  // The OTHER edge of the same unconditional retire (#352, round 5). A start the platform cannot
  // read is not a re-statement: `recordAppointment` refuses to move the record on it and writes
  // nothing, so the previous booking goes on standing at its old start. Retiring on that path would
  // take its reminders with it and arm nothing back, leaving a live appointment the customer is
  // never reminded of — and the only signal is the unreadable-start warning, which says nothing
  // about reminders.
  test("(#352) an unreadable re-statement leaves the standing booking's reminders alone", async () => {
    await seedConversation(117);
    const book = (startISO: string) =>
      appointmentBooked({
        tenantId,
        threadId: threadOf(117),
        provider: "feegow",
        eventId: "unreadable",
        calendarId: null,
        credentialRef: null,
        startISO,
        summary: null,
        calendarLabel: null,
        reminders: { offsetsHours: [24], askConfirmationOnLast: false },
        base: appDb,
      });
    const pending = () =>
      runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.count({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: { startsWith: "reminder:feegow/unreadable:" },
            status: "PENDING",
          },
        }),
      );

    expect((await book(inHours(48))).remindersArmed).toBe(1);
    expect(await pending()).toBe(1);

    // The operator's system answered with something no date parser accepts.
    const again = await book("next tuesday-ish");
    expect(again.record).toBe("unreadable-start");
    expect(again.remindersArmed).toBe(0);

    // Both halves are untouched: the appointment still stands at the readable start, and its
    // reminder is still armed for it.
    expect(await pending()).toBe(1);
    expect(await hasLiveAppointment(tenantId, threadOf(117), appDb)).toBe(true);
  });

  // (#352, round 10) The retire has to survive the re-arm that FOLLOWS it. `isRetired` asks two
  // questions — is there a tombstone, and did the claim token move — and the re-arm answers the first
  // one away: enqueueJob's upsert replaces the payload wholesale, so a row a handler had already
  // CLAIMED comes back with no stamp. Without the token moving too, that handler goes on to send a
  // reminder built from its claim-time payload, announcing the start the re-statement just replaced.
  // The very defect the retire exists to prevent, through the in-flight door instead of a leftover
  // PENDING row.
  test("(#352) a re-statement retires the reminder a handler is already running", async () => {
    await seedConversation(119);
    const book = (hoursOut: number) =>
      appointmentBooked({
        tenantId,
        threadId: threadOf(119),
        provider: "feegow",
        eventId: "inflight",
        calendarId: null,
        credentialRef: null,
        startISO: inHours(hoursOut),
        summary: null,
        calendarLabel: null,
        reminders: { offsetsHours: [24], askConfirmationOnLast: false },
        base: appDb,
      });
    const readRow = () =>
      runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.findFirstOrThrow({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:feegow/inflight:24",
          },
          select: { id: true, claimSeq: true, payload: true, status: true },
        }),
      );

    await book(48);
    // A worker picks it up: this is the snapshot the running handler holds.
    const before = await readRow();
    await runScopedOn(appDb, sysCtx(), (db) =>
      db.schedulerJob.update({
        where: { id: before.id },
        data: { status: "CLAIMED" },
      }),
    );
    const claimed: ClaimedJob = {
      id: before.id,
      tenantId,
      kind: "APPOINTMENT_REMINDER",
      payload: before.payload as Record<string, unknown>,
      attempts: 0,
      claimSeq: before.claimSeq,
    };

    // The customer moves the appointment while that handler is mid-run. 36h out keeps the 24h offset
    // alive, so the row is re-armed rather than left retired — which is what clears the tombstone.
    await book(36);
    const after = await readRow();
    expect(
      (after.payload as { cancelledAt?: unknown } | null)?.cancelledAt,
    ).toBeUndefined();

    // Neither signal is the tombstone, so the token is the one that has to have moved.
    expect(await jobRetired(claimed, appDb)).toBe(true);
  });

  // (#352, round 5) "primary" is a real Google calendar. A booking that lives in the operator's own
  // system has no calendar at all, and the payload is what the nudge's fenced data is built from, so
  // a fill-in here reaches the model as `calendar_id=primary` for an appointment Google never saw.
  // The context block already answers this question by emitting no calendar_id for those bookings.
  test("(#352) a declared booking arms reminders with no calendar id", async () => {
    await seedConversation(118);
    await appointmentBooked({
      tenantId,
      threadId: threadOf(118),
      provider: "feegow",
      eventId: "nocal",
      calendarId: null,
      credentialRef: null,
      startISO: inHours(48),
      summary: null,
      calendarLabel: null,
      reminders: { offsetsHours: [24], askConfirmationOnLast: false },
      base: appDb,
    });
    const row = await runScopedOn(appDb, sysCtx(), (db) =>
      db.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "APPOINTMENT_REMINDER",
          dedupeKey: "reminder:feegow/nocal:24",
        },
        select: { payload: true },
      }),
    );
    expect((row?.payload as { calendarId?: unknown } | null)?.calendarId).toBe(
      null,
    );
    // (#352, round 8) And the payload says WHICH system, because two of them may issue the same id:
    // the reminder turn holds `42` and, without this, no way to name the system that issued it.
    expect((row?.payload as { provider?: unknown } | null)?.provider).toBe(
      "feegow",
    );

    // The control: a Google booking with no explicit calendar still gets Google's own default.
    await appointmentBooked({
      tenantId,
      threadId: threadOf(118),
      eventId: "gcal",
      calendarId: null,
      credentialRef: "vault:1",
      startISO: inHours(48),
      summary: null,
      calendarLabel: null,
      reminders: { offsetsHours: [24], askConfirmationOnLast: false },
      base: appDb,
    });
    const gRow = await runScopedOn(appDb, sysCtx(), (db) =>
      db.schedulerJob.findFirst({
        where: {
          tenantId,
          kind: "APPOINTMENT_REMINDER",
          dedupeKey: "reminder:gcal:24",
        },
        select: { payload: true },
      }),
    );
    expect((gRow?.payload as { calendarId?: unknown } | null)?.calendarId).toBe(
      "primary",
    );
    expect((gRow?.payload as { provider?: unknown } | null)?.provider).toBe(
      "google_calendar",
    );
  });

  // The reminder key is read back by PREFIX, so an id that contains the delimiter puts a second
  // appointment inside the first one's prefix. A declared id is whatever the operator's system
  // answers with, and `clinic:123` is an ordinary shape.
  test("(#352) an id containing the delimiter does not reach its neighbour", async () => {
    await seedConversation(116);
    for (const eventId of ["foo", "foo:bar"]) {
      await appointmentBooked({
        tenantId,
        threadId: threadOf(116),
        provider: "clinic",
        eventId,
        calendarId: null,
        credentialRef: null,
        startISO: inHours(48),
        summary: eventId,
        calendarLabel: null,
        reminders: { offsetsHours: [24], askConfirmationOnLast: false },
        base: appDb,
      });
    }
    const pending = () =>
      runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.findMany({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            status: "PENDING",
            dedupeKey: { startsWith: "reminder:clinic/" },
          },
          select: { dedupeKey: true },
        }),
      );
    // Sorted here, never by the database: `%` and `:` order differently under different collations,
    // and the CI runs a different one from this machine.
    const keys = async () => (await pending()).map((r) => r.dedupeKey).sort();
    expect(await keys()).toEqual([
      "reminder:clinic/foo%3Abar:24",
      "reminder:clinic/foo:24",
    ]);

    // Retiring `foo` must not reach `foo:bar`, whose key would sit inside `reminder:clinic/foo:`
    // if the id were not encoded.
    await cancelAppointment(tenantId, "foo", appDb, "clinic");
    expect(await keys()).toEqual(["reminder:clinic/foo%3Abar:24"]);
    const left = await runScopedOn(appDb, sysCtx(), (db) =>
      loadAppointmentContext(db, tenantId, threadOf(116)),
    );
    expect(left.map((e) => e.eventId)).toEqual(["foo:bar"]);
  });

  // The other half of the same rule: a Google appointment keeps the BARE event id in its dedupe key,
  // because every reminder armed before providers existed is keyed that way and a cancel that
  // started prefixing them would leave a real customer reminder firing.
  test("(#352) a Google appointment's reminder key is unchanged", async () => {
    await seedConversation(112);
    await appointmentBooked({
      tenantId,
      threadId: threadOf(112),
      eventId: "ev_gcal_key",
      calendarId: "primary",
      credentialRef: "vault:1",
      startISO: inHours(48),
      summary: null,
      calendarLabel: null,
      reminders: { offsetsHours: [24], askConfirmationOnLast: false },
      base: appDb,
    });
    expect(
      await runScopedOn(appDb, sysCtx(), (db) =>
        db.schedulerJob.count({
          where: {
            tenantId,
            kind: "APPOINTMENT_REMINDER",
            dedupeKey: "reminder:ev_gcal_key:24",
          },
        }),
      ),
    ).toBe(1);
  });
});
