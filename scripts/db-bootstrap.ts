#!/usr/bin/env bun
import { Client } from "pg";
import {
  FLEET_ROLE_EXPR,
  FLEET_ROLE_RETAINED_MEMBER_ENV,
  retainedFleetMembers,
} from "@/lib/tenancy/fleet-role";
import {
  OUTLIVES_SET_ROLE,
  privilegedReachSql,
} from "@/lib/tenancy/privileged-reach";

// Idempotent DB provisioning, run as the migration role before `prisma migrate deploy` on every
// boot (docs/deploy.md, "Deterministic provisioning"). It provisions the runtime role named in
// DATABASE_URL as NON-superuser/NON-bypassrls, without `initdb.d`, which managed Postgres never runs.
// The migration role may not be a real superuser, so the script reads the catalog: a statement
// whose failure breaks that guarantee is FATAL, one that only carries a convenience is BEST-EFFORT
// with a warning, because a non-zero exit on boot is what leaves an install crash-looping.

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
  // NOTE: the role name is interpolated into DDL as a double-quoted identifier, so anything that
  // could break out of the quotes is rejected.
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

// What the runtime role needs, from what the catalog says it already is. Since PostgreSQL 16 an
// ALTER ROLE naming any privilege option (even NOSUPERUSER) needs a real superuser, while CREATE
// ROLE and ALTER ... PASSWORD do not. So the attributes are asserted at creation, where they are
// free, and re-asserted only when they are actually wrong.
export function planRoleProvisioning(
  role: RuntimeRoleState,
): RoleProvisioningPlan {
  if (!role.exists) return "create";
  if (role.isSuperuser || role.bypassesRls) return "demote";
  return "syncPassword";
}

// Post-condition: a role with no privileged attribute can still reach SUPERUSER or BYPASSRLS
// through a membership, and the server's boot guard refuses it. Asked AFTER the DDL (for a
// superuser `pg_has_role` is true of every role, so asked before it would swallow the demotion) and
// before the runtime role is granted to CURRENT_USER. Two names because the membership may be
// transitive: `reaches` is the privileged role, `revokable` the DIRECT edge, since REVOKE on an
// indirect one is a silent no-op.
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

// What the fleet role may not be. The runtime role SETs ROLE into it, and a pre-existing role with
// the derived name is kept rather than recreated, so a privileged one is REFUSED, not warned about:
// a membership from an earlier boot would already expose it on every request. Every attribute that
// outlives a SET ROLE counts, not only the two that defeat RLS; LOGIN because nothing should
// connect as this role.
export const FLEET_ROLE_FORBIDDEN_ATTRIBUTES = [
  ["rolsuper", "SUPERUSER"],
  ["rolbypassrls", "BYPASSRLS"],
  ["rolcanlogin", "LOGIN"],
  ["rolcreatedb", "CREATEDB"],
  ["rolcreaterole", "CREATEROLE"],
  ["rolreplication", "REPLICATION"],
] as const;

export function assertFleetRoleIsUnprivileged(
  fleetRole: string,
  state: Partial<
    Record<(typeof FLEET_ROLE_FORBIDDEN_ATTRIBUTES)[number][0], boolean>
  > & {
    reaches: string | null;
  },
) {
  const reasons: string[] = [];
  for (const [field, word] of FLEET_ROLE_FORBIDDEN_ATTRIBUTES) {
    if (state[field]) reasons.push(word);
  }
  if (state.reaches !== null) {
    reasons.push(`can become a privileged role (${state.reaches})`);
  }
  if (reasons.length === 0) return;
  throw new Error(
    `the cross-tenant role "${fleetRole}" already exists and is privileged ` +
      `(${reasons.join(", ")}). The runtime role SETs ROLE into it, so granting that would make ` +
      "RLS a no-op for every request. This is a role this installation did not create — a database " +
      "dropped and recreated leaves one behind. Drop it (as its owner or a superuser) and let this " +
      `script create it: DROP OWNED BY "${fleetRole}"; DROP ROLE "${fleetRole}";`,
  );
}

