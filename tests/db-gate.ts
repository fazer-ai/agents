// WHY A RUN WITHOUT A DATABASE MUST NOT BE GREEN.
//
// More than 150 `describe` blocks in this suite are guarded by `describe.skipIf(!dbUp)`, and `dbUp`
// is a CONNECTION ATTEMPT each file makes against TEST_MIGRATION_DATABASE_URL / TEST_APP_DATABASE_URL.
// When those are unset or the database does not answer, every one of those blocks is skipped, the
// run exits 0, and the line a reader checks says `0 fail`. Measured on one file, with the variable
// pointed at a database that does not exist: `0 pass, 10 skip, 0 fail`, exit 0. Measured on a real
// full-suite run in a tree where the variables were never set: `3839 pass, 2008 skip, 0 fail` out of
// 5847 across 409 files, a third of the suite, silent (issue #351).
//
// The trigger is configuration, not carelessness: a fresh clone of this repository has no `.env`, so
// the first suite run from one skips the DB-backed half and says nothing. The guard itself is right
// (a contributor without a database has to be able to run the rest), so what this adds is the
// distinction the guard never had: NO DATABASE AND THAT IS DELIBERATE, versus NO DATABASE AND NOBODY
// NOTICED. The first is a flag someone sets once. The second is now a failure before the first test
// runs, which is the only place it can still be read as one.
//
// PREVENTIVE, NOT A TALLY. Counting skips after the fact would report the same fact one run too
// late, and against a number nobody reads; refusing to start names what is missing while the reader
// is still looking at the command they typed.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DB_GATE_OPT_OUT = "ALLOW_NO_DB";

// Every line here has to be runnable FROM THE STATE THAT PRINTED IT, as one paste. `bun run
// db:test:setup` on its own is not: it reads the same two variables this gate just found missing, so
// on a fresh clone it fails at its own first check. `--wait` is not decoration either: plain
// `up -d` returns when the container STARTS, and the setup script connects with no retry, so the
// chained command loses the race against a cold Postgres (measured, `read ECONNRESET`). The whole
// line was run from a clone with no `.env`, against a cold container, and ends with a suite that
// runs.
//
// The worktree line carries the setup too, and that is the whole of what #417 changed here: since
// the database name is derived per checkout (./db-name.ts), a new worktree that only copies the
// `.env` has a reachable Postgres and no database of its own, and the refusal it gets would
// otherwise point at the copy it had just made.
const HOW = [
  `  - fresh clone: cp .env.example .env && docker compose up -d --wait && bun run db:test:setup`,
  `  - in a worktree, with the database already up: cp ../main/.env .env && bun run db:test:setup`,
  `  - deliberately without a database: ${DB_GATE_OPT_OUT}=1 bun test`,
].join("\n");

// The half of the decision that needs no I/O, so it can be proved with fixtures rather than with a
// database that has to be absent to test the absence.
export function missingDbConfig(env: {
  [k: string]: string | undefined;
}): string | null {
  if (env[DB_GATE_OPT_OUT] === "1") return null;
  const missing = (
    ["TEST_MIGRATION_DATABASE_URL", "TEST_APP_DATABASE_URL"] as const
  ).filter((k) => !env[k]);
  if (missing.length === 0) return null;
  return [
    `${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not set, so every database-backed test in this suite would be SKIPPED and the run would still exit 0.`,
    HOW,
  ].join("\n");
}

// Named after the VARIABLE, not after the database: both connections point at the same database and
// differ only in the role they authenticate as, so the database name alone cannot say which of the
// two failed.
export function unreachableDb(
  variable: string,
  url: string,
  err: unknown,
): string {
  return [
    `the test database did not answer, so every database-backed test in this suite would be SKIPPED and the run would still exit 0.`,
    `  ${variable} (${new URL(url).pathname.replace(/^\//, "")}): ${oneLine(err)}`,
    HOW,
  ].join("\n");
}

