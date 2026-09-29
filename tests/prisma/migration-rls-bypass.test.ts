import { describe, expect, test } from "bun:test";
import { Client } from "pg";

// Every DATA migration over a tenant-scoped table must set the RLS bypass, asked ONCE here rather
// than per migration, since a per-migration test is one the next migration is born without. Those
// tables carry FORCE RLS, which binds the owner too, and `MIGRATION_DATABASE_URL` may be an owner
// without rolsuper (managed Postgres), where an unbypassed cross-tenant UPDATE reaches zero rows and
// reports success (docs/deploy.md). Which bypass depends on the era, and each spelling is silently
// inert in the other's: before 20260827000000 the policy's `is_super_admin` GUC was the escape;
// from that split on the GUC grants nothing and the file brackets its writes with NO FORCE.

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

// Migrations that predate the rule and cannot be fixed in place: a migration already applied
// somewhere is append-only, so the repair is always a LATER migration, never an edit to this one.
const GRANDFATHERED = new Set([
  // Corrected by 20260818120000_followup_armed_at_backfill_rls, which re-runs the backfill properly.
  "20260807032257_agent_follow_up_armed_at",
]);

// A `CREATE FUNCTION` body is not the migration's DML: a trigger statement runs later, per row, under
// the writer's own RLS context, so demanding a bypass for it would be meaningless. Only function
// bodies come out; a `DO $$ … $$` runs during the migration under RLS like a bare UPDATE, and a
// backfill wrapped in one is the shape this rule most needs to catch. The tag is matched as Postgres
// spells it (`$$` or `$name$`) and the body ends at the first repeat of the SAME tag.
export function stripFunctionBodies(sql: string): string {
  const re = /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i;
  let done = "";
  let rest = sql;
  for (;;) {
    const head = re.exec(rest);
    if (head === null) return done + rest;
    const tag = /\$([A-Za-z_]\w*)?\$/.exec(rest.slice(head.index));
    if (!tag) return done + rest;
    const openAt = head.index + (tag.index ?? 0);
    const closeAt = rest.indexOf(tag[0], openAt + tag[0].length);
    if (closeAt === -1) return done + rest;
    // NOTE: The header goes with the body and the scan resumes after it. Rescanning from the start
    // would match the same `CREATE FUNCTION` again and swallow the next dollar-quoted block (a
    // `DO $$ … $$` in several migrations) as its body, hiding the DML this rule exists to read.
    done += `${rest.slice(0, head.index)}CREATE_FUNCTION`;
    rest = rest.slice(closeAt + tag[0].length);
  }
}

