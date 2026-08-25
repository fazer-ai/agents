-- What the recovery sweep needs from a stranded delivery, and nothing more (issue #228).
--
-- A row stranded on PROCESSING is recovered by re-arming its conversation's debounce flush, and the
-- flush re-reads the conversation's messages from Chatwoot (`coalesceAndRunTurn` opens with
-- `client.getMessages`). So recovery needs the conversation's identity, never the event body: no
-- ciphertext column, no retention window, and no second copy of a customer's message at rest.
--
-- Nullable with no backfill. An event that names no conversation leaves it null, and so does every
-- row written before this migration — the sweep classifies both as unrecoverable rather than
-- guessing, and rows old enough to predate the column are long past any conversation worth
-- reviving.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "conversation_id" INTEGER;

-- Serves the sweep's only query: the oldest rows still on PROCESSING. PROCESSING is a transient
-- state (in-flight deliveries plus strands), so this index stays small next to the table.
CREATE INDEX "chatwoot_webhook_deliveries_status_received_at_idx" ON "chatwoot_webhook_deliveries"("status", "received_at");

-- The message the delivery carried, for the same reason and with the same discipline: an id, never
-- the content. Recovery passes it to the flush as the burst's high-water mark so a gate that closed
-- between the strand and the sweep can mark the burst handled without re-fetching it.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "message_id" INTEGER;
