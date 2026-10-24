-- The customer message a conversation's first reading of a field covered (docs/occurrences.md,
-- "Flags"): the flags count a conversation at it, not at the read, so a round that reads late does
-- not move it into the window. Readings stored before this column have none and keep counting at
-- `first_read_at`.
ALTER TABLE "conversation_readings" ADD COLUMN IF NOT EXISTS "first_inbound_at" TIMESTAMP(3);
