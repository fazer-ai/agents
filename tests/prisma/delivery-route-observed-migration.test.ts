import { describe, expect, test } from "bun:test";

// What the backfill reaches, which no test against a freshly migrated database can see: rows written
// by the previous build. A null role is not replayed (guessing "the responder's" loses an
// observation on an unanswered inbox and duplicates one on an answered inbox), which is wrong for
// pre-existing rows, where observers did not exist and the route was always a responder's. So the
// backfill covers every status recovery can still pick up, DEAD included: `DELIVERY_RECOVERY`
// reclaims DEAD rows (`claimFrom: "DEAD"`), and a null role there is refused after an inbox rebind.

const MIGRATION =
  "prisma/migrations/20260903130000_delivery_route_observed/migration.sql";

describe("migration: the delivery's route role", () => {
  test("backfills every status the recovery can still reclaim, and only those", async () => {
    const sql = await Bun.file(MIGRATION).text();
    const update = sql
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("UPDATE"));
    expect(update).toBeDefined();
    const statuses = [...(update ?? "").matchAll(/'([A-Z_]+)'/g)].map(
      (m) => m[1],
    );
    // PROCESSED is the only genuinely terminal status: nothing replays it, so leaving it null keeps
    // the write off the table's history and on its worklist.
    expect(new Set(statuses)).toEqual(
      new Set(["PENDING", "PROCESSING", "DEAD"]),
    );
    // FALSE, and it is a statement of fact: observers did not exist before this column.
    expect(update).toContain('"route_observed" = false');
    expect(update).toContain('"route_observed" IS NULL');
  });

  test("brackets the write, because the table forces row-level security", async () => {
    const sql = await Bun.file(MIGRATION).text();
    const noForce = sql.indexOf("NO FORCE ROW LEVEL SECURITY");
    const write = sql.indexOf("UPDATE");
    const force = sql.lastIndexOf("FORCE ROW LEVEL SECURITY");
    expect(noForce).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(noForce);
    expect(force).toBeGreaterThan(write);
  });
});
