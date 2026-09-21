import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { Client } from "pg";

// A `CREATE INDEX CONCURRENTLY` THAT DIES LEAVES AN INDEX POSTGRES REFUSES TO USE (issue #759).
//
// Without a transaction the build is not atomic, so a deploy interrupted mid-build leaves
// `indisvalid = false` behind: never chosen for a query, still maintained on every write. Nothing
// else in the suite can see it, because an index changes no result, only a cost, and nothing in the
// schema or in `migrate status` says a word.
//
// The interruption itself is LOUD, and the `DROP INDEX IF EXISTS` every one of those migrations
// opens with is NOT the defence, which is what `20260919140000_conversations_contact_inbox_index`
// claims in its own header. Measured against a scratch database: the file whose connection dies
// leaves its `_prisma_migrations` row with `finished_at = NULL`, and the next deploy stops with
// `P3009`, so the container never serves. The silence is in the way OUT of P3009 —
// `migrate resolve --applied` marks the file applied without running it, the app boots, and the
// corpse stays in the catalog for good. The DROP only ever helps the other door
// (`resolve --rolled-back` plus a re-deploy), which reruns the file.
//
// So the defence is a FOLLOWING migration that asks the catalog, and this file holds both halves of
// keeping it: that the guard FIRES against a real invalid index (not merely that its text mentions
// `indisvalid`), and that no table gets a concurrent build without one.

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

