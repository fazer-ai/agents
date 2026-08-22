#!/usr/bin/env bun
import { Client } from "pg";

// Deterministic, platform-independent DB provisioning. Run ONCE at deploy time (and safe to
// re-run) as the FIRST step before `prisma migrate deploy`. It does what scripts/db-bootstrap.sql
// does, but without depending on Postgres `initdb.d` — which only runs on an empty data volume,
// so on managed Postgres (Coolify/EasyPanel provision the DB for you, no mount) the app role would
// never be created and the operator would be forced onto the superuser (RLS no-op).
//
// It connects as the migration role (MIGRATION_DATABASE_URL) and provisions exactly the role the
// runtime will use, derived from DATABASE_URL — so the runtime role is guaranteed to exist and be
// NON-superuser/NON-bypassrls (the boot guard, assertRuntimeRoleIsNotSuperuser, then passes).
//
// On managed Postgres that migration role is NOT a real superuser, and PostgreSQL 16 turned two of
// the statements below into ones a superuser has to run. So the script reads the catalog and picks
// what it may execute, along this line: a statement whose failure breaks the guarantee above is
// FATAL (creating the role, demoting a privileged one), and a statement that only carries a
// convenience is BEST-EFFORT with a warning — because this runs unattended on every container
// boot, and exiting non-zero there is what leaves an install crash-looping.

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

interface RuntimeRoleState {
  exists: boolean;
  isSuperuser: boolean;
  bypassesRls: boolean;
}

export type RoleProvisioningPlan = "create" | "demote" | "syncPassword";

// What the runtime role needs, from what the catalog says it already is.
//
// The three are not interchangeable, and PostgreSQL 16 is why. Since 16 the privilege check in
// `AlterRole` fires on an option being PRESENT, not on its value, so `NOSUPERUSER` is refused for
// exactly the same reason `SUPERUSER` is, for any administrative role that is not a real
// superuser. `CreateRole` still checks the value, which is why the create branch can keep the full
// option list and the alter branch cannot. Measured on PostgreSQL 17.10 with a
// CREATEROLE/NOSUPERUSER admin: CREATE with the full list succeeds; ALTER naming any of
// NOSUPERUSER / NOBYPASSRLS / NOCREATEDB / NOREPLICATION is `permission denied to alter role`;
// ALTER ... PASSWORD alone succeeds.
//
// So the attributes are asserted where they are free (creation) and re-asserted only when they are
// actually WRONG, which is the one case worth spending a superuser on.
export function planRoleProvisioning(
  role: RuntimeRoleState,
): RoleProvisioningPlan {
  if (!role.exists) return "create";
  if (role.isSuperuser || role.bypassesRls) return "demote";
  return "syncPassword";
}

// The DDL that carries the password. It reads role and password from session GUCs rather than from
// a string we build, so the password is never spliced into SQL we assemble or log. The templates
// are our own constants with no quotes to escape; only %I/%L are filled, by Postgres itself.
const ROLE_DDL: Record<RoleProvisioningPlan, string> = {
  create:
    "CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
  demote:
    "ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE",
  syncPassword: "ALTER ROLE %I LOGIN PASSWORD %L",
};

