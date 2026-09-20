-- THE CATALOG HAS TO AGREE WITH THE MIGRATION BEFORE THIS ONE (issue #718, PR review round 2), the
-- same pair `20260908170005` and `20260904170001` already form for their tables. Without a
-- transaction the build is not atomic, and a `CREATE INDEX CONCURRENTLY` that dies leaves an
-- `indisvalid = false` index Postgres refuses to use WITHOUT SAYING SO: the plan goes back to the
-- sequential scan, the migration still records as applied, and `threadResetBoundary` goes on reading
-- every conversation of the instance from inside the ingest lock.
--
-- Its own file because a `DO $$` block puts the migration in an implicit transaction, which the
-- `CREATE INDEX CONCURRENTLY` it is checking cannot share.
--
-- It asks about the WHOLE table rather than about the one index this PR adds: an invalid index
-- anywhere on `conversations` is the same silent outage, and a later concurrent build here will be
-- covered by this file without anyone remembering to extend it.
DO $$
DECLARE dead text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO dead
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
   WHERE t.relname = 'conversations' AND NOT i.indisvalid;
  IF dead IS NOT NULL THEN
    RAISE EXCEPTION
      'conversations carries invalid index(es): %. A concurrent build was interrupted; run DROP INDEX CONCURRENTLY on each and re-deploy.',
      dead;
  END IF;
END $$;
