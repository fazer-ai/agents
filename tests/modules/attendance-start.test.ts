import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { attendanceStartedAt } from "@/modules/memory/attendance-start";
import { seedChatwootInstance } from "../utils/chatwoot";

// Where the current attendance of a contact's thread starts, read from the compaction rows: the
// `attendance` scope of carrying a customer's files into a case.

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
    // Contact-inbox 301: conversation 7 was cut, then a cut folded 7 and 8 together under 8's name,
    // then one more was cut with its mirrored conversation gone, and a late cut wrote an earlier
    // attendance last. 302 only has an undated cut. 999 is someone else's thread.
    await suDb.attendanceSummary.createMany({
      data: [
        row(7, "m1", new Date("2026-10-01T10:00:00Z")),
        row(8, "m2", new Date("2026-10-03T10:00:00Z")),
        row(7, "m3", null),
        row(6, "m6", new Date("2026-10-02T10:00:00Z")),
        row(4, "m4", null, 302),
        row(7, "m5", new Date("2026-10-05T10:00:00Z"), 999),
      ],
    });
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await suDb.tenant.delete({ where: { id: otherTenantId } }).catch(() => {});
  });

  const ask = (over: { tenantId?: bigint; contactInboxId?: number } = {}) =>
    attendanceStartedAt(appDb, {
      tenantId: over.tenantId ?? tenantId,
      instanceId,
      contactInboxId: over.contactInboxId ?? 301,
    });

  test("the newest dated cut of the thread is where the open attendance starts, whichever conversation names it", async () => {
    expect((await ask())?.toISOString()).toBe("2026-10-03T10:00:00.000Z");
  });

  test("a thread never compacted has no boundary: all of it is current", async () => {
    expect(await ask({ contactInboxId: 303 })).toBeNull();
  });

  test("a cut with no date says nothing about where", async () => {
    expect(await ask({ contactInboxId: 302 })).toBeNull();
  });

  test("another contact-inbox's rows, and another tenant's, are not read", async () => {
    expect((await ask({ contactInboxId: 999 }))?.toISOString()).toBe(
      "2026-10-05T10:00:00.000Z",
    );
    expect(await ask({ tenantId: otherTenantId })).toBeNull();
  });
});
