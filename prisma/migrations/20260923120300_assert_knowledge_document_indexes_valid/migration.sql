-- THE CATALOG HAS TO AGREE WITH THE MIGRATION BEFORE THIS ONE, which builds the unique index on
-- (knowledge_base_id, external_id) CONCURRENTLY (issue #794). Same file as
-- `20260921120000_assert_conversation_indexes_valid`, pointed at `knowledge_documents`; that file's
-- header holds every measurement behind the message below, and none of it is repeated here.
--
-- The index is UNIQUE, which that header names as the one case a REINDEX cannot revive when the data
-- violates it. Here the data cannot: the index arrives in the same release as the only writer of a
-- non-null external id, and every earlier row is NULL. The message's "could not create unique index"
-- branch stays because a failed REINDEX has other causes and the operator still has to read the error.
--
-- In a file of its own, because with anything else beside it the concurrent build it checks is
-- refused with `25001` (.claude/rules/prisma.md).
DO $$
DECLARE dead text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO dead
    FROM pg_class c
    JOIN pg_index i ON i.indexrelid = c.oid
    JOIN pg_class t ON t.oid = i.indrelid
   WHERE t.relname = 'knowledge_documents' AND NOT i.indisvalid;
  IF dead IS NOT NULL THEN
    RAISE EXCEPTION
      'knowledge_documents carries invalid index(es): %.
WHY: Postgres creates a concurrent index invalid and validates it at the end, so this state means a build was interrupted and Postgres now refuses what it left, OR one is running RIGHT NOW. indisready does not separate the two, and they COEXIST: an abandoned index and an unrelated live build land in the same list above. So this is a sequence, not a choice between branches.
STEP 1, SEE WHAT IS RUNNING: SELECT pid, relid::regclass, index_relid::regclass, phase FROM pg_stat_progress_create_index;
Run it with no WHERE. Without superuser or pg_read_all_stats, a build another role started comes back as a row with every column NULL, and a filter on relid drops exactly that row. An index shown as a bare OID instead of a name belongs to another database of this cluster.
STEP 2, WAIT OUT WHAT COULD BE THIS TABLE''S: an index that query names on knowledge_documents is being built right now, so leave it alone. A row naming another table, or one whose relid and index_relid render as bare OIDs instead of names (a build in another database of this cluster), is not yours and you do not wait for it. A row of all NULLs names nothing at all, so you cannot rule it out and you do wait. Re-run step 1 until nothing that could be this table''s is left. If nulled rows keep arriving, which on a busy cluster they will because step 1 is cluster-wide, have an admin run GRANT pg_read_all_stats TO <your role> and run step 1 again in a NEW session: the same role then reads the same build as knowledge_documents | ..._key | waiting for old snapshots instead of NULLs, and the rule above applies again.
STEP 3, REINDEX WHAT SURVIVES THE WAIT. Do not skip this because step 2 found a build: waiting repairs nothing, and an abandoned index sitting beside a live one raises this same assertion on the next deploy. Re-run this file''s own query, which is the one answer no role setup can hide from the owner (the list above is from before the wait, and step 1 can be nulls):
  SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_class t ON t.oid = i.indrelid WHERE t.relname = ''knowledge_documents'' AND NOT i.indisvalid;
Every index it still returns is abandoned, and they come in two kinds.
  A name ending in ..._ccnew or ..._ccold, with or without a trailing number, is NOT an index of its own: it is a leftover from a REINDEX that was interrupted or failed. DROP it, and never rebuild it. Measured in all three shapes: interrupting a REINDEX before the swap leaves the original invalid plus an invalid ..._ccnew; a second interruption, with that name taken, adds ..._ccnew1; and interrupting AFTER the swap leaves the real index VALID and an invalid ..._ccold beside it, which is this assertion firing with nothing wrong with the index at all.
  Everything else gets REINDEX INDEX CONCURRENTLY, never a DROP (the migration that built it is already recorded as applied and will not run again, so a drop leaves the table with no index at all).
Reindexing either of those instead of dropping it ends with TWO valid indexes carrying the same definition, measured for both suffixes: a duplicate that costs storage and every write from then on, and that nothing in this file will ever report again, because both are valid.
The REINDEX has a wait phase of its own and waits for ANY transaction whose snapshot is older than itself, including one that never touches this table, so it can sit for exactly as long as the build step 2 excused you from waiting for: measured on one index, 1s with nothing else running, 28s against a single open transaction on an unrelated table, and 111s beside a live concurrent build on another table, ending with that build. Looked up in pg_stat_activity it shows as Lock / virtualxid, which reads like a lock problem and is not one: the progress view names the same operation ..._ccnew | waiting for old snapshots. It is NOT stuck, and you must not interrupt it: an interrupted REINDEX leaves the original still invalid AND adds an invalid ..._ccnew beside it, which is one more of exactly what this migration is reporting.
If a REINDEX fails on its own, READ THE ERROR. "could not create unique index" means the index is UNIQUE and its data violates uniqueness: resolve the duplicates, DROP the ..._ccnew that attempt left behind, then reindex the original. Any other error, such as no disk space, a deadlock, or a statement or lock timeout, is its own problem with its own fix and has nothing to do with duplicate data.
STEP 4, ALWAYS: prisma migrate resolve --rolled-back 20260923120300_assert_knowledge_document_indexes_valid, then re-deploy. This migration''s own row is FAILED from the moment it raised, so without step 4 the next deploy stops with P3009 no matter what you did about the index.',
      dead;
  END IF;
END $$;
