-- AlterTable
-- Nullable with no default, so Postgres records it in the catalog without rewriting the table, like
-- `turn_id` before it (issue #855). Rows from before it stay null: nothing timed them.
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "duration_ms" INTEGER;
