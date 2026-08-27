import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { FLEET_ROLE } from "@/lib/tenancy/fleet-role";

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

export const FLEET_INHERITED_REASON = `inherits ${FLEET_ROLE}`;

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
  inherits_fleet: boolean;
  server_version_num: number;
}

export async function assertRuntimeRoleIsNotSuperuser(
  db: PrismaClient = basePrisma,
  opts: { allow?: boolean } = {},
): Promise<void> {
  const allow =
    opts.allow ?? (config.env !== "production" && config.allowSuperuserRuntime);

  // current_user's own attributes + whether it is a member (recursively) of ANY superuser or
  // bypassrls role. pg_has_role with 'USAGE' walks inherited memberships.
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
      pg_has_role(r.oid, ${FLEET_ROLE}, 'USAGE') AS inherits_fleet,
      current_setting('server_version_num')::int AS server_version_num
    FROM pg_roles r
    WHERE r.rolname = current_user
  `;
  const row = rows[0];
  if (!row) throw new Error("could not resolve the current DB role");

  const reasons: string[] = [];
  if (row.rolsuper) reasons.push("SUPERUSER");
  if (row.rolbypassrls) reasons.push("BYPASSRLS");
  if (row.inherits_privileged) reasons.push("inherits a privileged role");
  // A superuser holds USAGE on every role, so this is redundant with the two above rather than a
  // separate finding there — and it is exactly the local-dev shape ALLOW_SUPERUSER_RUNTIME exists
  // to permit, which is why it must not be reported when the role is already privileged.
  if (row.inherits_fleet && !row.rolsuper && !row.rolbypassrls) {
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
      ? `GRANT ${FLEET_ROLE} TO "${row.rolname}" WITH INHERIT FALSE, SET TRUE;`
      : `ALTER ROLE "${row.rolname}" NOINHERIT; GRANT ${FLEET_ROLE} TO "${row.rolname}";`,
  );
}
