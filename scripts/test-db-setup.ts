#!/usr/bin/env bun
import { Client } from "pg";
import {
  localMigrations,
  type MigrationRow,
  reprovisionReasons,
} from "@/tests/db-gate";
import { checkoutRootFrom, testDbNameFor, withDbName } from "@/tests/db-name";

// Provisions (idempotently) the DEDICATED test database the integration suite runs against, so
// tests never touch the dev DB. The suite does destructive, unscoped ops (e.g. `DELETE FROM
// scheduler_jobs`) and creates/drops tenants; pointing it at the dev DB wipes live dev data on
// every `bun test`. Run once after cloning / after a schema change: `bun db:test:setup`.
//
// Reads TEST_APP_DATABASE_URL (app role) and TEST_MIGRATION_DATABASE_URL (superuser) from the env.
// Steps: CREATE DATABASE (if missing) → db-bootstrap (extension, role grants, langgraph schema) →
// prisma migrate deploy. Safe to re-run.

const ROOT = checkoutRootFrom(import.meta.url, "..");

function substitutePort(url: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching the literal ${POSTGRES_PORT} placeholder from .env, not a JS template.
  return url.replace("${POSTGRES_PORT}", process.env.POSTGRES_PORT ?? "5432");
}

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, "");
}

// Swap the database in a connection URL for the `postgres` maintenance DB so we can issue
// CREATE DATABASE (which cannot run while connected to the target).
function maintenanceUrl(url: string): string {
  const u = new URL(url);
  u.pathname = "/postgres";
  return u.toString();
}

async function main() {
  const appUrlRaw = process.env.TEST_APP_DATABASE_URL;
  const suUrlRaw = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!appUrlRaw || !suUrlRaw) {
    throw new Error(
      "TEST_APP_DATABASE_URL and TEST_MIGRATION_DATABASE_URL must be set (see .env.example)",
    );
  }
  const appUrl = substitutePort(appUrlRaw);
  const suUrl = substitutePort(suUrlRaw);

  const declared = dbNameOf(suUrl);
  // Guard: this script (and the suite) must only ever run against a *_test database. It reads the
  // DECLARED name, before the derivation below, because it is a statement about what the developer
  // pointed at.
  if (!declared.endsWith("_test") || declared !== dbNameOf(appUrl)) {
    throw new Error(
      `refusing to provision: test DB name must end in "_test" and match across both URLs (su="${declared}", app="${dbNameOf(appUrl)}")`,
    );
  }

  // The `.env` name is the base; the target is per checkout, by the same derivation tests/setup.ts
  // applies at preload. Deriving it in both places rather than asking each checkout to edit its
  // `.env` is what makes the isolation impossible to forget — see tests/db-name.ts (issue #417).
  const dbName = testDbNameFor(declared, ROOT);
  if (dbName !== declared) {
    console.log(
      `test-db-setup: this checkout's database is "${dbName}" (base "${declared}")`,
    );
  }
  const targetSuUrl = withDbName(suUrl, dbName);
  const targetAppUrl = withDbName(appUrl, dbName);

  // 1. CREATE DATABASE if missing (via the postgres maintenance DB).
  const maint = new Client({ connectionString: maintenanceUrl(targetSuUrl) });
  await maint.connect();
  try {
    const { rowCount } = await maint.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName],
    );
    // A database in one of the states `reprovisionReasons` names cannot be REPAIRED by deploying,
    // so it is dropped and rebuilt, which costs nothing because it holds test fixtures and nothing
    // else.
    //
    // The connections are closed first, and that reverses a decision made earlier in this change on
    // the reasoning that Postgres refusing is safer than killing a suite mid-run. What refuted it
    // was measuring the refusal: `database "…" is being accessed by other users`, exit 1, with the
    // holder being ONE backend in `state=idle` whose last statement was `ROLLBACK` — a pool
    // connection leaked by a test process that had already exited. That is the ordinary case, not
    // the concurrent-run case, so the refusal fires where there is nothing to protect and hands the
    // reader a Postgres error naming no way out.
    //
    // What makes closing them defensible is the OTHER half of this change: the database is derived
    // per checkout, so the only thing that can be connected is this checkout's own work, and the
    // person typing this command owns it. `datname` fences the termination to this database alone.
    if (rowCount !== 0) {
      const reasons = await reprovisionOf(targetSuUrl);
      if (reasons.length > 0) {
        console.log(
          `test-db-setup: "${dbName}" cannot be deployed onto (${reasons.length} reason(s)), so it is being reprovisioned:`,
        );
        for (const m of reasons) console.log(`  ${m}`);
        const { rows: closed } = await maint.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        if (closed.length > 0) {
          console.log(
            `test-db-setup: closed ${closed.length} connection(s) still open on it`,
          );
        }
        await maint.query(`DROP DATABASE "${dbName}"`);
        await maint.query(`CREATE DATABASE "${dbName}"`);
        console.log(`test-db-setup: recreated database "${dbName}"`);
      } else {
        console.log(`test-db-setup: database "${dbName}" already exists`);
      }
    } else if (rowCount === 0) {
      // dbName is validated (*_test) and comes from our own env, not external input.
      await maint.query(`CREATE DATABASE "${dbName}"`);
      console.log(`test-db-setup: created database "${dbName}"`);
    }
  } finally {
    await maint.end();
  }

  // 2. Bootstrap (extension, app-role grants, langgraph schema) and 3. migrate, both pointed at the
  // test DB. db-bootstrap derives the app role from DATABASE_URL and connects via
  // MIGRATION_DATABASE_URL; prisma migrate (prisma.config.ts) connects via MIGRATION_DATABASE_URL.
  const childEnv = {
    ...process.env,
    DATABASE_URL: targetAppUrl,
    MIGRATION_DATABASE_URL: targetSuUrl,
  };
  for (const cmd of [
    ["bun", "scripts/db-bootstrap.ts"],
    ["bunx", "prisma", "migrate", "deploy"],
  ]) {
    const proc = Bun.spawn(cmd, {
      env: childEnv,
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) {
      throw new Error(`"${cmd.join(" ")}" exited with code ${code}`);
    }
  }
  console.log(`test-db-setup: "${dbName}" ready`);
}

// `_prisma_migrations` may not exist at all (a database created and never migrated), and that is a
// state and not an error: there is nothing to undo in it, only migrations to apply.
async function reprovisionOf(url: string): Promise<string[]> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<MigrationRow>(
      `SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations
       WHERE to_regclass('_prisma_migrations') IS NOT NULL`,
    );
    return reprovisionReasons(rows, localMigrations(ROOT));
  } catch {
    return [];
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(
    "test-db-setup failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
