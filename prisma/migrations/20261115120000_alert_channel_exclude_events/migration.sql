-- AlterTable
-- A constant default, so Postgres records it in the catalog without rewriting the table. Empty leaves
-- no event out, which is how every existing channel keeps alerting exactly as before.
ALTER TABLE "alert_channels" ADD COLUMN IF NOT EXISTS "exclude_events" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
