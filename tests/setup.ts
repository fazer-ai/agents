import "@testing-library/jest-dom";
import {
  DB_GATE_OPT_OUT,
  missingDbConfig,
  PROBE_BACKSTOP_MS,
  probePoolConfig,
  probeTargets,
  unreachableDb,
  withDeadline,
} from "./db-gate";

// NOTE: happy-dom registration and the Bun-native global capture live in
// ./dom-setup.ts, which bunfig.toml preloads BEFORE this file. The DOM must
// exist before the @testing-library import above is evaluated — see the comment
// there before moving either piece back here.

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
const testSuUrl = process.env.TEST_MIGRATION_DATABASE_URL;
if (testSuUrl) {
  const testDbPath = new URL(testSuUrl).pathname;
  const dbName = testDbPath.replace(/^\//, "");
  if (!dbName.endsWith("_test")) {
    throw new Error(
      `TEST_MIGRATION_DATABASE_URL must point at a *_test database (got "${dbName}") — refusing to run the destructive test suite against it.`,
    );
  }
  process.env.MIGRATION_DATABASE_URL = testSuUrl;
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
}

process.env.JWT_SECRET = "test-secret-key-for-testing-only";
// NOTE: Force a deterministic Google client id so the auth controller registers
// `/auth/google` regardless of the developer's local `.env` and so tests can
// exercise the enabled-mode code path.
process.env.GOOGLE_CLIENT_ID = "test-google-client.apps.googleusercontent.com";
// NOTE: Force the shipped rate-limit budgets, for the same reason as the line
// above and with one consequence worth spelling out. Two test files read a real
// response from the real app: one identifies WHICH limiter answered by the
// ceiling it advertises (`RateLimit-Limit: 20` is the credential bucket, 600 the
// global one), the other measures what a rejected request costs by watching the
// remaining budget move. All four of these are environment variables, so a
// developer who tunes one in their `.env` would watch a correct app fail, and
// fail with `Expected: "20", Received: "600"`, which is exactly the signature of
// the limiter-collision regression those tests exist to catch. Pinning here, at
// preload and before any module reads config, is what keeps that signal
// unambiguous.
process.env.RATE_LIMIT_USER_PER_MIN = "600";
process.env.RATE_LIMIT_MCP_PER_MIN = "1200";
process.env.RATE_LIMIT_CREDENTIAL_MAX = "20";
process.env.RATE_LIMIT_CREDENTIAL_WINDOW_MINUTES = "5";
