import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  AGENT_EXPORT_KIND,
  AGENT_EXPORT_VERSION,
  type AgentExport,
  importAgent,
} from "@/modules/agents/transfer";
import {
  MAX_SCHEDULE_EXCEPTIONS,
  MAX_SCHEDULE_WINDOWS,
  parseSchedule,
  scheduleCanClose,
} from "@/modules/business-hours/hours";
import { outOfHoursGate } from "@/modules/chatwoot/webhook";

// Issue #346. The import writes the two schedule JSON columns straight through
// (`exportedBusinessHoursSchema` takes them as `z.array(z.unknown())`), so a hand-authored or
// hand-edited bundle is the one writer that never answers to `businessHoursCreateSchema`. What makes
// it worth a test rather than a type is the DIRECTION of the failure: a grid that cannot be read is
// an EMPTY grid, and an empty grid is always open, so a typo in a bundle turns an agent that was
// closed at night into one that answers around the clock on the destination tenant.

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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const WEEK = [1, 2, 3, 4, 5].map((day) => ({
  day,
  start: "09:00",
  end: "18:00",
}));
// Thu 2026-08-27, 03:00 in São Paulo: outside every window above.
const NIGHT = new Date("2026-08-27T06:00:00Z");

// A bundle carrying exactly one schedule, which the agent references by name.
function bundle(
  hoursName: string,
  windows: unknown[],
  exceptions: unknown[] = [],
): AgentExport {
  return {
    version: AGENT_EXPORT_VERSION,
    kind: AGENT_EXPORT_KIND,
    agent: {
      name: hoursName,
      systemPrompt: "x",
      modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      settings: {},
      transferWithSummary: false,
      businessHours: hoursName,
      followUpHours: null,
      tools: [],
      credentials: [],
    },
    components: {
      httpTools: [],
      mcpServers: [],
      integrations: [],
      knowledgeBases: [],
      businessHours: [
        { name: hoursName, timezone: "America/Sao_Paulo", windows, exceptions },
      ],
    },
  } as AgentExport;
}

async function importSchedule(
  name: string,
  windows: unknown[],
  exceptions: unknown[] = [],
) {
  const { agent, warnings } = await importAgent(
    ctx(),
    bundle(name, windows, exceptions),
    appDb,
  );
  const row = await suDb.businessHours.findFirst({
    where: { tenantId, name },
    select: { id: true, windows: true, exceptions: true, timezone: true },
  });
  if (!row) throw new Error(`schedule ${name} was not created`);
  const linked = await suDb.agent.findUnique({
    where: { id: BigInt(agent.id) },
    select: { businessHoursId: true },
  });
  return { row, warnings, linkedTo: linked?.businessHoursId ?? null };
}

