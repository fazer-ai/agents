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
-- AND THE VIEW ANSWERS DIFFERENTLY BY ROLE, which is why the message carries no `WHERE`. Measured on
-- a database owned by a non-superuser, the shape `docs/deploy.md` describes for managed Postgres:
-- against a build another role started, the owner gets the ROW but every column NULL, while a
-- superuser gets `conversations | …_idx | waiting for old snapshots`. So `WHERE relid =
-- 'conversations'::regclass` drops precisely that row, and the check reports "nothing running" for
-- the operator it was written for. Unfiltered, the nulled row is still an answer: something is
-- building, and you cannot see what.
--
-- AND THE TWO STATES COEXIST, which is what made a FORK the wrong shape for this message. The list
-- this file prints is not "either corpses or a live build": a table can carry an index abandoned
-- last week AND have an unrelated build running right now, and the progress view names only the
-- second. Measured on this tree, with a forged `zz_corpse` alongside a real
-- `CREATE INDEX CONCURRENTLY "zz_live"` held in `waiting for old snapshots`: the assertion lists
-- both, the progress view names `conversations | zz_live` alone, and when the build finishes
-- `zz_live` is valid while `zz_corpse` is still `indisvalid = false`. An operator told "a build is
-- in flight, let it finish" therefore waits, resolves, re-deploys, and this file raises on the index
-- nobody touched. The verifier had already produced this exact state one round earlier and priced it
-- as a cost (one extra deploy round); it is a defect, because three lines of text remove it.
--
-- AND PARTITIONING THE LIST BY NAME DOES NOT FIX IT EITHER, which was the first correction attempted
-- here: "leave alone what the view names, reindex every other name" reads well and breaks on the
-- nulled row, which names NOTHING. For an operator without `pg_read_all_stats` every index in the
-- list is then "not named by the view", so the rule sends them to reindex a live build they have no
-- privilege to see. So the message is a SEQUENCE: wait out whatever the view shows, including the
-- row it shows as NULLs, and only then reindex whatever is STILL invalid. It costs a wait when the
-- hidden build belonged to another database of the cluster, and it is the only ordering where
-- neither the corpse nor the live build is handled wrong.
--
-- AND THE WAIT NEEDS A CEILING, because step 1 is cluster-wide by design and that is what makes the
-- nulled row appear at all. "Re-run until it comes back empty" is unbounded on a cluster where some
-- database always has a build running, and the operator is then stuck waiting instead of fixing.
-- What bounds it is that step 3 reindexes from the CATALOG, scoped to this table, so the wait only
-- has to cover rows that could be this table's: a row naming another table is not, a row rendering
-- as bare OIDs belongs to another database, and only the all-NULL row is unattributable. The escape
-- from a stream of nulled rows is measured and not assumed: the same role, against the same live
-- build, goes from `179174 | | |` to `179174 | conversations | zz_live2 | waiting for old snapshots`
-- after `GRANT pg_read_all_stats TO <role>`, in a new session. So the message names that GRANT.
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
WHY: Postgres creates a concurrent index invalid and validates it at the end, so this state means a build was interrupted and Postgres now refuses what it left, OR one is running RIGHT NOW. indisready does not separate the two, and they COEXIST: an abandoned index and an unrelated live build land in the same list above. So this is a sequence, not a choice between branches.
STEP 1, SEE WHAT IS RUNNING: SELECT pid, relid::regclass, index_relid::regclass, phase FROM pg_stat_progress_create_index;
Run it with no WHERE. Without superuser or pg_read_all_stats, a build another role started comes back as a row with every column NULL, and a filter on relid drops exactly that row. An index shown as a bare OID instead of a name belongs to another database of this cluster.
STEP 2, WAIT OUT WHAT COULD BE THIS TABLE''S: an index that query names on conversations is being built right now, so leave it alone. A row naming another table, or one whose relid and index_relid render as bare OIDs instead of names (a build in another database of this cluster), is not yours and you do not wait for it. A row of all NULLs names nothing at all, so you cannot rule it out and you do wait. Re-run step 1 until nothing that could be this table''s is left. If nulled rows keep arriving, which on a busy cluster they will because step 1 is cluster-wide, have an admin run GRANT pg_read_all_stats TO <your role> and run step 1 again in a NEW session: the same role then reads the same build as conversations | ..._idx | waiting for old snapshots instead of NULLs, and the rule above applies again.
STEP 3, REINDEX WHAT SURVIVES THE WAIT. Do not skip this because step 2 found a build: waiting repairs nothing, and an abandoned index sitting beside a live one raises this same assertion on the next deploy. Re-run this file''s own query, which is the one answer no role setup can hide from the owner (the list above is from before the wait, and step 1 can be nulls):
  SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_class t ON t.oid = i.indrelid WHERE t.relname = ''conversations'' AND NOT i.indisvalid;
Every index it still returns is abandoned: run REINDEX INDEX CONCURRENTLY on each, NOT a DROP (the migration that built it is already recorded as applied and will not run again, so a drop leaves the table with no index at all). A REINDEX that fails means the index is UNIQUE and its data violates uniqueness: resolve the duplicates, DROP the ..._ccnew the failed attempt left behind, then reindex the original.
STEP 4, ALWAYS: prisma migrate resolve --rolled-back 20260921120000_assert_conversation_indexes_valid, then re-deploy. This migration''s own row is FAILED from the moment it raised, so without step 4 the next deploy stops with P3009 no matter what you did about the index.',
      dead;
  END IF;
END $$;
