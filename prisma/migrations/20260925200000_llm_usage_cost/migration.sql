-- AlterTable
-- Nullable with no default, so Postgres records it in the catalog without rewriting the table, like
-- `duration_ms` before it (issue #863). Rows from before it stay null: nothing priced them, and a
-- zero would read as free.
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "cost_usd" DECIMAL(18,10);
-- The table that priced the row, so a correction can find exactly the rows a wrong table wrote.
ALTER TABLE "llm_usage" ADD COLUMN IF NOT EXISTS "price_table" TEXT;
