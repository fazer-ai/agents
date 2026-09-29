// Whether a role can BECOME a privileged one, asked by SET permission rather than by
// `pg_has_role(…, 'USAGE')`, which is INHERITANCE: a chain granted `WITH INHERIT FALSE, SET TRUE`
// reports no inheritance while SET permission is TRANSITIVE along it, so the runtime role can
// `SET ROLE <superuser>` in one statement. Used by the boot guard (`src/lib/db-guard.ts`) and by
// provisioning (`scripts/db-bootstrap.ts` and its `.sql` twin). `SET` exists only from Postgres 16;
// before that `MEMBER` is the whole answer, so the server branches on its own version in SQL.
// The table of memberships and verdicts is in docs/tenancy.md, "Role attributes are not inherited".
export const CAN_REACH = `CASE WHEN current_setting('server_version_num')::int >= 160000
                               THEN 'SET' ELSE 'MEMBER' END`;

// The privileged roles a role can reach, as a comma-separated list, or NULL for none. `$SUBJECT` is
// an expression naming the role's OID, a compile-time constant, never caller input. Both paths are
// reported because the repairs differ: an inherited membership is revoked, a SET-only one gets
// `GRANT … WITH SET FALSE`.

// `attributes` is what counts as elevated. `RLS_DEFEATING` is the boot guard's (CREATEDB does not make
// RLS a no-op). `OUTLIVES_SET_ROLE` is the fleet role's at provisioning: the runtime role ACQUIRES
// each of these on entering it (CREATEROLE lets it mint cluster roles). LOGIN is not on it, since a
// session is already open by the time a SET ROLE happens (see `FLEET_ROLE_FORBIDDEN_ATTRIBUTES`).
export const RLS_DEFEATING = "m.rolsuper OR m.rolbypassrls";
export const OUTLIVES_SET_ROLE =
  "m.rolsuper OR m.rolbypassrls OR m.rolcreatedb OR m.rolcreaterole OR m.rolreplication";

// `exceptRoleExpr` leaves one role out, for the RUNTIME role at provisioning only: reaching this
// database's fleet role is the design there, and the fleet role gets its own assertion one step later
// with the repair that fits it (`DROP ROLE`), instead of a misleading "revoke the membership". The
// boot guard passes nothing: the fleet role has no other check there, so a BYPASSRLS fleet role
// stops the server here.
export function privilegedReachSql(
  subjectOid: string,
  exceptRoleExpr?: string,
  attributes: string = RLS_DEFEATING,
): string {
  const except = exceptRoleExpr ? `AND m.rolname <> ${exceptRoleExpr}` : "";
  return `(SELECT string_agg(DISTINCT quote_ident(m.rolname)
                             || CASE WHEN pg_has_role(${subjectOid}, m.oid, 'USAGE')
                                     THEN ' (inherited)' ELSE ' (via SET ROLE)' END, ', ')
             FROM pg_roles m
            WHERE (${attributes})
              AND m.oid <> ${subjectOid}
              ${except}
              AND (pg_has_role(${subjectOid}, m.oid, 'USAGE')
                   OR pg_has_role(${subjectOid}, m.oid, ${CAN_REACH})))`;
}
