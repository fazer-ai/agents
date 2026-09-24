-- AlterTable
-- Nullable with no default, so Postgres records it in the catalog without rewriting the table: the
-- ACCESS EXCLUSIVE it takes is held for that, not for a scan (issue #839). Rows from before it stay
-- null, which the reader treats as "no turn known", never as a turn of its own.
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "turn_id" TEXT;