async function runRoleDdl(client: Client, plan: RoleProvisioningPlan) {
  await client.query(`
    DO $$
    DECLARE
      v_role text := current_setting('fazerai.app_role');
      v_pw   text := current_setting('fazerai.app_password');
    BEGIN
      EXECUTE format('${ROLE_DDL[plan]}', v_role, v_pw);
    END $$;
  `);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    // pgvector extension (superuser-only to install; permitted, and a no-op, once it is present).
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    // Role + password handed to the DO block via session GUCs so the password is never spliced
    // into a SQL string we build (and never logged).
    await client.query("SELECT set_config('fazerai.app_role', $1, false)", [
      role,
    ]);
    await client.query("SELECT set_config('fazerai.app_password', $1, false)", [
      password,
    ]);

    // One round trip for everything the branching needs. The last two columns decide nothing on
    // their own; they are what turns a bare permission error into a message that names the mode
    // the script was running in.
    const state = await client.query<{
      app_exists: boolean;
      app_superuser: boolean;
      app_bypassrls: boolean;
      admin_superuser: boolean;
      server_version_num: number;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS app_exists,
         COALESCE((SELECT rolsuper      FROM pg_roles WHERE rolname = $1), false) AS app_superuser,
         COALESCE((SELECT rolbypassrls  FROM pg_roles WHERE rolname = $1), false) AS app_bypassrls,
         COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS admin_superuser,
         current_setting('server_version_num')::int AS server_version_num`,
      [role],
    );
    const s = state.rows[0];
    if (!s) throw new Error("could not read the role catalog");
    const plan = planRoleProvisioning({
      exists: s.app_exists,
      isSuperuser: s.app_superuser,
      bypassesRls: s.app_bypassrls,
    });

    if (plan === "demote") {
      // Fatal: RLS is a silent no-op for a privileged role, so the server refuses to serve with it
      // anyway. Only a real superuser can take the attributes back off, so when we are not one,
      // name the statement a superuser has to run instead of dying on `permission denied`.
      try {
        await runRoleDdl(client, plan);
      } catch (err) {
        const attrs = [
          s.app_superuser ? "SUPERUSER" : null,
          s.app_bypassrls ? "BYPASSRLS" : null,
        ]
          .filter(Boolean)
          .join(" + ");
        throw new Error(
          `runtime role "${role}" is ${attrs}, which makes RLS a no-op, and this administrative ` +
            `role cannot take that away (${message(err)}). Run as a superuser: ` +
            `ALTER ROLE "${role}" NOSUPERUSER NOBYPASSRLS;`,
        );
      }
    } else if (plan === "syncPassword") {
      // Best-effort: what this script owes is that the role EXISTS and is unprivileged, and both
      // already hold here. Rewriting the password needs ADMIN over the role, which an
      // administrative role that did not create it does not have — and the authority on whether
      // the password is right is the runtime's own connection seconds later, whose authentication
      // error says so far more clearly than a failed boot does.
      try {
        await runRoleDdl(client, plan);
      } catch (err) {
        console.warn(
          `db-bootstrap: could not sync the password of runtime role "${role}" (${message(err)}); ` +
            "leaving it as it is — the server reports an authentication failure if it is stale",
        );
      }
    } else {
      await runRoleDdl(client, plan);
    }

    // CONNECT to use the DB; CREATE so PostgresSaver.setup() can run its own
    // `CREATE SCHEMA IF NOT EXISTS langgraph` at boot (the privilege is checked even when the
    // schema already exists).
    await client.query(`
      DO $$
      BEGIN
        EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO %I',
                       current_database(), current_setting('fazerai.app_role'));
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

    // Since PostgreSQL 16, creating an object owned by another role requires being able to SET ROLE
    // to it, and the membership a CREATEROLE role gets over the roles it creates carries SET FALSE
    // — so `CREATE SCHEMA ... AUTHORIZATION` fails there with `must be able to SET ROLE`. The grant
    // that fixes it is one an administrative role may make (it holds ADMIN), and `WITH SET` is
    // itself 16+ syntax, so older servers neither need it nor parse it. Best-effort: if it does not
    // go through, the CREATE SCHEMA below is the statement that reports the real problem.
    if (s.server_version_num >= 160000) {
      try {
        await client.query(`GRANT ${ident} TO CURRENT_USER WITH SET TRUE`);
      } catch (err) {
        console.warn(
          `db-bootstrap: could not grant "${role}" to the administrative role (${message(err)})`,
        );
      }
    }

    // LangGraph checkpointer schema, owned by the runtime role so PostgresSaver.setup() can create
    // its tables (thread_id prefixing is the tenant fence here). Which statement is needed, and
    // whether a refusal may be survived, depends on what is already there — the two cases fail
    // differently and one catch over both would answer the wrong question:
    //
    //   ABSENT is a convenience. `setup()` runs its own `CREATE SCHEMA IF NOT EXISTS langgraph` at
    //   boot and the runtime role holds CREATE ON DATABASE for exactly that reason
    //   (docs/graph.md), so doing it here only settles the owner earlier — and when the server does
    //   it instead the owner comes out the same, because the runtime role is the creator. Creating
    //   it OWNED BY another role is what needs the membership taken above, so a refusal must not
    //   abort a boot that completes itself a minute later.
    //
    //   PRESENT UNDER ANOTHER OWNER is not, and it is the case a rotated runtime role lands in.
    //   `CREATE SCHEMA IF NOT EXISTS` is a no-op there, for us and for `setup()` alike, so nothing
    //   downstream repairs it: without USAGE/CREATE the checkpointer fails at boot on schema
    //   access, and reporting a successful bootstrap first is what makes that unreadable.
    const schemaOwner = (
      await client.query<{ owner: string }>(
        "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'langgraph'",
      )
    ).rows[0]?.owner;

    if (schemaOwner === undefined) {
      try {
        await client.query(
          `CREATE SCHEMA IF NOT EXISTS langgraph AUTHORIZATION ${ident}`,
        );
      } catch (err) {
        console.warn(
          `db-bootstrap: could not create the langgraph schema (${message(err)}); ` +
            `leaving it to the server, which creates it as "${role}" on its first boot`,
        );
      }
    } else if (schemaOwner !== role) {
      try {
        await client.query(
          `GRANT USAGE, CREATE ON SCHEMA langgraph TO ${ident}`,
        );
      } catch (err) {
        throw new Error(
          `the langgraph schema is owned by "${schemaOwner}", not by the runtime role "${role}", ` +
            `and this administrative role cannot grant on it (${message(err)}). The checkpointer ` +
            `would fail at boot instead. Run as its owner or as a superuser: ` +
            `GRANT USAGE, CREATE ON SCHEMA langgraph TO "${role}";`,
        );
      }
    }

    console.log(
      `db-bootstrap: provisioned runtime role "${role}" (idempotent; ${plan}, ` +
        `admin=${s.admin_superuser ? "superuser" : "non-superuser"}, server=${s.server_version_num})`,
    );
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(
      "db-bootstrap failed:",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
}
