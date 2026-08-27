-- The tenant predicate becomes the WHOLE policy, and the cross-tenant path becomes a role.
--
-- Every tenant-scoped table carried this:
--
--   USING (current_setting('app.is_super_admin', true) = 'on'
--          OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
--
-- One side of that OR names no column, so the planner can turn neither side into an index
-- condition: the policy became a Filter applied on top of whatever scan it picked, and every
-- `@@index([tenantId])` and `(tenantId, ...)` composite in the schema was unreachable through it.
-- The ORM does not supply the predicate either — `runScoped` sets the GUC and lets RLS fence, so
-- a scoped read is emitted as `WHERE 1=1`.
--
-- Measured on PostgreSQL 17.10, `outbound_webhook_deliveries` seeded with 1,000,000 rows across
-- 50 tenants, returning one page of 51 rows to a tenant holding 0.01% of the table:
--
--   policy as shipped          108 ms   25,065 buffers   509,949 rows discarded   pkey scan
--   tenant predicate alone    0.033 ms      78 buffers            0 discarded   (tenant_id, status, id)
--
-- The cost is not a constant factor: a backward primary-key scan walks roughly
-- `page_size x (table rows / tenant rows)` before it can fill a page, so the smallest tenant on an
-- instance pays the most, and it gets worse as an instance takes on tenants rather than as any one
-- of them grows.
--
-- Splitting the OR into two PERMISSIVE policies does NOT fix it. Postgres ORs permissive policies
-- together and the qual comes out the same shape — measured at 100.0 ms against 113.6 ms, with
-- 25,065 buffers and 509,949 rows discarded on BOTH, i.e. the identical plan. What separates them
-- is `TO <role>`: a policy whose role does not match the caller is not part of the qual at all.
--
-- So the tenant policy stays at PUBLIC and only the fleet policy names a role. That is deliberate:
-- the runtime role's NAME is deployment configuration (`DATABASE_URL`), and a migration has no way
-- to read a deployment's env, so a policy that had to name it could not be written here at all.

-- 1. The role the cross-tenant path becomes, for the length of one transaction.
--
-- It holds no attribute of its own: NOSUPERUSER and NOBYPASSRLS, so it is still fenced by RLS like
-- anything else and merely has a policy that lets it through. That keeps the fleet path visible in
-- `pg_policy` instead of disappearing into a role attribute, and makes a future table that gets RLS
-- without a fleet policy fail CLOSED rather than open (measured: 0 rows of 30 through the policy,
-- 30 of 30 through a BYPASSRLS role, which is the design this replaced). NOLOGIN: nothing ever
-- connects as it.
--
-- Its NAME carries the database, and that is not cosmetic. Roles are CLUSTER-wide while databases
-- are not, so a fixed name would be ONE role shared by every installation on a server — and
-- membership is cluster-wide too. Installation A's runtime role could then connect to installation
-- B's database (databases grant CONNECT to PUBLIC by default), SET ROLE into that shared role, and
-- pick up the grants and the fleet policy B gave it: measured across two databases with two
-- distinct app roles as **permission denied before this change, 30 of 30 rows after**. Nor does it
-- need an operator to wire it — with the cluster superuser as the migration role on both
-- installations, which is the documented self-hosted setup, the second bootstrap grants the
-- membership with no manual step (also measured).
--
-- The derivation lives in a function so that the runtime, the boot guard and this file cannot drift
-- into three spellings of one name. Eight hex of md5 because the identifier limit is 63 bytes and
-- Postgres truncates silently: two long database names sharing a prefix would otherwise become the
-- same role.
CREATE OR REPLACE FUNCTION public.fazerai_fleet_role()
  RETURNS name LANGUAGE sql STABLE AS $fn$
    SELECT ('fazerai_fleet_'
            || left(regexp_replace(current_database()::text, '[^a-zA-Z0-9_]', '_', 'g'), 30)
            || '_' || substr(md5(current_database()::text), 1, 8))::name
  $fn$;

-- `scripts/db-bootstrap` is what owns roles and grants, and it creates this one too. It is repeated
-- here so that `prisma migrate deploy` run on its own does not fail on a missing role — the
-- policies below reference it by name, and a missing role is a hard error, not a warning.
DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_fleet) THEN
    EXECUTE format(
      'CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', v_fleet);
  END IF;
  -- Same set the runtime role gets, and for the same reason: ALTER DEFAULT PRIVILEGES is scoped to
  -- the role that runs it, so tables a later migration creates inherit these.
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_fleet);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', v_fleet);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', v_fleet);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public'
                 ' GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', v_fleet);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public'
                 ' GRANT USAGE, SELECT ON SEQUENCES TO %I', v_fleet);