// The statement that repairs the membership, behind the version gate so an operator is never
// printed a 16-only spelling their server cannot parse. On 15 and older the member's `rolinherit`
// is the whole control.
export function fleetMembershipRepair(
  appRole: string,
  fleetRole: string,
  serverVersionNum: number,
): string {
  let statement = `ALTER ROLE "${appRole}" NOINHERIT; GRANT "${fleetRole}" TO "${appRole}";`;
  if (serverVersionNum >= 160000) {
    statement = `GRANT "${fleetRole}" TO "${appRole}" WITH INHERIT FALSE, SET TRUE;`;
  }
  // NOTE: roles are cluster-wide, so the fleet role may belong to another installation's
  // administrator, and a CREATEROLE role holds no ADMIN on a role it did not create: who runs the
  // statement is part of the instruction.
  return (
    `${statement} (run it as a superuser, or as the role that created "${fleetRole}"; ` +
    `a CREATEROLE administrator holds no ADMIN on a role it did not create, and can be given one ` +
    `with: GRANT "${fleetRole}" TO <administrator> WITH ADMIN OPTION;)`
  );
}

// Both halves of the runtime role's fleet membership REFUSE the boot (docs/deploy.md, "Fleet role
// membership"): USAGE true makes the fleet policy apply passively, reading every tenant on a scoped
// request; SET false breaks `asSuperAdmin`, which API-key verification, Chatwoot route resolution,
// the scheduler claim and first-admin creation all need. Asked of `pg_has_role`, the effect,
// because on 16+ the grant's own `inherit_option` overrides the member's `rolinherit`.
export function assertFleetMembership(
  appRole: string,
  fleetRole: string,
  state: { can_set_role: boolean; usage: boolean },
  repair: string,
): void {
  if (state.usage) {
    throw new Error(
      `runtime role "${appRole}" INHERITS "${fleetRole}", which makes the cross-tenant policy ` +
        "apply to it passively — every tenant's rows would be readable on an ordinary scoped " +
        `request, with no error to see. Repair with: ${repair}`,
    );
  }
  if (!state.can_set_role) {
    throw new Error(
      `runtime role "${appRole}" cannot SET ROLE to "${fleetRole}". Every cross-tenant call fails ` +
        "with `permission denied to set role`, and that is not only fleet administration: it is " +
        "how an API key is verified, how a Chatwoot route is resolved, how the scheduler claims " +
        `work, and how the first admin is created. Repair with: ${repair}`,
    );
  }
}

// The DDL that carries the password, filled by Postgres from session GUCs so the password is never
// spliced into SQL we assemble or log. The NO* on `create` are CREATE ROLE's defaults anyway; they
// state what the role may be, next to `demote` where the same words are the point.
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

