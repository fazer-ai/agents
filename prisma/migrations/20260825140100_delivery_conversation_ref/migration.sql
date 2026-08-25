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

-- The INBOUND message the delivery carried, for the same reason and with the same discipline: an id,
-- never the content. Null on every event that is not a customer message, which is what lets the
-- sweep tell a row where nothing was lost from one where a customer went unanswered. Compared
-- against the conversation's handled watermark and read no other way.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "inbound_message_id" INTEGER;

-- Every row still non-terminal at this moment is, by definition, abandoned: nothing but
-- `processChatwootDelivery` moves these, and the process that would have is long gone. They predate
-- both columns above, so the sweep could never tell whether each one carried a customer message —
-- and closing them as PROCESSED would hide real losses in exactly the list that exists to surface
-- them. Marked DEAD once, here, so they appear in it instead.
--
-- A delivery genuinely in flight during this migration is being stranded by the same deploy that
-- runs it, so DEAD is the right answer for it too.
UPDATE "chatwoot_webhook_deliveries"
   SET status = 'DEAD', processed_at = now()
 WHERE status IN ('PENDING', 'PROCESSING');
