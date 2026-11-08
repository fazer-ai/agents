-- THE DASHBOARD READS EACH BLOCK DIRECTLY (issue #1732, docs/dashboard.md "How the console loads"):
-- nothing queues late changes for kept days any more, so the triggers that wrote that queue go, with
-- their functions. They are found by their function in the catalog rather than named here, so the file
-- drops whatever a database carries, whichever of the migrations that added and rewrote them it went
-- through, and a second run drops nothing.
--
-- The tables stay for one release. `migrate deploy` runs in the new container while the previous one
-- still serves (docs/deploy.md), and that one still reads `dashboard_days` and `dashboard_dirty`: with
-- the triggers gone its kept days only stop being invalidated for the minutes of the rollout, and a
-- revert to it still finds its tables. The release after drops them (docs/roadmap.md).
--
-- Dropping a trigger locks its table briefly; a lock that waits past 10 s fails the migration instead
-- of holding the writers behind it, and the file runs again as is.
BEGIN;

SET LOCAL lock_timeout = '10s';

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.tgname, c.relname
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public' AND NOT t.tgisinternal AND p.proname LIKE 'dashboard\_dirty%'
  LOOP
    EXECUTE format('DROP TRIGGER %I ON %I', r.tgname, r.relname);
  END LOOP;
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'dashboard\_dirty%'
  LOOP
    EXECUTE format('DROP FUNCTION %s', r.sig);
  END LOOP;
END $$;

COMMIT;
