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
  hasCreateDb: boolean;
  hasCreateRole: boolean;
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

// Elevated attributes the runtime role must not keep, but whose removal is NOT the demote branch's
// business: neither defeats RLS, so the boot guard does not look at them and nothing downstream
// notices. Before this file branched, every boot re-asserted them as part of one option list, and
// that is the behaviour being kept — a role that acquired CREATEDB or CREATEROLE along the way is
// still stripped of them on the next boot.
//
// One statement each, because a `CREATEROLE` administrator may take CREATEROLE away and not
// CREATEDB (it can only set an attribute it holds itself, measured), and a combined statement would
// lose both to the one it is refused. And a warning rather than a refusal, because RLS holds either
// way and this script must not turn a hardening it cannot finish into a crash-loop.
const ELEVATED_ATTRIBUTES = [
  ["hasCreateDb", "NOCREATEDB"],
  ["hasCreateRole", "NOCREATEROLE"],
] as const satisfies readonly (readonly [keyof RuntimeRoleState, string])[];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Makes the LangGraph checkpointer schema usable by the runtime role, which is three different
// jobs depending on what is already there and only looks like one.
//
// The schema is owned by the runtime role so PostgresSaver.setup() can create its tables
// (thread_id prefixing is the tenant fence here). Which statement is needed, and whether a refusal
// may be survived, depends on what is already there — the two cases fail differently and one catch
// over both would answer the wrong question:
//
//   ABSENT is a convenience. `setup()` runs its own `CREATE SCHEMA IF NOT EXISTS langgraph` at
//   boot and the runtime role holds CREATE ON DATABASE for exactly that reason
//   (docs/graph.md), so doing it here only settles the owner earlier — and when the server does
//   it instead the owner comes out the same, because the runtime role is the creator. Creating
//   it OWNED BY another role is what needs the membership taken above, so a refusal must not
//   abort a boot that completes itself a minute later.
//
//   PRESENT is not, and it is the case a rotated runtime role lands in. `CREATE SCHEMA IF NOT
//   EXISTS` is a no-op there, for us and for `setup()` alike, so nothing downstream repairs it:
//   the checkpointer fails at boot on schema or table access, and reporting a successful
//   bootstrap first is what makes that unreadable.
//
// A present schema is reconciled whoever owns it, and the schema's own owner is deliberately not
// a shortcut out of that. Ownership of the schema and of the tables move independently here (only
// the tables are transferred), so a rotation A -> B leaves the schema with A and its tables with
// B — and a rollback to A would then find `owner === role`, skip everything, and boot into a
// checkpointer that cannot read the tables A no longer owns. The reconciliation is idempotent, so
// running it on a healthy install costs two no-op grants and a loop over nothing.
async function provisionCheckpointerSchema(
  client: Client,
  role: string,
  ident: string,
) {
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
  } else {
    // NOTE: reconciling an existing schema is the rotated-runtime-role case, and it has three
    // depths, only the first of which is obvious:
    //
    //   the schema      -- USAGE/CREATE, or nothing in it can be reached at all;
    //   the tables      -- granting on a schema does not reach what is inside it, and setup()
    //                      opens with `SELECT v FROM langgraph.checkpoint_migrations` and writes
    //                      to the same table one statement later;
    //   their ownership -- setup() also runs the checkpointer's own migrations, one of which is
    //                      `ALTER TABLE ... ALTER COLUMN blob DROP NOT NULL`
    //                      (@langchain/langgraph-checkpoint-postgres 1.0.4), and Postgres allows
    //                      that only to the table's owner.
    //
    // NOTE: only the TABLES are re-owned. The schema itself stays with whoever holds it:
    // setup() needs USAGE and CREATE on it, which a grant covers, and nothing it runs alters the
    // schema — so taking it over buys nothing, and having it inside the same block would make a
    // refusal there abort the table transfers that do matter. Identifiers are quoted by Postgres
    // in the DO block rather than spliced here.
    //
    // NOTE: that independence is also why the schema's owner already matching is NOT a
    // shortcut out of here: a rotation A -> B leaves the schema with A and its tables with B, so a
    // rollback to A finds its own name on the schema and no access to the tables. This runs
    // whoever owns it, and is idempotent — on a healthy install it is two no-op grants and a loop
    // over nothing.
    //
    // NOTE: the grants go FIRST, and the order is load-bearing rather than stylistic: Postgres
    // requires a table's prospective owner to hold CREATE on its schema, so on a fresh rotation,
    // where the new role has nothing on the old owner's schema yet, the transfer below would fail,
    // roll back its whole loop, and leave every table where it was.
    let adoptError: unknown;
    try {
      await client.query(`GRANT USAGE, CREATE ON SCHEMA langgraph TO ${ident}`);
      await client.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph TO ${ident}`,
      );
    } catch (err) {
      adoptError = err;
    }
    try {
      await client.query(`
        DO $$
        DECLARE
          v_role text := current_setting('fazerai.app_role');
          r      record;
        BEGIN
          FOR r IN
            SELECT c.relname FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'langgraph' AND c.relkind IN ('r', 'p')
          LOOP
            EXECUTE format('ALTER TABLE langgraph.%I OWNER TO %I', r.relname, v_role);
          END LOOP;
        END $$;
      `);
    } catch (err) {
      adoptError ??= err;
    }

    // NOTE: what decides the outcome is a privilege check, not the absence of an error above: this
    // administrator may be refused everything while the runtime role already holds what it needs
    // from someone else, and it may equally hold only half of it.
    //
    // NOTE: one has_table_privilege() call per privilege. A comma-separated list is OR, not AND
    // ("the result will be true if any of the listed privileges is held"), so asking for
    // 'SELECT, INSERT, UPDATE, DELETE' in one call passes on a read-only grant.
    const usable = (
      await client.query<{
        schema_ok: boolean;
        tables_ok: boolean;
        foreign_owners: string | null;
      }>(
        `SELECT
           has_schema_privilege($1, 'langgraph', 'USAGE')
             AND has_schema_privilege($1, 'langgraph', 'CREATE') AS schema_ok,
           (SELECT COALESCE(bool_and(
                     has_table_privilege($1, c.oid, 'SELECT')
                     AND has_table_privilege($1, c.oid, 'INSERT')
                     AND has_table_privilege($1, c.oid, 'UPDATE')
                     AND has_table_privilege($1, c.oid, 'DELETE')), true)
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'langgraph' AND c.relkind IN ('r', 'p')) AS tables_ok,
           (SELECT string_agg(DISTINCT quote_ident(pg_get_userbyid(c.relowner)), ', ')
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'langgraph' AND c.relkind IN ('r', 'p')
               AND pg_get_userbyid(c.relowner) <> $1) AS foreign_owners`,
        [role],
      )
    ).rows[0];

    const missing = [
      usable?.schema_ok ? null : "the schema itself",
      usable?.tables_ok ? null : "the tables already in it",
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `the runtime role "${role}" cannot reach ${missing.join(" nor ")} of the langgraph ` +
          `schema (owned by "${schemaOwner}")` +
          `${adoptError ? `: ${message(adoptError)}` : ""}. The checkpointer reads ` +
          "langgraph.checkpoint_migrations on its first query, so the server would fail at boot " +
          `instead. Run as "${schemaOwner}" or as a superuser: ` +
          `GRANT USAGE, CREATE ON SCHEMA langgraph TO "${role}"; ` +
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph TO "${role}";`,
      );
    }
    // NOTE: NULL when every table is the runtime role's (and when there are no tables at all): the
    // aggregate only sees rows whose owner differs. Deliberately a string rather than an array --
    // the pg driver hands a scalar-subquery array back as its Postgres literal, not as a JS array.
    const foreignOwners = usable?.foreign_owners;
    if (foreignOwners) {
      // NOTE: a warning and not a refusal, because this install works: DML is all the checkpointer
      // needs until a package upgrade brings a migration that alters those tables, and refusing
      // now would crash-loop a server that boots fine today.
      console.warn(
        `db-bootstrap: runtime role "${role}" can use the langgraph tables but does not own ` +
          `them (owned by ${foreignOwners}); a future ` +
          "checkpointer migration that ALTERs them would fail at boot. Run as their owner or as " +
          `a superuser: ALTER TABLE langgraph.<table> OWNER TO "${role}";`,
      );
    }
  }
}

