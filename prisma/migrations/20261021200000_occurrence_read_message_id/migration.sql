-- The customer message a reading covered, by Chatwoot id beside its time (docs/occurrences.md,
-- "Readings"): two messages in the same second share `last_inbound_at`, and only the id tells the
-- second one from the first. Additive and nullable: a row read before it is due once more.
ALTER TABLE "occurrence_conversation_reads" ADD COLUMN "read_inbound_message_id" INTEGER;
