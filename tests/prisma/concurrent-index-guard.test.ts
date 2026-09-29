import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Client } from "pg";

// A `CREATE INDEX CONCURRENTLY` THAT DIES LEAVES AN INDEX POSTGRES REFUSES TO USE: `indisvalid =
// false`, never chosen by the planner, still maintained on every write, and invisible to every
// behavioural test and to `migrate status`. The file's `DROP INDEX IF EXISTS` is not the defence: a
// deploy out of `P3009` via `resolve --applied` never reruns the file. The defence is a FOLLOWING
// migration that asks the catalog, and this file checks both halves: the guard FIRES on a real
// invalid index, and no table gets a concurrent build without one. The runbook and the Postgres
// behaviour behind it: .claude/rules/prisma.md, "O arquivo da migration NÃO roda em transação".

const MIGRATIONS = "prisma/migrations";
const ASSERT_FILE = `${MIGRATIONS}/20260921120000_assert_conversation_indexes_valid/migration.sql`;
const INDEX = "conversations_tenant_id_chatwoot_instance_id_contact_inbox__idx";
// Distinctive on purpose: the sweep below would report it as an unguarded build if it ever reached a
// migration file, and the cleanup has to be able to name it after a crash.
const PROBE = "conversations_invalid_index_probe_idx";

type File = { name: string; sql: string };

// A comment carries the very words this sweep looks for: three migrations explain the rule in prose
// above their statements, and each assertion file quotes the command an operator has to run. Strip
// whole-line comments before asking anything of the SQL. Nothing in this tree puts a `--` after code
// on the same line, and no string literal holds one.
function statementsOf(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

// AND A STRING LITERAL IS NOT A STATEMENT: the guard's own `RAISE EXCEPTION` quotes
// `CREATE INDEX CONCURRENTLY` and `REINDEX INDEX CONCURRENTLY … on each`, which read as code is a
// concurrent build `ON` a table called `each`. Strip the quoted spans before asking what the file
// EXECUTES. `''` is Postgres's escape for a quote inside a literal, so it continues the span.
function codeOf(sql: string): string {
  return statementsOf(sql).replace(/'(?:[^']|'')*'/g, "''");
}

// THE SWEEP, as a function over files rather than over the directory, so the cases that do not exist
// in this tree can still be tested: a guard that runs BEFORE its build, and a build whose `ON` sits
// on the next line. Both of those are how a sweep like this passes while the hole it exists to close
// stays open, and neither can be reached by pointing it at `prisma/migrations`.
function sweep(files: File[]): {
  builds: Map<string, string>;
  asserts: Map<string, string[]>;
  unguarded: string[];
} {
  const builds = new Map<string, string>(); // table -> last migration that builds on it
  const asserts = new Map<string, string[]>(); // table -> migrations that assert it
  for (const { name, sql } of [...files].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    // NOTE: anything may sit between the index name and its `ON`, INCLUDING A NEWLINE (two of the three
    // real files), so a per-line pattern misses builds. `UNIQUE` sits between CREATE and INDEX, and a
    // unique build's interrupted corpse is the only kind a REINDEX cannot revive.
    for (const m of codeOf(sql).matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY[\s\S]*?\bON\s+"?([a-z0-9_]+)"?/gi,
    )) {
      builds.set(m[1] as string, name); // sorted, so the last write is the last build
    }
    // Over `statementsOf`, the only right view here. Not `codeOf` (nor the DO-body-stripping
    // sweep in tenant-index-redundancy.test.ts): the table name lives in a string literal those strip.
    // Not raw SQL: a later file holding the check only IN A COMMENT would satisfy the fence.
    const declared = statementsOf(sql);
    if (/\bindisvalid\b/.test(declared)) {
      for (const m of declared.matchAll(/t\.relname\s*=\s*'([a-z0-9_]+)'/g)) {
        const table = m[1] as string;
        asserts.set(table, [...(asserts.get(table) ?? []), name]);
      }
    }
  }
  const unguarded: string[] = [];
  for (const [table, lastBuild] of builds) {
    // LATER, not merely present: a guard before the build asks about a table the index is not on
    // yet, and it can never be the same file, since a `DO $$` block puts the migration in an implicit
    // transaction, which `CREATE INDEX CONCURRENTLY` cannot share.
    const after = (asserts.get(table) ?? []).filter((a) => a > lastBuild);
    if (after.length === 0)
      unguarded.push(
        `${table} (last built in ${lastBuild}, asserted by ${
          (asserts.get(table) ?? []).join(", ") || "nothing"
        })`,
      );
  }
  return { builds, asserts, unguarded };
}

