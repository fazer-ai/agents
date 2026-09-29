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

  // NOTE: The backfill is one shot and the column has no DEFAULT, so a row the previous release
  // inserts afterwards keeps a null role. A default is not the fix: it would make an unclaimed row
  // say "the responder's", a false statement rather than a missing one. The deploy note is.
  test("is named in the deploy notes as wanting the old writer stopped", async () => {
    const notes = await Bun.file("docs/deploy.md").text();
    const para = notes
      .split("\n")
      .find((l) => l.includes("20260903130000_delivery_route_observed"));
    expect(para).toBeDefined();
    expect(para).toContain("stop the old process");
    const sql = await Bun.file(MIGRATION).text();
    expect(sql).toContain("STOP THE OLD PROCESS FIRST");
    // No DEFAULT on the column, which is what makes the note necessary rather than optional.
    expect(sql).toMatch(/ADD COLUMN "route_observed" BOOLEAN;/);
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
