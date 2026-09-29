// Why a run without a database must not be green. Most DB-backed `describe` blocks are guarded by
// `describe.skipIf(!dbUp)`, so with TEST_MIGRATION_DATABASE_URL / TEST_APP_DATABASE_URL unset or
// unreachable about a third of the suite skips and the run still exits 0 with `0 fail`. A fresh
// clone has no `.env`, so that is the default state. The guard stays (a contributor without a
// database can run the rest); this gate tells a deliberate opt-out from an unnoticed one, and refuses
// before the first test runs, because a skip tally after the fact is read one run too late.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DB_GATE_OPT_OUT = "ALLOW_NO_DB";

// Each line must run as one paste FROM THE STATE THAT PRINTED IT: `db:test:setup` alone reads the
// variables this gate found missing, and `--wait` matters because plain `up -d` returns before a cold
// Postgres accepts connections and the setup script does not retry. The worktree line carries the
// setup too: the database name is derived per checkout (./db-name.ts), so a copied `.env` still has
// no database of its own.
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

// COLLAPSED, not truncated to the first line: Prisma's driver errors start with an empty line, so line
// one would print nothing. None of the failures a reader hits (bad password, closed port, unknown
// host, missing database) echo the connection string, so no credential travels in here.
function oneLine(err: unknown): string {
  const collapsed = (err instanceof Error ? err.message : String(err))
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 200)}...` : collapsed;
}

// What to probe and what to call it differ: the preload DERIVES the URLs it hands the suite, so the
// probe runs against the derived URL the guarded files use, while the label is the variable a `.env`
// holds (naming the derived one sends the reader to edit a value overwritten on the next run).
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

// An endpoint that accepts the connection and stays silent would hang the preload with no output.
// 10s is far above a `SELECT 1` on a loaded machine and far below any OS-level socket timeout.
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

// When the database answers and is not THIS TREE'S database, the run fails with errors naming code
// nobody broke. `prisma migrate status` misses it: a migration applied here but absent from the tree
// is neither pending nor failed. So the difference is taken by hand, in both directions (THE DATABASE
// MATCHES THE TREE). Pure, so it is proved with fixtures rather than a broken database.

// `_prisma_migrations` is a LEDGER, not a list of what is in the schema. It keeps the row of a
// migration that failed half-way (`finished_at` still null, `logs` filled) and of one resolved as
// rolled back (`rolled_back_at` set), and reading the name alone counts both as applied, so a
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

// The rows `appliedMigrations` drops, named separately rather than merely excluded: `prisma migrate
// deploy` refuses the whole database with P3009 while one stands, and excluding it alone would call a
// half-applied database up to date.
export function failedMigrations(rows: MigrationRow[]): string[] {
  return rows
    .filter((r) => r.finished_at === null || r.rolled_back_at !== null)
    .map((r) => r.migration_name)
    .sort();
}

// A migration this tree has not applied yet whose NAME sorts before one it already applied. Prisma
// applies pending migrations in filename order and nothing else, so deploying this one now runs it
// AFTER the newer one, an order no fresh database would ever produce. Several migrations here share
// a timestamp and differ only by suffix, so sort order says nothing about which was written first.
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

// The same NAME, different SQL: a migration edited after it was applied, or a directory name two
// branches both took, satisfies every name comparison above. Takes the LEDGER rather than a filtered
// applied set, so no caller can drop rows. `_prisma_migrations.checksum` is a plain hex SHA-256 of the
// migration.sql bytes; the wrong algorithm would report every migration as changed.
export function changedMigrations(
  rows: MigrationRow[],
  local: LocalMigration[],
): string[] {
  const onDisk = new Map(local.map((m) => [m.name, m.checksum]));
  return rows
    .filter((r) => {
      const here = onDisk.get(r.migration_name);
      // NOTE: absent from disk is FOREIGN, which is a different answer and already has one.
      return here !== undefined && here !== r.checksum;
    })
    .map((r) => r.migration_name)
    .sort();
}

// ONE comparator for both the sort and the inversion check, in code-point order because Prisma sorts
// directory names as bytes. `localeCompare` for one and `<` for the other disagree on pairs like
// `a-b` vs `a_b`, so a tie sorted one way reads as an inversion the other way, and a correct
// database is refused forever.
function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// The order the database was BUILT in, which the sets above cannot see once everything is applied.
// A finished-at sequence that disagrees with the name sequence means two deploys with a merge between
// them. Rows finished in the same instant are ordered by name, as a fresh build runs them.
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
  // NOTE: one command for both directions, and it has to REPROVISION rather than deploy: a foreign
  // migration is already recorded in `_prisma_migrations`, so nothing is pending and a plain
  // `migrate deploy` is a no-op that leaves the schema exactly as wrong as it found it.
  lines.push(`  - ${RESYNC}`);
  return lines.join("\n");
}

const RESYNC = "bun run db:test:setup";

// Why the command above has to REPROVISION and not deploy, per state. Deploying only repairs a
// database simply BEHIND this tree, in this tree's order. Every state below is one `prisma migrate
// deploy` cannot fix or fixes into a schema a fresh database would not have, so the database is thrown
// away, which costs nothing because it holds test fixtures only.
export function reprovisionReasons(
  rows: MigrationRow[],
  local: LocalMigration[],
): string[] {
  const names = local.map((m) => m.name);
  const applied = appliedMigrations(rows);
  const reasons: string[] = [];
  for (const m of changedMigrations(rows, local)) {
    // NOTE: applied from SQL the file no longer holds. Deploying skips it entirely: it is recorded.
    reasons.push(`${m} (applied from different SQL than the file now holds)`);
  }
  for (const m of foreignMigrations(applied, names)) {
    // NOTE: already recorded, so nothing is pending and whatever it dropped stays dropped.
    reasons.push(`${m} (applied here, absent from this tree)`);
  }
  for (const m of failedMigrations(rows)) {
    // NOTE: `migrate deploy` refuses the whole database with P3009 while this row stands.
    reasons.push(`${m} (recorded but never finished)`);
  }
  for (const m of outOfOrderPending(applied, names)) {
    reasons.push(`${m} (would be applied after a migration that sorts later)`);
  }
  for (const m of appliedOutOfOrder(rows)) {
    // NOTE: already built that way, and deploying has nothing left to do about it.
    reasons.push(`${m} — an order no fresh database would produce`);
  }
  return reasons;
}

// The one function here that touches a disk, kept beside the decisions so both callers share one
// answer. It reads the tree, never the database, so everything above stays provable with fixtures.
export function localMigrations(root: string): LocalMigration[] {
  const dir = join(root, "prisma", "migrations");
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      name: e.name,
      // NOTE: Prisma's own checksum, SHA-256 of the migration.sql bytes in hex. A directory without
      // one is not a migration Prisma would apply, and hashing nothing keeps it from matching.
      checksum: createHash("sha256")
        .update(readFileSync(join(dir, e.name, "migration.sql")))
        .digest("hex"),
    }));
}