// Brings the runtime role to what the rest of this script assumes: it exists, it is not
// privileged, and it answers to the password in DATABASE_URL. Only the first two are worth failing
// a boot over -- see the header.
async function provisionRuntimeRole(
  client: Client,
  role: string,
  ident: string,
  runtimeRole: RuntimeRoleState,
  plan: RoleProvisioningPlan,
) {
  if (plan === "demote") {
    // NOTE: fatal on purpose. RLS is a silent no-op for a privileged role, so the server refuses
    // to serve with it
    // anyway. Only a real superuser can take the attributes back off, so when we are not one,
    // name the statement a superuser has to run instead of dying on `permission denied`.
    try {
      await runRoleDdl(client, plan);
    } catch (err) {
      const attrs = [
        runtimeRole.isSuperuser ? "SUPERUSER" : null,
        runtimeRole.bypassesRls ? "BYPASSRLS" : null,
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
    // NOTE: best-effort. What this script owes is that the role EXISTS and is unprivileged, and
    // both already hold here. Rewriting the password needs ADMIN over the role, which an
    // administrative role that did not create it does not have — and the authority on whether the
    // password is right is the runtime's own connection seconds later, whose authentication error
    // says so far more clearly than a failed boot does.
    try {
      await runRoleDdl(client, plan);
    } catch (err) {
      console.warn(
        `db-bootstrap: could not sync the password of runtime role "${role}" (${message(err)}); ` +
          "leaving it as it is — the server reports an authentication failure if it is stale",
      );
    }
    for (const [held, option] of ELEVATED_ATTRIBUTES) {
      if (!runtimeRole[held]) continue;
      try {
        await client.query(`ALTER ROLE ${ident} ${option}`);
      } catch (err) {
        console.warn(
          `db-bootstrap: could not apply ${option} to runtime role "${role}" ` +
            `(${message(err)}); RLS is unaffected, but the role keeps a privilege it should not have`,
        );
      }
    }
  } else {
    await runRoleDdl(client, plan);
  }
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

    // NOTE: one round trip for everything the branching needs. The last two columns decide
    // nothing on their own; they are what turns a bare permission error into a message that names
    // the mode the script was running in.
    const state = await client.query<{
      app_exists: boolean;
      app_superuser: boolean;
      app_bypassrls: boolean;
      app_createdb: boolean;
      app_createrole: boolean;
      admin_superuser: boolean;
      server_version_num: number;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS app_exists,
         COALESCE((SELECT rolsuper      FROM pg_roles WHERE rolname = $1), false) AS app_superuser,
         COALESCE((SELECT rolbypassrls  FROM pg_roles WHERE rolname = $1), false) AS app_bypassrls,
         COALESCE((SELECT rolcreatedb   FROM pg_roles WHERE rolname = $1), false) AS app_createdb,
         COALESCE((SELECT rolcreaterole FROM pg_roles WHERE rolname = $1), false) AS app_createrole,
         COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) AS admin_superuser,
         current_setting('server_version_num')::int AS server_version_num`,
      [role],
    );
    const s = state.rows[0];
    if (!s) throw new Error("could not read the role catalog");
    const runtimeRole: RuntimeRoleState = {
      exists: s.app_exists,
      isSuperuser: s.app_superuser,
      bypassesRls: s.app_bypassrls,
      hasCreateDb: s.app_createdb,
      hasCreateRole: s.app_createrole,
    };
    const plan = planRoleProvisioning(runtimeRole);

    await provisionRuntimeRole(client, role, ident, runtimeRole, plan);

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

    await provisionCheckpointerSchema(client, role, ident);

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
