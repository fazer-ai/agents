-- Idempotent DB bootstrap for fazer.ai agents.
-- Run as a SUPERUSER (or DB owner with CREATEROLE) against the application database,
-- once at provisioning time. Safe to re-run. Unlike scripts/db-bootstrap.ts, which runs unattended
-- on every container boot and therefore downgrades what it can to a warning, this one is invoked
-- by hand with someone watching, so every statement here is allowed to fail loudly.
--
-- It establishes the split the multi-tenant isolation model depends on:
--   * the pgvector extension (needs superuser; cannot live in a Prisma migration);
--   * a NON-SUPERUSER, NON-BYPASSRLS runtime role so RLS policies actually apply
--     (the runtime connection MUST NOT be a superuser or owner, or RLS is a no-op);
--   * the `langgraph` schema owned by that role (the LangGraph PostgresSaver creates
--     its own tables there at boot, outside Prisma);
--   * default privileges so the runtime role can use tables the migration/owner role
--     creates later (ALTER DEFAULT PRIVILEGES is scoped to the role running it, so this
--     must be run by the same role that runs migrations — the owner/superuser).
--
-- Usage:
--   psql "$MIGRATION_DATABASE_URL" \
--     -v app_role=fazerai_app -v app_password='...' -f scripts/db-bootstrap.sql

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS vector;

-- psql variable substitution does not reach inside dollar-quoted DO blocks, so the
-- role name and password are handed to the block via session GUCs set out here.
SELECT set_config('fazerai.app_role', :'app_role', false);
SELECT set_config('fazerai.app_password', :'app_password', false);

-- Runtime role: explicit NOSUPERUSER + NOBYPASSRLS is load-bearing.
--
-- Which of the three statements below is legal depends on who is running this. Since PostgreSQL 16
-- the privilege check in ALTER ROLE fires on an option being PRESENT, not on its value, so
-- NOSUPERUSER is refused for exactly the same reason SUPERUSER is, for any role that is not a real
-- superuser -- while CREATE ROLE still checks the value and accepts the same list. So the
-- attributes are asserted at creation, where they are free, and re-asserted only when the existing
-- role actually HAS them, which is the one case that needs a superuser and deserves to fail loudly.
DO $$
DECLARE
  v_role       text := current_setting('fazerai.app_role');
  v_pw         text := current_setting('fazerai.app_password');
  v_privileged boolean;
  v_createdb   boolean;
  v_createrole boolean;
BEGIN
  SELECT (rolsuper OR rolbypassrls), rolcreatedb, rolcreaterole
    INTO v_privileged, v_createdb, v_createrole
    FROM pg_roles WHERE rolname = v_role;
  IF v_privileged IS NULL THEN
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
      v_role, v_pw);
  ELSIF v_privileged THEN
    EXECUTE format(
      'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
      v_role, v_pw);
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', v_role, v_pw);
    -- CREATEDB and CREATEROLE do not defeat RLS, so they are not part of the demotion above and
    -- nothing downstream checks them -- this script is what takes them away. One statement each,
    -- and only when actually set: an administrator may only set an attribute it holds itself, so a
    -- combined statement would lose the half it can do to the half it cannot.
    IF v_createdb   THEN EXECUTE format('ALTER ROLE %I NOCREATEDB', v_role);   END IF;
    IF v_createrole THEN EXECUTE format('ALTER ROLE %I NOCREATEROLE', v_role); END IF;
  END IF;
  -- CONNECT to use the DB; CREATE so the LangGraph PostgresSaver.setup() can run its
  -- `CREATE SCHEMA IF NOT EXISTS langgraph` at boot (the privilege is checked even when the
  -- schema already exists). The role stays NON-superuser/NON-bypassrls, so RLS still fences
  -- all tenant data; CREATE on the database only lets it create schemas/objects, which it
  -- already effectively can within the app's own tables.
  EXECUTE format('GRANT CONNECT, CREATE ON DATABASE %I TO %I', current_database(), v_role);
