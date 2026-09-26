-- Issue #890: the newest message the contact authorization gate refused on a conversation, so a
-- later update of a refused message never sends its media to a provider on a newer yes.
ALTER TABLE "conversations" ADD COLUMN "media_refused_through_message_id" BIGINT;
