import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { seedChatwootInstance } from "../utils/chatwoot";

// NOTE: End-to-end wiring of the schedule variables: the agent's BusinessHours row → the system
// prompt the model is handed at turn prep. The truth table for each value lives in the unit test
// (tests/graph/prompt.test.ts); what this file proves is that the whole schedule travels — the
// weekly grid, its dated exceptions and its timezone — and not just the timezone, which is all the
// read carried before. No model and no Chatwoot call are involved.

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
let hoursId = "";
let agentScheduled = 0n;
let agentAlwaysOn = 0n;
const CONV_ID = 7810;
const PROMPT =
  "Aberto: {{esta_aberto}} | Volta: {{proximo_atendimento}} | Horário: {{horario_atendimento}}";

function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

// `promptNow` is the product's own time simulation (the playground's), and the only injection point
// this path has. The two cases that do NOT use it assert values a schedule renders the same at any
// instant, so the real, un-simulated path is covered too.
const load = (agentId: bigint, promptNow?: string, businessHoursId?: string) =>
  runScopedOn(appDb, ctx(tenantId), (db) =>
    loadAgentConfig(
      db,
      {
        tenantId,
        instanceId,
        conversationId: CONV_ID,
        agentId,
        threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
      },
      promptNow || businessHoursId !== undefined
        ? { overrides: { promptNow, businessHoursId } }
        : undefined,
    ),
  );

describe.skipIf(!dbUp)("schedule variables in the system prompt", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SC", slug: `sc-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 1,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const keyId = (
      await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      })
    ).id;
    const mc = {
      provider: "openai",
      model: "gpt-4o-mini",
      credentialRef: `vault:${keyId}`,
    };
    // Mon–Fri 09:00–18:00, with Friday 2026-08-21 closed. The exception is the whole point: a read
    // that carried only the weekly grid would answer that Friday, eleven hours out, instead of the
    // Monday the gate will actually honour.
    const hours = await suDb.businessHours.create({
      data: {
        tenantId,
        name: "Comercial",
        timezone: "America/Sao_Paulo",
        windows: [1, 2, 3, 4, 5].map((day) => ({
          day,
          start: "09:00",
          end: "18:00",
        })),
        exceptions: [{ date: "2026-08-21", label: "Feriado", ranges: [] }],
      },
      select: { id: true },
    });
    hoursId = String(hours.id);
    agentScheduled = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Com horário",
          systemPrompt: PROMPT,
          modelConfig: mc,
          businessHoursId: hours.id,
        },
      })
    ).id;
    agentAlwaysOn = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Sem horário",
          systemPrompt: PROMPT,
          modelConfig: mc,
        },
      })
    ).id;
    const contact = await suDb.contact.create({
      data: { tenantId, chatwootContactId: 4343, name: "Maria" },
    });
    await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: CONV_ID,
        contactId: contact.id,
        status: "pending",
        threadId: `${tenantId}:${instanceId}:${CONV_ID}`,
      },
    });
  });

  afterAll(async () => {
    if (dbUp && tenantId) {
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await app?.$disconnect();
    await su?.$disconnect();
  });

  test("an agent with no Availability says so, at any hour", async () => {
    const cfg = await load(agentAlwaysOn);
    expect(cfg?.systemPrompt).toBe(
      "Aberto: sim | Volta: agora | Horário: sempre aberto",
    );
  });

  test("the weekly grid reaches the prompt", async () => {
    const cfg = await load(agentScheduled);
    expect(cfg?.systemPrompt).toContain("Horário: seg.–sex. 09:00–18:00");
  });

  test("outside the window, the next opening skips a dated closure", async () => {
    // Thursday 22:00. The grid alone answers Friday; the exception moves it to Monday. One assertion
    // over the whole read: without `windows` it cannot be closed, without `exceptions` it answers
    // Friday, and without the row's timezone 22:00 lands in a different local day.
    const cfg = await load(agentScheduled, "2026-08-20T22:00");
    expect(cfg?.systemPrompt).toBe(
      "Aberto: não | Volta: segunda-feira, 24/08, 09:00 | Horário: seg.–sex. 09:00–18:00",
    );
  });

  test("the playground's unsaved Availability wins over the saved column", async () => {
    // The operator picked a schedule in the Behavior tab and hit the playground before saving. The
    // agent has none saved, so without the draft this answers "sim / agora / sempre aberto" — the
    // config the picker no longer shows, which is the exact drift these variables exist to remove.
    const cfg = await load(agentAlwaysOn, "2026-08-20T22:00", hoursId);
    expect(cfg?.systemPrompt).toBe(
      "Aberto: não | Volta: segunda-feira, 24/08, 09:00 | Horário: seg.–sex. 09:00–18:00",
    );
  });

  test("clearing the picker reads as no schedule, not as the saved one", async () => {
    const cfg = await load(agentScheduled, "2026-08-20T22:00", "");
    expect(cfg?.systemPrompt).toBe(
      "Aberto: sim | Volta: agora | Horário: sempre aberto",
    );
  });

  test("an unresolvable draft id falls through to always-on", async () => {
    // Console input. A row this tenant cannot read (or an id that is not one) must not silently fall
    // back to the saved schedule: the answer would then describe a config nobody selected.
    // "99999999999999999999" is the one that used to reach the database: digits, so the old regex
    // passed it, and past 2^63-1, so the query failed at BIND and took the whole turn with it.
    for (const bogus of [
      "999999999",
      "../etc",
      "0x1",
      "99999999999999999999",
    ]) {
      const cfg = await load(agentScheduled, "2026-08-20T22:00", bogus);
      expect(cfg?.systemPrompt).toBe(
        "Aberto: sim | Volta: agora | Horário: sempre aberto",
      );
    }
  });

  test("inside the window it reports open, with no future opening to promise", async () => {
    const cfg = await load(agentScheduled, "2026-08-20T12:00");
    expect(cfg?.systemPrompt).toContain("Aberto: sim | Volta: agora");
  });
});
