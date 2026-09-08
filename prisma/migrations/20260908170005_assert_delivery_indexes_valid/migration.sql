-- THE CATALOG HAS TO AGREE WITH THE MIGRATION BEFORE THIS ONE (issue #540, PR review round 11), and
-- this is the half that catches the silent case. Without a transaction the builds are not atomic, and
-- a `CREATE INDEX CONCURRENTLY` that dies leaves an `indisvalid = false` index Postgres refuses to use
-- WITHOUT SAYING SO: the plan goes back to what it was, the migration still records as applied, and
-- the sibling lookup goes on scanning a ledger nothing prunes. `.claude/rules/prisma.md` asks for
-- exactly this check, and `20260904170001_audit_assert_indexes_valid` is the same file for audit_logs.
--
-- Its own file because a `DO $$` block puts the migration in an implicit transaction, which the
-- `CREATE INDEX CONCURRENTLY` it is checking cannot share.
--
-- It asks about the WHOLE table rather than about the one index this PR adds: the two beside it were
-- built concurrently too (20260825140100), and an invalid one there is the same silent outage.
DO $$
DECLARE dead text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO dead
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
   WHERE t.relname = 'chatwoot_webhook_deliveries' AND NOT i.indisvalid;
  IF dead IS NOT NULL THEN
    RAISE EXCEPTION
      'chatwoot_webhook_deliveries carries invalid index(es): %. A concurrent build was interrupted; run DROP INDEX CONCURRENTLY on each and re-deploy.',
      dead;
  END IF;
END $$;
