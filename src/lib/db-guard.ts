import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { FLEET_ROLE_FN } from "@/lib/tenancy/fleet-role";
import { privilegedReachSql } from "@/lib/tenancy/privileged-reach";

// Boot-time fail-fast: the RUNTIME database connection must NOT be a superuser or a BYPASSRLS
// role, directly OR via role membership. Our whole tenant-isolation model rests on RLS, and RLS
// is silently a NO-OP for superuser/bypassrls roles — so a misconfigured runtime URL (e.g. the
// `postgres` superuser, or DATABASE_URL pointed at the migration role) would turn isolation off
// without any error. We refuse to serve in that case.
//
// FORCE ROW LEVEL SECURITY is set on every tenant table, so the table OWNER is also subject to
// policies — only superuser and bypassrls bypass.
//
// The audited cross-tenant path is a ROLE this same non-superuser role SETs into for the length of
// one transaction (`@/lib/tenancy/fleet-role`), never a bypassrls account — so the check above still
// covers the runtime. What it does NOT cover is the membership that makes SET ROLE possible: held
// with INHERIT, it applies the `fleet_super_admin` policy to the runtime role PASSIVELY, and every
// ordinary scoped request reads every tenant's rows. No error, no plan difference, nothing in a log.
// `scripts/db-bootstrap` provisions the grant with INHERIT FALSE and refuses otherwise; this is the
// same question asked at boot, of the connection actually being served, because a grant made by hand
// afterwards is invisible to provisioning.

// Every refusal this guard can make shares a base, and `src/index.ts` rethrows on the BASE rather
// than on each class. That is not tidiness: `FleetPolicyMismatchError` was added here and the boot
// path went on catching only `SuperuserRuntimeError`, so the process logged "DB unavailable?" and
// kept serving with every cross-tenant read answering zero rows. With the base, a refusal added
// later is fatal by construction instead of by someone remembering the call site.
export abstract class RuntimeIsolationError extends Error {}

export const FLEET_INHERITED_REASON = "inherits the fleet role";
// Not a "reason" on the privileged-role list, and the difference is what ALLOW_SUPERUSER_RUNTIME
// means. That flag says "I accept that RLS may be a no-op on this connection" — a local-dev
// statement about ISOLATION. Being unable to enter the fleet role is not that: `asSuperAdminOn` is
// how an API key is verified (the tenant is unknown until the key row is read), how a Chatwoot route
// is resolved, how the scheduler claims work and how the first admin is created, so the process
// would start and fail every authenticated request. No flag should wave that through.
export class FleetRoleUnreachableError extends RuntimeIsolationError {
  constructor(role: string, fleetRole: string, repair: string) {
    super(
      `runtime role "${role}" cannot SET ROLE to "${fleetRole}". Every cross-tenant call fails ` +
        "with `permission denied to set role`, and that is not only fleet administration: it is " +
        "how an API key is verified, how a Chatwoot route is resolved, how the scheduler claims " +
        `work, and how the first admin is created. Repair with: ${repair}`,
    );
    this.name = "FleetRoleUnreachableError";
  }
}

