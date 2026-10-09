-- The newest incoming customer message mirrored on a conversation, by Chatwoot id (issue #1122).
-- Nullable with no default, so the ALTER only touches the catalog.
ALTER TABLE "conversations" ADD COLUMN "last_inbound_message_id" INTEGER;
