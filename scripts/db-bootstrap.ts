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

// The fleet role is a SET ROLE target for the runtime role, so what it may BE is the same question
// `assertRuntimeRoleIsUnprivileged` asks of the runtime role itself — and it has to be asked of a
// role that already EXISTS, because this script only creates one when it is absent. A stale or
// hand-made role carrying the derived name can be SUPERUSER, BYPASSRLS or LOGIN, and granting the
// runtime role a path into it hands away exactly what this design refuses to hand away.
//
// It REFUSES rather than warning, unlike the missing-membership case beside it, because the loss
// here can already be silent: if the runtime role is a member from an earlier boot (the reconcile
// keeps that membership by design), every request can reach a privileged role right now, with RLS a
// no-op and nothing in a log. LOGIN counts for the same reason it is refused on the runtime role —
// a role nothing should connect as should not be connectable.
// The attribute list is every one `CREATE ROLE` can carry that outlives a SET ROLE, not just the two
// that defeat RLS: the runtime role ACQUIRES all of them the moment it enters this role, so
// CREATEDB, CREATEROLE and REPLICATION are cluster-level privileges handed to every request path.
// LOGIN counts for its own reason — a role nothing should connect as should not be connectable.
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

// The statement that repairs the membership, which is not the same statement on every server.
//
// It lives in its own function because the 16-only spelling has to sit behind a version gate, and a
// message built inline would put it outside one — printing an operator a statement their server
// cannot parse. On 16+ the GRANT's own option is the control; on 15 and older the option does not
// exist and the member's `rolinherit` is the whole control.
export function fleetMembershipRepair(
  appRole: string,
  fleetRole: string,
  serverVersionNum: number,
): string {
  let statement = `ALTER ROLE "${appRole}" NOINHERIT; GRANT "${fleetRole}" TO "${appRole}";`;
  if (serverVersionNum >= 160000) {
    statement = `GRANT "${fleetRole}" TO "${appRole}" WITH INHERIT FALSE, SET TRUE;`;
  }
  // WHO runs it is half the instruction, and it is the half an operator hits second. Roles are
  // CLUSTER-wide while a database is not, so on a shared server the fleet role may have been
  // created by another installation's administrator — and a CREATEROLE role holds no ADMIN on a
  // role it did not create, so this same statement answers `permission denied to grant role` for
  // exactly the person the message was written for (measured).
  return (
    `${statement} (run it as a superuser, or as the role that created "${fleetRole}"; ` +
    `a CREATEROLE administrator holds no ADMIN on a role it did not create, and can be given one ` +
    `with: GRANT "${fleetRole}" TO <administrator> WITH ADMIN OPTION;)`
  );
}

// The fleet role is reached by SET ROLE, and the membership that allows that is the same catalog
// entry that can make its policy apply PASSIVELY. Both halves are asked, and neither is inferable
// from the DDL that was issued — but they are NOT the same severity, and treating them alike is
// wrong in both directions:
//
//   USAGE true  -> the `fleet_super_admin` policy (`USING (true)`) applies to the RUNTIME role as
//                  well, and it reads every tenant's rows on an ordinary scoped request. No error,
//                  no plan difference, nothing in a log: measured on this schema as 400 rows across
//                  2 tenants where the fence expects 200 across 1. Silent isolation loss, so this
//                  REFUSES — serving is the harm.
//   SET false   -> `asSuperAdmin` cannot switch role. This REFUSES too, and the first version of
//                  this check warned instead, on the claim that only fleet administration breaks
//                  and tenant traffic is untouched. Counting the call sites says otherwise:
//                  `asSuperAdminOn` is how an API key is verified (the tenant is not known until
//                  the key row is read, so the lookup cannot be tenant-scoped), how a Chatwoot
//                  route is resolved, how the scheduler claims work, and how the very first admin
//                  is created. Without it the installation starts and then fails every
//                  authenticated request. Crash-looping with the repair on screen beats serving
//                  500s that name nothing.
//
// Asked of `pg_has_role` rather than of `pg_auth_members.inherit_option` for the reason the other
// checks in this file already give: the column is 16-only, the function is the portable spelling,
// and pre-16 it reads the member's `rolinherit` — which on those servers IS the whole control.
//
// And it has to be asked of the EFFECT, because on 16+ the two disagree. `ALTER ROLE <app>
// NOINHERIT` does not touch a membership that already exists: the grant keeps the `inherit_option`
// recorded when it was made. Measured, on 17.10, all three combinations:
//
//   rolinherit=false + inherit_option=true  -> USAGE true   (isolation gone)
//   rolinherit=false + inherit_option=false -> USAGE false
//   rolinherit=true  + inherit_option=false -> USAGE false
//
// So the grant is what has to carry `INHERIT FALSE`, and re-issuing it repairs an inherited
// membership in place (no REVOKE needed, also measured).
//
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

