import { describe, expect, test } from "bun:test";
import { Client } from "pg";

// Every DATA migration over a tenant-scoped table must set the RLS bypass, asked ONCE here instead
// of once per migration.
//
// The rule itself is old and documented (docs/deploy.md): those tables carry FORCE ROW LEVEL
// SECURITY, which binds the table OWNER as well, and `MIGRATION_DATABASE_URL` is only ever promised
// to be "superuser OR owner". On managed Postgres the admin role is typically the owner WITHOUT
// rolsuper, and there an UPDATE across tenants matches ZERO rows and reports success — green
// deploy, no error, no warning, and a backfill that never happened.
//
// What this file adds is the ASKING. The rule already had three tests, one per migration that
// happens to follow it, and a rule checked once per instance is a rule the next instance is born
// without: it has now been missed twice, by 20260807032257 (corrected later by a whole extra
// migration) and by 20260825140100 (caught in review, which is luck rather than process). A
// migration is append-only, so the cost of noticing late is a second migration, and the cost of
// never noticing is a silent data loss on exactly the installs we do not run ourselves.

const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let forced = new Set<string>();
if (suUrl) {
  try {
    const c = new Client({ connectionString: suUrl });
    await c.connect();
    const r = await c.query<{ relname: string }>(
      "SELECT relname FROM pg_class WHERE relforcerowsecurity AND relkind = 'r'",
    );
    forced = new Set(r.rows.map((row) => row.relname));
    await c.end();
    dbUp = forced.size > 0;
  } catch {
    dbUp = false;
  }
}

// Migrations that predate the rule and cannot be fixed in place — a migration already applied
// somewhere is append-only, so the repair is always a LATER migration, never an edit to this one.
const GRANDFATHERED = new Set([
  // Corrected by 20260818120000_followup_armed_at_backfill_rls, which re-runs the backfill properly.
  "20260807032257_agent_follow_up_armed_at",
]);

// The tables a file's DML writes to. Deliberately syntactic and deliberately blunt: it over-reports
// rather than under-reports, because a name this misses is a check that silently does not happen.
export function tablesWrittenBy(sql: string): string[] {
  const stripped = sql.replace(/^\s*--.*$/gm, "");
  const names: string[] = [];
  const re =
    /\b(?:UPDATE|DELETE\s+FROM|INSERT\s+INTO)\s+"?([A-Za-z_][\w]*)"?/gi;
  for (const m of stripped.matchAll(re)) {
    const name = m[1];
    if (name) names.push(name);
  }
  return names;
}

export function needsBypass(sql: string, forcedTables: Set<string>): boolean {
  return tablesWrittenBy(sql).some((t) => forcedTables.has(t));
}

export function hasBypass(sql: string): boolean {
  // Plain SET, never SET LOCAL: outside a transaction SET LOCAL is a no-op with a warning, which is
  // the same silent failure wearing the right words.
  return /^\s*SET\s+app\.is_super_admin\s*=/m.test(
    sql.replace(/^\s*--.*$/gm, ""),
  );
}

describe.skipIf(!dbUp)("every data migration sets the RLS bypass", () => {
  test("no migration writes to a FORCE-RLS table without it", async () => {
    const dir = "prisma/migrations";
    const offenders: string[] = [];
    for await (const entry of new Bun.Glob("*/migration.sql").scan({
      cwd: dir,
    })) {
      const name = entry.split("/")[0] ?? entry;
      if (GRANDFATHERED.has(name)) continue;
      const sql = await Bun.file(`${dir}/${entry}`).text();
      if (needsBypass(sql, forced) && !hasBypass(sql)) offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  // The positive control. A scan that finds nothing passes whether it works or not, so the predicate
  // is asked directly about a file it MUST reject and one it must not.
  test("the predicate rejects a bare backfill and accepts a guarded one", () => {
    const table = [...forced][0];
    if (table === undefined) throw new Error("no FORCE-RLS table to test with");
    const bare = `UPDATE "${table}" SET x = 1;`;
    const guarded = `SET app.is_super_admin = 'on';\n${bare}\nRESET app.is_super_admin;`;
    expect(needsBypass(bare, forced)).toBe(true);
    expect(hasBypass(bare)).toBe(false);
    expect(hasBypass(guarded)).toBe(true);
    // SET LOCAL is not the same thing, and reads as if it were.
    expect(hasBypass(`SET LOCAL app.is_super_admin = 'on';\n${bare}`)).toBe(
      false,
    );
    // DDL alone never needs it.
    expect(
      needsBypass(`ALTER TABLE "${table}" ADD COLUMN "x" INTEGER;`, forced),
    ).toBe(false);
    // And a commented-out backfill is not a backfill.
    expect(needsBypass(`-- UPDATE "${table}" SET x = 1;`, forced)).toBe(false);
  });
});
