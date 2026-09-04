-- THE CATALOG HAS TO AGREE WITH THE MIGRATION BEFORE THIS ONE, and this is the half that catches the
-- silent case. Without a transaction the builds are not atomic, and a `CREATE INDEX CONCURRENTLY`
-- that dies leaves an `indisvalid=false` index Postgres refuses to use WITHOUT SAYING SO: the plan
-- goes back to what it was and the migration still records as applied. `.claude/rules/prisma.md` asks
-- for exactly this check.
--
-- Its own file because a `DO $$` block puts the migration in an implicit transaction, which the
-- `CREATE INDEX CONCURRENTLY` statements it is checking cannot share. It sits BEFORE the drops of the
-- superseded indexes, so a failed build stops the deploy while the old indexes are still in place
-- rather than after they are gone.
DO $$
DECLARE dead text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO dead
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
   WHERE t.relname = 'audit_logs' AND NOT i.indisvalid;
  IF dead IS NOT NULL THEN
    RAISE EXCEPTION
      'audit_logs carries invalid index(es): %. A concurrent build was interrupted; run DROP INDEX CONCURRENTLY on each and re-deploy.',
      dead;
  END IF;
END $$;