// Attributes worth removing but not worth failing over: neither defeats RLS, so the boot guard
// never looks at them and this script is the only thing that takes them away. One ALTER per row,
// each with its own catch and outside ROLE_DDL: an administrator may only set an attribute it holds
// itself, so a combined statement would lose the half it can do to the half it cannot.
const ELEVATED_ATTRIBUTES = [
  ["hasCreateDb", "NOCREATEDB"],
  ["hasCreateRole", "NOCREATEROLE"],
] as const satisfies readonly (readonly [keyof RuntimeRoleState, string])[];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A database restored or cloned under another name keeps policies and grants naming the source's
// fleet role, whose cluster-wide members can then read all of it (docs/deploy.md). `db-guard.ts`
// only stops our own process, so the privileges are revoked here. The foreign role's MEMBERSHIP is
// left alone, since revoking it would break the source installation; only names with the
// derivation's prefix are candidates, never an operator role.
async function revokeForeignFleetAccess(client: Client, fleetRole: string) {
  const foreignRoles = async () =>
    (
      await client.query<{
        rolname: string;
        quoted: string;
        privileges: number;
      }>(
        `SELECT DISTINCT r.rolname, quote_ident(r.rolname) AS quoted,
                (SELECT count(*)::int
                   FROM pg_class c2
                   JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                   CROSS JOIN LATERAL aclexplode(c2.relacl) a
                  WHERE n2.nspname = 'public' AND a.grantee = r.oid)
              + (SELECT count(*)::int
                   FROM pg_namespace n3
                   CROSS JOIN LATERAL aclexplode(n3.nspacl) a
                  WHERE n3.nspname = 'public' AND a.grantee = r.oid) AS privileges
           FROM pg_policy p
           JOIN pg_class c ON c.oid = p.polrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           CROSS JOIN LATERAL unnest(p.polroles) AS pr(oid)
           JOIN pg_roles r ON r.oid = pr.oid
          WHERE n.nspname = 'public' AND p.polname = 'fleet_super_admin'
            AND r.rolname <> $1 AND r.rolname LIKE 'fazerai\\_fleet\\_%'`,
        [fleetRole],
      )
    ).rows;

  const foreign = await foreignRoles();
  if (foreign.length === 0) return;

  for (const { rolname, quoted } of foreign) {
    // NOTE: spelled out in full so `tests/scripts/db-bootstrap-twins.test.ts` can match them against
    // the SQL twin by text.
    for (const what of [
      "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I",
      "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I",
      "REVOKE ALL ON SCHEMA public FROM %I",
    ]) {
      try {
        // Quoted by the server, because the name comes from the catalog and a syntax error
        // caught here would read as a permission problem while the access stayed in place.
        const stmt = (
          await client.query<{ stmt: string }>(
            `SELECT format('${what}', $1::text) AS stmt`,
            [rolname],
          )
        ).rows[0]?.stmt as string;
        await client.query(stmt);
      } catch (err) {
        console.warn(
          `db-bootstrap: could not run "${what}" for ${quoted} (${message(err)})`,
        );
      }
    }
  }

  // Re-read, because a REVOKE by anyone but the GRANTOR removes nothing and reports success.
  // Reported, not thrown: in the SQL twin a refusal rolls the REVOKEs back with it, and
  // `src/lib/db-guard.ts` already refuses to serve on this condition.
  const left = (await foreignRoles()).filter((r) => r.privileges > 0);
  const named = foreign.map((r) => r.quoted).join(", ");
  console.warn(
    `db-bootstrap: this database carries fleet_super_admin policies naming ${named}, and not ` +
      `"${fleetRole}" — the shape of a database restored or cloned under a different name, whose ` +
      "cross-tenant policies still point at the source installation's role, which could read every " +
      "tenant here through them.",
  );
  console.warn(
    left.length > 0
      ? `db-bootstrap: ${left
          .map((r) => r.quoted)
          .join(
            ", ",
          )} still hold privileges here, which this administrator is not the grantor ` +
          "of; clear them as their grantor or as a superuser."
      : "db-bootstrap: revoked their privileges in this database. Their cluster-wide membership is " +
          "deliberately untouched — it belongs to a source installation still running on its own " +
          "database. The policies still name them, and re-running the migration is NOT the repair: " +
          "it is recorded as applied in this copy, and `migrate resolve --rolled-back` answers " +
          "`P3012 … not in a failed state` (measured). The boot refusal that follows prints the " +
          "statement that rewrites them.",
  );
}