// COLLAPSED, not truncated to the first line. Every driver error that matters here arrives as a
// multi-line block whose FIRST line is empty: Prisma's is
// "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `28P01`. Message: `...`",
// so taking line one prints the variable, the database, and then nothing at all. Measured on the
// four failures a reader actually hits (bad password, closed port, unknown host, missing database),
// none of which echo the connection string, so no credential travels in here.
function oneLine(err: unknown): string {
  const collapsed = (err instanceof Error ? err.message : String(err))
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}...` : collapsed;
}

// WHAT TO PROBE, AND WHAT TO CALL IT WHEN IT FAILS. The two are not the same string. The preload
// DERIVES the URLs it hands the suite (`MIGRATION_DATABASE_URL` is overwritten from
// TEST_MIGRATION_DATABASE_URL, and the app URL has its database name swapped in), so a refusal that
// names the derived variable sends the reader to edit a value that is overwritten again on the next
// run. The label is therefore always the variable a `.env` actually holds, while the probe still
// runs against the derived URL, which is the one the guarded files will use.
export function probeTargets(env: { [k: string]: string | undefined }): {
  variable: string;
  url: string;
}[] {
  return [
    {
      variable: "TEST_MIGRATION_DATABASE_URL",
      url: env.MIGRATION_DATABASE_URL as string,
    },
    {
      variable: "TEST_APP_DATABASE_URL",
      url: env.TEST_APP_DATABASE_URL as string,
    },
  ];
}

// An endpoint that ACCEPTS the connection and then says nothing is not a slow database, it is a
// refusal that never arrives: measured against a listener that accepts and stays silent, the preload
// was still hanging at 45s with no output at all. A deadline is what keeps this a gate rather than a
// second way to stall. 10s is far above a `SELECT 1` on a loaded machine and far below any OS-level
// socket timeout, which is the wait it replaces.
export const PROBE_DEADLINE_MS = 10_000;

// The driver's own limits, which is what actually CANCELS the work. `Promise.race` alone stops the
// waiting without stopping the query, leaving a client checked out of the pool. These two cover the
// two phases (handshake, then query); the race below stays as the backstop for anything they do not
// honour, and is given headroom so the driver's own error is the one a reader sees.
export function probePoolConfig(url: string) {
  return {
    connectionString: url,
    connectionTimeoutMillis: PROBE_DEADLINE_MS,
    query_timeout: PROBE_DEADLINE_MS,
  };
}

export const PROBE_BACKSTOP_MS = PROBE_DEADLINE_MS + 2_000;

export function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} did not answer within ${ms / 1000}s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// WHEN THE DATABASE ANSWERS AND IS THE WRONG DATABASE (issue #417).
//
// Everything above this line asks whether there is a database. This asks whether it is THIS TREE'S
// database, which is a different question and fails in the opposite direction: the run does not exit
// 0 with a third of the suite skipped, it exits non-zero with a number of failures that name code
// nobody broke. Measured on `main`, clean, against a database carrying one migration from an
// unmerged branch: 31 failures on three consecutive runs, plus 29 tests that never executed because
// their `beforeAll` died first and the failure count does not include those.
//
// `prisma migrate status` does not answer it. It reports PENDING and FAILED migrations, and a
// migration that is applied while the tree has never heard of it is neither — it said "Database
// schema is up to date!" about that exact database. The set difference has to be taken by hand, and
// it is taken in both directions because they are one invariant: THE DATABASE MATCHES THE TREE. The
// other direction is what a `git pull` produces, and it reaches a reader as a missing column rather
// than as a missing migration, which is no more readable than the incident above.
//
// Pure, like `missingDbConfig`, so the decision can be proved with fixtures instead of with a
// database that has to be broken to test the breakage.

// `_prisma_migrations` is a LEDGER, not a list of what is in the schema. It keeps the row of a
// migration that failed half-way (`finished_at` still null, `logs` filled) and of one resolved as
// rolled back (`rolled_back_at` set), and reading the name alone counts both as applied — so a
// database left partially migrated reads as matching this tree and the suite runs against a schema
// nobody finished writing. This is the distinction `prisma migrate status` draws when it reports a
// FAILED migration, and the one part of its answer worth keeping.
export type MigrationRow = {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
};

export type LocalMigration = { name: string; checksum: string };

export function appliedMigrations(rows: MigrationRow[]): string[] {
  return rows
    .filter((r) => r.finished_at !== null && r.rolled_back_at === null)
    .map((r) => r.migration_name);
}

// The rows `appliedMigrations` drops, which are not nothing: an apply that died half-way leaves the
// row with `finished_at` still null, and `prisma migrate deploy` then refuses the whole database
// with P3009 rather than continuing. Dropping them from the applied set and stopping there is how
// the FIRST version of this check came to call such a database up to date — measured, with a
// half-applied foreign row planted in a real ledger: 57 rows, 56 counted, `foreignMigrations`
// empty, verdict "up to date". So they are named separately rather than merely excluded.
export function failedMigrations(rows: MigrationRow[]): string[] {
  return rows
    .filter((r) => r.finished_at === null || r.rolled_back_at !== null)
    .map((r) => r.migration_name)
    .sort();
}

// A migration this tree has not applied yet whose NAME sorts before one it already applied. Prisma
// applies pending migrations in filename order and nothing else, so deploying this one now runs it
// AFTER the newer one — an order no fresh database would ever produce, and it is decided by the
// filename rather than by when anybody wrote it. Not hypothetical in this repo: three migrations
// share the timestamp `20260827000000` and are told apart by their suffixes alone, so which of two
// branches sorts first has nothing to do with which was written first.
export function outOfOrderPending(
  applied: string[],
  local: string[],
): string[] {
  const pending = pendingMigrations(applied, local);
  const newest = [...applied].sort().pop();
  if (newest === undefined) return [];
  return pending.filter((p) => p < newest);
}

export function foreignMigrations(
  applied: string[],
  local: string[],
): string[] {
  const known = new Set(local);
  return applied.filter((m) => !known.has(m)).sort();
}

export function pendingMigrations(
  applied: string[],
  local: string[],
): string[] {
  const done = new Set(applied);
  return local.filter((m) => !done.has(m)).sort();
}

// Takes the LEDGER, not an applied set someone already filtered. The difference is the whole of
// what the second review round found: a caller handed the filtered names cannot see the rows that
// were filtered out, and a caller that has to remember to pass them separately is a caller that
// will not.
// The same NAME, different SQL. A migration edited after it was applied, or a directory name two
// branches both reached for, leaves the two name sets identical while the schema is whichever SQL
// ran — so every comparison above is satisfied and the run proceeds against the wrong tables.
// `_prisma_migrations.checksum` is a plain SHA-256 of the migration.sql bytes, in hex; verified
// against three real rows of this repo's own ledger rather than assumed, because a checksum
// comparison against the wrong algorithm reports every migration as changed.
export function changedMigrations(
  rows: MigrationRow[],
  local: LocalMigration[],
): string[] {
  const onDisk = new Map(local.map((m) => [m.name, m.checksum]));
  return rows
    .filter((r) => {
      const here = onDisk.get(r.migration_name);
      // Absent from disk is FOREIGN, which is a different answer and already has one.
      return here !== undefined && here !== r.checksum;
    })
    .map((r) => r.migration_name)
    .sort();
}

// The order a database was BUILT in, which the four sets above stop being able to see the moment
// everything is applied. `outOfOrderPending` catches the merge before the deploy; once both
// migrations have run, every set is empty and a schema assembled in an order no fresh database uses
// reads as healthy. Prisma applies pending migrations in filename order and nothing else, so a
// finished-at sequence that disagrees with the name sequence means two deploys with a merge between
// them. Ties are not disagreement: rows that finished in the same instant are ordered by name here,
// exactly as a fresh build would have run them. A freshly provisioned database of this repo was
// measured at 56 migrations and 0 disagreements, which is what makes this a signal rather than a
// second way to refuse every run.
// ONE comparator for both the sort and the comparison, and it is code-point order because that is
// what Prisma applies in — it sorts the directory names as bytes. Using `localeCompare` for the
// tie-break and `<` for the inversion was two different orders: measured, they disagree on
// `20260101000000-b` vs `20260101000000_a`, on `a-b` vs `a_b`, on `A_x` vs `a_x` and on `m-1` vs
// `m_1`, so a tie sorted one way is reported as an inversion by the other — refusing a correct
// database, recreating it, and refusing it again. The same trap the ordering of exposed names hit
// in #412, one layer down.
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function appliedOutOfOrder(rows: MigrationRow[]): string[] {
  const finished = rows
    .filter((r) => r.finished_at !== null && r.rolled_back_at === null)
    .sort((a, b) => {
      const at = (a.finished_at as Date).getTime();
      const bt = (b.finished_at as Date).getTime();
      return at === bt ? byName(a.migration_name, b.migration_name) : at - bt;
    });
  const out: string[] = [];
  for (let i = 1; i < finished.length; i++) {
    const prev = finished[i - 1] as MigrationRow;
    const cur = finished[i] as MigrationRow;
    if (byName(cur.migration_name, prev.migration_name) < 0) {
      out.push(`${cur.migration_name} (ran after ${prev.migration_name})`);
    }
  }
  return out;
}

export function schemaOutOfStep(
  dbName: string,
  rows: MigrationRow[],
  local: LocalMigration[],
): string | null {
  const names = local.map((m) => m.name);
  const applied = appliedMigrations(rows);
  const failed = failedMigrations(rows);
  const foreign = foreignMigrations(applied, names);
  const pending = pendingMigrations(applied, names);
  const changed = changedMigrations(rows, local);
  const misordered = appliedOutOfOrder(rows);
  if (
    foreign.length === 0 &&
    pending.length === 0 &&
    failed.length === 0 &&
    changed.length === 0 &&
    misordered.length === 0
  ) {
    return null;
  }
  const lines = [
    `the test database "${dbName}" does not match this tree, so failures below would be about its schema and not about the code.`,
  ];
  if (foreign.length > 0) {
    lines.push(
      `  applied here but absent from prisma/migrations (left by another branch):`,
      ...foreign.map((m) => `    ${m}`),
    );
  }
  if (pending.length > 0) {
    lines.push(
      `  in prisma/migrations and never applied:`,
      ...pending.map((m) => `    ${m}`),
    );
  }
  if (failed.length > 0) {
    lines.push(
      `  recorded but never finished, or resolved as rolled back:`,
      ...failed.map((m) => `    ${m}`),
    );
  }
  if (changed.length > 0) {
    lines.push(
      `  applied from different SQL than the file now holds:`,
      ...changed.map((m) => `    ${m}`),
    );
  }
  if (misordered.length > 0) {
    lines.push(
      `  applied in an order no fresh database would produce:`,
      ...misordered.map((m) => `    ${m}`),
    );
  }
  // One command for both directions, and it has to REPROVISION rather than deploy: a foreign
  // migration is already recorded in `_prisma_migrations`, so nothing is pending and a plain
  // `migrate deploy` is a no-op that leaves the schema exactly as wrong as it found it.
  lines.push(`  - ${RESYNC}`);
  return lines.join("\n");
}

const RESYNC = "bun run db:test:setup";

// WHY THE COMMAND ABOVE HAS TO REPROVISION AND NOT DEPLOY, per state. Deploying is only ever the
// right repair for a database that is simply BEHIND this tree, in this tree's own order. Every
// other state below is one `prisma migrate deploy` either cannot fix or fixes into a schema a fresh
// database would not have, so the answer is to throw the database away — which costs nothing,
// because it holds test fixtures and nothing else.
export function reprovisionReasons(
  rows: MigrationRow[],
  local: LocalMigration[],
): string[] {
  const names = local.map((m) => m.name);
  const applied = appliedMigrations(rows);
  const reasons: string[] = [];
  for (const m of changedMigrations(rows, local)) {
    // Applied from SQL the file no longer holds. Deploying skips it entirely: it is recorded.
    reasons.push(`${m} (applied from different SQL than the file now holds)`);
  }
  for (const m of foreignMigrations(applied, names)) {
    // Already recorded, so nothing is pending and whatever it dropped stays dropped.
    reasons.push(`${m} (applied here, absent from this tree)`);
  }
  for (const m of failedMigrations(rows)) {
    // `migrate deploy` refuses the whole database with P3009 while this row stands.
    reasons.push(`${m} (recorded but never finished)`);
  }
  for (const m of outOfOrderPending(applied, names)) {
    reasons.push(`${m} (would be applied after a migration that sorts later)`);
  }
  for (const m of appliedOutOfOrder(rows)) {
    // Already built that way, and deploying has nothing left to do about it.
    reasons.push(`${m} — an order no fresh database would produce`);
  }
  return reasons;
}

// THE ONE FUNCTION HERE THAT TOUCHES A DISK, and it lives beside the decisions rather than in each
// caller because both of them ask the same question and a second copy is a second answer. It reads
// the tree, never the database, so nothing above it stops being provable with fixtures.
export function localMigrations(root: string): LocalMigration[] {
  const dir = join(root, "prisma", "migrations");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      // Prisma's own checksum: SHA-256 of the migration.sql bytes, hex. A directory without one is
      // not a migration Prisma would apply, and hashing nothing keeps it from matching anything.
      checksum: createHash("sha256")
        .update(readFileSync(join(dir, e.name, "migration.sql")))
        .digest("hex"),
    }));
}
