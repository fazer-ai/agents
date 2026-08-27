import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { FLEET_ROLE_FN } from "@/lib/tenancy/fleet-role";

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

export const FLEET_INHERITED_REASON = "inherits the fleet role";

// The fleet role's name carries the database it belongs to, so a database RESTORED under a new name
// resolves a name its own dumped policies do not mention. Nothing errors: `SET ROLE` succeeds (the
// role exists and is granted), and every fleet read then matches no policy and returns ZERO ROWS.
// That is the silent shape, so it refuses rather than warns — and the repair is one statement,
// because a policy references its role by OID and a rename leaves it pointing at the same role.
export class FleetPolicyMismatchError extends Error {
  constructor(resolved: string, offenders: string) {
    super(
      `the fleet policies in this database do not name "${resolved}", which is the role this ` +
        `database resolves to: ${offenders}. Every cross-tenant read would match no policy and ` +
        "answer zero rows, with no error. This is what a database restored under a different name " +
        `looks like; rename the role the policies DO name: ALTER ROLE "<that role>" RENAME TO "${resolved}";`,
    );
    this.name = "FleetPolicyMismatchError";
  }
}

export class SuperuserRuntimeError extends Error {
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
  misnamed_fleet_policies: string | null;
}

export async function assertRuntimeRoleIsNotSuperuser(
  db: PrismaClient = basePrisma,
  opts: { allow?: boolean } = {},
): Promise<void> {
  const allow =
    opts.allow ?? (config.env !== "production" && config.allowSuperuserRuntime);

  // current_user's own attributes + whether it is a member (recursively) of ANY superuser or
  // bypassrls role. pg_has_role with 'USAGE' walks inherited memberships.
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
      EXISTS (
        SELECT 1 FROM pg_roles m
        WHERE (m.rolsuper OR m.rolbypassrls)
          AND m.oid <> r.oid
          AND pg_has_role(r.oid, m.oid, 'USAGE')
      ) AS inherits_privileged,
      current_setting('server_version_num')::int AS server_version_num
    FROM pg_roles r
    WHERE r.rolname = current_user
  `;
  const row = rows[0];
  if (!row) throw new Error("could not resolve the current DB role");

  // `to_regprocedure` rather than calling the function directly: on a database whose migrations have
  // not run it does not exist, and a boot guard that throws `function does not exist` reports the
  // wrong problem. Absent, both answers come back NULL and neither question below applies.
  //
  // `to_regrole` rather than a `::regrole` cast for the same shape of reason: the cast RAISES on a
  // name no role carries, and the resolved role legitimately does not exist yet before bootstrap.
  const fleet = (
    await db.$queryRawUnsafe<FleetRow[]>(`
      SELECT
        f.fleet_role,
        -- to_regrole guards this as well, and for the same reason: pg_has_role RAISES on a
        -- name no role carries (measured), so a database provisioned but not yet bootstrapped
        -- would crash this guard with role does not exist instead of being reported.
        CASE WHEN to_regrole(f.fleet_role) IS NULL THEN false
             ELSE pg_has_role(current_user, f.fleet_role, 'USAGE') END AS inherits_fleet,
        CASE WHEN f.fleet_role IS NULL THEN NULL ELSE (
          SELECT string_agg(DISTINCT p.polname || ' on ' || c.relname, ', ')
            FROM pg_policy p
            JOIN pg_class c ON c.oid = p.polrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public'
             AND p.polname = 'fleet_super_admin'
             AND (to_regrole(f.fleet_role) IS NULL
                  OR NOT (to_regrole(f.fleet_role)::oid = ANY (p.polroles)))
        ) END AS misnamed_fleet_policies
      FROM (
        SELECT CASE WHEN to_regprocedure('${FLEET_ROLE_FN}') IS NULL
                    THEN NULL ELSE ${FLEET_ROLE_FN} END AS fleet_role
      ) f
    `)
  )[0] ?? {
    fleet_role: null,
    inherits_fleet: false,
    misnamed_fleet_policies: null,
  };

  // Asked before the privilege questions below, and not covered by ALLOW_SUPERUSER_RUNTIME: that
  // flag means "I accept that RLS may be a no-op here", and this is not about RLS being skipped —
  // it is about the cross-tenant path reading nothing at all, on any role.
  if (fleet.fleet_role && fleet.misnamed_fleet_policies) {
    throw new FleetPolicyMismatchError(
      fleet.fleet_role,
      fleet.misnamed_fleet_policies,
    );
  }

  const reasons: string[] = [];
  if (row.rolsuper) reasons.push("SUPERUSER");
  if (row.rolbypassrls) reasons.push("BYPASSRLS");
  if (row.inherits_privileged) reasons.push("inherits a privileged role");
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