// A `fleet_super_admin` policy in this database naming SOMEONE ELSE's fleet role is what a restore
// or a clone under a different name leaves behind, and the refusal it used to get was not the whole
// answer.
//
// Measured: dump a database and restore it under a new name on the same cluster, and the copied
// policies still say `TO <source fleet role>` while the copied grants still give that role every
// table. Its members are unaffected, because a role membership is CLUSTER-wide and survives being
// copied around, so the source installation's runtime role connects to the restored database
// (PUBLIC holds CONNECT by default), enters that role, and reads all of it: 0 of 30 rows without
// the `SET ROLE`, 30 of 30 with it. `src/lib/db-guard.ts` refuses to serve such a database, and
// that refusal stops OUR process and nothing else — the door it names stays open behind it.
//
// So the privileges are taken away here, and the boot still refuses afterwards: the policies name a
// role this database did not derive, which only re-running the migration rewrites.
//
// What is deliberately NOT touched is the foreign role's cluster-wide MEMBERSHIP. That role belongs
// to a source installation which is, in the ordinary case, running perfectly well on its own
// database; revoking its membership from here would break it. Privileges are per-database and are
// exactly the right blast radius. Only names matching the derivation's own prefix are considered at
// all, so an operator role that happens to appear in a policy is never a candidate.
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
    // Spelled out rather than assembled from a shared tail, so the statement in this file is the
    // statement the SQL twin carries and `tests/scripts/db-bootstrap-twins.test.ts` can hold the two
    // to each other by text.
    for (const what of [
      "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I",
      "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I",
      "REVOKE ALL ON SCHEMA public FROM %I",
    ]) {
      try {
        // Built by the server for the same reason the membership revoke is: the name comes out of
        // the catalog, and a catch here reading a syntax error as a permission problem would leave
        // the access in place while reporting that it tried.
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

  // Re-read, because a REVOKE by anyone who is not the GRANTOR removes nothing and reports success
  // — the same measurement that made the membership reconcile re-read.
  //
  // Reported and NOT thrown, and the ordering is the whole reason. Refusing from here would undo
  // the repair: measured on the SQL twin, which raised from the same block, and the RAISE rolled the
  // REVOKEs back with it — the restored database read 30 of 30 again after the boot that had just
  // closed it. Refusing is `src/lib/db-guard.ts`'s job and it already does it unconditionally, ahead
  // of every override, on exactly this condition. So this provisions what it can and says what it
  // found; the process still will not serve.
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

// Provisions the role the cross-tenant path becomes (see `@/lib/tenancy/fleet-role` for why it is
// a role at all, and the migration `20260827000000_rls_split_tenant_and_fleet_policies` for the
// numbers). Idempotent, and every statement here is one an administrative CREATEROLE role may run.
//
// The role holds nothing: NOSUPERUSER, NOBYPASSRLS, NOLOGIN. What lets it across tenants is the
// `fleet_super_admin` policy the migration writes, not an attribute — so this is not a second
// privileged account to guard, and a table that gets RLS without that policy fails closed.
async function provisionFleetRole(
  client: Client,
  role: string,
  ident: string,
  serverVersionNum: number,
) {
  // The name is resolved BY the database, because it carries the database (see
  // `@/lib/tenancy/fleet-role` for the measurement that made it so). The expression rather than the
  // function this repository also ships: on a first install this runs before `migrate deploy`, so
  // the function does not exist yet. `tests/lib/rls-policy-shape.test.ts` proves the two agree.
  const fleetRole = (
    await client.query<{ role: string }>(`SELECT ${FLEET_ROLE_EXPR} AS role`)
  ).rows[0]?.role as string;
  // Interpolated rather than passed through `format('%I', …)` on every statement, and that is safe
  // BECAUSE the derivation normalises the readable half to `[a-zA-Z0-9_]`: the name cannot carry a
  // quote to escape. Before that normalisation it could, and did — a database name containing one
  // produced `syntax error at or near …` on the first grant (measured).
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

  // Asked AFTER the create-if-absent above, of whatever the role actually turned out to be: on the
  // branch that created it the answer is free, and on the branch that FOUND one it is the whole
  // point. Same shape, and the same reason, as the runtime role's own post-condition.
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

  // EXECUTE on the resolver, to the RUNTIME role: `asSuperAdmin` calls it on every cross-tenant
  // statement. Functions carry EXECUTE for PUBLIC by default, so this is a no-op on an ordinary
  // install and the whole difference on one that revoked that — measured, the call then dies with
  // `permission denied for function fazerai_fleet_role`. Best-effort and conditional: on a FIRST
  // boot this runs before `migrate deploy` has created the function, and the default covers that
  // boot until the next one makes it explicit.
  // The DEFAULT privilege first, and it is the half that covers the FIRST boot: on a hardened
  // install (one that revoked PUBLIC's default EXECUTE) the grant below is skipped because the
  // function does not exist yet, `migrate deploy` then creates it carrying nothing, and the SAME
  // boot fails in the runtime guard. ALTER DEFAULT PRIVILEGES is scoped to the role that runs it —
  // which is the role that will create the function one step later — so it reaches forward.
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

  // Membership on this role is RECONCILED, not merely added to, and a measurement is why. Roles are
  // cluster-wide while databases are not, so a database dropped and recreated under the same name
  // derives the same fleet role — and every membership the PREVIOUS installation granted survives
  // it. Measured: after the recreate, the old installation's runtime role read all 30 rows of the
  // new installation's data through the new policies, with nothing but a SET ROLE.
  //
  // The expected set is exactly two: this database's runtime role, and the administrator running
  // this (which needs it for data migrations). Anything else is a leftover, and it is REVOKED and
  // named — quietly leaving it is the shape the measurement above describes. Best-effort like the
  // grants below, and for the same reason: a member this administrator holds no ADMIN over cannot
  // be revoked here, and that is worth reporting rather than crash-looping on.
  // `quote_ident` on the way out, so the statement the message prints is one an operator can paste:
  // a role name may legally contain a double quote, and wrapping it here by hand produces text that
  // reads like SQL and is not. The same reason the REVOKE below is built by the server.
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

  // A stray is kept only where the operator DECLARED it and it is still serving — see
  // `FLEET_ROLE_RETAINED_MEMBER_ENV` in `@/lib/tenancy/fleet-role` for the measurement that took
  // this away from being inferred. In short: a stale installation's role, after its database was
  // dropped and recreated under the same name, presents the same open session as a rotation's
  // outgoing role, and `pg_stat_activity` holds nothing that separates them.
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
  // Named separately, because this is the line that explains a rotation that just lost its
  // cross-tenant path: the role IS serving, and the only reason it is being cut is that nothing
  // declared it.
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
      // Quoted by the SERVER, not here: `rolname` comes out of the catalog and a legal role name may
      // contain a double quote, which would make this statement invalid SQL — and the catch below
      // would read that as a permission problem while the member kept its path to every tenant.
      // Two round trips because `DO` takes no parameters: `format` builds it, then it is run.
      //
      // CASCADE, and it is required rather than defensive: a PREVIOUS ADMINISTRATOR is a stray here
      // (a rotated `MIGRATION_DATABASE_URL` leaves one), and the membership it granted onward to the
      // runtime role depends on it — Postgres answers `dependent privileges exist` without it. What
      // CASCADE drops with it is exactly that onward grant, which the two GRANTs below re-make a
      // moment later. Measured: without it, a rotation of the administrative account refuses to
      // boot on a leftover it could have cleared.
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

  // Re-read, because a REVOKE by someone who is not the GRANTOR removes nothing and does not say
  // so: measured, the statement returned success and the membership was still there. Since
  // PostgreSQL 16 a membership is one row PER GRANTOR, so the superuser's grant survives an
  // administrator's revoke of its own. What is left is reported with the statement that clears it.
  const after = (await membersOf()).filter((r) => !spared(r));
  const remaining = new Set(after.map((r) => r.rolname));
  // Said out loud, because a security reconcile that happens quietly reads as one that did not
  // happen. Each of these could read every tenant in this database a moment ago.
  for (const rolname of before) {
    if (!remaining.has(rolname)) {
      console.warn(
        `db-bootstrap: revoked "${rolname}" from "${fleetRole}" — a membership this database did ` +
          "not grant, which could read every tenant here through the cross-tenant policy",
      );
    }
  }
  // REFUSES, matching the SQL twin, and the asymmetry this replaces was a real hole: a membership
  // that survives the revoke can `SET ROLE` into this database's fleet role and read every tenant
  // in it (measured — the previous installation's runtime role read all 30 rows of the new one).
  // That is an active breach, not a degraded feature, so it is not something a boot warns past.
  if (after.length > 0) {
    // By NAME, not by row: since 16 a membership is one row per grantor, so a role granted twice
    // would otherwise be listed twice and told to revoke itself twice.
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

  // Two grants, and BOTH are best-effort. Roles are CLUSTER-wide objects while databases are not,
  // so even a per-database NAME can land on a role this administrator did not create — a database
  // dropped and recreated under the same name is the ordinary way — and a CREATEROLE role holds no
  // ADMIN over such a role: Postgres answers `permission denied to grant role` (measured). That is a
  // real install, not a broken one — everything tenant-scoped works — so it is reported and
  // survived, and the review below turns it into a message naming the exact repair.
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

  // The administrative role needs it too, and for the same reason the runtime role does: a DATA
  // migration over a FORCE-RLS table is bound by the tenant policy like anything else, so it opens
  // with `SET ROLE fazerai_fleet` (see docs/deploy.md and tests/prisma/migration-rls-bypass.test.ts).
  // On a self-hosted install this role is usually a real superuser and can SET ROLE regardless; on
  // managed Postgres it is the owner WITHOUT rolsuper, and there this grant is the whole difference
  // between a backfill that runs and one that matches zero rows and reports success.
  //
  // INHERIT FALSE here as well, and it is not symmetry for its own sake: an INHERITING migration
  // role would pass the fleet policy PASSIVELY, so a migration that forgot the bypass would work on
  // our machines and silently no-op on an install whose role is not a superuser — which is the exact
  // asymmetry the convention exists to remove.
  //
  // On 15 and older the options do not parse, and the grant still has to happen: skipping it there
  // would leave every future data migration on a non-superuser owner failing with
  // `permission denied to set role` — the exact contract docs/deploy.md states for that role. The
  // member's own `rolinherit` is the control on those servers, and CURRENT_USER is the
  // administrator: it is left alone rather than demoted, because taking INHERIT off an
  // administrative account reaches every other membership it holds. A superuser can SET ROLE
  // regardless, and a non-superuser owner that inherits this role gains nothing it did not already
  // have as the table owner under FORCE RLS — the fleet policy is what it is missing.
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

  // `MEMBER` is not the question, and answering it is how a broken install reads as healthy: since
  // PostgreSQL 16 a membership carries a SET option of its own, and `MEMBER` ignores it. Measured on
  // 17.10 with `WITH INHERIT FALSE, SET FALSE` — MEMBER true, USAGE false, and `SET ROLE` answering
  // `permission denied to set role`. That is the exact state the caught grant above leaves behind on
  // a shared cluster where an older grant already existed, so it is not hypothetical.
  //
  // `SET` is 16-only as a privilege type; on older servers the option does not exist either, every
  // membership allows SET ROLE, and `MEMBER` IS the right question there.
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
