import { describe, expect, test } from "bun:test";

// WHAT THE BACKFILL REACHES (issue #476), which is the half a behavioural test cannot: the statement
// decides what a delivery written by the PREVIOUS build says about its route after the upgrade, and
// no test that runs against a freshly migrated database ever sees such a row.
//
// The rule the column introduces is that a null role is not replayed — guessing "the responder's"
// loses an observation silently on an inbox nobody answers, and hands the responder a message its
// own route already carried on one it does. That rule is correct for rows written since, and wrong
// for every row written before, where observers did not exist and the route was always a
// responder's. So the backfill has to cover every status the recovery can still pick up.
//
// DEAD IS ONE OF THEM. The sweep's verdict is not the end of a delivery: `DELIVERY_RECOVERY`
// reclaims a DEAD row and replays it (`claimFrom: "DEAD"`). Left out, a pre-existing recovery whose
// inbox was rebound to another bot since is refused by an ambiguity check that did not exist when it
// stranded — a delivery the build before this one recovered against the current responder.

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

  // The backfill is ONE SHOT and the column has no DEFAULT, so a delivery the PREVIOUS release
  // inserts after it commits keeps a null role — skipped by the wide settlement and refused by the
  // recovery after a rebind. A default is not the fix: it would make a row between its insert and
  // its claim say "the responder's", a false statement rather than a missing one. The deploy note
  // is, and it is the artefact an operator actually reads.
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
