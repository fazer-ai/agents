-- The customer message a conversation's first reading of a field covered (docs/occurrences.md,
-- "Flags"): the flags count a conversation at it, not at the read, so a round that reads late does
-- not move it into the window. The theme member keeps the one of the reading it was placed from, so a
-- reason field switched since does not move it back to its read. Rows stored before these columns
-- have none and keep counting at the read.
ALTER TABLE "conversation_readings" ADD COLUMN IF NOT EXISTS "first_inbound_at" TIMESTAMP(3);
ALTER TABLE "occurrence_theme_members" ADD COLUMN IF NOT EXISTS "inbound_at" TIMESTAMP(3);
