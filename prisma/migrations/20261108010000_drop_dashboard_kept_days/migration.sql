-- THE DASHBOARD READS EACH BLOCK DIRECTLY (issue #1732, docs/dashboard.md "How the console loads"):
-- the kept days, the queue of late changes that dropped them and the views the warm-up pass kept go,
-- with every trigger that wrote that queue. The triggers are found by their function in the catalog
-- rather than named here, so the file drops whatever a database carries, whichever of the migrations
-- that added and rewrote them it went through; the tables are dropped only if they exist, since
-- another change may already have dropped `dashboard_views`.
--
-- Wrapped in a transaction: a failure between the triggers and the tables would leave the triggers of
-- six busy tables writing into a queue nothing reads, or gone with the queue still there.
BEGIN;

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

DROP TABLE IF EXISTS "dashboard_dirty";
DROP TABLE IF EXISTS "dashboard_days";
DROP TABLE IF EXISTS "dashboard_views";

COMMIT;
