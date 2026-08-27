import { describe, expect, test } from "bun:test";
import { Client } from "pg";

// Every DATA migration over a tenant-scoped table must set the RLS bypass, asked ONCE here instead
// of once per migration.
//
// WHICH bypass depends on when the migration runs, and that is not a style choice — the two
// spellings are each inert in the other's era, silently. Before 20260827000000 the policy carried
// `is_super_admin = 'on' OR tenant_id = <guc>` and the GUC was the escape; that migration split the
// OR out into a role-restricted policy (issue #382), after which the GUC grants nothing at all.
// Measured on 17.10, running the same UPDATE as a non-superuser owner against the post-split
// policy: the GUC form reaches ZERO rows and reports success.
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

// The migration that split the policy. Its own directory name is the boundary, and the comparison
// is lexicographic because the names are fixed-width timestamps.
// The bypass a migration writes, from the split onward: it lifts FORCE for the duration and puts it
// back. Not the fleet role, and that was measured rather than chosen — `prisma migrate dev` replays
// every migration in a fresh SHADOW database that bootstrap never touches, so the fleet role there
// has no grants and no membership, and `set_config('role', …)` answers `permission denied to set
// role`. The same three arms in that condition: no bypass reaches 0 of 30 rows, the fleet role
// cannot be entered, and NO FORCE reaches 30 of 30.
//
// It is the OWNER's own table and only the owner's view changes; the runtime role is not the owner
// and is unaffected. Leaving FORCE off is the risk, and it has its own backstop: the catalog fence
// in tests/lib/rls-policy-shape.test.ts asserts every table under RLS also FORCES it.
export const FLEET_ENTRY_RE =
  /^\s*ALTER\s+TABLE\s+"?(\w+)"?\s+NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\s*;/im;

// And whatever it lifts, it restores — asked per table, because a file that lifts two and restores
// one leaves the second permanently unfenced for the owner.
export function liftsWithoutRestoring(sql: string): string[] {
  const stripped = sql.replace(/^\s*--.*$/gm, "");
  const lifted = [
    ...stripped.matchAll(
      /ALTER\s+TABLE\s+"?(\w+)"?\s+NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi,
    ),
  ].map((m) => (m[1] as string).toLowerCase());
  const restored = new Set(
    [
      ...stripped.matchAll(
        /ALTER\s+TABLE\s+"?(\w+)"?\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi,
      ),
    ].map((m) => (m[1] as string).toLowerCase()),
  );
  return [...new Set(lifted)].filter((t) => !restored.has(t));
}

export const POLICY_SPLIT_MIGRATION =
  "20260827000000_rls_split_tenant_and_fleet_policies";

// Plain SET, never SET LOCAL: outside a transaction SET LOCAL is a no-op with a warning, which is
// the same silent failure wearing the right words.
export function hasBypass(sql: string, migrationName: string): boolean {
  const stripped = sql.replace(/^\s*--.*$/gm, "");
  return migrationName < POLICY_SPLIT_MIGRATION
    ? /^\s*SET\s+app\.is_super_admin\s*=/m.test(stripped)
    : FLEET_ENTRY_RE.test(stripped);
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
      if (needsBypass(sql, forced) && !hasBypass(sql, name))
        offenders.push(name);
    }
    expect(offenders).toEqual([]);
  });

  // The positive control. A scan that finds nothing passes whether it works or not, so the predicate
  // is asked directly about a file it MUST reject and one it must not — in BOTH eras, because the
  // whole point of the boundary is that each spelling is wrong on the other side of it.
  test("the predicate rejects a bare backfill and accepts the guard of its own era", () => {
    const table = [...forced][0];
    if (table === undefined) throw new Error("no FORCE-RLS table to test with");
    const bare = `UPDATE "${table}" SET x = 1;`;
    const before = "20260101000000_old";
    const after = "20270101000000_new";
    const guc = `SET app.is_super_admin = 'on';\n${bare}\nRESET app.is_super_admin;`;
    const role = `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;\n${bare}\nALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`;

    expect(needsBypass(bare, forced)).toBe(true);
    expect(hasBypass(bare, before)).toBe(false);
    expect(hasBypass(bare, after)).toBe(false);

    // Each guard counts in its own era and NOT in the other's. Accepting both everywhere is the
    // shape that would let a migration written today carry a line that reaches zero rows.
    expect(hasBypass(guc, before)).toBe(true);
    expect(hasBypass(guc, after)).toBe(false);
    expect(hasBypass(role, after)).toBe(true);
    expect(hasBypass(role, before)).toBe(false);

    // The split migration itself is the first of the new era, not the last of the old.
    expect(hasBypass(role, POLICY_SPLIT_MIGRATION)).toBe(true);
    expect(hasBypass(guc, POLICY_SPLIT_MIGRATION)).toBe(false);

    // SET LOCAL is not the same thing, and reads as if it were.
    expect(
      hasBypass(`SET LOCAL app.is_super_admin = 'on';\n${bare}`, before),
    ).toBe(false);
    // The fleet role is NOT it, and that is the correction this fence carries: it cannot be entered
    // in the shadow database `prisma migrate dev` replays into (measured).
    expect(
      hasBypass(
        `SELECT set_config('role', public.fazerai_fleet_role(), true);\n${bare}`,
        after,
      ),
    ).toBe(false);
    // And whatever a file lifts it must restore, asked per table.
    expect(liftsWithoutRestoring(role)).toEqual([]);
    expect(
      liftsWithoutRestoring(
        `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;\n${bare}`,
      ),
    ).toEqual([table.toLowerCase()]);

    // DDL alone never needs it.
    expect(
      needsBypass(`ALTER TABLE "${table}" ADD COLUMN "x" INTEGER;`, forced),
    ).toBe(false);
    // And a commented-out backfill is not a backfill.
    expect(needsBypass(`-- UPDATE "${table}" SET x = 1;`, forced)).toBe(false);
  });

  // The era boundary is only a rule if the files obey it, and the two directions fail differently:
  // a GUC line written today is inert and silent, a SET ROLE line written before the split is a
  // hard error on a role that does not exist yet.
  test("no migration carries the guard of the other era", async () => {
    const dir = "prisma/migrations";
    const stale: string[] = [];
    const early: string[] = [];
    for await (const entry of new Bun.Glob("*/migration.sql").scan({
      cwd: dir,
    })) {
      const name = entry.split("/")[0] ?? entry;
      const sql = (await Bun.file(`${dir}/${entry}`).text()).replace(
        /^\s*--.*$/gm,
        "",
      );
      const guc = /^\s*SET\s+app\.is_super_admin\s*=/m.test(sql);
      const role = FLEET_ENTRY_RE.test(sql);
      stale.push(
        ...(liftsWithoutRestoring(sql).length
          ? [`${name} (lifts FORCE without restoring)`]
          : []),
      );
      if (guc && name >= POLICY_SPLIT_MIGRATION) stale.push(name);
      if (role && name < POLICY_SPLIT_MIGRATION) early.push(name);
    }
    expect(stale).toEqual([]);
    expect(early).toEqual([]);
  });
});
