-- What the stranded-delivery sweep needs from a delivery, and nothing more (issue #228).
--
-- The sweep REPORTS a delivery that a process death abandoned; it does not answer the customer
-- (issue #295 carries that half and why). So what it needs is the delivery's identity, never the
-- event body: no ciphertext column, no retention window, and no second copy of a customer's message
-- at rest.
--
-- Nullable with no backfill. An event that names no conversation leaves it null, and so does every
-- row written before this migration — the sweep files those without a conversation rather than
-- guessing.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "conversation_id" INTEGER;

-- Serves the sweep's only query: the oldest non-terminal rows. PENDING and PROCESSING are both
-- transient (in-flight deliveries plus strands), so this index stays small next to the table.
CREATE INDEX "chatwoot_webhook_deliveries_status_received_at_idx" ON "chatwoot_webhook_deliveries"("status", "received_at");


-- The INBOUND message the delivery carried, for the same reason and with the same discipline: an id,
-- never the content. Null on every event that is not a customer message, which is what lets the
-- sweep tell a row where nothing was lost from one where a customer went unanswered.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "inbound_message_id" INTEGER;
-- Serves the other half of the same contract: when a turn answers a burst it retires the ledger rows
-- of the messages that burst contained, matched by conversation and message id. That write is what
-- lets the sweep ask "did anything cover this message" of the ROW rather than inferring it from the
-- conversation's watermarks, which cannot answer a per-message question.
CREATE INDEX "chatwoot_webhook_deliveries_conversation_message_idx" ON "chatwoot_webhook_deliveries"("conversation_id", "inbound_message_id");

-- When the CURRENT attempt claimed the row, stamped by the tx1 CAS `PENDING -> PROCESSING`.
--
-- The staleness clock has to be per-ATTEMPT, not per-receipt. A redelivery is deliberately allowed
-- to claim a row left stranded on PENDING (`recordAndProcessChatwootDelivery` sends both branches on
-- to the CAS, because the row existing is not the same as the work having been done), and that claim
-- can land long after the original receipt. Measured from `received_at`, the live attempt looks
-- abandoned the instant it starts, and the sweep would mark a row DEAD — and page an operator about
-- a lost message — while the process answering it is still running.
--
-- Null on a row never claimed, where receipt is the only clock there is and the right one.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "claimed_at" TIMESTAMP(3);


-- Every row still non-terminal at this moment is, by definition, abandoned: nothing but
-- `processChatwootDelivery` moves these, and the process that would have is long gone. They predate
-- the columns above, so the sweep could never tell whether each one carried a customer message —
-- and closing them as PROCESSED would hide real losses in exactly the list that exists to surface
-- them. Marked DEAD once, here, so they appear in it instead.
--
-- A delivery genuinely in flight during this migration is being stranded by the same deploy that
-- runs it, so DEAD is the right answer for it too.
UPDATE "chatwoot_webhook_deliveries"
   SET status = 'DEAD', processed_at = now()
 WHERE status IN ('PENDING', 'PROCESSING');
