-- Two nullable columns, no backfill, no default, no index: an ADD COLUMN with no default is a
-- catalog-only change on Postgres 11+, so nothing rewrites and nothing is locked for the duration
-- of a table scan.
--
-- THE ROLLOUT WINDOW IS REAL AND CANNOT BE CLOSED BY A BACKFILL, stated rather than glossed. Both
-- columns record a fact that is only observable at the moment something happens — what Chatwoot's
-- message sequence read at the instant of a console write, and which message an owed takeover was
-- about — and neither is recoverable from anything stored: the delivery ledger holds ids and shapes
-- but never the event body (issue #228), and a console write leaves no trace of the read it made.
-- So every row that predates this migration keeps NULL, and both readers treat NULL as "no evidence"
-- and fall back to the behaviour that shipped before it: the takeover's fence does not refuse, and
-- the recovery runs unfenced. That is the pre-existing defect (issue #469), not a new one, and it
-- ends for a conversation the first time an operator clicks anything on it after the deploy.
ALTER TABLE "conversations" ADD COLUMN "console_write_at_message_id" INTEGER;
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "human_reply_message_id" INTEGER;
