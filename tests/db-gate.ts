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

export const DB_GATE_OPT_OUT = "ALLOW_NO_DB";

// Every line here has to be runnable FROM THE STATE THAT PRINTED IT, as one paste. `bun run
// db:test:setup` on its own is not: it reads the same two variables this gate just found missing, so
// on a fresh clone it fails at its own first check. `--wait` is not decoration either: plain
// `up -d` returns when the container STARTS, and the setup script connects with no retry, so the
// chained command loses the race against a cold Postgres (measured, `read ECONNRESET`). The whole
// line was run from a clone with no `.env`, against a cold container, and ends with a suite that
// runs.
const HOW = [
  `  - fresh clone: cp .env.example .env && docker compose up -d --wait && bun run db:test:setup`,
  `  - in a worktree, with the database already up: cp ../main/.env .env`,
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