function migrationFiles(): File[] {
  const out: File[] = [];
  for (const name of readdirSync(MIGRATIONS).sort()) {
    const file = `${MIGRATIONS}/${name}/migration.sql`;
    if (!existsSync(file)) continue;
    out.push({ name, sql: readFileSync(file, "utf8") });
  }
  return out;
}

const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;

describe("the concurrent-index guard", () => {
  test("every table built on concurrently is asserted by a LATER migration", () => {
    const { builds, unguarded } = sweep(migrationFiles());
    // Anti-vacuum: a parser that stops matching reports an empty sweep as a clean one. These three
    // are the tables the migrations build on concurrently today, and the count only grows.
    expect([...builds.keys()].sort()).toEqual(
      expect.arrayContaining([
        "audit_logs",
        "chatwoot_webhook_deliveries",
        "conversations",
      ]),
    );
    expect(builds.size).toBeGreaterThanOrEqual(3);
    expect(unguarded).toEqual([]);
  });

  test("the sweep reads the forms this tree does not currently hold", () => {
    const build = (t: string) =>
      `CREATE INDEX CONCURRENTLY "some_idx"\n    ON "${t}"("a", "b")\n WHERE "a" IS NOT NULL;`;
    const guard = (t: string) =>
      `DO $$\nBEGIN\n  PERFORM 1 FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid\n   WHERE t.relname = '${t}' AND NOT i.indisvalid;\nEND $$;`;

    // The `ON` on its own line, which is how two of the three real files are written.
    expect(sweep([{ name: "1_build", sql: build("t") }]).unguarded).toEqual([
      "t (last built in 1_build, asserted by nothing)",
    ]);
    // A guard BEFORE its build guards nothing, and reads exactly like one that guards something.
    expect(
      sweep([
        { name: "1_guard", sql: guard("t") },
        { name: "2_build", sql: build("t") },
      ]).unguarded,
    ).toEqual(["t (last built in 2_build, asserted by 1_guard)"]);
    // ...and after it, it counts.
    expect(
      sweep([
        { name: "1_build", sql: build("t") },
        { name: "2_guard", sql: guard("t") },
      ]).unguarded,
    ).toEqual([]);
    // A SECOND build after the guard reopens the window: the guard already ran.
    expect(
      sweep([
        { name: "1_build", sql: build("t") },
        { name: "2_guard", sql: guard("t") },
        { name: "3_build", sql: build("t") },
      ]).unguarded,
    ).toEqual(["t (last built in 3_build, asserted by 2_guard)"]);
    // A UNIQUE CONCURRENT BUILD IS A CONCURRENT BUILD. `UNIQUE` sits between CREATE and INDEX, so a
    // pattern without it reports a clean sweep over a table whose guard nobody wrote.
    expect(
      sweep([
        {
          name: "1_build",
          sql: 'CREATE UNIQUE INDEX CONCURRENTLY "u_idx"\n    ON "t"("v");',
        },
      ]).unguarded,
    ).toEqual(["t (last built in 1_build, asserted by nothing)"]);
    // A COMMENTED-OUT ASSERTION IS NOT AN ASSERTION. Read off raw SQL, a later file holding nothing
    // but the check in a comment satisfies the fence while executing no catalog query at all.
    expect(
      sweep([
        { name: "1_build", sql: build("t") },
        {
          name: "2_guard",
          sql: "-- WHERE t.relname = 't' AND NOT i.indisvalid;\nSELECT 1;",
        },
      ]).unguarded,
    ).toEqual(["t (last built in 1_build, asserted by nothing)"]);
    // NOTE: a quoted runbook is not a build either: the guard's own `RAISE EXCEPTION` tells the operator
    // to run `REINDEX INDEX CONCURRENTLY … on each` index, which read as code is a build `ON` `each`.
    expect(
      sweep([
        {
          name: "1_guard",
          sql: `DO $$\nBEGIN\n  RAISE EXCEPTION 'an in-flight CREATE INDEX CONCURRENTLY on "conversations" reads the same; run REINDEX INDEX CONCURRENTLY on each dead index';\nEND $$;`,
        },
      ]).builds.size,
    ).toBe(0);
    // NOTE: prose is not a build. Every one of these files explains the rule above its statements.
    expect(
      sweep([
        {
          name: "1_prose",
          sql: '-- a CREATE INDEX CONCURRENTLY on "conversations" that dies leaves a corpse\nSELECT 1;',
        },
      ]).builds.size,
    ).toBe(0);
  });

  test("the assertion lives in a file of its own, and asks about the table", () => {
    const sql = readFileSync(ASSERT_FILE, "utf8");
    const statements = statementsOf(sql);
    // Its own file, so it can never share a transaction with a concurrent build. Asked of the CODE,
    // because the message inside it quotes `CREATE INDEX CONCURRENTLY` on purpose.
    expect(codeOf(sql)).not.toMatch(/CREATE\s+INDEX/i);
    expect(statements).toContain("indisvalid");
    expect(statements).toContain("'conversations'");
    // The exception has to tell an operator what to do: the fix is a command, and the deploy is
    // stopped at the moment they read it.
    expect(statements).toContain("RAISE EXCEPTION");
    // ...and the command has to be the one that ENDS WITH AN INDEX. A drop is what the two sibling
    // guards say, and behind the `--applied` door it leaves the table with none at all: the build
    // file is already recorded as applied, so `migrate deploy` never runs it again. The message says
    // so in as many words, because "drop it" is what an operator reaches for by default.
    expect(statements).toContain("REINDEX INDEX CONCURRENTLY");
    expect(statements).toMatch(/never a DROP/);
    // NOTE: a build in flight reads exactly like a corpse (`indisvalid = false` for its whole run).
    // Refusing the deploy is right; telling the operator to reindex someone's live build is not.
    // `indisready` does not separate them; `pg_stat_progress_create_index` does, and names the index.
    // A query-text match does not: a live `CREATE UNIQUE INDEX CONCURRENTLY` misses
    // `query ILIKE 'create index%'`.
    expect(statements).toContain("pg_stat_progress_create_index");
    // NOTE: the ban is on the IDIOM, not on the name: naming `pg_stat_activity` is fine (the reindex's
    // wait shows there as `Lock / virtualxid`); telling live from abandoned by query text is not.
    expect(statements).not.toMatch(/query\s+ILIKE/i);
    expect(statements).not.toMatch(/pg_stat_activity[^.]*\bWHERE\b/i);
    // NOTE: the view answers DIFFERENTLY by role: for a non-superuser owner (managed Postgres, per
    // `docs/deploy.md`) a build another role started comes back as a row of NULLs, so a
    // `WHERE relid = …` filter drops it and reports "nothing running". Asserted by the CLAIM, not by
    // the word `pg_read_all_stats`, which the message also names in the GRANT step.
    expect(statements).toMatch(/a filter on relid drops exactly that row/);
    // NOTE: the window stops at the statement's own `;`: the message says "Run it with no WHERE" one
    // line below the query, and a proximity match would read that sentence as the filter.
    expect(statements).not.toMatch(
      /pg_stat_progress_create_index[^;\n]*WHERE/i,
    );
    // NOTE: the REINDEX's precondition: the index has to be BUILDABLE.
    expect(statements).toMatch(/is UNIQUE/);
    // NOTE: scoped to a REINDEX that failed ON ITS OWN (interruption is a second way to fail), and
    // conditioned on the error reported, because no disk, a deadlock and a statement or lock timeout
    // fail one too, including on non-unique indexes; an unqualified claim sends the operator hunting
    // duplicates that are not there.
    expect(statements).toMatch(/If a REINDEX fails on its own, READ THE ERROR/);
    expect(statements).toMatch(
      /"could not create unique index" means the index is UNIQUE/,
    );
    // NOTE: the clause that says what to DO about the duplicates: a cause without the recovery leaves
    // the operator with a diagnosis.
    expect(statements).toMatch(
      /resolve the duplicates, DROP the \.\.\._ccnew that attempt left behind, then reindex the original/,
    );
    // NOTE: a `..._ccnew`/`..._ccold` is excluded from the rebuild: the catalog query lists the leftover
    // AND the original, and reindexing both leaves two valid identical indexes, a duplicate every write
    // pays for that the guard can never report again.
    expect(statements).toMatch(
      /A name ending in \.\.\._ccnew or \.\.\._ccold, with or without a trailing number/,
    );
    expect(statements).toMatch(
      /Reindexing either of those instead of dropping it ends with TWO valid indexes/,
    );
    // NOTE: the reindex waits for ANY older snapshot, including one that never touches this table, so it
    // can take minutes. Interrupting it turns one dead index into two: the original stays invalid and an
    // invalid `..._ccnew` appears beside it.
    expect(statements).toMatch(
      /wait phase of its own and waits for ANY transaction whose snapshot is older/,
    );
    // NOTE: the numbers stay in the message: "it may take a while" is advice, "111s beside a live build
    // on another table" tells an operator staring at a prompt that this is the normal shape.
    expect(statements).toContain("111s");
    // ...and the name the operator meets if they go looking, because the two views call the same
    // wait different things and the pg_stat_activity one reads like a lock problem.
    expect(statements).toMatch(
      /shows as Lock \/ virtualxid, which reads like a lock problem/,
    );
    expect(statements).toMatch(
      /It is NOT stuck, and you must not interrupt it/,
    );
    expect(statements).toMatch(
      /leaves the original still invalid AND adds an invalid \.\.\._ccnew/,
    );
    // ...including what the failed attempt leaves behind. A REINDEX that fails on a unique index
    // adds a second dead index, so the clause has to say to DROP it rather than reindex it too:
    // reindexing both ends with a valid duplicate of the same index that somebody removes by hand.
    expect(statements).toContain("_ccnew");
    // The operator also needs this file's own name, for the `resolve` that unblocks the deploy...
    expect(statements).toContain(
      "resolve --rolled-back 20260921120000_assert_conversation_indexes_valid",
    );
    // The message is a SEQUENCE of four steps, not a fork. With the final `resolve` inside one
    // branch, the other re-deploys into `P3009`; with exclusive branches, an index abandoned beside an
    // unrelated live build is waited on and never repaired, because the two states coexist.
    const steps = ["STEP 1", "STEP 2", "STEP 3", "STEP 4"].map((s) =>
      statements.indexOf(s),
    );
    expect(Math.min(...steps)).toBeGreaterThan(-1);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(statements).not.toContain("OTHERWISE");
    // NOTE: the reindex is not skippable because the wait happened...
    expect(statements).toMatch(/Do not skip this because step 2 found a build/);
    // ...and the wait has to cover the row that names NOTHING, which is where partitioning the list
    // by name breaks: without `pg_read_all_stats` the view names no index at all, so "reindex
    // everything it does not name" is "reindex the live build you cannot see".
    expect(statements).toMatch(/row of all NULLs names nothing at all/);
    // NOTE: ...and the wait needs a ceiling: step 1 is cluster-wide, so "re-run until empty" is unbounded
    // on a cluster where some database always has a build running. Only a row that could be THIS
    // table's counts, and the GRANT turns unattributable rows into names.
    expect(statements).toMatch(/is not yours and you do not wait for it/);
    expect(statements).toMatch(/GRANT pg_read_all_stats TO/);
    // ...and step 3 derives from the catalog, not from the exception's list or step 1's rows, which
    // is what makes the sequence hold when the operator cannot read the progress view at all.
    expect(statements).toMatch(/no role setup can hide from the owner/);
    // The final step belongs to every path, and it names the failure it prevents.
    expect(statements).toContain("P3009");
    expect(steps[3]).toBeGreaterThan(
      statements.indexOf("REINDEX INDEX CONCURRENTLY on each"),
    );
  });

  describe.skipIf(!dbUp)("against the catalog", () => {
    // A run that dies mid-forge leaves the probe index (disposable) and the REAL index invalid
    // (not: the guard test would fail on debris instead of on the code). Reindexing it is the command
    // the message tells an operator to run, and it is idempotent on a valid index.
    const limpar = async () => {
      await suDb.query(`DROP INDEX IF EXISTS "${PROBE}"`);
      await suDb.query(`REINDEX INDEX CONCURRENTLY "${INDEX}"`);
    };

    beforeAll(limpar);
    afterAll(limpar);

    test("a database built from these migrations holds the index, valid", async () => {
      const r = await suDb.query<{ valid: boolean }>(
        `SELECT i.indisvalid AS valid
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = $1`,
        [INDEX],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.valid).toBe(true);
    });

    test("the guard passes on a clean catalog and RAISES on an invalid index", async () => {
      const guard = readFileSync(ASSERT_FILE, "utf8");

      // The control first, and it is not a formality: a guard that raises unconditionally would stop
      // every deploy, and the arm below could not tell the two apart.
      await suDb.query(guard);

      // NOTE: FORGED, not interrupted: killing a real build at the right moment is not reproducible, and
      // `indisvalid = false` is all it leaves for the planner to read. A unique build that hits a
      // duplicate would need rows in `conversations` (a tenant, an instance, RLS) for the same column.
      await suDb.query(`CREATE INDEX "${PROBE}" ON "conversations" ("id")`);
      await suDb.query(
        `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"${PROBE}"'::regclass`,
      );
      const forged = await suDb.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_index i
           JOIN pg_class c ON c.oid = i.indexrelid
           JOIN pg_class t ON t.oid = i.indrelid
          WHERE t.relname = 'conversations' AND NOT i.indisvalid`,
      );
      expect(forged.rows[0]?.n).toBe(1);

      // The name is in the message, and it is the point: the operator's next command needs it.
      await expect(suDb.query(guard)).rejects.toThrow(
        new RegExp(`conversations carries invalid index\\(es\\): ${PROBE}`),
      );

      // ...and the command the message names is what unblocks the deploy, which is the other half of
      // the message being useful.
      await suDb.query(`DROP INDEX "${PROBE}"`);
      await suDb.query(guard);
    });

    test("a REINDEX cannot save a unique index whose data violates it", async () => {
      // Why the message carries that clause: on the index a duplicate-key build leaves, REINDEX
      // fails the same way AND adds a second invalid index (`..._ccnew`). On a scratch table of its own,
      // so nothing is forged on the real one.
      const T = "conversations_unique_reindex_probe";
      try {
        await suDb.query(`DROP TABLE IF EXISTS "${T}"`);
        await suDb.query(`CREATE TABLE "${T}" (id int, v int)`);
        await suDb.query(`INSERT INTO "${T}" VALUES (1, 7), (2, 7)`);
        await expect(
          suDb.query(
            `CREATE UNIQUE INDEX CONCURRENTLY "${T}_v_idx" ON "${T}" (v)`,
          ),
          // `pg` puts Postgres's DETAIL ("Key (v)=(7) is duplicated") on `err.detail`, not on
          // `err.message`, so matching the word psql prints matches nothing here.
        ).rejects.toThrow(/could not create unique index/);
        const dead = async () => {
          const r = await suDb.query<{ n: string }>(
            `SELECT c.relname AS n
               FROM pg_class c
               JOIN pg_index i ON i.indexrelid = c.oid
               JOIN pg_class t ON t.oid = i.indrelid
              WHERE t.relname = $1 AND NOT i.indisvalid
              ORDER BY c.relname`,
            [T],
          );
          return r.rows.map((x) => x.n);
        };
        expect(await dead()).toEqual([`${T}_v_idx`]);

        // The command the message names, on the one index it cannot fix.
        await expect(
          suDb.query(`REINDEX INDEX CONCURRENTLY "${T}_v_idx"`),
        ).rejects.toThrow(/could not create unique index/);
        // NOTE: ...and it leaves a SECOND corpse.
        expect(await dead()).toEqual([`${T}_v_idx`, `${T}_v_idx_ccnew`]);

        // The guarded index is non-unique, where the precondition always holds, and the test below
        // exercises that path on the real one.
        const real = await suDb.query<{ uniq: boolean }>(
          `SELECT i.indisunique AS uniq
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relname = $1`,
          [INDEX],
        );
        expect(real.rows[0]?.uniq).toBe(false);
      } finally {
        await suDb.query(`DROP TABLE IF EXISTS "${T}"`);
      }
    });

    test("the recovery the message names gives the index back, not just a green deploy", async () => {
      // Running the guard's SQL proves it raises, not that its sentence leads anywhere. Behind the
      // `--applied` door the build file never runs again, so an operator who drops the dead index ends
      // with NO index on this prefix and a green deploy. Exercised here on the REAL index.
      const guard = readFileSync(ASSERT_FILE, "utf8");
      const valido = async () => {
        const r = await suDb.query<{ valid: boolean }>(
          `SELECT i.indisvalid AS valid
             FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
            WHERE c.relname = $1`,
          [INDEX],
        );
        return r.rows.map((x) => x.valid);
      };

      // The state an interrupted build leaves: the index is there, and Postgres will not use it.
      await suDb.query(
        `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"${INDEX}"'::regclass`,
      );
      expect(await valido()).toEqual([false]);
      // Substring, not a pattern: the message carries `index(es)`, whose parentheses are literal and
      // one escape away from a regex that quietly matches nothing.
      await expect(suDb.query(guard)).rejects.toThrow(INDEX);

      // The command the message names, and the definition survives it: this is why it is a REINDEX
      // and not a drop plus a hand-written CREATE that nobody has the text of at 3am.
      const antes = await suDb.query<{ def: string }>(
        `SELECT pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = $1`,
        [INDEX],
      );
      await suDb.query(`REINDEX INDEX CONCURRENTLY "${INDEX}"`);
      expect(await valido()).toEqual([true]);
      const depois = await suDb.query<{ def: string }>(
        `SELECT pg_get_indexdef(i.indexrelid) AS def
           FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
          WHERE c.relname = $1`,
        [INDEX],
      );
      expect(depois.rows[0]?.def).toBe(antes.rows[0]?.def as string);

      // ...and only then does the guard let the deploy through.
      await suDb.query(guard);
    });
  });
});
