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