describe.skipIf(!dbUp)("importing a schedule with unreadable entries", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "IS", slug: `is-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM business_hours WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a clean bundle is stored verbatim and warns about nothing", async () => {
    // The control. Without it every assertion below is also satisfied by an import that drops
    // everything, or by one that warns unconditionally.
    const name = `limpa-${process.pid}`;
    const { row, warnings, linkedTo } = await importSchedule(name, WEEK);
    expect(row.windows).toEqual(WEEK);
    expect(warnings.filter((w) => w.code.startsWith("hours"))).toEqual([]);
    expect(linkedTo).toBe(row.id);
  });

  test("one unreadable window costs that window, not the schedule", async () => {
    const name = `torta-${process.pid}`;
    const { row, warnings, linkedTo } = await importSchedule(name, [
      ...WEEK,
      { day: 6, start: "10:00", ends: "14:00" },
    ]);
    // Stored cleaned, so the console shows what the runtime will actually honour and an
    // edit-and-save round trip cannot resurrect the entry.
    expect(row.windows).toEqual(WEEK);
    // And the agent is still CLOSED at 03:00 — asserted through the gate the webhook actually runs,
    // not through the parsed schedule, because "the schedule can close" is a proxy and "the agent is
    // silenced and the customer hears the away note" is the effect the issue reports.
    const schedule = parseSchedule(
      row as unknown as {
        windows: unknown;
        exceptions: unknown;
        timezone: string;
      },
    );
    expect(scheduleCanClose(schedule)).toBe(true);
    expect(outOfHoursGate(schedule, NIGHT, false)).toEqual({
      silence: true,
      postNote: true,
    });
    expect(linkedTo).toBe(row.id);
    const w = warnings.find((x) => x.code === "hoursWindowsDropped");
    expect(w?.params).toEqual({ name, count: 1 });
    expect(w?.target).toEqual({ kind: "businessHours", name });
  });

  test("one unreadable date exception costs that exception, not the holidays", async () => {
    const name = `feriado-${process.pid}`;
    const good = { date: "2026-09-07", label: "Independência", ranges: [] };
    const { row, warnings } = await importSchedule(name, WEEK, [
      good,
      { dateee: "2026-12-25", ranges: [] },
      // A date the regex accepts and the calendar does not: the write path refuses it too.
      { date: "2026-02-30", ranges: [] },
    ]);
    expect(row.exceptions).toEqual([good]);
    expect(
      warnings.find((x) => x.code === "hoursExceptionsDropped")?.params,
    ).toEqual({ name, count: 2 });
  });

  // Review round 1. The count is a per-ENTRY question, not a subtraction of array lengths: an
  // exception can survive and still lose something. `parseExceptions` prunes the ranges INSIDE an
  // exception it keeps, and an exception with no ranges means CLOSED ALL DAY, so a half-day written
  // backwards lands as a full-day closure. Safe direction, and still a schedule the operator did not
  // ask for, which is the silence this warning exists to break.
  test("a half-day whose range is backwards becomes a full closure, and says so", async () => {
    const name = `meia-${process.pid}`;
    const backwards = {
      date: "2026-12-24",
      label: "Véspera",
      ranges: [{ start: "14:00", end: "09:00" }],
    };
    const { row, warnings } = await importSchedule(name, WEEK, [backwards]);
    // Kept, not dropped: dropping it would let the weekly grid apply on Christmas Eve, which is the
    // always-open direction. It lands as the closure it now is.
    expect(row.exceptions).toEqual([
      { date: "2026-12-24", label: "Véspera", ranges: [] },
    ]);
    expect(
      warnings.find((x) => x.code === "hoursExceptionsDropped")?.params,
    ).toEqual({ name, count: 1 });
  });

  test("an exception that keeps one of two ranges is still counted", async () => {
    const name = `parcial-${process.pid}`;
    const { row, warnings } = await importSchedule(name, WEEK, [
      {
        date: "2026-12-24",
        ranges: [
          { start: "09:00", end: "12:00" },
          { start: "14:00", end: "09:00" },
        ],
      },
    ]);
    expect(row.exceptions).toEqual([
      { date: "2026-12-24", ranges: [{ start: "09:00", end: "12:00" }] },
    ]);
    expect(
      warnings.find((x) => x.code === "hoursExceptionsDropped")?.params,
    ).toEqual({ name, count: 1 });
  });

  test("an exception stored exactly as written warns about nothing", async () => {
    // The control for the two above: the per-entry check must not fire on a clean entry, or the
    // warning becomes noise and stops meaning anything.
    const name = `intacta-${process.pid}`;
    const clean = {
      date: "2026-12-24",
      ranges: [{ start: "09:00", end: "12:00" }],
    };
    const { row, warnings } = await importSchedule(name, WEEK, [clean]);
    expect(row.exceptions).toEqual([clean]);
    expect(warnings.filter((w) => w.code.startsWith("hours"))).toEqual([]);
  });

  test("a schedule cannot be imported larger than the API would accept", async () => {
    const name = `grande-${process.pid}`;
    const many = Array.from({ length: MAX_SCHEDULE_WINDOWS + 25 }, (_, i) => {
      const hh = String(i % 23).padStart(2, "0");
      return { day: i % 7, start: `${hh}:00`, end: `${hh}:59` };
    });
    const { row, warnings, linkedTo } = await importSchedule(name, many);
    expect((row.windows as unknown[]).length).toBe(MAX_SCHEDULE_WINDOWS);
    expect(
      warnings.find((x) => x.code === "hoursWindowsDropped")?.params,
    ).toEqual({ name, count: 25 });
    // Not skipped: skipping would leave the agent with no schedule at all, which is the always-open
    // state this whole change exists to keep unreachable.
    expect(linkedTo).toBe(row.id);
  });

  // Review round 2. The cap counts SURVIVORS, not positions: a malformed entry consumes no slot, so
  // every one of them before the cap used to over-report the loss by one.
  test("an unreadable window before the cap does not cost a valid one", async () => {
    const name = `contagem-${process.pid}`;
    const many = Array.from({ length: MAX_SCHEDULE_WINDOWS }, (_, i) => {
      const hh = String(i % 23).padStart(2, "0");
      return { day: i % 7, start: `${hh}:00`, end: `${hh}:59` };
    });
    const { row, warnings } = await importSchedule(name, [
      { day: 9, start: "x", end: "y" },
      ...many,
    ]);
    // All 200 valid windows land: the bad one did not push the last one past the cap.
    expect((row.windows as unknown[]).length).toBe(MAX_SCHEDULE_WINDOWS);
    expect(
      warnings.find((x) => x.code === "hoursWindowsDropped")?.params,
    ).toEqual({ name, count: 1 });
  });

  test("exceptions past the cap are refused by the WRITER, and named", async () => {
    // The reader no longer truncates these (a dropped closure widens availability), so this bound
    // exists only here, where the operator is told the count.
    const name = `muitas-${process.pid}`;
    const many = Array.from({ length: MAX_SCHEDULE_EXCEPTIONS + 12 }, () => ({
      date: "2026-01-01",
      ranges: [{ start: "09:00", end: "10:00" }],
    }));
    const { row, warnings } = await importSchedule(name, WEEK, many);
    expect((row.exceptions as unknown[]).length).toBe(MAX_SCHEDULE_EXCEPTIONS);
    expect(
      warnings.find((x) => x.code === "hoursExceptionsDropped")?.params,
    ).toEqual({ name, count: 12 });
  });

  test("a schedule whose every window is unreadable still lands, and says so", async () => {
    const name = `ilegivel-${process.pid}`;
    const { row, warnings, linkedTo } = await importSchedule(name, [
      { day: 9, start: "x", end: "y" },
      { day: 1 },
    ]);
    expect(row.windows).toEqual([]);
    // Always open is the honest reading of a grid with nothing in it — but the operator is told,
    // which is the difference between this and the defect.
    expect(
      warnings.find((x) => x.code === "hoursWindowsDropped")?.params,
    ).toEqual({ name, count: 2 });
    expect(linkedTo).toBe(row.id);
  });
});