END $$;

GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";

-- Tables/sequences created later by the owner role inherit these grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_role";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO :"app_role";

-- Since PostgreSQL 16, creating an object owned by another role requires being able to SET ROLE to
-- it, and the membership a CREATEROLE role gets over the roles it creates carries SET FALSE -- so
-- the CREATE SCHEMA below fails there with `must be able to SET ROLE`. WITH SET is itself 16+
-- syntax, hence the EXECUTE: older servers must not parse it, and do not need it.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT %I TO CURRENT_USER WITH SET TRUE', current_setting('fazerai.app_role'));
  END IF;
END $$;

-- The role the cross-tenant path becomes, for the length of one transaction. `asSuperAdmin` does
-- `set_config('role', public.fazerai_fleet_role(), true)`, and the `fleet_super_admin` policy every
-- table under RLS carries is written TO that role. It holds NOTHING of its own -- NOSUPERUSER,
-- NOBYPASSRLS, NOLOGIN -- so it is still fenced by RLS and merely has a policy that lets it through.
--
-- Why a role rather than the GUC this replaces: the old policy read
-- `is_super_admin = 'on' OR tenant_id = <guc>`, and a branch naming no column cannot become an
-- index condition, so every tenant-scoped read filtered on top of a scan it had already paid for
-- (issue #382; the measurements are in the migration that splits it). Two permissive policies do
-- not help -- Postgres ORs those -- and `TO <role>` does, because a policy whose role does not
-- match the caller is not part of the qual at all.
--
-- Why the NAME carries the database: roles are CLUSTER-wide while databases are not, so a fixed
-- name would be one role shared by every installation on a server, and installation A's runtime
-- role could SET ROLE into it inside installation B's database and read every tenant there
-- (measured: permission denied before, 30 of 30 rows after). The expression is spelled out here
-- rather than calling `public.fazerai_fleet_role()` because on a first install this script runs
-- before the migration that creates that function.
-- A fleet_super_admin policy naming SOMEONE ELSE's fleet role is what a restore or a clone under a
-- different name leaves behind: the copied policies still say TO <source fleet role> and the copied
-- grants still give that role every table, while its members survive untouched because a membership
-- is CLUSTER-wide. Measured: the source installation's runtime role read 30 of 30 rows of the
-- restored database, against 0 of 30 without the SET ROLE.
--
-- TWO blocks, and that is the load-bearing part. The first repairs and the second refuses, because
-- a RAISE aborts the transaction it is in and takes the repair down with it — measured, with both
-- in one block: the script refused, and the restored database read 30 of 30 again immediately
-- after, the revoke having been rolled back by the very statement that announced it. At psql's top
-- level each statement is its own transaction, so splitting them is what lets the repair survive.
--
-- The privileges go, in THIS database only. The foreign role's cluster-wide membership is left
-- alone on purpose: it belongs to a source installation that is, in the ordinary case, running fine
-- on its own database, and revoking it from here would break that one (measured: the source keeps
-- reading its own 30 of 30 after this runs). Only names matching the derivation's own prefix are
-- candidates, so an operator role that appears in a policy is never one.
DO $$
DECLARE
  v_fleet name := ('fazerai_fleet_'
                   || left(regexp_replace(current_database()::text, '[^a-zA-Z0-9_]', '_', 'g'), 30)
                   || '_' || substr(md5(current_database()::text), 1, 8))::name;
  v_stray text;
BEGIN
  FOR v_stray IN
    SELECT DISTINCT r.rolname
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL unnest(p.polroles) AS pr(oid)
      JOIN pg_roles r ON r.oid = pr.oid
     WHERE n.nspname = 'public' AND p.polname = 'fleet_super_admin'
       AND r.rolname <> v_fleet AND r.rolname LIKE 'fazerai\_fleet\_%'
  LOOP
    BEGIN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', v_stray);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', v_stray);
      EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', v_stray);
      RAISE NOTICE 'revoked the privileges of % here -- a foreign fleet role, which could read '
                   'every tenant in this database through the policies naming it',
                   quote_ident(v_stray);
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'could not revoke privileges from %: %', quote_ident(v_stray), SQLERRM;
    END;
  END LOOP;
