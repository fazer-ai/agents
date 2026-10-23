-- The customer message a failed read was for, by Chatwoot id beside its time (docs/occurrences.md,
-- "Readings"): a second message in the same second must not inherit the first one's failures.
-- Additive and nullable.
ALTER TABLE "occurrence_conversation_reads" ADD COLUMN "failed_inbound_message_id" INTEGER;