END $$;

-- 2. Rewrite every tenant policy, and give each table its fleet policy.
--
-- Driven off the catalog rather than off a list, because the list is the thing that goes stale:
-- `tenant_isolation` was written for 38 tables in the init migration and four later migrations
-- added their own, none of which a list written today would know about tomorrow. The count is
-- asserted at the end, so a database in an unexpected state fails loudly instead of quietly
-- getting half of this.
DO $$
DECLARE
  t       text;
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_policy p
      JOIN pg_class c     ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND p.polname = 'tenant_isolation'
       AND c.relname NOT IN ('tenants', 'audit_logs')
     ORDER BY c.relname
  LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
    $f$, t);
    EXECUTE format($f$
      CREATE POLICY fleet_super_admin ON %I TO %I USING (true) WITH CHECK (true)
    $f$, t, v_fleet);
  END LOOP;
END $$;

-- tenants: keyed by its own id rather than by a tenant_id column.
DROP POLICY tenant_isolation ON "tenants";
CREATE POLICY tenant_isolation ON "tenants"
  USING (id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "tenants" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

-- audit_logs: tenant_id may be NULL (fleet-level rows), and those must never reach a tenant.
--
-- The old qual spelled that out as `tenant_id IS NOT NULL AND tenant_id = <guc>`. The conjunct was
-- already redundant and is dropped here: `nullif` yields NULL when the GUC is unset, and both
-- `NULL = NULL` and `<value> = NULL` evaluate to NULL, which is not TRUE — so a NULL row is
-- invisible either way, and a NULL GUC still fails closed. Keeping it would have cost the index
-- condition a redundant Filter beside it. `tests/lib/rls-policy-shape.test.ts` holds both halves.
DROP POLICY tenant_isolation ON "audit_logs";
CREATE POLICY tenant_isolation ON "audit_logs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "audit_logs" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

-- 3. The migration's own positive control: one of each policy per table under RLS, or nothing here
-- ran the way it reads. A loop over an empty catalog completes successfully and silently.
--
-- Raising here is safe to do, and what happens next was measured rather than assumed, because a
-- neighbouring migration (`20260825140100_delivery_conversation_ref`) states the opposite in its
-- header: that `prisma migrate deploy` does not wrap a migration in a transaction. For THIS file it
-- does. Applied through the real command to a scratch database carrying a deliberate drift (a table
-- with RLS whose policy has another name), the exception left `fleet_super_admin` at ZERO and all 41
-- `tenant_isolation` policies still holding the old `OR` — nothing above was committed. So there is
-- no half-split schema to clean up and no `IF EXISTS` needed to make a retry possible.
--
-- What DOES survive the failure is Prisma's own record of it, and that is the part an operator has
-- to know: the next `migrate deploy` answers `migrate found failed migrations in the target
-- database` and applies NOTHING, including migrations unrelated to this one. Recovery is to fix the
-- drift, then `prisma migrate resolve --rolled-back 20260827000000_rls_split_tenant_and_fleet_policies`,
-- then deploy again. That cost is deliberate: the alternative to raising is a schema split for some
-- tables and not others, which nothing downstream would report.
DO $$
DECLARE
  n_rls    int;
  n_tenant int;
  n_fleet  int;
BEGIN
  SELECT count(*) INTO n_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity;
  SELECT count(*) INTO n_tenant
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND p.polname = 'tenant_isolation';
  SELECT count(*) INTO n_fleet
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND p.polname = 'fleet_super_admin';
  IF n_rls = 0 OR n_tenant <> n_rls OR n_fleet <> n_rls THEN
    RAISE EXCEPTION
      'RLS policy split did not land: % tables under RLS, % tenant_isolation, % fleet_super_admin',
      n_rls, n_tenant, n_fleet;
  END IF;
END $$;