// The fleet role's name carries the database it belongs to, so a database RESTORED under a new name
// resolves a name its own dumped policies do not mention. Nothing errors: `SET ROLE` succeeds (the
// role exists and is granted), and every fleet read then matches no policy and returns ZERO ROWS.
// That is the silent shape, so it refuses rather than warns.
//
// The repair rewrites the POLICIES, not the role, and the obvious alternative is why. Renaming the
// role the policies name would work only if this database were the only one using it — roles are
// cluster-wide, so on a server that also runs the database the dump came from, that rename breaks
// the live one. And it cannot even be attempted in the order this fires: the documented boot order
// is bootstrap → migrate → serve, so by the time this runs, bootstrap has ALREADY created the
// resolved role and `ALTER ROLE … RENAME TO` fails on the name it would take. Rewriting the policies
// touches nothing outside this database, is idempotent, and is the same statement the split
// migration runs.
export class FleetPolicyMismatchError extends RuntimeIsolationError {
  constructor(resolved: string, offenders: string) {
    super(
      `the fleet policies in this database do not name "${resolved}" and only it, which is the ` +
        `role this database resolves to: ${offenders}. A policy naming any OTHER role gives that ` +
        "role every tenant here through `USING (true)`, with no `SET ROLE` needed. One naming " +
        "neither is the restore case: every cross-tenant read would match no policy and " +
        "answer zero rows, with no error. This is what a database restored under a different name " +
        "looks like — and refusing here is only half of it, because those policies grant the SOURCE " +
        "installation's role every tenant in this database and this refusal stops only this " +
        "process (measured: 30 of 30 rows, against 0 of 30 without the SET ROLE). " +
        "`scripts/db-bootstrap` revokes that role's privileges here on the boot before this one; " +
        "if it did not run, do that first. Then point the policies at the resolved role (safe to " +
        "re-run, and it touches only " +
        "this database):\n" +
        "DO $$ DECLARE t text; BEGIN\n" +
        "  FOR t IN SELECT c.relname FROM pg_policy p\n" +
        "             JOIN pg_class c ON c.oid = p.polrelid\n" +
        "             JOIN pg_namespace n ON n.oid = c.relnamespace\n" +
        "            WHERE n.nspname = 'public' AND p.polname = 'fleet_super_admin'\n" +
        "  LOOP\n" +
        "    EXECUTE format('DROP POLICY fleet_super_admin ON %I', t);\n" +
        "    EXECUTE format('CREATE POLICY fleet_super_admin ON %I TO %I USING (true) WITH CHECK (true)',\n" +
        "                   t, public.fazerai_fleet_role());\n" +
        "  END LOOP;\n" +
        "END $$;",
    );
    this.name = "FleetPolicyMismatchError";
  }
}

export class SuperuserRuntimeError extends RuntimeIsolationError {
  constructor(role: string, reasons: string[], repair?: string) {
    super(
      `Runtime DB role "${role}" is privileged (${reasons.join(", ")}); RLS would be a no-op. ` +
        (reasons.includes(FLEET_INHERITED_REASON) && repair
          ? `Repair the membership with: ${repair} ` +
            "(SET ROLE must stay possible; only the inheritance is the problem). "
          : "") +
        `Point DATABASE_URL at a NON-superuser, NON-bypassrls role (see scripts/db-bootstrap.sql). ` +
        `For local dev only, set ALLOW_SUPERUSER_RUNTIME=true.`,
    );
    this.name = "SuperuserRuntimeError";
  }
}

interface RoleRow {
  rolname: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  inherits_privileged: boolean;
  server_version_num: number;
}

interface FleetRow {
  fleet_role: string | null;
  inherits_fleet: boolean;
  can_set_role: boolean;
  misnamed_fleet_policies: string | null;
}

// The existence question, on its own connection round trip and with no reference to the function
// itself — which is the whole point: naming it in the same statement is what fails to parse.
//
// And EXECUTE, asked of the catalog rather than by calling it. Functions carry EXECUTE for PUBLIC by
// default, but an installation that revoked that leaves the runtime role unable to call this one:
// measured, `asSuperAdmin` then dies with `permission denied for function fazerai_fleet_role` and
// this guard threw a raw driver error that the boot path read as an outage and warned past.
async function fleetFunctionAccess(
  db: PrismaClient,
): Promise<{ present: boolean; executable: boolean }> {
  const rows = await db.$queryRawUnsafe<
    Array<{ present: boolean; executable: boolean }>
  >(
    `SELECT to_regprocedure('${FLEET_ROLE_FN}') IS NOT NULL AS present,
            COALESCE(has_function_privilege(current_user, '${FLEET_ROLE_FN}', 'EXECUTE'), false)
              AS executable
       WHERE to_regprocedure('${FLEET_ROLE_FN}') IS NOT NULL
     UNION ALL
     SELECT false, false WHERE to_regprocedure('${FLEET_ROLE_FN}') IS NULL`,
  );
  return rows[0] ?? { present: false, executable: false };
}

