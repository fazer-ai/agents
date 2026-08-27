// The Postgres role the cross-tenant path becomes, for the length of one transaction.
//
// It exists because the tenant predicate has to be the WHOLE policy to be indexable. The policy
// used to read `is_super_admin = 'on' OR tenant_id = <guc>`, and one side of that OR names no
// column, so the planner could turn neither into an index condition: every tenant-scoped read
// filtered on top of a scan it had already paid for. Measured on 1,000,000 rows, returning a page
// of 51 to a tenant holding 0.01% of the table: 108 ms and 509,949 rows discarded, against
// 0.033 ms and none once the OR is gone (issue #382).
//
// Splitting the OR into two PERMISSIVE policies does not help — Postgres ORs those together and
// the qual comes out identical, buffer for buffer. What separates them is `TO <role>`: a policy
// whose role does not match the caller is not part of the qual at all. So the tenant policy stays
// at PUBLIC (the migration therefore never has to know the deployment's app-role name, which is
// configurable) and only the fleet policy names a role.
//
// The name is a fixed constant rather than configuration for the same reason: `CREATE POLICY ...
// TO <role>` is written by a migration, which has no way to read a deployment's env.
//
// This role holds NO attribute of its own — it is NOSUPERUSER, NOBYPASSRLS, NOLOGIN. It is still
// fenced by RLS like anything else; it just has a policy that lets it through, which means the
// fleet path stays visible in `pg_policy` instead of disappearing into a role attribute, and a
// table that gets RLS without a fleet policy fails closed rather than open.
export const FLEET_ROLE = "fazerai_fleet";
