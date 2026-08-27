import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  appliedMigrations,
  DB_GATE_OPT_OUT,
  foreignMigrations,
  pendingMigrations,
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

describe("a database that is not this tree's database", () => {
  const local = ["20260101000000_a", "20260102000000_b"];

  // `_prisma_migrations` keeps the row of a migration that FAILED half-way (`finished_at` still
  // null, `logs` filled) and of one resolved as rolled back (`rolled_back_at` set). Reading the
  // name alone counts both as applied, so a database left partially migrated reads as matching and
  // the suite runs against a schema nobody finished writing. Measured on the real table: an
  // interrupted apply leaves `{ finished_at: null, rolled_back_at: null }`.
  test("a migration that never finished is not applied", () => {
    const rows = [
      {
        migration_name: "20260101000000_a",
        finished_at: new Date(),
        rolled_back_at: null,
      },
      {
        migration_name: "20260102000000_b",
        finished_at: null,
        rolled_back_at: null,
      },
    ];
    expect(appliedMigrations(rows)).toEqual(["20260101000000_a"]);
    expect(schemaOutOfStep("x_test", appliedMigrations(rows), local)).toContain(
      "20260102000000_b",
    );
  });

  test("a migration resolved as rolled back is not applied either", () => {
    const rows = [
      {
        migration_name: "20260101000000_a",
        finished_at: new Date(),
        rolled_back_at: new Date(),
      },
    ];
    expect(appliedMigrations(rows)).toEqual([]);
  });

  test("a matching database is not stopped", () => {
    expect(schemaOutOfStep("x_test", local, local)).toBeNull();
  });

  // The direction that produced the incident: applied, and the tree has never heard of it.
  test("a migration the tree does not have is named", () => {
    const applied = [...local, "20260103000000_from_another_branch"];
    expect(foreignMigrations(applied, local)).toEqual([
      "20260103000000_from_another_branch",
    ]);
    const message = schemaOutOfStep("x_test", applied, local);
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
    expect(schemaOutOfStep("x_test", applied, local)).toContain(
      "20260102000000_b",
    );
  });

  // Both at once is the branch switch that also pulled, and a message that reported only the first
  // one it found would send the reader back for a second run to learn the rest.
  test("both directions are reported in one refusal, and told apart", () => {
    const message = schemaOutOfStep(
      "x_test",
      ["20260101000000_a", "20260199000000_foreign"],
      local,
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
    expect(schemaOutOfStep("x_test", [...local].reverse(), local)).toBeNull();
  });

  // An empty applied set is a database that exists and has never been migrated, which is what a
  // fresh `CREATE DATABASE` leaves behind. It is out of step with every non-empty tree, and saying
  // so is the difference between one clear refusal and a suite that fails on the first missing
  // table.
  test("a database with nothing applied is out of step, not up to date", () => {
    expect(schemaOutOfStep("x_test", [], local)).toContain("20260101000000_a");
  });

  // And the fence against the fence: a scan that found nothing passes exactly like a scan that
  // found everything, so an empty tree has to be the one case that cannot refuse.
  test("an empty tree asks nothing of any database", () => {
    expect(schemaOutOfStep("x_test", [], [])).toBeNull();
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
               finished_at timestamptz,
               rolled_back_at timestamptz)`,
          );
          await seed.query(
            `INSERT INTO _prisma_migrations (migration_name, finished_at) VALUES ($1, now())`,
            [FOREIGN],
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
               finished_at timestamptz,
               rolled_back_at timestamptz)`,
          );
          await seed.query(
            `INSERT INTO _prisma_migrations (migration_name, finished_at) VALUES ($1, now())`,
            [FOREIGN],
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
});