END $$;


DO $$
DECLARE
  v_role  text := current_setting('fazerai.app_role');
  v_fleet name := ('fazerai_fleet_'
                   || left(regexp_replace(current_database()::text, '[^a-zA-Z0-9_]', '_', 'g'), 30)
                   || '_' || substr(md5(current_database()::text), 1, 8))::name;
  v_stray text;
  v_left  text;
  -- The rotation's outgoing role, DECLARED rather than inferred from an open session. The reason is
  -- measured and lives in @/lib/tenancy/fleet-role: a stale installation, after its database was
  -- dropped and recreated under the same name, reconnects and presents the same open session as a
  -- rotation. This script has no environment, so the declaration arrives as a session GUC:
  --   SET fazerai.retain_fleet_member = 'fazerai_app_v1';   -- comma-separated for two at once
  v_retained text[] := string_to_array(
    replace(coalesce(current_setting('fazerai.retain_fleet_member', true), ''), ' ', ''), ',');
  v_priv  text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_fleet) THEN
    EXECUTE format(
      'CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', v_fleet);
  END IF;

  -- What the role IS, asked of whatever it turned out to be. This script only CREATES one when it is
  -- absent, so on the branch that FINDS an existing role -- a database dropped and recreated leaves
  -- one behind -- nothing else asks whether it is the harmless NOLOGIN role this design describes.
  -- The runtime role SETs ROLE into it, so a privileged one makes RLS a no-op for every request.
  -- Every attribute that outlives a SET ROLE, not just the two that defeat RLS: the runtime role
  -- ACQUIRES all of them the moment it enters this role, so CREATEDB, CREATEROLE and REPLICATION are
  -- cluster-level privileges handed to every request path.
  SELECT string_agg(w, ', ') INTO v_priv FROM (
    SELECT 'SUPERUSER' AS w FROM pg_roles WHERE rolname = v_fleet AND rolsuper
    UNION ALL SELECT 'BYPASSRLS' FROM pg_roles WHERE rolname = v_fleet AND rolbypassrls
    UNION ALL SELECT 'LOGIN' FROM pg_roles WHERE rolname = v_fleet AND rolcanlogin
    UNION ALL SELECT 'CREATEDB' FROM pg_roles WHERE rolname = v_fleet AND rolcreatedb
    UNION ALL SELECT 'CREATEROLE' FROM pg_roles WHERE rolname = v_fleet AND rolcreaterole
    UNION ALL SELECT 'REPLICATION' FROM pg_roles WHERE rolname = v_fleet AND rolreplication
    -- REACHES, not inherits, and the difference is a measured hole: with
    -- `GRANT <superuser> TO <fleet> WITH INHERIT FALSE, SET TRUE` the USAGE question answers FALSE
    -- while the runtime role runs `SET ROLE <superuser>` and comes back with is_superuser = on --
    -- SET permission is transitive through the chain. `SET` is 16-only as a privilege type; before
    -- 16 a grant carried no options and MEMBER is the whole answer.
    UNION ALL SELECT 'can become a privileged role'
                FROM pg_roles r
               WHERE r.rolname = v_fleet
                 -- Every attribute that OUTLIVES a SET ROLE, matching the direct list above
                 -- rather than only the two that defeat RLS. Measured with this role a SET-only
                 -- member of a CREATEROLE role: the runtime role entered it and minted a new
                 -- cluster role, while a check asking about SUPERUSER and BYPASSRLS alone called
                 -- this role unprivileged. LOGIN is absent on purpose: a session is already open
                 -- by the time a SET ROLE happens, so it is the one that does not transfer.
                 AND EXISTS (SELECT 1 FROM pg_roles m
                              WHERE (m.rolsuper OR m.rolbypassrls OR m.rolcreatedb
                                     OR m.rolcreaterole OR m.rolreplication)
                                AND m.oid <> r.oid
                                AND (pg_has_role(r.oid, m.oid, 'USAGE')
                                     OR pg_has_role(r.oid, m.oid,
                                          CASE WHEN current_setting('server_version_num')::int >= 160000
                                               THEN 'SET' ELSE 'MEMBER' END)))
  ) x;
  IF v_priv IS NOT NULL THEN
    -- `quote_ident` in the ARGUMENT, not `%I` in the format string: PL/pgSQL's RAISE knows only `%`,
    -- so `%I` emits the value followed by a literal `I` and quotes nothing (measured:
    -- `DROP ROLE some_roleI;`). The statement printed here is one an operator pastes.
    RAISE EXCEPTION
      'the cross-tenant role % already exists and is privileged (%). The runtime role SETs ROLE '
      'into it, so granting that would make RLS a no-op for every request. Drop it and let this '
      'script create it: DROP OWNED BY %; DROP ROLE %;',
      v_fleet, v_priv, quote_ident(v_fleet), quote_ident(v_fleet);
  END IF;

  -- EXECUTE on the resolver, to the RUNTIME role: asSuperAdmin calls it on every cross-tenant
  -- statement. Functions carry EXECUTE for PUBLIC by default, so this is a no-op on an ordinary
  -- install and the whole difference on one that revoked that (measured: the call dies with
  -- `permission denied for function fazerai_fleet_role`). Conditional, because on a FIRST run this
  -- script executes before the migration that creates the function.
  -- The DEFAULT privilege first, and it is the half that covers the FIRST run: on a hardened install
  -- the grant below is skipped because the function does not exist yet, the migration then creates
  -- it carrying nothing, and the same boot fails in the runtime guard. ALTER DEFAULT PRIVILEGES is
  -- scoped to the role that runs it, which is the role that creates the function one step later.
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public'
                 ' GRANT EXECUTE ON FUNCTIONS TO %I', v_role);
  IF to_regprocedure('public.fazerai_fleet_role()') IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.fazerai_fleet_role() TO %I', v_role);
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', v_fleet);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', v_fleet);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', v_fleet);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public'
                 ' GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', v_fleet);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public'
                 ' GRANT USAGE, SELECT ON SEQUENCES TO %I', v_fleet);

  -- Membership on this role is RECONCILED, not merely added to. Roles are cluster-wide while
  -- databases are not, so a database dropped and recreated under the same name derives the SAME
  -- fleet role -- and every membership the PREVIOUS installation granted survives it. Measured: the
  -- old installation's runtime role read all 30 rows of the new installation's data through the new
  -- policies, with nothing but a SET ROLE.
  --
  -- Loudly, unlike the TypeScript twin: that one runs unattended on every container boot and warns,
  -- this one is invoked by hand with someone watching (see the header), so a member it cannot clear
  -- stops the script instead of scrolling past. And it is re-read rather than trusted, because a
  -- REVOKE issued by someone who is not the GRANTOR removes nothing and reports success (measured).
  -- A stray is kept only where BOTH hold: the operator declared it in fazerai.retain_fleet_member,
  -- and it still has a session here. The declaration authorises keeping the access (docs/deploy.md
  -- promises the container still serving on a rotation's outgoing role survives the transfer); the
  -- session bounds it, so a declaration left behind clears itself once the old process exits.
  FOR v_stray IN
    SELECT DISTINCT r.rolname
      FROM pg_auth_members am
      JOIN pg_roles r ON r.oid = am.member
      JOIN pg_roles d ON d.oid = am.roleid
     WHERE d.rolname = v_fleet AND r.rolname <> v_role AND r.rolname <> current_user
       AND NOT (r.rolname = ANY (v_retained)
                AND EXISTS (SELECT 1 FROM pg_stat_activity a
                             WHERE a.datname = current_database() AND a.usename = r.rolname))
  LOOP
    BEGIN
      -- CASCADE for the same reason as the TypeScript twin: a PREVIOUS ADMINISTRATOR is a stray
      -- here, and the membership it granted onward to the runtime role depends on it. What CASCADE
      -- drops with it is exactly that onward grant, re-made by the GRANTs a moment later.
      EXECUTE format('REVOKE %I FROM %I CASCADE', v_fleet, v_stray);
      RAISE NOTICE 'revoked % from % -- a membership this database did not grant', v_stray, v_fleet;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'could not revoke % from %: %', v_stray, v_fleet, SQLERRM;
    END;
  END LOOP;

  SELECT string_agg(DISTINCT r.rolname, ', ') INTO v_left
    FROM pg_auth_members am
    JOIN pg_roles r ON r.oid = am.member
    JOIN pg_roles d ON d.oid = am.roleid
   WHERE d.rolname = v_fleet AND r.rolname <> v_role AND r.rolname <> current_user
     AND NOT (r.rolname = ANY (v_retained)
              AND EXISTS (SELECT 1 FROM pg_stat_activity a
                           WHERE a.datname = current_database() AND a.usename = r.rolname));
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION
      '% are still members of % and can read every tenant in this database through the '
      'cross-tenant policy. This is what a database dropped and recreated under the same name '
      'leaves behind; clear them as their grantor or as a superuser.', v_left, v_fleet;
  END IF;

  -- The membership, and the half of it that is load-bearing is `INHERIT FALSE`.
  --
  -- SET ROLE needs the membership; INHERITING it would apply `fleet_super_admin` to the runtime role
  -- passively, and then an ordinary scoped request reads every tenant's rows with no error and no
  -- plan difference. On 16+ the grant's own option is the control and the role attribute does NOT
  -- override it: `ALTER ROLE <app> NOINHERIT` leaves an existing grant inheriting (measured). On 15
  -- and older the option does not parse and `rolinherit` is the whole control.
  --
  -- The administrative role gets it too: a DATA migration over a FORCE-RLS table opens with
  -- `SET ROLE`, and on managed Postgres this role is the owner WITHOUT rolsuper, so without the
  -- membership that line fails.
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', v_fleet, v_role);
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT FALSE, SET TRUE', v_fleet);
  ELSE
    EXECUTE format('ALTER ROLE %I NOINHERIT', v_role);
    EXECUTE format('GRANT %I TO %I', v_fleet, v_role);
    EXECUTE format('GRANT %I TO CURRENT_USER', v_fleet);
  END IF;

  -- Asserted on the EFFECT rather than on the statements above, which is the only form that
  -- survives a hand-made grant landing here first. And on the CAPABILITY, not the membership: since
  -- 16 a grant carries its own SET option and `MEMBER` ignores it, so `SET FALSE` reads as healthy
  -- while every SET ROLE is denied (measured). `SET` is 16-only as a privilege type.
  IF pg_has_role(v_role, v_fleet, 'USAGE') THEN
    -- `quote_ident` in the arguments, same as above: RAISE knows only `%`.
    RAISE EXCEPTION
      'runtime role % INHERITS %: the cross-tenant policy would apply to it passively, '
      'making every tenant readable on an ordinary request. Repair with: '
      'GRANT % TO % WITH INHERIT FALSE, SET TRUE;',
      v_role, v_fleet, quote_ident(v_fleet), quote_ident(v_role);
  END IF;
  IF NOT pg_has_role(
       v_role, v_fleet,
       CASE WHEN current_setting('server_version_num')::int >= 160000
            THEN 'SET' ELSE 'MEMBER' END) THEN
    RAISE EXCEPTION 'runtime role % cannot SET ROLE to %: no cross-tenant read would '
      'return a row', v_role, v_fleet;
  END IF;
END $$;

-- LangGraph checkpointer schema, owned by the runtime role so PostgresSaver.setup()
-- can create its tables. thread_id prefixing is the tenant fence here (RLS on these
-- tables is hardened in a later phase).
CREATE SCHEMA IF NOT EXISTS langgraph AUTHORIZATION :"app_role";
GRANT USAGE, CREATE ON SCHEMA langgraph TO :"app_role";
-- No-op on a first provisioning, and the whole point on an existing schema: granting on a schema
-- does not reach the tables inside it, which still belong to whoever created them, and
-- PostgresSaver.setup() opens with `SELECT v FROM langgraph.checkpoint_migrations`. Grants only,
-- and deliberately: re-owning a table strips its previous owner's implicit privileges, which takes
-- down anything still serving on that role, so db-bootstrap.ts does it only for tables the
-- administrator running it owns itself. This script is run once, by hand, and provisions.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA langgraph TO :"app_role";

-- The refusal, and it comes LAST for a measured reason on top of the transaction one.
--
-- Its own statement, so the repair it reports is already committed (a RAISE aborts the transaction
-- it is in). And at the END of the script, because the statement it PRINTS names this database's
-- own fleet role: raised from where the repair sits, the script aborted before provisioning that
-- role, and pasting the repair answered `role ... does not exist` (measured). Everything above is
-- idempotent and safe to have run on a database that will not serve, so provisioning first costs
-- nothing and is what makes the repair runnable.
--
-- It re-reads rather than trusting the loop, because a REVOKE issued by anyone who is not the
-- GRANTOR removes nothing and reports success (measured).
DO $$
DECLARE
  v_fleet name := ('fazerai_fleet_'
                   || left(regexp_replace(current_database()::text, '[^a-zA-Z0-9_]', '_', 'g'), 30)
                   || '_' || substr(md5(current_database()::text), 1, 8))::name;
  v_foreign text;
  v_held    text;
BEGIN
  SELECT string_agg(DISTINCT quote_ident(r.rolname), ', '),
         string_agg(DISTINCT quote_ident(r.rolname), ', ') FILTER (WHERE
           EXISTS (SELECT 1 FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
                    CROSS JOIN LATERAL aclexplode(c2.relacl) a
                   WHERE n2.nspname = 'public' AND a.grantee = r.oid)
        OR EXISTS (SELECT 1 FROM pg_namespace n3 CROSS JOIN LATERAL aclexplode(n3.nspacl) a
                   WHERE n3.nspname = 'public' AND a.grantee = r.oid))
    INTO v_foreign, v_held
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(p.polroles) AS pr(oid)
    JOIN pg_roles r ON r.oid = pr.oid
   WHERE n.nspname = 'public' AND p.polname = 'fleet_super_admin'
     AND r.rolname <> v_fleet AND r.rolname LIKE 'fazerai\_fleet\_%';
  IF v_foreign IS NOT NULL THEN
    RAISE EXCEPTION
      'this database carries fleet_super_admin policies naming %, and not % -- the shape of a '
      'database restored or cloned under a different name. %  Re-running the migration is NOT the '
      'repair: it is recorded as applied in this copy, and migrate resolve --rolled-back answers '
      'P3012 (not in a failed state). Rewrite the policies instead, which is idempotent and '
      'touches only this database: DO $x$ DECLARE t text; BEGIN FOR t IN SELECT c.relname '
      'FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN pg_namespace n ON '
      'n.oid = c.relnamespace WHERE n.nspname = ''public'' AND p.polname = ''fleet_super_admin'' '
      'LOOP EXECUTE format(''DROP POLICY fleet_super_admin ON %%I'', t); EXECUTE format('
      '''CREATE POLICY fleet_super_admin ON %%I TO %%I USING (true) WITH CHECK (true)'', t, '
      'public.fazerai_fleet_role()); END LOOP; END $x$;',
      v_foreign, quote_ident(v_fleet),
      CASE WHEN v_held IS NULL THEN 'Their privileges here have been revoked.'
           ELSE v_held || ' still hold privileges here, which this administrator is not the '
                          'grantor of; clear them as their grantor or as a superuser.' END;
  END IF;
END $$;
