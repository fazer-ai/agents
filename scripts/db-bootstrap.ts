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

export function parseAppRole(databaseUrl: string): AppRole {
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

// What the plan above cannot decide, because it is a question about the role AFTER provisioning
// rather than before: a role may hold no privileged attribute of its own and still reach SUPERUSER
// or BYPASSRLS through a membership. RLS is a no-op for it just the same, and the server's own
// `assertRuntimeRoleIsNotSuperuser` refuses to start with it — so provisioning it and reporting
// success only moves the failure to the next boot, on a guard bootstrap had the catalog open to
// check.
//
// NOTE: this is a post-condition rather than a fourth plan, and asking it AFTER the DDL is not a
// detail. `pg_has_role` is true of every role for a superuser, so on a role that is privileged
// outright the question answers itself and would swallow the demotion — the one repair there is.
// Asked afterwards, it is asked of what the role actually ended up being.
//
// NOTE: it must be asked before `GRANT <role> TO CURRENT_USER ... INHERIT TRUE` further down.
// Handing the administrative role a path into the runtime role is harmless when the runtime role
// has no privileges, and is the whole problem when it reaches SUPERUSER through someone else.
//
// NOTE: it takes TWO names, and they are not the same name whenever the membership is transitive.
// `runtime -> team -> privileged` reaches `privileged`, which is what to report; but
// `REVOKE privileged FROM runtime` targets a grant that does not exist, and Postgres accepts it
// as a no-op (measured) — so the operator runs it, sees success, restarts, and fails identically.
// What has to be revoked is the DIRECT edge, `team`. Reporting only one of the two gives either a
// diagnosis nobody can act on or an instruction that does not say what it is for.
export function assertRuntimeRoleIsUnprivileged(
  role: string,
  reaches: string | null,
  revokable: string | null,
) {
  if (reaches === null) return;
  throw new Error(
    `runtime role "${role}" reaches a privileged role through a membership (${reaches}), ` +
      "which makes RLS a no-op for it just as SUPERUSER would — the server refuses to serve with " +
      "it, so provisioning it would only move the failure to the next boot. No attribute takes " +
      "this away, and the membership to revoke is the one it holds DIRECTLY" +
      `${revokable === null ? "" : `: as a role holding ADMIN on it, REVOKE ${revokable} FROM "${role}";`}`,
  );
}

// The DDL that carries the password. It reads role and password from session GUCs rather than from
// a string we build, so the password is never spliced into SQL we assemble or log. The templates
// are our own constants with no quotes to escape; only %I/%L are filled, by Postgres itself.
//
// NOTE: the four NO* on `create` are what `CREATE ROLE` defaults to anyway (measured: a bare
// `CREATE ROLE x LOGIN PASSWORD y` lands with all four false), so they buy no behaviour and no
// test can tell them from their absence. They are here to say out loud what this role is allowed
// to be, next to a `demote` line where the same words are the entire point.
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
// Attributes worth removing but not worth failing over: neither defeats RLS, so the boot guard
// never looks at them and nothing downstream notices — which also means this script is the only
// thing that takes them away.
//
// NOTE: a table rather than a statement, and deliberately NOT part of ROLE_DDL above, because
// these are issued ONE ALTER PER ROW, each in its own round trip with its own catch, outside any
// DO block or transaction. An administrator may only set an attribute it holds itself, so the
// documented CREATEROLE-but-not-CREATEDB admin is refused NOCREATEDB and allowed NOCREATEROLE:
// a combined statement, or a shared block, would lose the half it can do to the half it cannot.
// The partial outcome is asserted in the tests, and combining them turns that assertion red.
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
  const readOwner = async () =>
    (
      await client.query<{ owner: string }>(
        "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = 'langgraph'",
      )
    ).rows[0]?.owner;

  let schemaOwner = await readOwner();

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
    // NOTE: read it back rather than assume the CREATE settled it. `IF NOT EXISTS` reports success
    // for a schema someone else just created, so "absent, therefore mine" is a conclusion this
    // branch is not entitled to — and the reconciliation below is exactly what handles a schema
    // owned by someone else. Reading it back removes the special case instead of adding one: still
    // absent means the CREATE failed and the server will do it (the warning above says so), and
    // present means reconcile it like any other existing schema, whoever ended up owning it.
    //
    // NOTE: no measured failure sits behind this, and the honest reason is worth writing down. Two
    // containers booting at once with different runtime roles is the case that would reach it, and
    // in 14 attempts it never got that far: they collide earlier on `GRANT ... ON DATABASE`, the
    // same `pg_database` tuple, and the loser dies on `tuple concurrently updated` — loudly, which
    // is recoverable, rather than reporting success it did not achieve. This stands as the simpler
    // shape, not as a fix for something observed.
    schemaOwner = await readOwner();
  }

  if (schemaOwner !== undefined) {
    // NOTE: an existing schema has to be reached at two depths, only the first of which is obvious:
    //
    //   the schema — USAGE/CREATE, or nothing in it can be reached at all;
    //   the tables — granting on a schema does not reach what is inside it, and setup() opens with
    //                `SELECT v FROM langgraph.checkpoint_migrations` and writes to the same table
    //                one statement later.
    //
    // Ownership is a third thing setup() needs — one of the checkpointer's own migrations is
    // `ALTER TABLE ... ALTER COLUMN blob DROP NOT NULL`
    // (@langchain/langgraph-checkpoint-postgres 1.0.4), which Postgres allows only to the owner —
    // but it is deliberately NOT reconciled in general. See the transfer below.
    //
    // NOTE: only the TABLES are ever re-owned. The schema itself stays with whoever holds it:
    // setup() needs USAGE and CREATE on it, which a grant covers, and nothing it runs alters the
    // schema — so taking it over buys nothing, and having it inside the same block would make a
    // refusal there abort the table transfers that do matter. Identifiers are quoted by Postgres
    // in the DO block rather than spliced here.
    //
    // NOTE: the grants go FIRST, and the order is load-bearing rather than stylistic: Postgres
    // requires a table's prospective owner to hold CREATE on its schema, so where the new role has
    // nothing on the old owner's schema yet, the transfer below would fail, roll back its whole
    // loop, and leave every table where it was. Reaching them is also the part that carries the
    // most: the grants alone serve every checkpointer read and write, and only the ALTER inside a
    // pending migration needs more than that.
    //
    // NOTE: the transfer takes ONLY the tables this administrator itself owns, and that is the
    // whole rule rather than an optimisation. `ALTER TABLE ... OWNER TO` strips the previous
    // owner's implicit privileges the moment it commits (measured), and this runs on EVERY boot,
    // including the overlap of a rolling deploy where the previous container is still answering
    // customers on the old role. The script cannot tell a retired owner from a serving one — but it
    // knows one owner that is certainly not serving: itself, because setup() connects as the
    // RUNTIME role (config.langgraphDatabaseUrl) and never as this one. So a brownfield install
    // whose tables were created through a superuser DATABASE_URL — the case this script exists for
    // — is adopted, while a runtime role that may still be live is left alone and reported.
    //
    // NOTE: `<> v_role` on top of that is what keeps a healthy re-boot free: `ALTER TABLE ... OWNER
    // TO` takes an ACCESS EXCLUSIVE lock even when the owner does not change (measured), so on an
    // install where the administrator and the runtime role are the same account, an unfiltered loop
    // would freeze the checkpointer once per deploy for no change at all.
    //
    // NOTE: and `pg_has_role(..., 'USAGE')` is the third, because the administrator surviving its
    // own transfer is a condition rather than a given. `ALTER TABLE ... OWNER TO` needs only
    // MEMBERSHIP in the new owner, while KEEPING access to the table afterwards needs to INHERIT
    // it — and the two come apart on a membership granted `SET TRUE, INHERIT FALSE`, which the
    // grant above cannot repair without ADMIN on the role (measured: the transfer succeeds and the
    // administrator is left with `permission denied` on the table it just handed over). 'USAGE' is
    // the mode that means inherited, and it is the same one the boot guard asks with.
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
               AND pg_get_userbyid(c.relowner) = current_user
               AND pg_get_userbyid(c.relowner) <> v_role
               AND pg_has_role(current_user, v_role, 'USAGE')
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
      // NOTE: a warning and not a refusal, and the wording is careful because the risk is not
      // only in the future. setup() applies the checkpointer's migrations from the last version
      // recorded in checkpoint_migrations, and the current last one is an ALTER TABLE — so a
      // migration can be pending RIGHT NOW (a setup() interrupted between its DDL and the INSERT
      // that records it), not just after a package upgrade. What this script cannot do is tell
      // the two apart: that would mean reading a version number against a migration list owned by
      // a third-party package, which is exactly the kind of coupling that rots silently. Refusing
      // instead would crash-loop every install of this shape that boots fine today, which is the
      // failure this whole script's rewrite is about. So it says what it knows and names the fix.
      console.warn(
        `db-bootstrap: runtime role "${role}" can use the langgraph tables but does not own ` +
          `them (owned by ${foreignOwners}). Any checkpointer migration that ALTERs them fails at ` +
          "boot, including one already pending from an interrupted setup. Run as their owner or " +
          `as a superuser: ALTER TABLE langgraph.<table> OWNER TO "${role}";`,
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

    // Re-read rather than reuse the row above: the demotion may have just changed the answer, and
    // on a role that WAS a superuser the answer above is meaningless (see the function's header).
    // NOTE: `pg_has_role(..., 'USAGE')` rather than `pg_auth_members.inherit_option`, which says the
    // same thing and only since PostgreSQL 16 — this script has to run on older servers, where that
    // column does not exist and the query would fail on every boot. The function is the portable
    // spelling of the question (pre-16 it reads the member's `rolinherit`), and it is the one the
    // other two privilege checks here already use. The only 16-only syntax left in this file is the
    // `WITH SET / INHERIT` grant, which is behind the version gate; a test pins that.
    const privileged = (
      await client.query<{
        reaches: string | null;
        revokable: string | null;
      }>(
        `SELECT
           (SELECT string_agg(DISTINCT quote_ident(m.rolname), ', ')
              FROM pg_roles r
              JOIN pg_roles m ON (m.rolsuper OR m.rolbypassrls) AND m.oid <> r.oid
             WHERE r.rolname = $1 AND pg_has_role(r.oid, m.oid, 'USAGE')) AS reaches,
           (SELECT string_agg(DISTINCT quote_ident(d.rolname), ', ')
              FROM pg_auth_members am
              JOIN pg_roles r ON r.oid = am.member
              JOIN pg_roles d ON d.oid = am.roleid
             WHERE r.rolname = $1
               AND pg_has_role(r.oid, d.oid, 'USAGE')
               AND EXISTS (SELECT 1 FROM pg_roles p
                            WHERE (p.rolsuper OR p.rolbypassrls)
                              AND pg_has_role(d.oid, p.oid, 'USAGE'))) AS revokable`,
        [role],
      )
    ).rows[0];
    assertRuntimeRoleIsUnprivileged(
      role,
      privileged?.reaches ?? null,
      privileged?.revokable ?? null,
    );

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
    //
    // NOTE: what repairs `SET ROLE` is the explicit GRANT, not the `WITH SET TRUE` on it —
    // measured, a bare `GRANT a TO b` already lands with set_option true. Only the membership
    // CREATEROLE confers implicitly carries set_option false, which is why an administrator that
    // created the role still cannot SET ROLE to it. The clause is spelled out because a default
    // that is silently relied upon is a default that changes.
    //
    // NOTE: `INHERIT TRUE` is not decoration, and it is the half that is NOT redundant. An explicit
    // GRANT defaults INHERIT to the grantee's own `rolinherit`, so on a NOINHERIT administrator the
    // membership lands inheriting nothing. That matters because this administrator may itself be
    // the outgoing DATABASE_URL role — a brownfield install pointing both URLs at the privileged
    // account is the shape #195 asks operators to correct — and the schema step below adopts its
    // tables. Inheriting the incoming role is what keeps the container still serving on it alive
    // through that transfer; without this clause it loses the checkpointer mid-deploy (measured).
    if (s.server_version_num >= 160000) {
      try {
        await client.query(
          `GRANT ${ident} TO CURRENT_USER WITH SET TRUE, INHERIT TRUE`,
        );
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