export async function assertRuntimeRoleIsNotSuperuser(
  db: PrismaClient = basePrisma,
  opts: { allow?: boolean } = {},
): Promise<void> {
  const allow =
    opts.allow ?? (config.env !== "production" && config.allowSuperuserRuntime);

  // current_user's own attributes + whether it can BECOME any superuser or bypassrls role. Not
  // whether it INHERITS one: see `privilegedReachSql`, and the measurement that a SET-only grant
  // reads as false there while the role runs `SET ROLE` into it and comes back a superuser.
  // Two queries rather than one, and the split is not stylistic: the privilege question is a plain
  // tagged template, while the fleet question needs the role NAME as a SQL expression (it carries
  // the database — see `@/lib/tenancy/fleet-role`) and therefore the Unsafe form. Keeping them
  // apart keeps the parameterised half parameterised. `FLEET_ROLE_FN` is a constant of this
  // repository and never carries input.
  const rows = await db.$queryRaw<RoleRow[]>`
    SELECT
      r.rolname,
      r.rolsuper,
      r.rolbypassrls,
      ${Prisma.raw(privilegedReachSql("r.oid"))} IS NOT NULL AS inherits_privileged,
      current_setting('server_version_num')::int AS server_version_num
    FROM pg_roles r
    WHERE r.rolname = current_user
  `;
  const row = rows[0];
  if (!row) throw new Error("could not resolve the current DB role");

  // TWO queries, because a CASE cannot protect a function call: PostgreSQL resolves the reference
  // while PARSING, so `CASE WHEN to_regprocedure(…) IS NULL THEN NULL ELSE public.fazerai_fleet_role()
  // END` raises `function … does not exist` on a database whose migrations have not run — measured.
  // The first query only asks whether it is there; the second is sent only if it is.
  //
  // `to_regrole` guards the name for the same shape of reason: a `::regrole` cast RAISES on a name
  // no role carries, and the resolved role legitimately does not exist yet before bootstrap.
  // Named once: three copies of this literal is how the type grew a field and one of them did not.
  const NO_FLEET: FleetRow = {
    fleet_role: null,
    inherits_fleet: false,
    can_set_role: false,
    misnamed_fleet_policies: null,
  };
  const fn = await fleetFunctionAccess(db);
  if (fn.present && !fn.executable) {
    // Named, never `CURRENT_USER`: the operator runs this as the function's owner or through the
    // migration connection, where CURRENT_USER is the administrator — so the statement would grant
    // EXECUTE to the wrong role and leave the boot exactly as broken.
    throw new FleetRoleUnreachableError(
      row.rolname,
      FLEET_ROLE_FN,
      `GRANT EXECUTE ON FUNCTION ${FLEET_ROLE_FN} TO "${row.rolname}";`,
    );
  }
  const fleet: FleetRow = fn.present
    ? ((
        await db.$queryRawUnsafe<FleetRow[]>(`
      SELECT
        f.fleet_role,
        CASE WHEN to_regrole(f.fleet_role) IS NULL THEN false
             ELSE pg_has_role(current_user, f.fleet_role, 'USAGE') END AS inherits_fleet,
        -- The capability, not the membership: since 16 a grant carries its own SET option and
        -- MEMBER ignores it, so SET FALSE reads as healthy while every SET ROLE is denied.
        -- SET is 16-only as a privilege type, hence the version branch.
        CASE WHEN to_regrole(f.fleet_role) IS NULL THEN false
             ELSE pg_has_role(current_user, f.fleet_role,
                    CASE WHEN current_setting('server_version_num')::int >= 160000
                         THEN 'SET' ELSE 'MEMBER' END) END AS can_set_role,
        (
          SELECT string_agg(DISTINCT p.polname || ' on ' || c.relname, ', ')
            FROM pg_policy p
            JOIN pg_class c ON c.oid = p.polrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND p.polname = 'fleet_super_admin'
             -- EXACTLY this role, not "among the roles". Containment let a hand-edited
             -- TO <someone>, <fleet> through, and USING (true) then applies to that someone:
             -- measured, an ordinary runtime role read every tenant with no SET ROLE at all
             -- (3 of 3, against 0 of 3 for the singleton). TO PUBLIC, <fleet> was already
             -- caught, but by accident of representation rather than by this predicate --
             -- Postgres collapses that list to the single OID 0, which is no role's.
             AND (to_regrole(f.fleet_role) IS NULL
                  OR p.polroles <> ARRAY[to_regrole(f.fleet_role)::oid])
        ) AS misnamed_fleet_policies
      FROM (SELECT ${FLEET_ROLE_FN} AS fleet_role) f
    `)
      )[0] ?? NO_FLEET)
    : NO_FLEET;

  // Asked before the privilege questions below, and not covered by ALLOW_SUPERUSER_RUNTIME: that
  // flag means "I accept that RLS may be a no-op here", and this is not about RLS being skipped —
  // it is about the cross-tenant path reading nothing at all, on any role.
  if (fleet.fleet_role && fleet.misnamed_fleet_policies) {
    throw new FleetPolicyMismatchError(
      fleet.fleet_role,
      fleet.misnamed_fleet_policies,
    );
  }

  // Also before the override, and for the same reason. A superuser can SET ROLE to anything, so this
  // never fires on the connection ALLOW_SUPERUSER_RUNTIME exists for; what it catches is an ordinary
  // role that was never granted the membership, on an install that happens to carry the flag.
  if (fleet.fleet_role && !fleet.can_set_role) {
    const version = row.server_version_num;
    throw new FleetRoleUnreachableError(
      row.rolname,
      fleet.fleet_role,
      version >= 160000
        ? `GRANT "${fleet.fleet_role}" TO "${row.rolname}" WITH INHERIT FALSE, SET TRUE;`
        : `ALTER ROLE "${row.rolname}" NOINHERIT; GRANT "${fleet.fleet_role}" TO "${row.rolname}";`,
    );
  }

  const reasons: string[] = [];
  if (row.rolsuper) reasons.push("SUPERUSER");
  if (row.rolbypassrls) reasons.push("BYPASSRLS");
  if (row.inherits_privileged) reasons.push("can become a privileged role");
  // A superuser holds USAGE on every role, so this is redundant with the two above rather than a
  // separate finding there — and it is exactly the local-dev shape ALLOW_SUPERUSER_RUNTIME exists
  // to permit, which is why it must not be reported when the role is already privileged.
  if (fleet.inherits_fleet && !row.rolsuper && !row.rolbypassrls) {
    reasons.push(FLEET_INHERITED_REASON);
  }

  if (reasons.length === 0) return; // safe

  if (allow) {
    logger.warn(
      { role: row.rolname, reasons },
      "Runtime DB role is privileged (RLS is a NO-OP); allowed by ALLOW_SUPERUSER_RUNTIME — never do this in production",
    );
    return;
  }
  // The repair is a statement an operator pastes, so it is spelled for the server that will run it:
  // `WITH INHERIT` is 16+ syntax and 15 refuses to parse it, where the control is the attribute.
  throw new SuperuserRuntimeError(
    row.rolname,
    reasons,
    row.server_version_num >= 160000
      ? `GRANT "${fleet.fleet_role}" TO "${row.rolname}" WITH INHERIT FALSE, SET TRUE;`
      : `ALTER ROLE "${row.rolname}" NOINHERIT; GRANT "${fleet.fleet_role}" TO "${row.rolname}";`,
  );
}
