-- Where the test-mode silence opened a conversation for the team, and who Chatwoot assigned it to in
-- that write. Nullable, no default, no backfill: a conversation silenced before this column stays
-- `pending` until its next message, which opens it and fills both.
ALTER TABLE "conversations" ADD COLUMN "test_parked_open_at" TIMESTAMP(3),
ADD COLUMN "test_parked_assignee_id" INTEGER;
