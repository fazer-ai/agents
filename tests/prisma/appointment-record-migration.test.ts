import { describe, expect, test } from "bun:test";
import { Client } from "pg";

// The backfill of 20260826220000_appointment_record, run against rows shaped like the ones it will
// actually meet in production.
//
// The reason it gets a test of its own is the cast. `startISO` reaches a reminder payload from the
// model's own tool input, so unreadable values are not hypothetical, and a cast that raises inside a
// migration does not skip a row: it aborts `migrate deploy`, which on the documented boot ordering
// (`db-bootstrap && migrate deploy && exec bun src/index.ts`) is a container that never starts. One
// bad payload anywhere in the fleet would be an outage, and no behavioural test in the suite can see
// a migration's SQL.
//
// Everything here runs inside a transaction that is rolled back, so the statement is exercised
// VERBATIM — across every tenant, as it runs for real — without leaving a row behind in the shared
// test database.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260826220000_appointment_record/migration.sql";

let dbUp = false;
let sql = "";
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    sql = await Bun.file(MIGRATION).text();
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const db = su as Client;

// The INSERT exactly as the migration ships it, not a paraphrase: a copy would drift from the file
// on the first edit and keep passing.
function backfillStatement(text: string): string {
  const start = text.indexOf('INSERT INTO "appointments"');
  const end = text.indexOf(";", text.indexOf("ON CONFLICT"));
  if (start < 0 || end < 0) throw new Error("backfill statement not found");
  return text.slice(start, end + 1);
}

const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

describe.skipIf(!dbUp)("migration: the appointment backfill", () => {
  test("the cast is fenced by a CASE, not by an AND chain", () => {
    // Postgres does not promise to evaluate WHERE conjuncts left to right, so the guard has to be
    // structural. Asked of the FILE because the behaviour below cannot distinguish a plan that
    // happened to order the conjuncts favourably from one that is guaranteed to.
    expect(sql).toMatch(/pg_input_is_valid/);
    expect(sql).not.toMatch(
      /AND\s+pg_input_is_valid[^\n]*\n\s*AND[^\n]*::timestamptz/i,
    );
    expect(sql).toMatch(
      /WHEN[\s\S]{0,120}pg_input_is_valid[\s\S]{0,120}THEN[\s\S]{0,80}::timestamptz/,
    );
  });

  test("an unreadable start is skipped instead of aborting the deploy", async () => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL app.is_super_admin = 'on'");
      const t = await db.query<{ id: string }>(
        "INSERT INTO tenants (name, slug, updated_at) VALUES ($1, $2, now()) RETURNING id",
        [`ApBackfill ${process.pid}`, `apbackfill-${process.pid}`],
      );
      const tenantId = t.rows[0]?.id as string;
      const thread = `${tenantId}:1:1`;

      const rows: Array<[string, Record<string, unknown>]> = [
        [
          "good",
          {
            threadId: thread,
            eventId: "b_good",
            startISO: hours(48),
            summary: "Consulta",
            calendarId: "primary",
          },
        ],
        [
          "garbage",
          {
            threadId: thread,
            eventId: "b_garbage",
            startISO: "amanhã de manhã",
          },
        ],
        [
          "impossible",
          {
            threadId: thread,
            eventId: "b_impossible",
            startISO: "2027-02-30T10:00:00Z",
          },
        ],
        [
          "allday",
          {
            threadId: thread,
            eventId: "b_allday",
            startISO: hours(72).slice(0, 10),
          },
        ],
        [
          "offsetless",
          {
            threadId: thread,
            eventId: "b_offsetless",
            startISO: hours(50).slice(0, 19),
          },
        ],
        ["past", { threadId: thread, eventId: "b_past", startISO: hours(-2) }],
        [
          "tombstoned",
          {
            threadId: thread,
            eventId: "b_tombstoned",
            startISO: hours(48),
            cancelledAt: new Date().toISOString(),
          },
        ],
        ["nothread", { eventId: "b_nothread", startISO: hours(48) }],
      ];
      for (const [tag, payload] of rows) {
        await db.query(
          `INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, status, run_at, payload, updated_at)
           VALUES ($1, 'APPOINTMENT_REMINDER', $2, 'PENDING', now(), $3::jsonb, now())`,
          [tenantId, `reminder:${tag}:1`, JSON.stringify(payload)],
        );
      }

      // The whole point: this must not raise.
      await db.query(backfillStatement(sql));

      const got = await db.query<{ external_id: string; start_at: string }>(
        "SELECT external_id, start_at FROM appointments WHERE tenant_id = $1 ORDER BY external_id",
        [tenantId],
      );
      expect(got.rows.map((r) => r.external_id)).toEqual([
        "b_allday",
        "b_good",
        "b_offsetless",
      ]);
      // The all-day date is pinned to UTC midnight, matching parseStartMs.
      const allDay = got.rows.find((r) => r.external_id === "b_allday");
      expect(new Date(`${allDay?.start_at}Z`).toISOString()).toBe(
        `${hours(72).slice(0, 10)}T00:00:00.000Z`,
      );
    } finally {
      await db.query("ROLLBACK");
    }
  });

  test("the freshest arm of an event wins, and one event yields one row", async () => {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL app.is_super_admin = 'on'");
      const t = await db.query<{ id: string }>(
        "INSERT INTO tenants (name, slug, updated_at) VALUES ($1, $2, now()) RETURNING id",
        [`ApBackfill2 ${process.pid}`, `apbackfill2-${process.pid}`],
      );
      const tenantId = t.rows[0]?.id as string;
      const thread = `${tenantId}:1:1`;
      const older = hours(48);
      const newer = hours(96);
      // Two arms of ONE event, as a reschedule leaves them: same eventId, different offsets, and the
      // one written last carries the current start.
      await db.query(
        `INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, status, run_at, payload, updated_at)
         VALUES ($1, 'APPOINTMENT_REMINDER', 'reminder:b_one:24', 'PENDING', now(), $2::jsonb, now() - interval '1 hour')`,
        [
          tenantId,
          JSON.stringify({
            threadId: thread,
            eventId: "b_one",
            startISO: older,
          }),
        ],
      );
      await db.query(
        `INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, status, run_at, payload, updated_at)
         VALUES ($1, 'APPOINTMENT_REMINDER', 'reminder:b_one:1', 'PENDING', now(), $2::jsonb, now())`,
        [
          tenantId,
          JSON.stringify({
            threadId: thread,
            eventId: "b_one",
            startISO: newer,
          }),
        ],
      );
      await db.query(backfillStatement(sql));
      const got = await db.query<{ start_iso: string }>(
        "SELECT start_iso FROM appointments WHERE tenant_id = $1",
        [tenantId],
      );
      expect(got.rows).toHaveLength(1);
      expect(got.rows[0]?.start_iso).toBe(newer);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});
