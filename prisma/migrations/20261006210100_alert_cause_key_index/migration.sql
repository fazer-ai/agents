-- CreateIndex
-- A cause alert looks up its open delivery by (channel, cause) inside a window, on every failure that
-- names a cause. CONCURRENTLY because `alert_deliveries` takes a row per alerting line, and the plain
-- build's SHARE lock would block every alert insert for the whole scan while the old container still
-- serves. Not unique, so always buildable. The DROP clears what an interrupted build left, for the
-- `resolve --rolled-back` door (.claude/rules/prisma.md); the next migration asserts the catalog.
DROP INDEX IF EXISTS "alert_deliveries_channel_id_cause_key_created_at_idx";
CREATE INDEX CONCURRENTLY "alert_deliveries_channel_id_cause_key_created_at_idx" ON "alert_deliveries"("channel_id", "cause_key", "created_at");
