-- The Chatwoot message id of the last /reset that cleared this conversation, so a turn answering an
-- earlier message can tell that the operator asked for a clean slate under it and stand down. A
-- message id and not a timestamp of ours: the ledger row that would date the delivery is inserted on
-- the detached path after the ack, so it does not preserve the order two events arrived in, and
-- Chatwoot's own sequence does. Existing rows need no backfill: NULL is "never reset".
ALTER TABLE "conversations" ADD COLUMN "reset_at_message_id" INTEGER;