// The tables a file's DML writes to. Deliberately syntactic and deliberately blunt: it over-reports
// rather than under-reports, because a name this misses is a check that silently does not happen.
export function tablesWrittenBy(sql: string): string[] {
  const stripped = stripFunctionBodies(sql).replace(/^\s*--.*$/gm, "");
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

// The bypass a migration writes from the policy split onward: lift FORCE for the duration and put it
// back. Not the fleet role: `prisma migrate dev` replays into a fresh shadow database bootstrap never
// touches, where that role has no grants or membership and `set_config('role', …)` is refused. Only
// the owner's view changes; the runtime role is not the owner. Leaving FORCE off is the risk, and
// tests/lib/rls-policy-shape.test.ts asserts every table under RLS also forces it.
export const FLEET_ENTRY_RE =
  /^\s*ALTER\s+TABLE\s+"?(\w+)"?\s+NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY\s*;/im;

// And whatever it lifts, it restores, asked per table, because a file that lifts two and restores
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

// The migration that split the policy is the era boundary; comparisons against it are
// lexicographic because migration names are fixed-width timestamps.
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

// The tables a file brackets with NO FORCE. Asked as a SET, because the old-era GUC was a
// file-level switch and this one is not: a migration that writes A and B and brackets only A passes
// any "does the file contain a bypass" question while B's UPDATE silently reaches zero rows.
export function bracketedTables(sql: string): Set<string> {
  const stripped = sql.replace(/^\s*--.*$/gm, "");
  return new Set(
    [
      ...stripped.matchAll(
        /ALTER\s+TABLE\s+"?(\w+)"?\s+NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/gi,
      ),
    ].map((m) => (m[1] as string).toLowerCase()),
  );
}

// The tables a file's DML READS: FORCE binds a SELECT exactly like an UPDATE, so a backfill that
// decides what to write by reading a forced table decides on zero rows and reports success. Blunt
// like `tablesWrittenBy`: a `DELETE FROM` target lands here too, at no cost, since it is bracketed as
// a write already.
export function tablesReadBy(sql: string): string[] {
  const stripped = stripFunctionBodies(sql).replace(/^\s*--.*$/gm, "");
  const names: string[] = [];
  const re = /\b(?:FROM|JOIN)\s+"?([A-Za-z_][\w]*)"?/gi;
  for (const m of stripped.matchAll(re)) {
    const name = m[1];
    if (name) names.push(name);
  }
  return names;
}

// Written FORCE-RLS tables this file does not bracket. Empty is the only acceptable answer from the
// split onward; before it, the GUC covered the whole file and the question does not apply.
export function unbracketedWrites(
  sql: string,
  forcedTables: Set<string>,
  migrationName: string,
): string[] {
  if (migrationName < POLICY_SPLIT_MIGRATION) return [];
  const bracketed = bracketedTables(sql);
  return [
    ...new Set(
      tablesWrittenBy(sql)
        .filter((t) => forcedTables.has(t))
        .map((t) => t.toLowerCase()),
    ),
  ].filter((t) => !bracketed.has(t));
}

// Read FORCE-RLS tables this file does not bracket, from the split onward, on the same argument.
export function unbracketedReads(
  sql: string,
  forcedTables: Set<string>,
  migrationName: string,
): string[] {
  if (migrationName < POLICY_SPLIT_MIGRATION) return [];
  const bracketed = bracketedTables(sql);
  return [
    ...new Set(
      tablesReadBy(sql)
        .filter((t) => forcedTables.has(t))
        .map((t) => t.toLowerCase()),
    ),
  ].filter((t) => !bracketed.has(t));
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
      if (needsBypass(sql, forced) && !hasBypass(sql, name)) {
        offenders.push(name);
      }
      // And per WRITTEN table, from the split onward: the old-era GUC was a file-level switch and
      // this one is not. A file that writes A and B and brackets only A answers every file-level
      // question correctly while B's UPDATE silently reaches zero rows.
      for (const t of unbracketedWrites(sql, forced, name)) {
        offenders.push(`${name} (writes ${t} without bracketing it)`);
      }
      for (const t of unbracketedReads(sql, forced, name)) {
        offenders.push(`${name} (reads ${t} without bracketing it)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // NOTE: The positive control. A scan that finds nothing passes whether it works or not, so the
  // predicate is asked directly about a file it MUST reject and one it must not, in BOTH eras,
  // because the whole point of the boundary is that each spelling is wrong on the other side of it.
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
    // NOTE: The fleet role is not the bypass: it cannot be entered in the shadow database
    // `prisma migrate dev` replays into.
    expect(
      hasBypass(
        `SELECT set_config('role', public.fazerai_fleet_role(), true);\n${bare}`,
        after,
      ),
    ).toBe(false);
    // And whatever a file lifts it must restore, asked per table.
    expect(liftsWithoutRestoring(role)).toEqual([]);
    // Per WRITTEN table too: bracketing one of two is a file that passes every file-level question
    // while the second UPDATE reaches nothing.
    expect(unbracketedWrites(role, forced, after)).toEqual([]);
    const second = [...forced][1];
    if (second) {
      const two = `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;\n${bare}\nUPDATE "${second}" SET x = 1;\nALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`;
      expect(unbracketedWrites(two, forced, after)).toEqual([
        second.toLowerCase(),
      ]);
      // And the question does not apply before the split, where the switch was file-level.
      expect(unbracketedWrites(two, forced, before)).toEqual([]);
    }
    expect(
      liftsWithoutRestoring(
        `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;\n${bare}`,
      ),
    ).toEqual([table.toLowerCase()]);
    // A READ of a forced table is bound the same way, and asked the same way: bracketed or not,
    // per table, from the split onward.
    const read = `SELECT count(*) FROM "${table}";`;
    expect(unbracketedReads(read, forced, after)).toEqual([
      table.toLowerCase(),
    ]);
    expect(unbracketedReads(read, forced, before)).toEqual([]);
    expect(
      unbracketedReads(
        `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;\n${read}\nALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
        forced,
        after,
      ),
    ).toEqual([]);

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

  // NOTE: The narrowing above, asked directly: a trigger function's body comes out, and everything
  // that actually runs during the migration stays in, a DO block most of all, since a backfill
  // wrapped in one is exactly the shape this rule exists to catch.
  test("a function body is not the migration's own DML; a DO block still is", () => {
    const trigger = `
      CREATE OR REPLACE FUNCTION bump()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        UPDATE "inboxes" SET binding_generation = binding_generation + 1 WHERE id = NEW.inbox_id;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER t AFTER INSERT ON "inbox_observers" FOR EACH ROW EXECUTE FUNCTION bump();`;
    expect(tablesWrittenBy(trigger)).toEqual([]);

    const doBlock = `
      DO $$ BEGIN UPDATE "agents" SET follow_up_armed_at = now(); END $$;`;
    expect(tablesWrittenBy(doBlock)).toEqual(["agents"]);

    // ...and a bare statement beside a function keeps being seen, so the marker cannot swallow the
    // rest of the file.
    const both = `${trigger}
      UPDATE "agents" SET name = 'x';`;
    expect(tablesWrittenBy(both)).toEqual(["agents"]);

    // NOTE: The shape existing migrations have: a function, and then a DO block that runs
    // during the migration. The second must survive the stripping of the first, or the rule stops
    // reading the very DML it is for.
    const functionThenDo = `${trigger}
      DO $$ BEGIN UPDATE "agents" SET follow_up_armed_at = now(); END $$;`;
    expect(tablesWrittenBy(functionThenDo)).toEqual(["agents"]);

    // Two functions in one file, with a statement after each: neither header may eat what follows.
    const twoFunctions = `${trigger}
      UPDATE "agents" SET name = 'a';
      ${trigger}
      UPDATE "inboxes" SET name = 'b';`;
    expect(tablesWrittenBy(twoFunctions)).toEqual(["agents", "inboxes"]);
  });
});
