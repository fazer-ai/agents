import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { attendanceStartedAt } from "@/modules/memory/attendance-start";
import { seedChatwootInstance } from "../utils/chatwoot";

// Where the current attendance of a conversation starts, read from the compaction rows (issue #1128,
// the `attendance` scope of carrying a customer's files into a case).

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantId = 0n;
let otherTenantId = 0n;
let instanceId = 0n;

describe.skipIf(!dbUp)("attendanceStartedAt", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "Attendance start",
        slug: `attendance-start-${process.pid}`,
      },
    });
    tenantId = t.id;
    const other = await suDb.tenant.create({
      data: {
        name: "Attendance start other",
        slug: `attendance-start-o-${process.pid}`,
      },
    });
    otherTenantId = other.id;
    const inst = await seedChatwootInstance(suDb, { tenantId, accountId: 1 });
    instanceId = inst.id;
    const row = (
      conversationId: number,
      id: string,
      at: Date | null,
      contactInboxId = 301,
    ) => ({
      tenantId,
      chatwootInstanceId: instanceId,
      contactInboxId,
      conversationId,
      lastMessageId: id,
      summary: "resumo",
      messageCount: 2,
      attendanceAt: at,
    });
    // Conversation 7 was resolved, compacted, reopened and compacted again; 8 never was; 9 was cut with
    // the mirrored conversation gone; 7 under another contact-inbox is someone else's.
    await suDb.attendanceSummary.createMany({
      data: [
        row(7, "m1", new Date("2026-10-01T10:00:00Z")),
        row(7, "m2", new Date("2026-10-03T10:00:00Z")),
        row(9, "m3", null),
        row(7, "m4", new Date("2026-10-05T10:00:00Z"), 999),
      ],
    });
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await suDb.tenant.delete({ where: { id: otherTenantId } }).catch(() => {});
  });

  const ask = (
    conversationId: number,
    over: { tenantId?: bigint; contactInboxId?: number } = {},
  ) =>
    attendanceStartedAt(appDb, {
      tenantId: over.tenantId ?? tenantId,
      instanceId,
      contactInboxId: over.contactInboxId ?? 301,
      conversationId,
    });

  test("the newest cut of the conversation is where the open attendance starts", async () => {
    expect((await ask(7))?.toISOString()).toBe("2026-10-03T10:00:00.000Z");
  });

  test("a conversation never compacted has no boundary: the whole of it is current", async () => {
    expect(await ask(8)).toBeNull();
  });

  test("a cut with no date says nothing about where", async () => {
    expect(await ask(9)).toBeNull();
  });

  test("another contact-inbox's rows, and another tenant's, are not read", async () => {
    expect((await ask(7, { contactInboxId: 999 }))?.toISOString()).toBe(
      "2026-10-05T10:00:00.000Z",
    );
    expect(await ask(7, { tenantId: otherTenantId })).toBeNull();
  });
});
