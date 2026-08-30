import "@testing-library/jest-dom";
import { jest } from "bun:test";
import { configure } from "@testing-library/dom";
import {
  DB_GATE_OPT_OUT,
  localMigrations,
  type MigrationRow,
  missingDbConfig,
  PROBE_BACKSTOP_MS,
  probePoolConfig,
  probeTargets,
  schemaOutOfStep,
  unreachableDb,
  withDeadline,
} from "./db-gate";
import { checkoutRootFrom, testDbNameFor, withDbName } from "./db-name";

// NOTE: happy-dom registration and the Bun-native global capture live in
// ./dom-setup.ts, which bunfig.toml preloads BEFORE this file. The DOM must
// exist before the @testing-library import above is evaluated — see the comment
// there before moving either piece back here.

// A DEADLINE MEASURES THE MACHINE, AND BOTH DEFAULTS BELOW WERE CHOSEN FOR AN IDLE ONE.
//
// Neither number is ours: 5s is `bun test`'s default per test, 1s is @testing-library's default for
// `waitFor`, and this suite has 260 `waitFor` calls, not one of which passes a timeout of its own. On
// a machine running the suite alone both are generous. Under `bun test --parallel` they are not: at
// 18 workers on 6 performance cores everything runs roughly three times slower, and one deadline or
// another lapses on most runs — a DIFFERENT one each time, which is what makes the class so
// expensive to chase. Measured across five runs at the default worker count: three failures, in
// three unrelated files, none reproducible on its own.
//
// RAISING THEM COSTS NOTHING ON A PASSING RUN, and that is the whole reason this is a fix rather
// than a bandage. `waitFor` polls and returns the moment its condition holds; a test timeout only
// elapses when a test hangs. What gets slower is the report of a genuine failure, from one second to
// five — a trade worth making against a green suite that goes red by lottery.
//
// This is NOT the answer for a window a test's own SETUP has to fit inside. There, a bigger number
// is paid in full on every run, so those are sized one at a time where they live: see the note on
// `setRefusalProtectionForTest` in tests/modules/contact-auth-grant.test.ts and the one on
// `jest.setTimeout` in tests/tooling/stale-base-guard.test.ts.
jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 5_000 });

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";

