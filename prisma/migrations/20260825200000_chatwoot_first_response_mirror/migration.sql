-- Chatwoot's own first-response SLA, mirrored onto the conversation. Both values are computed by
-- Chatwoot from the messages table and ship on every conversation payload, so existing rows need no
-- backfill and no exclusion: the next event any of them receives carries their real numbers.
ALTER TABLE "conversations" ADD COLUMN "chatwoot_created_at" TIMESTAMP(3);
ALTER TABLE "conversations" ADD COLUMN "chatwoot_first_reply_at" TIMESTAMP(3);
