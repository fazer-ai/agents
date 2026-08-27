// Whether a role can BECOME a privileged one, asked in the only way that answers it.
//
// Three checks in this repository ask "does this role reach a SUPERUSER or BYPASSRLS role?" — the
// runtime role at boot (`src/lib/db-guard.ts`), the runtime role at provisioning and the fleet role
// at provisioning (`scripts/db-bootstrap.ts`, with its `.sql` twin). All three asked
// `pg_has_role(…, 'USAGE')`, which is INHERITANCE, and inheritance is not the question.
//
// Measured: with `GRANT <superuser> TO <fleet> WITH INHERIT FALSE, SET TRUE` and the fleet role
// granted onward to the runtime role the same way, `pg_has_role(fleet, superuser, 'USAGE')` is
// FALSE and every one of those checks passed — while the runtime role ran `SET ROLE <superuser>`
// and came back with `is_superuser = on`. Not even by way of the fleet role: SET permission is
// TRANSITIVE through the membership chain, so `pg_has_role(app, superuser, 'SET')` is true and the
// runtime role reaches it in one statement. RLS is a no-op on that connection, which is the exact
// condition the boot guard exists to refuse.
//
// `SET` is a 16-only privilege type. Before 16 a grant carried no options of its own and `MEMBER`
// is the whole answer, which is the same version branch `can_set_role` already uses — so the branch
// is made in SQL, by the server that knows its own version, rather than by a caller that would have
// to fetch it first.
export const CAN_REACH = `CASE WHEN current_setting('server_version_num')::int >= 160000
                               THEN 'SET' ELSE 'MEMBER' END`;

// The privileged roles a role can reach, as a comma-separated list, or NULL for none. `$SUBJECT` is
// substituted with an expression naming the role's OID — these are compile-time constants of this
// repository and never carry caller input.
//
// BOTH directions are reported, because the repairs differ: an inherited membership is revoked, a
// SET-only one has its `SET` option taken away with `GRANT … WITH SET FALSE`. Reporting only the
// union would name a role and leave the operator guessing which statement clears it.
//
// `attributes` is the set that counts as elevated, and it is a PARAMETER because the two callers
// ask different questions of the same catalog.
//
// `RLS_DEFEATING` is the boot guard's: `src/lib/db-guard.ts` refuses to SERVE when RLS is a no-op
// on this connection, and CREATEDB does not make it one. `OUTLIVES_SET_ROLE` is the fleet role's at
// provisioning, and the reason is written on `FLEET_ROLE_FORBIDDEN_ATTRIBUTES` beside it: the
// runtime role ACQUIRES every one of them the moment it enters that role. Measured with the fleet
// role a SET-only member of a CREATEROLE role — the runtime role entered it and MINTED A NEW
// CLUSTER ROLE, while the check, asking only about SUPERUSER and BYPASSRLS, called the fleet role
// unprivileged. LOGIN is on the direct list and not on this one, because a session is already open
// by the time a SET ROLE happens: it is the one forbidden attribute that does not transfer.
export const RLS_DEFEATING = "m.rolsuper OR m.rolbypassrls";
export const OUTLIVES_SET_ROLE =
  "m.rolsuper OR m.rolbypassrls OR m.rolcreatedb OR m.rolcreaterole OR m.rolreplication";

// `exceptRoleExpr` names one role to leave out, and it exists for exactly one caller: the RUNTIME
// role at provisioning, whose reach legitimately includes this database's fleet role — being able
// to `SET ROLE` into it is the design. What matters there is whether the FLEET role is privileged,
// and that has its own assertion one step later with the repair that fits it (`DROP ROLE`, because
// this installation does not own a role a recreated database left behind), where this one would say
// "revoke the membership" and cost the operator a second boot to find out. Measured: without the
// exclusion, making the fleet role BYPASSRLS produced the runtime-role refusal and hid the
// fleet-role one entirely.
//
// The exclusion is NOT made at boot time (`src/lib/db-guard.ts` passes nothing): there the fleet
// role has no other check, so a fleet role someone made BYPASSRLS should stop the server, and this
// is what stops it.
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
