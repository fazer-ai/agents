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

// A DEADLINE MEASURES THE MACHINE, and both library defaults below are sized for an idle one: 5s is
// `bun test`'s per-test default and 1s is @testing-library's `waitFor` default, which the suite's
// `waitFor` calls rely on. Under `bun test --parallel` everything runs several times slower and a
// DIFFERENT deadline lapses on each run. Raising them costs nothing on a passing run (`waitFor`
// returns the moment its condition holds, a test timeout only elapses on a hang); only the report
// of a real failure gets slower. NOT the answer for a window a test's own SETUP must fit inside,
// paid on every run: see `setRefusalProtectionForTest` in tests/modules/contact-auth-grant.test.ts
// and the per-test cost note in tests/tooling/stale-base-guard.test.ts.
jest.setTimeout(30_000);
configure({ asyncUtilTimeout: 5_000 });

process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";

// NOTE: Integration tests run against a DEDICATED test database, identified SOLELY by
// TEST_MIGRATION_DATABASE_URL (superuser). MIGRATION_DATABASE_URL and TEST_APP_DATABASE_URL are
// FORCED onto it here, at preload, before any test module reads them, overriding the shell too (a
// dev shell often exports them at the DEV DB, and Bun gives exported env precedence over `.env`).
// The app URL keeps its role and host and only swaps in the test DB name. The `_test` guard refuses
// any other target, so the destructive suite can never hit the dev DB. `prisma migrate` never runs
// this preload, so the CLI keeps using the dev URLs.
const REPO_ROOT = checkoutRootFrom(import.meta.url, "..");
const testSuUrl = process.env.TEST_MIGRATION_DATABASE_URL;
if (testSuUrl) {
  const declared = new URL(testSuUrl).pathname.replace(/^\//, "");
  if (!declared.endsWith("_test")) {
    throw new Error(
      `TEST_MIGRATION_DATABASE_URL must point at a *_test database (got "${declared}") — refusing to run the destructive test suite against it.`,
    );
  }
  // NOTE: The `.env` name is the BASE, not the target. Every checkout on a machine copies one `.env`,
  // so a constant name would put them all on one database, where a migration applied from any of them
  // stays applied under all the others (./db-name.ts, tests/lib/test-db-identity.test.ts). The guard
  // above still reads the DECLARED name: it is a statement about what the developer pointed at.
  const dbName = testDbNameFor(declared, REPO_ROOT);
  const testDbPath = `/${dbName}`;
  process.env.MIGRATION_DATABASE_URL = withDbName(testSuUrl, dbName);
  // NOTE: BOTH spellings, which is what makes the derivation safe: some test files build their
  // superuser client from the RAW `TEST_MIGRATION_DATABASE_URL` rather than the derived
  // `MIGRATION_DATABASE_URL`, and with the two naming different databases they would SEED one and
  // READ another, silently. tests/lib/db-gate.test.ts fences the two against each other.
  process.env.TEST_MIGRATION_DATABASE_URL = process.env.MIGRATION_DATABASE_URL;
  if (process.env.TEST_APP_DATABASE_URL) {
    const appUrl = new URL(process.env.TEST_APP_DATABASE_URL);
    appUrl.pathname = testDbPath;
    process.env.TEST_APP_DATABASE_URL = appUrl.toString();
    // NOTE: The LangGraph checkpointer too: `config.langgraphDatabaseUrl` is
    // `LANGGRAPH_DATABASE_URL || DATABASE_URL`, so the dead DATABASE_URL set at the top only catches it
    // when LANGGRAPH_DATABASE_URL is UNSET, and a dev `.env` sets it to the DEV database (where the
    // /reset test's deleteThread would land). Forced onto the test DB like the line above.
    process.env.LANGGRAPH_DATABASE_URL = appUrl.toString();
  }
}
// THE GATE. Everything above points the suite at the test database; this refuses to start when
// there is nothing at the other end, because a suite that skips its database-backed half exits 0 and
// reads as green. The reasoning and the opt-out live in ./db-gate.ts.
const missing = missingDbConfig(process.env);
if (missing) throw new Error(`tests: ${missing}`);
if (process.env[DB_GATE_OPT_OUT] !== "1") {
  // NOTE: BOTH connections: a guarded file's `describe.skipIf(!dbUp)` probes the migration role AND
  // the app role, which authenticate differently, so probing only the first passes a run whose app
  // role cannot log in and skips the same blocks just as silently. The URLs read here are the ones
  // forced above. Imported HERE, not at the top: `generated/prisma` is gitignored and `bun install`
  // does not produce it, so a static import would fail before the opt-out is read, and the gate must
  // not be why a run without a database cannot start.
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

  // NOTE: AND WHETHER IT IS THIS TREE'S DATABASE. The probes above prove a database ANSWERS; this asks
  // whether its schema is the one prisma/migrations describes, in both directions, so a stale schema
  // is named up front instead of read off dozens of failures in code nobody broke.
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
// Force the rate-limit budgets, for the same reason as the line above. Two test files read
// WHICH limiter answered from the ceiling it advertises, so a `.env` tuning one would fail a correct
// app with the exact signature of a limiter collision. The GLOBAL budget is pinned HIGH, the one
// non-production number here: `server.handle` has no socket, so every request any file sends falls
// back to the client IP "unknown" and shares ONE bucket per process, which the suite would exhaust.
// The other three stay shipped-accurate, since nothing exhausts them through that key, and the
// limiter is exercised at a reachable budget in rateLimit.test.ts and rateLimitMetering.test.ts.
process.env.RATE_LIMIT_USER_PER_MIN = "1000000";
process.env.RATE_LIMIT_MCP_PER_MIN = "1200";
process.env.RATE_LIMIT_CREDENTIAL_MAX = "20";
process.env.RATE_LIMIT_CREDENTIAL_WINDOW_MINUTES = "5";