// NOTE: Integration tests run against a DEDICATED test database, identified SOLELY by
// TEST_MIGRATION_DATABASE_URL (superuser). The suite reads MIGRATION_DATABASE_URL (superuser) and
// TEST_APP_DATABASE_URL (app role); we FORCE both onto the test DB here, at preload, BEFORE any
// test module reads them. This must override the inherited *shell environment* too: a dev shell
// often exports MIGRATION_DATABASE_URL / TEST_APP_DATABASE_URL pointing at the DEV DB, and Bun
// gives the exported env precedence over `.env` — so a `.env` edit alone is silently shadowed.
// Assigning to process.env at runtime wins regardless. The app connection reuses whatever app-role
// creds/host TEST_APP_DATABASE_URL already carries (dev and test share them) and only swaps in the
// test DB *name* from TEST_MIGRATION_DATABASE_URL. The `_test` guard refuses any other target, so
// the destructive suite (unscoped `DELETE FROM scheduler_jobs`, tenant create/drop) can never hit
// the dev DB. This preload never runs for `prisma migrate`, so the CLI keeps using the dev URLs.
const REPO_ROOT = checkoutRootFrom(import.meta.url, "..");
const testSuUrl = process.env.TEST_MIGRATION_DATABASE_URL;
if (testSuUrl) {
  const declared = new URL(testSuUrl).pathname.replace(/^\//, "");
  if (!declared.endsWith("_test")) {
    throw new Error(
      `TEST_MIGRATION_DATABASE_URL must point at a *_test database (got "${declared}") — refusing to run the destructive test suite against it.`,
    );
  }
  // The `.env` name is the BASE, not the target. Every checkout on a machine copies one `.env` (the
  // worktree step is `cp ../main/.env .env`), so a constant name puts them all on one database and a
  // migration applied from any of them stays applied under all the others — see ./db-name.ts and
  // tests/lib/test-db-identity.test.ts for what that cost when it happened. The guard above still
  // reads the DECLARED name, because it is a statement about what the developer pointed at.
  const dbName = testDbNameFor(declared, REPO_ROOT);
  const testDbPath = `/${dbName}`;
  process.env.MIGRATION_DATABASE_URL = withDbName(testSuUrl, dbName);
  // BOTH spellings, and this line is the whole reason the derivation is safe to add. Three test
  // files build their superuser client from the RAW `TEST_MIGRATION_DATABASE_URL` rather than the
  // derived `MIGRATION_DATABASE_URL`, which was equivalent while the two named the same database
  // and stopped being equivalent the moment one of them was derived: those files then SEEDED one
  // database and READ another, silently. Measured before this line existed — 36 failures across
  // exactly those three files, all of them assertions about rows that had been written to the
  // underived database. tests/lib/db-gate.test.ts fences the two against each other.
  process.env.TEST_MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
  if (process.env.TEST_APP_DATABASE_URL) {
    const appUrl = new URL(process.env.TEST_APP_DATABASE_URL);
    appUrl.pathname = testDbPath;
    process.env.TEST_APP_DATABASE_URL = appUrl.toString();
    // NOTE: the LangGraph checkpointer is the one connection the fence above used to miss.
    // `config.langgraphDatabaseUrl` is `LANGGRAPH_DATABASE_URL || DATABASE_URL`, so the dead
    // DATABASE_URL set at the top only catches it when LANGGRAPH_DATABASE_URL is UNSET, and a dev
    // `.env` sets it to the DEV database. Measured before this line existed: every `bun test` run
    // pointed the checkpointer at secretaria_v4_db (1685 live checkpoint rows) while everything else
    // was on secretaria_v4_test, and the /reset test issued deleteThread against it. Forced onto the
    // test DB with the app-role creds, same derivation as the line above.
    process.env.LANGGRAPH_DATABASE_URL = appUrl.toString();
  }
}
// THE GATE. Everything above points the suite at the test database; this refuses to start when
// there is nothing at the other end, because a suite that skips its database-backed half exits 0 and
// reads as green. The reasoning, the measurements and the opt-out live in ./db-gate.ts.
const missing = missingDbConfig(process.env);
if (missing) throw new Error(`tests: ${missing}`);
if (process.env[DB_GATE_OPT_OUT] !== "1") {
  // BOTH connections, because both are what a guarded file asks for. Every `describe.skipIf(!dbUp)`
  // block sits behind a `SELECT 1` on the migration role AND one on the app role, and the two
  // authenticate as different roles with different credentials. Probing only the first passes a run
  // whose app role cannot log in, which skips the same blocks just as silently: measured with a
  // valid migration URL and a nonexistent app role, one file reported `6 pass, 14 skip, 0 fail`,
  // exit 0. The URLs read here are the ones forced above, so this asks the question in exactly the
  // shape the guarded files will ask it.
  // Imported HERE, not at the top of the file. `generated/prisma` is gitignored and `bun install`
  // does not produce it, so a static import fails on any checkout that has not run
  // `bun run prisma:generate` yet, and it fails BEFORE the opt-out is read: measured, a run of a
  // database-free test file with ALLOW_NO_DB=1 died on `Cannot find module`, where the same file on
  // the base commit ran. The gate must not be the reason a run without a database cannot start.
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("@/../generated/prisma/client");
  for (const { variable, url } of probeTargets(process.env)) {
    const probe = new PrismaClient({
      adapter: new PrismaPg(probePoolConfig(url)),
    });
    try {
      await withDeadline(
        probe.$queryRaw`SELECT 1`,
        PROBE_BACKSTOP_MS,
        variable,
      );
      await probe.$disconnect();
    } catch (err) {
      // Not awaited: the connection this is trying to close is the one that just failed to answer,
      // and waiting on it is the stall the deadline above exists to end.
      void probe.$disconnect().catch(() => {});
      throw new Error(`tests: ${unreachableDb(variable, url, err)}`);
    }
  }

  // AND WHETHER IT IS THIS TREE'S DATABASE. The probes above prove a database ANSWERS; this asks
  // whether its schema is the one prisma/migrations describes, in both directions. It is the same
  // preventive shape as the gate above and for the same reason: the alternative is reading the
  // answer off dozens of failures that name code nobody broke, one run too late (issue #417).
  const suUrl = process.env.MIGRATION_DATABASE_URL as string;
  const reader = new PrismaClient({
    adapter: new PrismaPg(probePoolConfig(suUrl)),
  });
  try {
    // `to_regclass` rather than a bare SELECT: a database that exists and has never been migrated
    // has no `_prisma_migrations` at all, and that is a real state (a fresh CREATE DATABASE), not an
    // error. It reports as every local migration being unapplied, which is the truth and names the
    // same command.
    const rows = await withDeadline(
      reader.$queryRaw<MigrationRow[]>`
        SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations
        WHERE to_regclass('_prisma_migrations') IS NOT NULL`,
      PROBE_BACKSTOP_MS,
      "TEST_MIGRATION_DATABASE_URL",
    ).catch(() => [] as MigrationRow[]);
    const local = localMigrations(REPO_ROOT);
    const drift = schemaOutOfStep(
      new URL(suUrl).pathname.replace(/^\//, ""),
      rows,
      local,
    );
    if (drift) throw new Error(`tests: ${drift}`);
  } finally {
    await reader.$disconnect().catch(() => {});
  }
}

process.env.JWT_SECRET = "test-secret-key-for-testing-only";
// NOTE: Force a deterministic Google client id so the auth controller registers
// `/auth/google` regardless of the developer's local `.env` and so tests can
// exercise the enabled-mode code path.
process.env.GOOGLE_CLIENT_ID = "test-google-client.apps.googleusercontent.com";
// NOTE: Force the rate-limit budgets, for the same reason as the line above and
// with one consequence worth spelling out. Two test files read a real response
// from the real app: one identifies WHICH limiter answered by the ceiling it
// advertises (`RateLimit-Limit: 20` is the credential bucket, 1000000 the global
// one), the other measures what a rejected request costs by watching the
// remaining budget move. All four of these are environment variables, so a
// developer who tunes one in their `.env` would watch a correct app fail, and
// fail with `Expected: "20", Received: "1000000"`, which is exactly the signature
// of the limiter-collision regression those tests exist to catch. Pinning here,
// at preload and before any module reads config, is what keeps that signal
// unambiguous.
//
// THE GLOBAL BUDGET IS PINNED HIGH RATHER THAN SHIPPED-ACCURATE, and that is the
// one number here that is not the production default. `server.handle` has no
// socket, so `server.requestIP` answers nothing and `resolveClientIp` falls back
// to the constant "unknown": every request every file sends through the app
// shares ONE bucket, for the whole process, over a 60s window. Measured in a
// fresh process, the 601st `server.handle` call came back 429. The limiter is not
// wrong — in production each client carries its own peer — but the ambient
// ceiling is a resource 520 files compete for, and whoever is running when it
// runs out fails on a status it never asked about. It cost two branding tests on
// master CI (429 where they expected 200 and 401) while the same suite passed
// locally: what differs between the two machines is how the requests fall across
// the minute, not what any of them assert.
//
// The other three stay shipped-accurate, because nothing can exhaust them
// through that shared key: the MCP transport bucket is reached from two call
// sites in the whole suite, and the credential bucket (20 per 5 minutes, and the
// suite runs in under 5) from none — every test that drives /auth/login either
// runs a real server, where the peer is 127.0.0.1 and the key is its own, or
// calls the service directly.
//
// The limiter is still exercised at a reachable budget, which is the coverage
// this line would otherwise cost: rateLimit.test.ts and rateLimitMetering.test.ts
// build the REAL middleware with an explicit `max`, which is what that parameter
// exists for.
process.env.RATE_LIMIT_USER_PER_MIN = "1000000";
process.env.RATE_LIMIT_MCP_PER_MIN = "1200";
process.env.RATE_LIMIT_CREDENTIAL_MAX = "20";
process.env.RATE_LIMIT_CREDENTIAL_WINDOW_MINUTES = "5";