// AND A STRING LITERAL IS NOT A STATEMENT, which stopped being a nicety the moment these guards
// started printing a runbook: this file's own `RAISE EXCEPTION` names `CREATE INDEX CONCURRENTLY`
// (to say that an in-flight one reads like a corpse) and `REINDEX INDEX CONCURRENTLY … on each`.
// Read as code, that is a concurrent build `ON` a table called `each`, so the sweep reported this
// very guard as an unguarded build and the "file of its own" check called it a build file. Strip the
// quoted spans before asking what the file EXECUTES. `''` is Postgres's escape for a quote inside a
// literal, so a doubled quote continues the span rather than closing it.
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
    // Anything may sit between the index name and its `ON`, INCLUDING A NEWLINE: two of the three
    // files in this tree are written that way, so a per-line pattern reads one build and misses two.
    // And `UNIQUE` sits between CREATE and INDEX, so a pattern without it cannot see the one kind of
    // concurrent build this round spent itself discussing: a unique one, whose interrupted corpse is
    // also the only kind a REINDEX cannot revive.
    for (const m of codeOf(sql).matchAll(
      /CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY[\s\S]*?\bON\s+"?([a-z0-9_]+)"?/gi,
    )) {
      builds.set(m[1] as string, name); // sorted, so the last write is the last build
    }
    // OVER `statementsOf`, which is the middle of the three views and the only right one here. NOT
    // `codeOf`: the table name lives inside a string literal (`t.relname = 'conversations'`), which
    // that view strips, and not the DO-body-stripping sweep in tenant-index-redundancy.test.ts
    // either, for the same reason. But not raw SQL, which was the bug: a later file holding nothing
    // but the check IN A COMMENT satisfied the fence while executing no catalog query at all.
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
    // LATER, not merely present: a guard that runs before the build asks about a table the index has
    // not been added to yet, and it can never be the same file — a `DO $$` block puts the migration
    // in an implicit transaction, which `CREATE INDEX CONCURRENTLY` cannot share.
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
    // A QUOTED RUNBOOK IS NOT A BUILD EITHER, and this is the case that actually bit: the guard's own
    // `RAISE EXCEPTION` tells the operator that an in-flight `CREATE INDEX CONCURRENTLY` reads like a
    // corpse, and to run `REINDEX INDEX CONCURRENTLY … on each` index. Read as code, that second
    // clause is a concurrent build `ON` a table named `each`.
    expect(
      sweep([
        {
          name: "1_guard",
          sql: `DO $$\nBEGIN\n  RAISE EXCEPTION 'an in-flight CREATE INDEX CONCURRENTLY on "conversations" reads the same; run REINDEX INDEX CONCURRENTLY on each dead index';\nEND $$;`,
        },
      ]).builds.size,
    ).toBe(0);
    // Prose is not a build. Every one of these files explains the rule above its statements, and the
    // sweep used to be fed the comments along with them.
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
    // A BUILD IN FLIGHT READS EXACTLY LIKE A CORPSE: Postgres creates the index invalid and
    // validates it afterwards, so a `CREATE INDEX CONCURRENTLY` running right now is
    // `indisvalid = false` for its whole duration and this guard stops the deploy on it. Keeping
    // that refusal is right; telling the operator to reindex somebody else's live build is not.
    // `indisready` does not separate the two (measured: a build killed during its first scan leaves
    // `false/false`, the pair a live build shows), so the message names the one thing that does.
    // `pg_stat_progress_create_index`, not a query-text match: a live `CREATE UNIQUE INDEX
    // CONCURRENTLY` does not match `query ILIKE 'create index%'` (measured: zero rows while the
    // progress view named the build), so that advice reported "nothing running" for the exact case
    // it existed to catch. The view also names the index, which is what lets the operator compare it
    // with the ones this message just listed.
    expect(statements).toContain("pg_stat_progress_create_index");
    // The ban is on the IDIOM, not on the name: this message shipped one round advising
    // `query ILIKE 'create index%'` on `pg_stat_activity`, which a live
    // `CREATE UNIQUE INDEX CONCURRENTLY` does not match. Naming that view is fine and now useful,
    // because the reindex's wait surfaces there as `Lock / virtualxid` and reads like a lock
    // problem; what must never come back is discriminating live from abandoned by query text.
    expect(statements).not.toMatch(/query\s+ILIKE/i);
    expect(statements).not.toMatch(/pg_stat_activity[^.]*\bWHERE\b/i);
    // ...and the privilege clause, because the view answers DIFFERENTLY by role and the weaker answer
    // is an EMPTY one. Measured against a database owned by a non-superuser, which is the managed
    // shape `docs/deploy.md` describes: for a build another role started, the row is there but every
    // column comes back NULL, so a `WHERE relid = …` filter drops it and the check reports "nothing
    // running" for the exact case it exists to catch. The message must not carry that filter.
    // Asserted by the CLAIM, not by the word: the message now also names `pg_read_all_stats` in the
    // GRANT that gets an operator out of a stream of unattributable rows, so matching the word alone
    // stopped covering this sentence at all (a mutant that deleted it survived).
    expect(statements).toMatch(/a filter on relid drops exactly that row/);
    // The window has to stop at the statement's own `;`: the message now says "Run it with no
    // WHERE" one line below the query, and a proximity match reads that sentence as the filter it
    // is warning against. Same shape as the literal that poisoned the sweep two rounds ago.
    expect(statements).not.toMatch(
      /pg_stat_progress_create_index[^;\n]*WHERE/i,
    );
    // ...and the REINDEX's precondition, which is the clause this message shipped one round without:
    // the index has to be BUILDABLE.
    expect(statements).toMatch(/is UNIQUE/);
    // ...scoped to a REINDEX that failed ON ITS OWN, because being interrupted is a second way for
    // one to fail and the unqualified claim reads as exhaustive.
    // ...and it is conditioned on the error the REINDEX actually reported, because no disk, a
    // deadlock and a statement or lock timeout fail one too, including on the non-unique indexes
    // this tree builds. The unqualified claim sent the operator hunting duplicate data that is not
    // there while the deploy stayed blocked.
    expect(statements).toMatch(/If a REINDEX fails on its own, READ THE ERROR/);
    expect(statements).toMatch(
      /"could not create unique index" means the index is UNIQUE/,
    );
    // ...and the clause that says what to DO about the duplicates, which a mutant deleting it
    // survived: naming the cause without the recovery leaves the operator with a diagnosis.
    expect(statements).toMatch(
      /resolve the duplicates, DROP the \.\.\._ccnew that attempt left behind, then reindex the original/,
    );
    // ...and a `..._ccnew` is excluded from the rebuild, which is the defect that admitting the
    // interrupted state created: the catalog query lists the leftover AND the original, and
    // reindexing both is measured to leave two valid indexes with identical pg_get_indexdef, a
    // duplicate paid for by every write that this file can never report again, because both are
    // valid.
    expect(statements).toMatch(
      /A name ending in \.\.\._ccnew or \.\.\._ccold, with or without a trailing number/,
    );
    expect(statements).toMatch(
      /Reindexing either of those instead of dropping it ends with TWO valid indexes/,
    );
    // ...and the wait the ceiling in step 2 excuses comes back INSIDE the reindex, which waits for
    // any older snapshot including one that never touches this table (measured: 1s idle, 28s
    // against one open transaction on an unrelated table, 111s beside a live build on another
    // table). An operator who reads that as hung and interrupts it turns one dead index into two:
    // the original stays invalid and an invalid `..._ccnew` appears beside it (measured).
    expect(statements).toMatch(
      /wait phase of its own and waits for ANY transaction whose snapshot is older/,
    );
    // The numbers stay in the message: "it may take a while" is advice, "111s beside a live build
    // on another table" is what tells an operator staring at a prompt that this is the normal shape.
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
    // ...and the message is a SEQUENCE of four steps, not a fork. Two rounds shipped a fork here.
    // The first put the final `resolve` inside one branch, so whoever took the other re-deployed
    // into `P3009` with nothing saying a command was missing (measured: the build finishes, the
    // re-deploy still exits 1). The second made the branches exclusive, and an index abandoned
    // beside an unrelated live build took the waiting one: the operator waited, resolved,
    // re-deployed, and this assertion raised on the index nobody repaired (measured: a forged
    // invalid index plus a real `CREATE INDEX CONCURRENTLY` held in `waiting for old snapshots` ->
    // the assertion lists both, the progress view names only the live one, and the corpse is still
    // invalid once the build finishes).
    const steps = ["STEP 1", "STEP 2", "STEP 3", "STEP 4"].map((s) =>
      statements.indexOf(s),
    );
    expect(Math.min(...steps)).toBeGreaterThan(-1);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    expect(statements).not.toContain("OTHERWISE");
    // The reindex is not skippable because the wait happened, which is the whole of the second fix...
    expect(statements).toMatch(/Do not skip this because step 2 found a build/);
    // ...and the wait has to cover the row that names NOTHING, which is where partitioning the list
    // by name breaks: without `pg_read_all_stats` the view names no index at all, so "reindex
    // everything it does not name" is "reindex the live build you cannot see".
    expect(statements).toMatch(/row of all NULLs names nothing at all/);
    // ...and the wait needs a ceiling, because step 1 is cluster-wide and that is what makes the
    // nulled row appear at all: "re-run until empty" is unbounded on a cluster where some database
    // always has a build running, and the operator is then stuck waiting instead of fixing. Only a
    // row that could be THIS table's counts, and the way out of a stream of unattributable rows is
    // the GRANT that turns them into names (measured: the same role, against the same live build,
    // goes from `179174 | | |` to `conversations | zz_live2 | waiting for old snapshots`).
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
    // The forges below leave two kinds of debris if a run dies between two statements: the probe
    // index, which is disposable, and the REAL index left invalid, which is not — the guard test
    // after it would fail on debris instead of on the code. Reindexing it is the same command this
    // file's message tells an operator to run, and it is idempotent on a valid index.
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

      // FORGED, not interrupted. Killing a real `CREATE INDEX CONCURRENTLY` at the right moment is
      // not reproducible, and `indisvalid = false` is the whole of what it leaves for anyone
      // downstream to read — the planner consults that column and nothing else. The other
      // reproducible route (a `CREATE UNIQUE INDEX CONCURRENTLY` that hits a duplicate) would need
      // rows in `conversations`, so a tenant, an instance and RLS, to arrive at the same column.
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
      // WHY THE MESSAGE CARRIES THAT CLAUSE, and it is here because the first version of this round
      // asserted the opposite: it chained "a duplicate-key build leaves `indisvalid = false`" to
      // "REINDEX takes it back to true" as though they were one measurement, and the second half had
      // been measured only after deleting the duplicate. On the index that failure leaves, the
      // REINDEX fails the same way AND adds a second invalid index (`..._ccnew`), so an operator who
      // followed the sentence would end with a worse catalog than they started with.
      //
      // On a scratch table of its own: the guard asks about `conversations`, so this proves the
      // Postgres behaviour the clause is about without forging anything on the real table.
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
        // ...and it left a SECOND corpse, which is the part worth a test rather than a sentence.
        expect(await dead()).toEqual([`${T}_v_idx`, `${T}_v_idx_ccnew`]);

        // The index of this issue is non-unique, where the precondition always holds, and the arm
        // below measures that path on the real one.
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
      // THE HALF THE SIBLING GUARDS GET WRONG. Running the guard's SQL directly proves it raises; it
      // does not prove the sentence it raises leads anywhere. Behind the `--applied` door the build
      // file is recorded as applied and never runs again, so an operator who drops the dead index
      // ends with `conversations` carrying NO index on this prefix: the deploy goes green, the plan
      // goes back to the scan, and nothing asks a second time. Measured here on the REAL index.
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
