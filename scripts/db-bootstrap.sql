-- Idempotent DB bootstrap for fazer.ai agents.
-- Run as a SUPERUSER (or DB owner with CREATEROLE) against the application database,
-- once at provisioning time. Safe to re-run.
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
DO $$
DECLARE
  v_role text := current_setting('fazerai.app_role');
  v_pw   text := current_setting('fazerai.app_password');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
      v_role, v_pw);
  ELSE
    EXECUTE format(
      'ALTER ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE',
      v_role, v_pw);
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

-- LangGraph checkpointer schema, owned by the runtime role so PostgresSaver.setup()
-- can create its tables. thread_id prefixing is the tenant fence here (RLS on these
-- tables is hardened in a later phase).
CREATE SCHEMA IF NOT EXISTS langgraph AUTHORIZATION :"app_role";
GRANT USAGE, CREATE ON SCHEMA langgraph TO :"app_role";
