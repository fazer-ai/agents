// The Postgres role the cross-tenant path becomes, for the length of one transaction. Only the fleet
// policy names it (`TO <role>`), so the tenant policy stays a bare, indexable predicate; the role has
// no attribute of its own (NOSUPERUSER, NOBYPASSRLS, NOLOGIN), so a table given RLS without a fleet
// policy fails closed. Why the name derives from the database: docs/tenancy.md, "RLS policy shape".

// The name is a prefix, the database name normalised to `[a-zA-Z0-9_]` and cut to 30 characters, and
// eight hex of the RAW name's md5. Normalising keeps it under the 63-BYTE identifier limit (Postgres
// truncates silently, which would cut the hash) and safe to interpolate (a database name may contain
// a double quote); the raw-name hash keeps names differing only in punctuation distinct.

// Schema-qualified on purpose: `set_config('role', …)` resolves through `search_path`, and a role
// that could create a function in an earlier schema would otherwise choose which role the fleet
// path becomes. The runtime role holds USAGE on `public` and not CREATE, so it cannot shadow this.
export const FLEET_ROLE_FN = "public.fazerai_fleet_role()";

// The one duplicate of the function's body, for `db-bootstrap`, which on a first install runs BEFORE
// the migration that creates the function; `tests/lib/rls-policy-shape.test.ts` proves the two
// resolve alike. Both are compile-time constants of this repository, never caller input.
export const FLEET_ROLE_EXPR =
  "('fazerai_fleet_' || left(regexp_replace(current_database()::text, '[^a-zA-Z0-9_]', '_', 'g'), 30) || '_' || substr(md5(current_database()::text), 1, 8))";

// The function's body, so the migration and this module cannot drift apart in review.
export const FLEET_ROLE_FUNCTION_DDL = `CREATE OR REPLACE FUNCTION public.fazerai_fleet_role()
  RETURNS name LANGUAGE sql STABLE AS $fn$ SELECT ${FLEET_ROLE_EXPR}::name $fn$`;

// The one statement that enters the fleet role, so `asSuperAdmin`, the migration tests that
// re-execute a historical backfill, and anything else that needs it cannot drift into three
// spellings of the same thing.
export const ENTER_FLEET_ROLE_SQL = `SELECT set_config('role', ${FLEET_ROLE_FN}, true)`;

// The rotation's outgoing role is DECLARED, never inferred from an open session: a database dropped
// and recreated under the same name gets the stale installation's pool back, whose role looks exactly
// like a rotation. The declaration authorises keeping the fleet access and the open session bounds it,
// so a leftover declaration clears itself once the old process exits (docs/deploy.md, rotating
// `DATABASE_URL`).
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
