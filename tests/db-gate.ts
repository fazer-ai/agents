// WHY A RUN WITHOUT A DATABASE MUST NOT BE GREEN.
//
// 154 `describe` blocks in this suite are guarded by `describe.skipIf(!dbUp)`, and `dbUp` is a
// CONNECTION ATTEMPT made by each file against TEST_MIGRATION_DATABASE_URL / TEST_APP_DATABASE_URL.
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

export const DB_GATE_OPT_OUT = "ALLOW_NO_DB";

const HOW = [
  `  - in a worktree: cp ../main/.env .env`,
  `  - first time on this machine: bun run db:test:setup`,
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

export function unreachableDb(url: string, err: unknown): string {
  return [
    `the test database did not answer, so every database-backed test in this suite would be SKIPPED and the run would still exit 0.`,
    `  ${new URL(url).pathname.replace(/^\//, "")}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    HOW,
  ].join("\n");
}
