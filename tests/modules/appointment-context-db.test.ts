import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { loadAppointmentContext } from "@/modules/appointments/context";
import {
  cancelAppointmentReminders,
  enqueueAppointmentReminders,
  hasLiveAppointment,
} from "@/modules/appointments/reminders";
import { seedChatwootInstance } from "../utils/chatwoot";

// DB-backed mirror of issue #22: the appointment identity block must reach the system prompt on the
// turn AFTER the last reminder fired (job DONE, start still ahead) — and a cancelled appointment
// must never resurface.

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

  test("the turn after the LAST reminder still sees the appointment (DONE row, future start)", async () => {
    await seedConversation(101);
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_ctx1:1",
        status: "DONE",
        runAt: new Date(Date.now() - 3_600_000),
        payload: {
          threadId: threadOf(101),
          eventId: "ev_ctx1",
          calendarId: "cal_x@group.calendar.google.com",
          credentialRef: null,
          startISO: inHours(2),
          offsetHours: 1,
          isLast: true,
          askConfirmation: true,
          summary: "Consulta – Ana",
          calendarLabel: "Agenda Dra. Ana",
        },
      },
    });
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

  test("cancelAppointmentReminders tombstones the rows: the appointment never resurfaces", async () => {
    await seedConversation(103);
    await enqueueAppointmentReminders({
      tenantId,
      threadId: threadOf(103),
      eventId: "ev_ctx2",
      calendarId: "primary",
      credentialRef: null,
      startISO: inHours(48),
      offsetsHours: [24, 1],
      askConfirmationOnLast: true,
      summary: "Retorno",
      calendarLabel: null,
      base: appDb,
    });
    const before = await runScopedOn(appDb, sysCtx(), (db) =>
      loadAppointmentContext(db, tenantId, threadOf(103)),
    );
    expect(before.map((e) => e.eventId)).toEqual(["ev_ctx2"]);
    expect(before[0]?.summary).toBe("Retorno");

    await cancelAppointmentReminders(tenantId, "ev_ctx2", appDb);
    const after = await runScopedOn(appDb, sysCtx(), (db) =>
      loadAppointmentContext(db, tenantId, threadOf(103)),
    );
    expect(after).toEqual([]);
    const prompt = await promptFor(103);
    expect(prompt).not.toContain("## Agendamentos deste atendimento");
  });

  // NOTE: hasLiveAppointment is the follow-up suppression predicate (issue #39) — the same shared
  // liveness projection, adapted from a base PrismaClient. Covered here because this file already
  // owns the enqueue/cancel fixtures.
  test("hasLiveAppointment: true after the last reminder fired (DONE, future start)", async () => {
    await seedConversation(104);
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_ctx3:1",
        status: "DONE",
        runAt: new Date(Date.now() - 3_600_000),
        payload: {
          threadId: threadOf(104),
          eventId: "ev_ctx3",
          startISO: inHours(2),
        },
      },
    });
    expect(await hasLiveAppointment(tenantId, threadOf(104), appDb)).toBe(true);
  });

  test("hasLiveAppointment: false once the appointment is cancelled (tombstoned)", async () => {
    await seedConversation(105);
    await enqueueAppointmentReminders({
      tenantId,
      threadId: threadOf(105),
      eventId: "ev_ctx4",
      calendarId: "primary",
      credentialRef: null,
      startISO: inHours(48),
      offsetsHours: [24, 1],
      askConfirmationOnLast: true,
      summary: null,
      calendarLabel: null,
      base: appDb,
    });
    expect(await hasLiveAppointment(tenantId, threadOf(105), appDb)).toBe(true);
    await cancelAppointmentReminders(tenantId, "ev_ctx4", appDb);
    expect(await hasLiveAppointment(tenantId, threadOf(105), appDb)).toBe(
      false,
    );
  });
});
