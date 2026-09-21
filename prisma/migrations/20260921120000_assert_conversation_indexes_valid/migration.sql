-- THE CATALOG HAS TO AGREE WITH THE MIGRATION BEFORE THIS ONE (issue #759), which builds its index
-- `CONCURRENTLY` and is the only one of the three concurrent builds in this tree with nothing after
-- it that asks. `20260904170001_audit_assert_indexes_valid` and
-- `20260908170005_assert_delivery_indexes_valid` are this same file for the other two.
--
-- WHERE THE SILENCE ACTUALLY IS, measured against a scratch database rather than assumed, because
-- the header of `20260919140000_conversations_contact_inbox_index` assumed and got it backwards: it
-- says the `DROP INDEX IF EXISTS` above its build "is what prevents an interrupted build from
-- leaving an `indisvalid = false` index". A build whose connection dies mid-file is not silent at
-- all. Prisma leaves the row with `finished_at = NULL`, and the NEXT deploy refuses to move:
-- `P3009 - migrate found failed migrations in the target database, new migrations will not be
-- applied`. The container's command is `db-bootstrap && migrate deploy && exec bun src/index.ts`,
-- so the new release does not serve at all until a human intervenes.
--
-- The silence is in how that human gets OUT of P3009, and there are two doors:
--
--   * `migrate resolve --rolled-back <name>` plus a re-deploy reruns the file, and there the DROP
--     earns its keep: it clears the corpse so the fresh build does not collide with the name. That
--     is what the DROP is for, and it is the whole of what it does.
--   * `migrate resolve --applied <name>` marks the file applied WITHOUT running it. The next deploy
--     reports "No pending migrations to apply", the app boots, and the dead index stays in the
--     catalog for good. Postgres refuses to use it WITHOUT SAYING SO: the plan silently goes back to
--     the scan the build was there to remove, while every write to `conversations` still maintains
--     it. Nothing in the schema, in `migrate status`, or in any behavioural test can see it, because
--     an index changes no result, only a cost.
--
-- This file is what asks, and it asks at the one moment a human is already watching the deploy. A
-- hand-run `CREATE INDEX CONCURRENTLY` that dies (ordinary on a hot table, precisely because of this
-- failure mode) leaves the same corpse with no migration row at all, and is caught here too.
--
-- In a file of its own because a DO block puts the migration in an implicit transaction, which the
-- `CREATE INDEX CONCURRENTLY` it is checking cannot share.
--
-- It asks about the WHOLE table rather than about the one index the previous file adds: an invalid
-- index anywhere on `conversations` is the same silent outage. It does NOT ask about the whole
-- schema, and it runs once rather than on every boot. A migration guard covers the window between
-- its own build and itself, so the coverage of the family is only as complete as its membership;
-- `tests/prisma/concurrent-index-guard.test.ts` is what keeps the next concurrent build from
-- shipping without a file like this one.
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