// Provisions the role the cross-tenant path becomes (see `@/lib/tenancy/fleet-role`). Every
// statement is one a CREATEROLE administrator may run. The role holds no attribute: what lets it
// across tenants is the `fleet_super_admin` policy, so a table with RLS but no such policy fails
// closed.
async function provisionFleetRole(
  client: Client,
  role: string,
  ident: string,
  serverVersionNum: number,
) {
  // The expression, not the `fazerai_fleet_role()` function: on a first install this runs
  // before `migrate deploy` creates it. `tests/lib/rls-policy-shape.test.ts` proves the two agree.
  const fleetRole = (
    await client.query<{ role: string }>(`SELECT ${FLEET_ROLE_EXPR} AS role`)
  ).rows[0]?.role as string;
  // Safe to interpolate only because the derivation normalises the name to `[a-zA-Z0-9_]`,
  // so it cannot carry a quote.
  const fleet = `"${fleetRole}"`;
  await revokeForeignFleetAccess(client, fleetRole);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${FLEET_ROLE_EXPR}) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
                       ${FLEET_ROLE_EXPR});
      END IF;
    END $$;
  `);

  // Asked after the create-if-absent, of whatever role is actually there: one this script
  // found rather than created is the case that matters.
  const fleetState = (
    await client.query<Record<string, boolean> & { reaches: string | null }>(
      `SELECT r.rolsuper, r.rolbypassrls, r.rolcanlogin,
              r.rolcreatedb, r.rolcreaterole, r.rolreplication,
              ${privilegedReachSql("r.oid", undefined, OUTLIVES_SET_ROLE)} AS reaches
         FROM pg_roles r WHERE r.rolname = $1`,
      [fleetRole],
    )
  ).rows[0];
  assertFleetRoleIsUnprivileged(fleetRole, fleetState ?? { reaches: null });

  // NOTE: EXECUTE on the resolver for the runtime role, which `asSuperAdmin` calls on every
  // cross-tenant statement; it matters on an install that revoked PUBLIC's default EXECUTE. The
  // DEFAULT privilege covers the first boot, where the function is created by `migrate deploy`
  // after this runs, as this same role, so the direct grant below is skipped.
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${ident}`,
  );

  const fnPresent = (
    await client.query<{ present: boolean }>(
      "SELECT to_regprocedure('public.fazerai_fleet_role()') IS NOT NULL AS present",
    )
  ).rows[0]?.present;
  if (fnPresent) {
    try {
      await client.query(
        `GRANT EXECUTE ON FUNCTION public.fazerai_fleet_role() TO ${ident}`,
      );
    } catch (err) {
      console.warn(
        `db-bootstrap: could not grant EXECUTE on public.fazerai_fleet_role() to "${role}" ` +
          `(${message(err)}); every cross-tenant call would fail on it`,
      );
    }
  }

  for (const grant of [
    `GRANT USAGE ON SCHEMA public TO ${fleet}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${fleet}`,
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${fleet}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${fleet}`,
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${fleet}`,
  ]) {
    await client.query(grant);
  }

  // Membership is RECONCILED, not only added to: a database dropped and recreated under the
  // same name derives the same fleet role, and the previous installation's memberships survive it.
  // The expected members are this runtime role and the administrator (for data migrations); any
  // other is revoked and named. `quote_ident` so a printed statement is one an operator can paste.
  const membersOf = async () =>
    (
      await client.query<{
        rolname: string;
        quoted: string;
        grantor: string;
        serving: boolean;
      }>(
        `SELECT DISTINCT r.rolname, quote_ident(r.rolname) AS quoted,
                quote_ident(g.rolname) AS grantor,
                EXISTS (SELECT 1 FROM pg_stat_activity a
                         WHERE a.datname = current_database() AND a.usename = r.rolname) AS serving
           FROM pg_auth_members am
           JOIN pg_roles r ON r.oid = am.member
           JOIN pg_roles d ON d.oid = am.roleid
           JOIN pg_roles g ON g.oid = am.grantor
          WHERE d.rolname = $1 AND r.rolname <> $2 AND r.rolname <> current_user`,
        [fleetRole, role],
      )
    ).rows;
  const quotedFleet = (
    await client.query<{ q: string }>("SELECT quote_ident($1::text) AS q", [
      fleetRole,
    ])
  ).rows[0]?.q as string;

  // A stray is kept only when the operator DECLARED it and it is still serving: an open session
  // cannot tell a rotation's outgoing role from a stale installation's (see
  // `FLEET_ROLE_RETAINED_MEMBER_ENV`).
  const retained = retainedFleetMembers(
    process.env[FLEET_ROLE_RETAINED_MEMBER_ENV],
  );
  const spared = (r: { rolname: string; serving: boolean }) =>
    r.serving && retained.has(r.rolname);
  const all = await membersOf();
  for (const { quoted } of all.filter(spared)) {
    console.warn(
      `db-bootstrap: ${quoted} holds ${quotedFleet} and was declared in ` +
        `${FLEET_ROLE_RETAINED_MEMBER_ENV}, so its access is kept while it still has a session ` +
        "here. The next boot after it exits clears it.",
    );
  }
  // NOTE: named separately, since it explains a rotation that just lost its cross-tenant path.
  for (const { quoted } of all.filter((r) => r.serving && !spared(r))) {
    console.warn(
      `db-bootstrap: ${quoted} holds ${quotedFleet} and has an open session here, but nothing ` +
        `declared it, so it is being revoked. If that is a rotation's outgoing role, set ` +
        `${FLEET_ROLE_RETAINED_MEMBER_ENV} to it for the length of the transfer.`,
    );
  }
  const before = new Set(all.filter((r) => !spared(r)).map((r) => r.rolname));
  for (const rolname of before) {
    try {
      // Quoted by the server, since a catalog name may contain a double quote and the catch
      // would read the syntax error as a permission problem. CASCADE is required: a previous
      // administrator is a stray whose onward grant to the runtime role depends on it (`dependent
      // privileges exist`), and the GRANTs below re-make that grant.
      const revoke = (
        await client.query<{ stmt: string }>(
          "SELECT format('REVOKE %I FROM %I CASCADE', $1::text, $2::text) AS stmt",
          [fleetRole, rolname],
        )
      ).rows[0]?.stmt as string;
      await client.query(revoke);
    } catch (err) {
      console.warn(
        `db-bootstrap: could not revoke "${rolname}" from "${fleetRole}" (${message(err)})`,
      );
    }
  }

  // Re-read, because a REVOKE by someone who is not the GRANTOR removes nothing and reports
  // success; since PostgreSQL 16 a membership is one row per grantor.
  const after = (await membersOf()).filter((r) => !spared(r));
  const remaining = new Set(after.map((r) => r.rolname));
  for (const rolname of before) {
    if (!remaining.has(rolname)) {
      console.warn(
        `db-bootstrap: revoked "${rolname}" from "${fleetRole}" — a membership this database did ` +
          "not grant, which could read every tenant here through the cross-tenant policy",
      );
    }
  }
  // NOTE: refuses, like the SQL twin: a surviving member can SET ROLE into the fleet role and read
  // every tenant, an active breach rather than a degraded feature.
  if (after.length > 0) {
    // By name, not by row, since a role granted by two grantors has two rows.
    const remaining = [...new Set(after.map((r) => r.quoted))];
    const names = remaining.join(", ");
    const statements = remaining
      .map((q) => `REVOKE ${quotedFleet} FROM ${q} CASCADE;`)
      .join(" ");
    const grantors = [...new Set(after.map((r) => r.grantor))].join(", ");
    throw new Error(
      `${names} ${remaining.length === 1 ? "is" : "are"} still a member of ${quotedFleet} and can ` +
        "read every tenant in this database through the cross-tenant policy. This is what a " +
        "database dropped and recreated under the same name leaves behind, and a REVOKE by anyone " +
        `who is not the GRANTOR removes nothing while reporting success. Clear it as ${grantors} ` +
        `or as a superuser: ${statements}`,
    );
  }

  // Both grants are best-effort: the fleet role may be one this administrator did not create
  // and holds no ADMIN over, which leaves tenant traffic working. The membership check below turns
  // the failure into a message naming the repair.
  const repair = fleetMembershipRepair(role, fleetRole, serverVersionNum);
  try {
    if (serverVersionNum >= 160000) {
      await client.query(
        `GRANT ${fleet} TO ${ident} WITH INHERIT FALSE, SET TRUE`,
      );
    } else {
      await client.query(`ALTER ROLE ${ident} NOINHERIT`);
      await client.query(`GRANT ${fleet} TO ${ident}`);
    }
  } catch (err) {
    console.warn(
      `db-bootstrap: could not grant "${fleetRole}" to runtime role "${role}" (${message(err)})`,
    );
  }

  // NOTE: the administrator gets the fleet role too, so a non-superuser owner on managed Postgres
  // can SET ROLE for cross-tenant work. INHERIT FALSE, because an inheriting one would pass the fleet
  // policy passively and hide a missing bypass until a non-superuser install. On 15 and older the
  // grant is bare and CURRENT_USER is not made NOINHERIT: that would reach every other membership
  // the administrator holds.
  try {
    if (serverVersionNum >= 160000) {
      await client.query(
        `GRANT ${fleet} TO CURRENT_USER WITH INHERIT FALSE, SET TRUE`,
      );
    } else {
      await client.query(`GRANT ${fleet} TO CURRENT_USER`);
    }
  } catch (err) {
    console.warn(
      `db-bootstrap: could not grant "${fleetRole}" to the administrative role ` +
        `(${message(err)}); a future DATA migration would fail on SET ROLE`,
    );
  }

  // On 16+ `MEMBER` ignores the membership's own SET option, so a grant with SET FALSE reads as
  // healthy; `SET` is asked there. Before 16 the privilege type does not exist and every membership
  // allows SET ROLE, so `MEMBER` is the right question.
  let capabilityQuery = `SELECT pg_has_role($1, $2, 'MEMBER') AS can_set_role,
              pg_has_role($1, $2, 'USAGE')  AS usage`;
  if (serverVersionNum >= 160000) {
    capabilityQuery = `SELECT pg_has_role($1, $2, 'SET')   AS can_set_role,
              pg_has_role($1, $2, 'USAGE') AS usage`;
  }
  const membership = (
    await client.query<{ can_set_role: boolean; usage: boolean }>(
      capabilityQuery,
      [role, fleetRole],
    )
  ).rows[0];
  assertFleetMembership(
    role,
    fleetRole,
    membership ?? { can_set_role: false, usage: false },
    repair,
  );
  return fleetRole;
}

