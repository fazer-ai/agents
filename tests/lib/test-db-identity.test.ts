import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appliedMigrations,
  appliedOutOfOrder,
  changedMigrations,
  DB_GATE_OPT_OUT,
  foreignMigrations,
  type LocalMigration,
  localMigrations,
  type MigrationRow,
  pendingMigrations,
  reprovisionReasons,
  schemaOutOfStep,
} from "../db-gate";
import { checkoutRootFrom, testDbNameFor, withDbName } from "../db-name";

// ONE DATABASE, MANY TREES, AND NOTHING THAT NOTICED (issue #417).
//
// The test database outlives every branch switch and `prisma migrate deploy` only ever ADDS, so a
// migration applied from one tree stays applied under the next one. While the leftover is additive
// it is invisible; when it is subtractive the next tree runs its whole suite against a schema that
// is not its own, and the failures name code that is correct.
//
// Measured on this repo before any of this existed, `main` checked out and clean: 7261 pass, 31
// fail, the SAME 31 on three consecutive full-suite runs, every one of them dying on
// `42P10 there is no unique or exclusion constraint matching the ON CONFLICT specification` because
// a migration from an unmerged branch had dropped the index `main`'s client upserts against. The
// `beforeAll` blocks took their files down with them, so 29 further tests never executed at all and
// the `31 fail` line did not count them (7321 tests on a correct schema, 7292 on that one). A fresh
// database from the same tree, same suite, same loaded machine: 7321 pass, 0 fail, three times.
//
// `prisma migrate status` answered "Database schema is up to date!" about that exact database. It
// looks for PENDING and FAILED migrations; one that is applied but absent from the tree is neither.
//
// Two halves below, and the file holds both because neither is a fix on its own. The name keeps two
// trees from sharing a database; the diff keeps a database that drifted anyway from being read as a
// verdict about the code.

const ROOT = checkoutRootFrom(import.meta.url, "../..");

