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
});