// Makes the LangGraph checkpointer schema usable by the runtime role (docs/deploy.md, "Checkpointer
// schema"). An ABSENT schema is a convenience, best-effort, since `setup()` creates it at boot as
// the runtime role anyway. A PRESENT one (a rotated runtime role) is reconciled and refuses on
// failure, because nothing downstream repairs it; whoever owns it, since schema and table owners
// move independently and a rollback would otherwise skip the tables it no longer owns.
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
    // NOTE: read back rather than assumed: `IF NOT EXISTS` reports success for a schema someone else
    // just created, and a present schema goes through the reconciliation below whoever owns it.
    schemaOwner = await readOwner();
  }

  if (schemaOwner !== undefined) {
    // Grants on the schema AND its tables (a schema grant does not reach the tables), and
    // FIRST: a table's new owner must hold CREATE on the schema, or the transfer loop rolls back.
    // Only tables are re-owned, and only those the administrator itself owns: OWNER TO strips the
    // previous owner at once, and a serving container on the old runtime role must keep them.
    // `<> v_role` skips a no-op transfer (it still takes ACCESS EXCLUSIVE); the 'USAGE' check skips
    // one the administrator could not keep access through (a SET TRUE, INHERIT FALSE membership).
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

    // The outcome is decided by a privilege check, not by the absence of an error above: the
    // runtime role may already hold what it needs from someone else. One has_table_privilege() per
    // privilege, because a comma-separated list is OR and would pass a read-only grant.
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
    // NULL when every table is the runtime role's. A string rather than an array, because the
    // pg driver returns a scalar-subquery array as its Postgres literal.
    const foreignOwners = usable?.foreign_owners;
    if (foreignOwners) {
      // NOTE: a warning, not a refusal: refusing would crash-loop every install of this shape that
      // boots fine today, and telling whether an owner-only checkpointer migration is pending would
      // couple this script to a third-party package's migration list.
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
// privileged, and it answers to the password in DATABASE_URL. Only the first two fail the boot.
async function provisionRuntimeRole(
  client: Client,
  role: string,
  ident: string,
  runtimeRole: RuntimeRoleState,
  plan: RoleProvisioningPlan,
) {
  if (plan === "demote") {
    // NOTE: fatal, since the server refuses a privileged role anyway. Only a real superuser can
    // demote it, so the error names the statement one has to run.
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
    // NOTE: best-effort: rewriting the password needs ADMIN over the role, and a stale password
    // shows up as the runtime's own authentication error seconds later.
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
    // NOTE: superuser-only to install, and a permitted no-op once present.
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    await client.query("SELECT set_config('fazerai.app_role', $1, false)", [
      role,
    ]);
    await client.query("SELECT set_config('fazerai.app_password', $1, false)", [
      password,
    ]);

    // `admin_superuser` and `server_version_num` decide nothing; they name the mode in the log.
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

    // Re-read, since the demotion may have changed the answer. `pg_has_role(..., 'USAGE')`
    // rather than `pg_auth_members.inherit_option`, a PostgreSQL 16 column that would fail every
    // boot on older servers.
    const privileged = (
      await client.query<{
        reaches: string | null;
        revokable: string | null;
      }>(
        `SELECT
           (SELECT ${privilegedReachSql("r.oid", FLEET_ROLE_EXPR)}
              FROM pg_roles r WHERE r.rolname = $1) AS reaches,
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

    // NOTE: CREATE so PostgresSaver.setup() can run `CREATE SCHEMA IF NOT EXISTS langgraph`, whose
    // privilege is checked even when the schema already exists.
    await client.query(`
      DO $$
      BEGIN
        EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO %I',
                       current_database(), current_setting('fazerai.app_role'));
      END $$;
    `);

    // NOTE: ALTER DEFAULT PRIVILEGES is scoped to the role running it, which is the one that runs
    // migrations, so future migration tables get these grants.
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

    // NOTE: on 16+ `CREATE SCHEMA ... AUTHORIZATION` needs SET ROLE to the owner, and the implicit
    // membership CREATEROLE confers carries SET FALSE; an explicit grant fixes it (best-effort, the
    // CREATE SCHEMA reports the real problem). `INHERIT TRUE` is not redundant: it defaults to the
    // grantee's `rolinherit`, and an administrator that is also the outgoing runtime role must keep
    // the checkpointer tables the schema step hands over.
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

    const fleetRoleName = await provisionFleetRole(
      client,
      role,
      ident,
      s.server_version_num,
    );

    await provisionCheckpointerSchema(client, role, ident);

    console.log(
      `db-bootstrap: provisioned runtime role "${role}" + fleet role "${fleetRoleName}" ` +
        `(idempotent; ${plan}, ` +
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
