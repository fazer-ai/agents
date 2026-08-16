#!/usr/bin/env bun
import { Client } from "pg";

// Deterministic, platform-independent DB provisioning. Run ONCE at deploy time (and safe to
// re-run) as the FIRST step before `prisma migrate deploy`. It does what scripts/db-bootstrap.sql
// does, but without depending on Postgres `initdb.d` — which only runs on an empty data volume,
// so on managed Postgres (Coolify/EasyPanel provision the DB for you, no mount) the app role would
// never be created and the operator would be forced onto the superuser (RLS no-op).
//
// It connects as the SUPERUSER (MIGRATION_DATABASE_URL) and provisions exactly the role the
// runtime will use, derived from DATABASE_URL — so the runtime role is guaranteed to exist and be
// NON-superuser/NON-bypassrls (the boot guard, assertRuntimeRoleIsNotSuperuser, then passes).

function substitutePort(url: string): string {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: matching the literal ${POSTGRES_PORT} placeholder from .env, not a JS template.
  return url.replace("${POSTGRES_PORT}", process.env.POSTGRES_PORT ?? "5432");
}

interface AppRole {
  role: string;
  password: string;
}

function parseAppRole(databaseUrl: string): AppRole {
  const u = new URL(databaseUrl);
  const role = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  // The role name is interpolated into DDL as a double-quoted identifier; allow the chars that
  // appear in operator/Coolify-generated role names (alnum, underscore, hyphen) and reject
  // anything that could break out of the quotes. Defense in depth — not external input.
  if (!/^[A-Za-z0-9_-]+$/.test(role)) {
    throw new Error(`unsafe app role name in DATABASE_URL: "${role}"`);
  }
  if (!password) {
    throw new Error("DATABASE_URL must include the app role's password");
  }
  return { role, password };
}

async function main() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!migrationUrl) {
    throw new Error(
      "MIGRATION_DATABASE_URL (a superuser/owner connection) is required for bootstrap",
    );
  }
  if (!appUrl) throw new Error("DATABASE_URL is required for bootstrap");

  const { role, password } = parseAppRole(substitutePort(appUrl));
  const ident = `"${role}"`; // validated above

  const client = new Client({ connectionString: substitutePort(migrationUrl) });
  await client.connect();
  try {
    // pgvector extension (superuser-only; cannot live in a Prisma migration).
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    // Role + password handed to the DO block via session GUCs so the password is never spliced
    // into a SQL string we build (and never logged).
    await client.query("SELECT set_config('fazerai.app_role', $1, false)", [
      role,
    ]);
    await client.query("SELECT set_config('fazerai.app_password', $1, false)", [
      password,
    ]);
    await client.query(`
      DO $$
      DECLARE
        v_role text := current_setting('fazerai.app_role');
        v_pw   text := current_setting('fazerai.app_password');
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
          EXECUTE format(
            'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
            v_role, v_pw);
        ELSE
          EXECUTE format(
            'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
            v_role, v_pw);
        END IF;
        EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', current_database(), v_role);
      END $$;
    `);

    // Privileges on existing + future objects. ALTER DEFAULT PRIVILEGES is scoped to the role
    // running it (the superuser/owner running migrations here), so future migration tables inherit
    // these grants.
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ident}`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ident}`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ident}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ident}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ident}`,
    );

    // LangGraph checkpointer schema, owned by the runtime role so PostgresSaver.setup() can create
    // its tables (thread_id prefixing is the tenant fence here).
    await client.query(
      `CREATE SCHEMA IF NOT EXISTS langgraph AUTHORIZATION ${ident}`,
    );
    await client.query(`GRANT USAGE, CREATE ON SCHEMA langgraph TO ${ident}`);

    console.log(
      `db-bootstrap: provisioned runtime role "${role}" (idempotent)`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(
    "db-bootstrap failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
