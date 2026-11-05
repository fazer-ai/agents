-- Clears what an interrupted concurrent build of scheduler_jobs_tenant_id_dedupe_key_idx left behind
-- (`indisvalid = false`, never used by the planner), so the next migration can build it again, and
-- leaves a valid index with this name alone. Some instances already carry a valid copy, created by
-- hand with this exact name as a mitigation, and it is what keeps their follow-up sweep under its
-- budget: dropping it unconditionally would leave the old container, still serving during a rolling
-- deploy, without the index for as long as the rebuild takes. A file of its own: a `DO` block runs
-- the file in an implicit transaction, which `CREATE INDEX CONCURRENTLY` cannot share.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'scheduler_jobs_tenant_id_dedupe_key_idx'
       AND n.nspname = current_schema()
       AND NOT i.indisvalid
  ) THEN
    DROP INDEX "scheduler_jobs_tenant_id_dedupe_key_idx";
  END IF;
END $$;
