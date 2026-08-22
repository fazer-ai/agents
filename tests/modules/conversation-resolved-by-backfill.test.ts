import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { seedChatwootInstance } from "../utils/chatwoot";

const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
if (suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as PrismaClient;

const MIGRATION =
  "prisma/migrations/20260822150000_conversation_resolved_by/migration.sql";

let tenantId = 0n;
let instanceId = 0n;

// The dashboard tells the operator that N conversations predate the recording, which is the whole
// defence against the funnel appearing to collapse on upgrade day. That promise is kept by ONE
// statement in the migration: without the backfill, every historical row reads as "resolved by
// somebody else" and the note never appears. So the statement is run here against seeded rows and
// its effect asserted, rather than the file being eyeballed.
describe.skipIf(!dbUp)("the resolved_by backfill", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "BACKFILL", slug: `backfill-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 21,
      baseUrl: "https://cw.example",
      adminToken: "enc",
    });
    instanceId = inst.id;
    for (const [convId, status] of [
      [101, "resolved"],
      [102, "resolved"],
      [103, "open"],
      [104, "pending"],
      [105, "snoozed"],
    ] as const) {
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: convId,
          status,
          threadId: `${tenantId}:${instanceId}:${convId}`,
        },
      });
    }
    // The column already exists (the migration ran when the test DB was built), so the rows above
    // start unstamped and stand in for the pre-migration state.
    await suDb.$executeRawUnsafe(
      `UPDATE conversations SET resolved_by = NULL WHERE tenant_id = ${tenantId}`,
    );
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await su?.$disconnect();
  });

  test("stamps every already-resolved row and nothing else", async () => {
    const sql = await Bun.file(MIGRATION).text();
    const update = sql
      .split(";")
      .map((chunk) =>
        chunk
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .find((chunk) => chunk.toUpperCase().startsWith("UPDATE"));
    // Pinning the statement is what keeps this test honest: it is scoped to one tenant below so a
    // parallel test file's rows are left alone, and that rewrite must not be able to hide a change
    // to what the migration actually does.
    expect(update).toBe(
      `UPDATE "conversations" SET "resolved_by" = 'legacy_unknown' WHERE "status" = 'resolved'`,
    );
    await suDb.$executeRawUnsafe(`${update} AND tenant_id = ${tenantId}`);

    const rows = await suDb.conversation.findMany({
      where: { tenantId },
      select: { chatwootConversationId: true, resolvedBy: true },
      orderBy: { chatwootConversationId: "asc" },
    });
    expect(rows).toEqual([
      { chatwootConversationId: 101, resolvedBy: "legacy_unknown" },
      { chatwootConversationId: 102, resolvedBy: "legacy_unknown" },
      { chatwootConversationId: 103, resolvedBy: null },
      { chatwootConversationId: 104, resolvedBy: null },
      { chatwootConversationId: 105, resolvedBy: null },
    ]);
  });
});