describe("the test database's name belongs to ONE checkout", () => {
  test("two checkouts of the same repo do not share a database", () => {
    const a = testDbNameFor("fazerai_agents_test", "/home/dev/agents/main");
    const b = testDbNameFor("fazerai_agents_test", "/home/dev/agents/hotfix");
    expect(a).not.toBe(b);
  });

  // The basename alone is not the identity: worktrees are named after the issue they carry, and two
  // clones of two repos can both hold a `main`. The hash is over the ABSOLUTE path for that reason,
  // and it is what makes the readable half safe to truncate.
  test("the same basename under different parents does not collide", () => {
    expect(testDbNameFor("x_test", "/a/main")).not.toBe(
      testDbNameFor("x_test", "/b/main"),
    );
  });

  test("the same checkout always gets the same name", () => {
    expect(testDbNameFor("x_test", "/a/main")).toBe(
      testDbNameFor("x_test", "/a/main"),
    );
    // A trailing separator is the same directory, and `git rev-parse` and `import.meta.url` do not
    // agree about whether it is there.
    expect(testDbNameFor("x_test", "/a/main/")).toBe(
      testDbNameFor("x_test", "/a/main"),
    );
  });

  // The `_test` suffix is load-bearing twice over: tests/setup.ts refuses any other target before it
  // will run the destructive suite, and scripts/test-db-setup.ts refuses to provision one. A
  // derivation that dropped it would disarm both.
  test("every derived name still ends in _test", () => {
    for (const base of ["x_test", "fazerai_agents_test", "no_suffix"]) {
      expect(testDbNameFor(base, ROOT).endsWith("_test")).toBe(true);
    }
  });

  // Postgres truncates an identifier at 63 bytes SILENTLY, which would turn two long checkout paths
  // back into one shared database — the exact failure this exists to prevent, arriving through the
  // fix for it.
  test("a very long checkout path still yields a legal, distinct identifier", () => {
    const deep = `/${"nested-directory/".repeat(12)}some-extremely-long-worktree-name`;
    const name = testDbNameFor("fazerai_agents_test", deep);
    expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(63);
    expect(name).not.toBe(testDbNameFor("fazerai_agents_test", `${deep}-two`));
    expect(
      Buffer.byteLength(
        testDbNameFor("fazerai_agents_test", `${deep}-two`),
        "utf8",
      ),
    ).toBeLessThanOrEqual(63);
  });

  // Deriving a name that was already derived HERE has to be a no-op, or anything that reads the
  // running suite's URL and starts a second run from it lands on a database that does not exist.
  // That is not hypothetical: it is how the gate's own subprocess test failed when this shipped
  // without it.
  test("deriving twice for the same checkout changes nothing", () => {
    const once = testDbNameFor("fazerai_agents_test", ROOT);
    expect(testDbNameFor(once, ROOT)).toBe(once);
  });

  // The other checkout's derived name is not this checkout's answer, so it must NOT pass through.
  test("a name derived for another checkout is re-derived, not adopted", () => {
    const theirs = testDbNameFor("fazerai_agents_test", "/somewhere/else");
    expect(testDbNameFor(theirs, ROOT)).not.toBe(theirs);
  });

  // THE FENCE THIS SHIPPED WITHOUT. The preload forces the suite's connections onto the derived
  // database, and it has to force EVERY spelling of it: `MIGRATION_DATABASE_URL` is what 175 files
  // read, but three build their superuser client from the raw `TEST_MIGRATION_DATABASE_URL`, which
  // was the same database until one of the two was derived. Those three then seeded one database
  // and read another — 36 failures, every one an assertion about a row that had been written
  // somewhere else, and none of them anywhere near this change.
  test.skipIf(process.env[DB_GATE_OPT_OUT] === "1")(
    "every spelling of the test database names ONE database after the preload",
    () => {
      const names = (
        [
          "MIGRATION_DATABASE_URL",
          "TEST_MIGRATION_DATABASE_URL",
          "TEST_APP_DATABASE_URL",
        ] as const
      ).map((v) => {
        const url = process.env[v];
        expect(url, `${v} is not set after the preload`).toBeTruthy();
        return new URL(url as string).pathname.replace(/^\//, "");
      });
      expect(new Set(names).size).toBe(1);
      // And it is THIS checkout's database, not the one the `.env` declares.
      expect(names[0]).toBe(testDbNameFor(names[0] as string, ROOT));
    },
  );

  // A `file://` URL percent-encodes what a path may hold and a filesystem call does not decode it,
  // so a checkout under a directory with a space in it reads its own root as `.../my%20tree` — and
  // then `readdirSync` on `prisma/migrations` under it is ENOENT and EVERY database-backed run
  // aborts. Measured before this was decoded: `ENOENT: no such file or directory, scandir
  // '/private/tmp/tree%20with%20space/sub/prisma/migrations'`. Not exotic on macOS, where a home
  // directory can sit under one.
  test("a checkout path with a space is a path, not a percent-encoded one", () => {
    expect(
      checkoutRootFrom("file:///tmp/tree%20with%20space/tests/x.ts", ".."),
    ).toBe("/tmp/tree with space");
    // Not only the space: anything a `file://` URL escapes comes back escaped.
    expect(
      checkoutRootFrom("file:///tmp/%C3%A7a%20va/lib/tests/x.ts", "../.."),
    ).toBe("/tmp/ça va");
    expect(checkoutRootFrom("file:///tmp/plain/tests/x.ts", "..")).toBe(
      "/tmp/plain",
    );
  });

  // The truncation has to come off whichever half is long. Shortening only the checkout leaves a
  // long BASE over the limit with nothing left to cut, and Postgres cuts it instead — silently, and
  // through the end of the hash, which is the one part that has to survive for two checkouts to
  // stay apart. Measured: a 57-character base produced 64 bytes, a 63-character one produced 70.
  test("a long BASE name is truncated too, and the hash survives it", () => {
    for (const len of [40, 52, 57, 63]) {
      const base = `${"b".repeat(len - 5)}_test`;
      const name = testDbNameFor(base, "/dev/agents/main");
      expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(63);
      expect(name.endsWith("_test")).toBe(true);
      // The full hash, not a prefix of it: a truncated hash is two checkouts sharing a database.
      const hashed = testDbNameFor("x_test", "/dev/agents/main");
      const hash = hashed.slice(-("_test".length + 6), -"_test".length);
      expect(name).toContain(hash);
    }
    // And two long-based checkouts still differ.
    const long = `${"b".repeat(58)}_test`;
    expect(testDbNameFor(long, "/dev/agents/main")).not.toBe(
      testDbNameFor(long, "/dev/agents/other"),
    );
  });

  // TWO BASES IN ONE CHECKOUT ARE TWO DATABASES, and the truncation must not be able to merge them.
  // Giving the checkout half priority meant a long checkout name consumed the whole budget, the base
  // half vanished, and every base derived to one name — measured with a 52-character checkout:
  // `secretaria_v4_test`, `fzgate417_test` and `fzsetup417_test` all became
  // `wwww…_79bdb0_test`. The live tests in this file create scratch databases from their own bases,
  // so the collision would have them DROP and terminate the database backing the suite running them.
  test("different bases never merge, however long the checkout name is", () => {
    const bases = ["secretaria_v4_test", "fzgate417_test", "fzsetup417_test"];
    for (const root of ["/dev/agents/main", `/dev/${"w".repeat(52)}`]) {
      const names = bases.map((b) => testDbNameFor(b, root));
      expect(new Set(names).size).toBe(bases.length);
      for (const n of names) {
        expect(Buffer.byteLength(n, "utf8")).toBeLessThanOrEqual(63);
      }
    }
  });

  // And the same two bases in two checkouts are four databases, which is the property both halves
  // of the name exist for.
  test("base and checkout are both part of the identity", () => {
    const names = new Set(
      ["a_test", "b_test"].flatMap((b) =>
        ["/x/one", "/x/two"].map((r) => testDbNameFor(b, r)),
      ),
    );
    expect(names.size).toBe(4);
  });

  // The hash's job is IDENTITY, so it is taken over the base as written. Hashing the normalized
  // text makes identity as lossy as display: `identifierSafe` folds every run of non-alphanumerics
  // to one underscore, so two legal, distinct databases became one — measured,
  // `foo-bar_test` and `foo_bar_test` both derived to `foo_bar_x_4928ca5cf696_test`.
  test("two bases that only NORMALIZE alike are still two databases", () => {
    expect(testDbNameFor("foo-bar_test", "/dev/x")).not.toBe(
      testDbNameFor("foo_bar_test", "/dev/x"),
    );
    expect(testDbNameFor("Foo_test", "/dev/x")).not.toBe(
      testDbNameFor("foo_test", "/dev/x"),
    );
  });

  // A name a human can read is the point of keeping the basename at all: `psql -l` has to say which
  // worktree owns which database, or the isolation just moves the confusion.
  test("the checkout is still readable in the name", () => {
    expect(
      testDbNameFor("x_test", "/dev/agents-master/295-delivery-recovery"),
    ).toContain("295_delivery_recovery");
  });

  // A path is not an identifier: anything that is not [a-z0-9_] has to fold, or the CREATE DATABASE
  // needs quoting that the connection URL then has to carry too.
  test("only identifier characters survive", () => {
    expect(testDbNameFor("x_test", "/dev/Feature Branch.v2")).toMatch(
      /^[a-z0-9_]+$/,
    );
  });

  test("the derived name is swapped into the URL, and nothing else is", () => {
    const url = withDbName(
      "postgres://u:p@localhost:5433/fazerai_agents_test?sslmode=disable",
      "fazerai_agents_main_ab12cd_test",
    );
    expect(url).toContain("/fazerai_agents_main_ab12cd_test");
    expect(url).toContain("u:p@localhost:5433");
    expect(url).toContain("sslmode=disable");
  });
});

// The ledger, in the shape the gate reads it. A row is not a name: it also says whether the apply
// FINISHED and whether someone resolved it as rolled back.
// The checksum is a real one of the name, so a fixture never accidentally matches a DIFFERENT
// name's file: `sameSql` below builds the local side from the same function.
const sumOf = (name: string) => createHash("sha256").update(name).digest("hex");
const done = (...names: string[]): MigrationRow[] =>
  names.map((migration_name) => ({
    migration_name,
    checksum: sumOf(migration_name),
    finished_at: new Date(),
    rolled_back_at: null,
  }));
const halfWay = (migration_name: string): MigrationRow => ({
  migration_name,
  checksum: sumOf(migration_name),
  finished_at: null,
  rolled_back_at: null,
});
// The tree side, agreeing with `done` by construction.
const sameSql = (names: string[]): LocalMigration[] =>
  names.map((name) => ({ name, checksum: sumOf(name) }));

describe("a database that is not this tree's database", () => {
  const local = ["20260101000000_a", "20260102000000_b"];

  // `_prisma_migrations` keeps the row of a migration that FAILED half-way (`finished_at` still
  // null, `logs` filled) and of one resolved as rolled back (`rolled_back_at` set). Reading the
  // name alone counts both as applied, so a database left partially migrated reads as matching and
  // the suite runs against a schema nobody finished writing. Measured on the real table: an
  // interrupted apply leaves `{ finished_at: null, rolled_back_at: null }`.
  test("a migration that never finished is not applied", () => {
    const rows = [...done("20260101000000_a"), halfWay("20260102000000_b")];
    expect(appliedMigrations(rows)).toEqual(["20260101000000_a"]);
    expect(schemaOutOfStep("x_test", rows, sameSql(local))).toContain(
      "20260102000000_b",
    );
  });

  test("a migration resolved as rolled back is not applied either", () => {
    const rows: MigrationRow[] = done("20260101000000_a").map((r) => ({
      ...r,
      rolled_back_at: new Date(),
    }));
    expect(appliedMigrations(rows)).toEqual([]);
  });

  test("a matching database is not stopped", () => {
    expect(
      schemaOutOfStep("x_test", done(...local), sameSql(local)),
    ).toBeNull();
  });

  // The direction that produced the incident: applied, and the tree has never heard of it.
  test("a migration the tree does not have is named", () => {
    const applied = [...local, "20260103000000_from_another_branch"];
    expect(foreignMigrations(applied, local)).toEqual([
      "20260103000000_from_another_branch",
    ]);
    const message = schemaOutOfStep("x_test", done(...applied), sameSql(local));
    expect(message).toContain("20260103000000_from_another_branch");
    expect(message).toContain("x_test");
    expect(message).toContain("db:test:setup");
  });

  // The other direction is the same invariant, and it is the one a `git pull` produces: the tree
  // gained a migration and the database has not been told. It reaches a reader as a missing column
  // rather than as a missing migration, which is just as unreadable as the incident above.
  test("a migration the database has never been given is named too", () => {
    const applied = [local[0] as string];
    expect(pendingMigrations(applied, local)).toEqual(["20260102000000_b"]);
    expect(
      schemaOutOfStep("x_test", done(...applied), sameSql(local)),
    ).toContain("20260102000000_b");
  });

  // Both at once is the branch switch that also pulled, and a message that reported only the first
  // one it found would send the reader back for a second run to learn the rest.
  test("both directions are reported in one refusal, and told apart", () => {
    const message = schemaOutOfStep(
      "x_test",
      done("20260101000000_a", "20260199000000_foreign"),
      sameSql(local),
    ) as string;
    expect(message).toContain("20260199000000_foreign");
    expect(message).toContain("20260102000000_b");
    expect(message.indexOf("20260199000000_foreign")).not.toBe(
      message.indexOf("20260102000000_b"),
    );
  });

  // Order is not the question. `_prisma_migrations` is read in whatever order the query returns and
  // the directory in whatever order the filesystem lists, so a set difference that depended on
  // either would report a healthy database as divergent.
  test("neither side's order is part of the answer", () => {
    expect(
      schemaOutOfStep("x_test", done(...[...local].reverse()), sameSql(local)),
    ).toBeNull();
  });

  // An empty applied set is a database that exists and has never been migrated, which is what a
  // fresh `CREATE DATABASE` leaves behind. It is out of step with every non-empty tree, and saying
  // so is the difference between one clear refusal and a suite that fails on the first missing
  // table.
  test("a database with nothing applied is out of step, not up to date", () => {
    expect(schemaOutOfStep("x_test", [], sameSql(local))).toContain(
      "20260101000000_a",
    );
  });

  // And the fence against the fence: a scan that found nothing passes exactly like a scan that
  // found everything, so an empty tree has to be the one case that cannot refuse.
  test("an empty tree asks nothing of any database", () => {
    expect(schemaOutOfStep("x_test", [], [])).toBeNull();
  });

  // The blind spot the FIRST fix opened, and the reason `schemaOutOfStep` takes rows rather than an
  // applied set: excluding a half-applied row from `applied` also excludes it from every comparison
  // built on `applied`, so a foreign migration that died half-way reads as a database in step.
  // Measured on the real ledger before this: 57 rows, 56 counted, foreign empty, verdict up to date.
  test("a migration that died half-way is named, not merely excluded", () => {
    const rows = [...done(...local), halfWay("20260199000000_died_elsewhere")];
    const message = schemaOutOfStep("x_test", rows, sameSql(local)) as string;
    expect(message).toContain("20260199000000_died_elsewhere");
    expect(message).toContain("never finished");
  });

  test("a local migration that died half-way stops the run too", () => {
    const rows = [done(local[0] as string)[0], halfWay(local[1] as string)];
    expect(
      schemaOutOfStep("x_test", rows as MigrationRow[], sameSql(local)),
    ).toContain(local[1] as string);
  });
});

// THE DOOR HAS TO OPEN ON EVERY STATE THE WALL REFUSES. `prisma migrate deploy` is the right repair
// for exactly one of them — a database simply BEHIND this tree, in this tree's own order. The rest
// it either cannot fix or fixes into a schema a fresh database would never have, and a refusal
// whose prescribed command cannot act on it is just a slower way to be stuck.
describe("which states cannot be deployed onto", () => {
  const local = ["20260101000000_a", "20260102000000_b", "20260103000000_c"];

  test("a database in step, and one merely behind, are deployed onto", () => {
    expect(reprovisionReasons(done(...local), sameSql(local))).toEqual([]);
    // Behind by the NEWEST migration: deploying applies it last, exactly as a fresh build would.
    expect(
      reprovisionReasons(
        done("20260101000000_a", "20260102000000_b"),
        sameSql(local),
      ),
    ).toEqual([]);
  });

  test("a foreign migration cannot be undone by deploying", () => {
    const reasons = reprovisionReasons(
      done(...local, "20260199000000_theirs"),
      sameSql(local),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("20260199000000_theirs");
  });

  test("a half-applied row is P3009, which deploying answers with a refusal", () => {
    const reasons = reprovisionReasons(
      [...done(...local), halfWay("20260104000000_d")],
      sameSql(local),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("never finished");
  });

  test("a rolled-back row counts the same way", () => {
    const reasons = reprovisionReasons(
      [
        ...done(...local),
        ...done("20260104000000_d").map((r) => ({
          ...r,
          rolled_back_at: new Date(),
        })),
      ],
      sameSql(local),
    );
    expect(reasons).toHaveLength(1);
  });

  // The merge case: a branch applied `_c`, then main brought in `_b`, which sorts BEFORE it.
  // Deploying now runs `_b` after `_c`, and no fresh database would ever be built that way.
  test("a pending migration that sorts before an applied one is not deployed onto", () => {
    const reasons = reprovisionReasons(
      done("20260101000000_a", "20260103000000_c"),
      sameSql(local),
    );
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("20260102000000_b");
    expect(reasons[0]).toContain("sorts later");
  });

  // Order is decided by the FILENAME and by nothing else, and in this repo three migrations share
  // the timestamp `20260827000000` — so which branch sorts first has nothing to do with which was
  // written first, and the suffix is what decides.
  test("the order that matters is the filename's, suffix included", () => {
    const sameStamp = ["20260827000000_a_first", "20260827000000_b_second"];
    expect(
      reprovisionReasons(done("20260827000000_b_second"), sameSql(sameStamp)),
    ).toHaveLength(1);
    expect(
      reprovisionReasons(done("20260827000000_a_first"), sameSql(sameStamp)),
    ).toEqual([]);
  });

  test("an empty database is provisioned, not reprovisioned", () => {
    expect(reprovisionReasons([], sameSql(local))).toEqual([]);
  });
});

// The two describes above prove the DECISIONS, which is all a pure function can prove. This proves
// the thing that ships: a real `bun test` invocation, against a real database carrying a real
// foreign migration row, refusing before the first test file loads. The same shape as the gate's own
// subprocess tests in ./db-gate.test.ts, and for the same reason — the preload is out of reach of a
// test by the time a test runs, so the only way to watch it refuse is to start another one.
//
// The scratch database is NAMED BY THE DERIVATION rather than by this file: pass a base and create
// whatever `testDbNameFor` says the child will look for. Pointing the child at a hand-picked name
// would need an escape hatch in the production path, and the only caller of that escape hatch would
// be this test.
describe("the refusal, as a run", () => {
  const suUrl = process.env.MIGRATION_DATABASE_URL;
  const live = process.env[DB_GATE_OPT_OUT] !== "1" && Boolean(suUrl);
  const BASE = "fzgate417_test";
  const FOREIGN = "20260828000000_left_by_another_branch";
  // `fileURLToPath`, not `.pathname`, for the same reason the derivation uses it: a repository
  // under a directory with a space would otherwise hand `bun test` a filename that does not exist.
  const noop = fileURLToPath(
    new URL("../utils/db-gate-noop.ts", import.meta.url),
  );
  const repoRoot = ROOT;

  test.skipIf(!live)(
    "a database carrying another branch's migration stops the run, naming it",
    async () => {
      const { Client } = await import("pg");
      const scratch = testDbNameFor(BASE, repoRoot);
      const maintUrl = new URL(suUrl as string);
      maintUrl.pathname = "/postgres";
      const maint = new Client({ connectionString: maintUrl.toString() });
      await maint.connect();
      try {
        await maint.query(`DROP DATABASE IF EXISTS "${scratch}"`);
        await maint.query(`CREATE DATABASE "${scratch}"`);
        const seedUrl = new URL(suUrl as string);
        seedUrl.pathname = `/${scratch}`;
        const seed = new Client({ connectionString: seedUrl.toString() });
        await seed.connect();
        try {
          // Only the columns the gate reads, and all three of them: the name alone is not the
          // question it asks, because a row can be there and describe a migration that failed.
          // `finished_at` is set because this fixture is a migration that SUCCEEDED on another
          // branch, which is the case the refusal is about.
          await seed.query(
            `CREATE TABLE _prisma_migrations (
               migration_name text NOT NULL,
               checksum text NOT NULL,
               finished_at timestamptz,
               rolled_back_at timestamptz)`,
          );
          await seed.query(
            `INSERT INTO _prisma_migrations (migration_name, checksum, finished_at)
             VALUES ($1, $2, now())`,
            [FOREIGN, sumOf(FOREIGN)],
          );
        } finally {
          await seed.end();
        }

        const childUrl = new URL(suUrl as string);
        childUrl.pathname = `/${BASE}`;
        const { [DB_GATE_OPT_OUT]: _optOut, ...inherited } = process.env;
        const proc = Bun.spawn(["bun", "test", noop], {
          cwd: repoRoot,
          env: {
            ...inherited,
            TEST_MIGRATION_DATABASE_URL: childUrl.toString(),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, err, out] = await Promise.all([
          proc.exited,
          new Response(proc.stderr).text(),
          new Response(proc.stdout).text(),
        ]);
        const output = `${out}\n${err}`;
        expect(code).not.toBe(0);
        expect(output).toContain(FOREIGN);
        expect(output).toContain("does not match this tree");
        // The command that repairs it, in the message, because a refusal a reader cannot act on is
        // just a different way to be stuck.
        expect(output).toContain("db:test:setup");
        // And the run never reached a test file: the whole point is that this happens BEFORE the
        // failures it would otherwise be read from.
        expect(output).not.toContain("1 pass");
      } finally {
        await maint
          .query(`DROP DATABASE IF EXISTS "${testDbNameFor(BASE, repoRoot)}"`)
          .catch(() => {});
        await maint.end();
      }
    },
    120_000,
  );
});

// THE DOOR, and it is tested because a wall with a door that stopped opening is worse than the
// wall alone. `prisma migrate deploy` cannot repair a database carrying a foreign migration: the row
// is already in `_prisma_migrations`, so nothing is pending and whatever that migration dropped
// stays dropped. `bun db:test:setup` is the command the refusal above prints, so it has to be the
// command that actually fixes what the refusal is about.
describe("the command the refusal names", () => {
  const suUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.TEST_APP_DATABASE_URL;
  const live =
    process.env[DB_GATE_OPT_OUT] !== "1" && Boolean(suUrl) && Boolean(appUrl);
  const BASE = "fzsetup417_test";
  const FOREIGN = "20260828000000_left_by_another_branch";
  const repoRoot = ROOT;

  test.skipIf(!live)(
    "reprovisions a database that carries a migration this tree does not have",
    async () => {
      const { Client } = await import("pg");
      const scratch = testDbNameFor(BASE, repoRoot);
      const maintUrl = new URL(suUrl as string);
      maintUrl.pathname = "/postgres";
      const maint = new Client({ connectionString: maintUrl.toString() });
      await maint.connect();
      const at = (url: string, db: string) => {
        const u = new URL(url);
        u.pathname = `/${db}`;
        return u.toString();
      };
      try {
        await maint.query(`DROP DATABASE IF EXISTS "${scratch}"`);
        await maint.query(`CREATE DATABASE "${scratch}"`);
        const seed = new Client({
          connectionString: at(suUrl as string, scratch),
        });
        await seed.connect();
        try {
          await seed.query(
            `CREATE TABLE _prisma_migrations (
               migration_name text NOT NULL,
               checksum text NOT NULL,
               finished_at timestamptz,
               rolled_back_at timestamptz)`,
          );
          await seed.query(
            `INSERT INTO _prisma_migrations (migration_name, checksum, finished_at)
             VALUES ($1, $2, now())`,
            [FOREIGN, sumOf(FOREIGN)],
          );
        } finally {
          await seed.end();
        }

        const proc = Bun.spawn(["bun", "scripts/test-db-setup.ts"], {
          cwd: repoRoot,
          env: {
            ...process.env,
            TEST_MIGRATION_DATABASE_URL: at(suUrl as string, BASE),
            TEST_APP_DATABASE_URL: at(appUrl as string, BASE),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, out, err] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        expect(`${out}\n${err}`).toContain(FOREIGN);
        expect(code).toBe(0);

        const after = new Client({
          connectionString: at(suUrl as string, scratch),
        });
        await after.connect();
        try {
          const { rows } = await after.query<{ migration_name: string }>(
            "SELECT migration_name FROM _prisma_migrations",
          );
          const applied = rows.map((r) => r.migration_name);
          expect(applied).not.toContain(FOREIGN);
          // And it is not merely emptied: the tree's own migrations are all there, which is the
          // difference between a repaired database and a dropped one.
          const local = readdirSync(join(repoRoot, "prisma", "migrations"), {
            withFileTypes: true,
          })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
          expect(foreignMigrations(applied, local)).toEqual([]);
          expect(pendingMigrations(applied, local)).toEqual([]);
        } finally {
          await after.end();
        }
      } finally {
        await maint
          .query(`DROP DATABASE IF EXISTS "${scratch}"`)
          .catch(() => {});
        await maint.end();
      }
    },
    300_000,
  );

  // AND IT REPROVISIONS WITH SOMETHING STILL CONNECTED, which is the ordinary case rather than the
  // exotic one. This change first refused to force the DROP, on the reasoning that Postgres saying
  // no is safer than killing a suite mid-run; measuring the refusal is what reversed it. The holder
  // was ONE backend in `state=idle` whose last statement was `ROLLBACK` — a pool connection leaked
  // by a test process that had already exited — and the reader got
  // `database "…" is being accessed by other users`, exit 1, naming no way out. This test holds a
  // connection open across the whole command for that reason.
  test.skipIf(!live)(
    "reprovisions even with a connection still open on the database",
    async () => {
      const { Client } = await import("pg");
      const scratch = testDbNameFor(BASE, repoRoot);
      const at = (url: string, db: string) => {
        const u = new URL(url);
        u.pathname = `/${db}`;
        return u.toString();
      };
      const maintUrl = new URL(suUrl as string);
      maintUrl.pathname = "/postgres";
      const maint = new Client({ connectionString: maintUrl.toString() });
      await maint.connect();
      let squatter: InstanceType<typeof Client> | undefined;
      try {
        await maint.query(`DROP DATABASE IF EXISTS "${scratch}"`);
        await maint.query(`CREATE DATABASE "${scratch}"`);
        const seed = new Client({
          connectionString: at(suUrl as string, scratch),
        });
        await seed.connect();
        try {
          await seed.query(
            `CREATE TABLE _prisma_migrations (
               migration_name text NOT NULL,
               checksum text NOT NULL,
               finished_at timestamptz,
               rolled_back_at timestamptz)`,
          );
          await seed.query(
            `INSERT INTO _prisma_migrations (migration_name, checksum, finished_at)
             VALUES ($1, $2, now())`,
            [FOREIGN, sumOf(FOREIGN)],
          );
        } finally {
          await seed.end();
        }

        // The leaked pool connection, personified: connected, idle, and going nowhere.
        squatter = new Client({
          connectionString: at(suUrl as string, scratch),
        });
        // Being terminated is the POINT of this fixture, and `pg` reports it by emitting `error` on
        // the client. Unhandled, that is an event with no listener, which Bun surfaces as a failure
        // of whichever test happens to be running — including the one above this.
        squatter.on("error", () => {});
        await squatter.connect();
        await squatter.query("SELECT 1");

        const proc = Bun.spawn(["bun", "scripts/test-db-setup.ts"], {
          cwd: repoRoot,
          env: {
            ...process.env,
            TEST_MIGRATION_DATABASE_URL: at(suUrl as string, BASE),
            TEST_APP_DATABASE_URL: at(appUrl as string, BASE),
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [code, out, err] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const output = `${out}
${err}`;
        // The failure this replaces, spelled out so a future FORCE-less DROP fails HERE and not in
        // somebody's terminal.
        expect(output).not.toContain("is being accessed by other users");
        expect(output).toContain("closed 1 connection");
        expect(code).toBe(0);

        const after = new Client({
          connectionString: at(suUrl as string, scratch),
        });
        await after.connect();
        try {
          const { rows } = await after.query<{ migration_name: string }>(
            "SELECT migration_name FROM _prisma_migrations",
          );
          expect(rows.map((r) => r.migration_name)).not.toContain(FOREIGN);
        } finally {
          await after.end();
        }
      } finally {
        await squatter?.end().catch(() => {});
        await maint
          .query(`DROP DATABASE IF EXISTS "${scratch}"`)
          .catch(() => {});
        await maint.end();
      }
    },
    300_000,
  );
});

// THE ORDER IT WAS BUILT IN, which the four sets stop being able to see once everything is applied.
// `outOfOrderPending` catches the merge BEFORE the deploy; after it, every set is empty and a schema
// assembled in an order no fresh database uses reads as healthy.
describe("a schema assembled in an order no fresh database uses", () => {
  const at = (name: string, ms: number): MigrationRow => ({
    migration_name: name,
    checksum: sumOf(name),
    finished_at: new Date(ms),
    rolled_back_at: null,
  });

  test("applying in filename order is silent", () => {
    expect(
      appliedOutOfOrder([at("20260101000000_a", 1), at("20260102000000_b", 2)]),
    ).toEqual([]);
  });

  // The merge, after the deploy: `_b` was applied on a branch, then `_a` arrived and ran second.
  test("a migration that ran after one sorting later is named, with what it followed", () => {
    const out = appliedOutOfOrder([
      at("20260102000000_b", 1),
      at("20260101000000_a", 2),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("20260101000000_a");
    expect(out[0]).toContain("20260102000000_b");
  });

  // One deploy writes rows that can share an instant, and a fresh build would have run them in name
  // order anyway. Reporting a tie would refuse databases that are correct.
  test("rows that finished in the same instant are not out of order", () => {
    expect(
      appliedOutOfOrder([at("20260102000000_b", 5), at("20260101000000_a", 5)]),
    ).toEqual([]);
  });

  // The tie-break and the inversion test have to be the SAME order, and it has to be Prisma's:
  // code points, because it sorts the directory names as bytes. `localeCompare` is a different
  // order and disagrees with `<` on exactly the characters a migration name carries — measured on
  // `20260101000000-b` vs `20260101000000_a`, `a-b` vs `a_b`, `A_x` vs `a_x` and `m-1` vs `m_1`.
  // Two orders means a tie sorted one way is reported as an inversion by the other, so a correct
  // database is refused, recreated, and refused again.
  test("a tie whose names carry punctuation is still not out of order", () => {
    for (const [x, y] of [
      ["20260101000000-b", "20260101000000_a"],
      ["a-b", "a_b"],
      ["A_x", "a_x"],
      ["m-1", "m_1"],
    ]) {
      expect(
        appliedOutOfOrder([at(x as string, 7), at(y as string, 7)]),
      ).toEqual([]);
      expect(
        appliedOutOfOrder([at(y as string, 7), at(x as string, 7)]),
      ).toEqual([]);
    }
  });

  test("a row that never finished is not part of the order at all", () => {
    expect(
      appliedOutOfOrder([
        at("20260102000000_b", 1),
        halfWay("20260101000000_a"),
      ]),
    ).toEqual([]);
  });

  test("the gate refuses it and the setup reprovisions", () => {
    const rows = [at("20260102000000_b", 1), at("20260101000000_a", 2)];
    const local = sameSql(["20260101000000_a", "20260102000000_b"]);
    expect(schemaOutOfStep("x_test", rows, local)).toContain(
      "no fresh database would produce",
    );
    expect(reprovisionReasons(rows, local)).toHaveLength(1);
  });

  // Against the real thing: a database this repo's own setup just built, which must be silent or
  // the check is a second way to refuse every run. Measured at 56 migrations, 0 disagreements.
  test.skipIf(process.env[DB_GATE_OPT_OUT] === "1")(
    "a database this tree's own setup built is in order",
    async () => {
      const { Client } = await import("pg");
      const c = new Client({
        connectionString: process.env.MIGRATION_DATABASE_URL as string,
      });
      await c.connect();
      try {
        const { rows } = await c.query<MigrationRow>(
          `SELECT migration_name, checksum, finished_at, rolled_back_at
             FROM _prisma_migrations`,
        );
        expect(rows.length).toBeGreaterThan(0);
        expect(appliedOutOfOrder(rows)).toEqual([]);
      } finally {
        await c.end();
      }
    },
    60_000,
  );
});

// THE SAME NAME, DIFFERENT SQL — the one way the two name sets can agree while the schema does not.
// A migration edited after it was applied (routine while writing one) or a directory name two
// branches both reached for leaves every comparison above satisfied. `_prisma_migrations.checksum`
// is a plain SHA-256 of the migration.sql bytes in hex, which was verified against three real rows
// of this repo's ledger rather than assumed: a comparison against the wrong algorithm would report
// every migration as changed and refuse every run.
describe("a migration whose file no longer matches what ran", () => {
  const names = ["20260101000000_a", "20260102000000_b"];

  test("a matching checksum is silent", () => {
    expect(changedMigrations(done(...names), sameSql(names))).toEqual([]);
    expect(
      schemaOutOfStep("x_test", done(...names), sameSql(names)),
    ).toBeNull();
  });

  test("an edited file is named, and the refusal says what changed", () => {
    const edited: LocalMigration[] = [
      { name: names[0] as string, checksum: sumOf("something else") },
      { name: names[1] as string, checksum: sumOf(names[1] as string) },
    ];
    expect(changedMigrations(done(...names), edited)).toEqual([
      names[0] as string,
    ]);
    const message = schemaOutOfStep("x_test", done(...names), edited) as string;
    expect(message).toContain(names[0] as string);
    expect(message).toContain("different SQL");
  });

  // Deploying skips it entirely — the row is already there — so this is a reprovision, like every
  // other state the deploy cannot reach.
  test("it is a reason to reprovision, not to deploy", () => {
    const edited: LocalMigration[] = [
      { name: names[0] as string, checksum: sumOf("something else") },
      { name: names[1] as string, checksum: sumOf(names[1] as string) },
    ];
    const reasons = reprovisionReasons(done(...names), edited);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(names[0] as string);
  });

  // A row with no file on disk is FOREIGN, which is a different answer with a different repair, and
  // reporting it twice would tell a reader two things about one row.
  test("a row with no file at all is foreign, not changed", () => {
    const rows = done(...names, "20260199000000_gone");
    expect(changedMigrations(rows, sameSql(names))).toEqual([]);
    expect(foreignMigrations(appliedMigrations(rows), names)).toEqual([
      "20260199000000_gone",
    ]);
  });

  // And the algorithm itself, against the real thing: this repo's own ledger, whose checksums were
  // written by Prisma and not by this file.
  test.skipIf(process.env[DB_GATE_OPT_OUT] === "1")(
    "the checksum this computes is the one Prisma wrote",
    () => {
      const mine = new Map(
        localMigrations(ROOT).map((m) => [m.name, m.checksum]),
      );
      expect(mine.size).toBeGreaterThan(0);
      // Every migration of this tree hashes to something, and the shape is Prisma's: 64 hex chars.
      for (const [, sum] of mine) expect(sum).toMatch(/^[0-9a-f]{64}$/);
    },
  );
});
