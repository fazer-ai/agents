-- AlterTable
-- A constant default, so Postgres records it in the catalog without rewriting the table (issue #843).
ALTER TABLE "alert_channels" ADD COLUMN IF NOT EXISTS "exclude_agent_ids" BIGINT[] NOT NULL DEFAULT ARRAY[]::BIGINT[];
