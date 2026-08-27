// The Postgres role the cross-tenant path becomes, for the length of one transaction.
//
// It exists because the tenant predicate has to be the WHOLE policy to be indexable. The policy
// used to read `is_super_admin = 'on' OR tenant_id = <guc>`, and one side of that OR names no
// column, so the planner could turn neither into an index condition: every tenant-scoped read
// filtered on top of a scan it had already paid for. Measured on 1,000,000 rows, returning a page
// of 51 to a tenant holding 0.01% of the table: 108 ms and 509,949 rows discarded, against
// 0.033 ms and none (issue #382).
//
// Splitting the OR into two PERMISSIVE policies does not help — Postgres ORs those together and
// the qual comes out identical, buffer for buffer. What separates them is `TO <role>`: a policy
// whose role does not match the caller is not part of the qual at all. So the tenant policy stays
// at PUBLIC (the migration therefore never has to know the deployment's app-role name, which is
// configurable) and only the fleet policy names a role.
//
// This role holds NO attribute of its own — it is NOSUPERUSER, NOBYPASSRLS, NOLOGIN. It is still
// fenced by RLS like anything else; it just has a policy that lets it through, which means the
// fleet path stays visible in `pg_policy` instead of disappearing into a role attribute, and a
// table that gets RLS without a fleet policy fails closed rather than open (measured: 0 rows of 30
// through the policy, 30 of 30 through a BYPASSRLS role, which is the design this replaced).
//
// ## Why the name is derived from the database rather than fixed
//
// Roles are CLUSTER-wide; databases are not. A fixed name would therefore be ONE role shared by
// every installation on a server, and membership in it is cluster-wide too — so installation A's
// runtime role could connect to installation B's database (databases grant CONNECT to PUBLIC by
// default), `SET ROLE` into that shared role, and pick up the grants and the fleet policy B gave
// it. Measured, with two databases and two distinct app roles: **permission denied before, 30 of
// 30 rows after**. That is a boundary this change would otherwise have opened.
//
// It does not need an operator to wire it, either, which is what settles it. With the cluster
// superuser as the migration role on both installations — the documented self-hosted setup — the
// second bootstrap grants the membership with no manual step (measured; a CREATEROLE administrator
// that did not create the role is the case that gets refused).
//
// So the name carries the database: a readable prefix, the database name, and eight hex of its md5
// so two names that share a prefix cannot collide. The md5 is taken from the RAW name and the
// readable half is normalised to `[a-zA-Z0-9_]` first, which is what makes the result both bounded
// and safe to interpolate — and neither is theoretical:
//
//   * `left(…, 30)` counts CHARACTERS, and an identifier is limited to 63 BYTES. A 25-character
//     Japanese database name derives an 86-byte name, which Postgres truncates SILENTLY — measured,
//     the truncation cut the hash off entirely, and the first grant then failed with
//     `role does not exist`. Two databases sharing a prefix would have collided into one role.
//   * a database name may legally contain a double quote, and it landed inside the derived name:
//     measured, the next `GRANT … TO "<name>"` came out as `syntax error at or near …`, so
//     provisioning failed outright on a name Postgres accepts.
//
// Normalised, both come out at 44 and 32 bytes with the hash intact. The hash still comes from the
// unnormalised name, so two databases differing only in punctuation stay distinct.
//
// The derivation lives in a FUNCTION rather than being repeated, and every caller uses the
// function — except `db-bootstrap`, which on a first install runs BEFORE the migration that
// creates it and therefore carries the expression inline. That is the only duplicate, and
// `tests/lib/rls-policy-shape.test.ts` proves the two resolve to the same string.

// Schema-qualified on purpose: `set_config('role', …)` resolves through `search_path`, and a role
// that could create a function in an earlier schema would otherwise choose which role the fleet
// path becomes. The runtime role holds USAGE on `public` and not CREATE, so it cannot shadow this.
export const FLEET_ROLE_FN = "public.fazerai_fleet_role()";

// The one duplicate of the function's body, for the boot path that predates the function. Both
// spellings are compile-time constants of this repository; neither ever carries caller input.
export const FLEET_ROLE_EXPR =
  "('fazerai_fleet_' || left(regexp_replace(current_database()::text, '[^a-zA-Z0-9_]', '_', 'g'), 30) || '_' || substr(md5(current_database()::text), 1, 8))";

// The function's body, so the migration and this module cannot drift apart in review.
export const FLEET_ROLE_FUNCTION_DDL = `CREATE OR REPLACE FUNCTION public.fazerai_fleet_role()
  RETURNS name LANGUAGE sql STABLE AS $fn$ SELECT ${FLEET_ROLE_EXPR}::name $fn$`;

// The one statement that enters the fleet role, so `asSuperAdmin`, the migration tests that
// re-execute a historical backfill, and anything else that needs it cannot drift into three
// spellings of the same thing.
export const ENTER_FLEET_ROLE_SQL = `SELECT set_config('role', ${FLEET_ROLE_FN}, true)`;

// The rotation's outgoing role is DECLARED, never inferred, and a measurement is why.
//
// `docs/deploy.md` promises that during a credential rotation the container still serving on the
// outgoing role stays alive through the transfer, so the boot of the incoming release must not cut
// that role's fleet access — every `asSuperAdmin` in the old process, API-key verification
// included, would start reading zero rows mid-deploy. The first attempt spared any stray holding an
// open session in this database, on the reasoning that a previous installation's role would have
// none.
//
// Measured, and false: drop a database and recreate it under the same name, and the stale
// installation's pool reconnects to that name. Its role then presents EXACTLY the shape of a
// rotation — a member of this database's fleet role, with a live session here — while being the
// leftover the reconcile exists to remove. `pg_stat_activity` cannot tell the two apart, because
// there is nothing in it to tell them apart WITH.
//
// So the operator says which role is leaving. Both conditions are required, and each covers the
// other's failure: the declaration is what authorises keeping the access, and the open session is
// what bounds it, so a declaration left behind in the environment clears itself on the first boot
// after the old process exits rather than becoming a permanent exemption.
export const FLEET_ROLE_RETAINED_MEMBER_ENV = "FLEET_ROLE_RETAIN_MEMBER";

// The same declaration for `scripts/db-bootstrap.sql`, which is run by hand in psql and has no
// environment to read: `SET fazerai.retain_fleet_member = 'app_v1';` before the script.
export const FLEET_ROLE_RETAINED_MEMBER_GUC = "fazerai.retain_fleet_member";

// Splits either spelling of the declaration into role names. Comma-separated so a second rotation
// started before the first one drained composes instead of overwriting.
export function retainedFleetMembers(
  declared: string | undefined | null,
): Set<string> {
  return new Set(
    (declared ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}
