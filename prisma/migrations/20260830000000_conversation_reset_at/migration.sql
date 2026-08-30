-- When /reset last cleared this conversation, so a turn that started before it can tell that the
-- operator asked for a clean slate under it and stand down. Existing rows need no backfill: NULL is
-- "never reset", and a turn compares what it read at the start against what it reads later, so a
-- conversation that stays NULL never trips.
ALTER TABLE "conversations" ADD COLUMN "reset_at" TIMESTAMP(3);
