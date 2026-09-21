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
-- WHY THE MESSAGE SAYS REINDEX AND NOT DROP, which is the one place this file deliberately departs
-- from its two siblings. Their message says to DROP the dead index and re-deploy, and following it
-- ends with the table carrying NO index at all: behind the `--applied` door the build file is
-- already recorded as applied, so `migrate deploy` never runs it again, and the plan goes back to
-- the same scan with the deploy green and nothing left asking. `REINDEX INDEX CONCURRENTLY` instead
-- revalidates in place and keeps the definition, so the recovery ends where the build meant to.
-- Measured on a genuinely interrupted build (a `CREATE INDEX CONCURRENTLY` over 250k rows whose
-- backend was terminated mid-scan): the REINDEX takes it back to `indisvalid = true` with the same
-- `pg_get_indexdef`. The siblings cannot be corrected in place: an applied migration is checksummed,
-- and editing the file makes `migrate deploy` refuse the database it already ran on.
--
-- THE REINDEX HAS ONE PRECONDITION, and it is in the message because leaving it out was a false
-- claim this file made for one round: the index has to be BUILDABLE. Every concurrent build in this
-- tree is non-unique, where that is always true. A UNIQUE index whose data violates uniqueness is
-- the exception, and the REINDEX there fails exactly the way the build did AND leaves a second
-- invalid index behind (measured: `u_v_idx` plus `u_v_idx_ccnew`, both `indisvalid = false`, after
-- `REINDEX INDEX CONCURRENTLY` on an index left by a duplicate-key failure). That case needs the
-- duplicate data resolved first, or the index dropped on purpose.
--
-- AND A BUILD IN FLIGHT READS EXACTLY LIKE A CORPSE. Postgres creates the index invalid and
-- validates it afterwards, so a `CREATE INDEX CONCURRENTLY` running RIGHT NOW is `indisvalid =
-- false` for its whole duration, and this file stops the deploy on it. That is the conservative
-- answer and it is the one to keep: guessing "somebody is probably building it" is how a real corpse
-- ships. `indisready` does not separate the two, which was measured rather than assumed, on four
-- states: a live build blocked by a writer sits at `false/false` for the whole wait, a build killed
-- during its first scan leaves `false/false`, and a live build waiting on a mere reader and a build
-- killed in the second wait both show `false/true`. The discriminator is
-- `pg_stat_progress_create_index`, which names the table, the index and the phase, and the message
-- sends the operator there because reindexing another session's live build is the wrong move. NOT a
-- query-text match on `pg_stat_activity`: this file shipped one round advising
-- `query ILIKE 'create index%'`, and a live `CREATE UNIQUE INDEX CONCURRENTLY` does not match that
-- prefix (measured: the progress view named the build while the ILIKE returned zero), so the
-- operator would have been told nothing was running and sent to reindex it.
--
-- THE LAST STEP BELONGS TO BOTH BRANCHES, and putting it inside one of them was the third defect of
-- this round. Whatever the operator does about the index, THIS migration's row is FAILED from the
-- moment it raised, so the next `migrate deploy` stops with `P3009` until it is resolved. Measured
-- on the in-flight branch followed to the letter: the build finishes, and the re-deploy still exits
-- 1. So the `resolve --rolled-back` is hoisted out of the fork, and the message says which failure
-- it prevents. A runbook that is right about the hard part and drops a step at the end leaves the
-- operator exactly where the silence did.
--
-- AND WHY IT ONLY REPORTS. Repairing here would need the dead index's NAME, which is not known when
-- this file is written, so it would take a `DO $$ … EXECUTE format('REINDEX INDEX CONCURRENTLY %I',
-- …)` loop. Postgres refuses that outright: `REINDEX CONCURRENTLY cannot be executed from a
-- function`. The guard can stop the deploy and name the index; it cannot fix it.
--
-- In a file of its own because with anything else beside it the `CREATE INDEX CONCURRENTLY` this is
-- checking is refused with `25001`. `.claude/rules/prisma.md` has both halves of that measurement
-- and asks that no comment here assert the explanation that would reconcile them.
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
      'conversations carries invalid index(es): %.
WHY: either a concurrent build was interrupted and Postgres now refuses to use what it left, or one is running RIGHT NOW. An in-flight build reads exactly the same way, and indisready does not separate the two.
CHECK: SELECT index_relid::regclass, phase FROM pg_stat_progress_create_index WHERE relid = ''conversations''::regclass;
IF A ROW COMES BACK: a build is in flight. Let it finish, and do NOT reindex it.
OTHERWISE: run REINDEX INDEX CONCURRENTLY on each dead index, NOT a DROP (the migration that built it is already recorded as applied and will not run again, so a drop leaves the table with no index at all). A REINDEX that fails means the index is UNIQUE and its data violates uniqueness: resolve the duplicates, DROP the ..._ccnew the failed attempt left behind, then reindex the original.
EITHER WAY, FINISH WITH: prisma migrate resolve --rolled-back 20260921120000_assert_conversation_indexes_valid, then re-deploy. This migration''s own row is FAILED now, so without that the next deploy stops with P3009 no matter which branch you took.',
      dead;
  END IF;
END $$;
